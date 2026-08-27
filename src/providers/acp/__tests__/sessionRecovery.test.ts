import { describe, expect, it } from 'vitest'
import { AcpProvider } from '@/providers/acp'
import type { AgentEvent } from '@/providers/types'

type SessionResponse = {
    sessionId?: string
    configOptions?: []
    models?: undefined
}

class RecoveryClientManager {
    connected = true
    supportsResumeSession = true
    supportsListSessions = false
    agentCapabilities = { agentCapabilities: { loadSession: false } }
    promptCapabilities = {}

    closeCalls = 0
    initCalls = 0
    newSessionCalls = 0
    resumeSessionCalls = 0
    loadSessionCalls = 0
    promptCalls = 0
    permissionHandlerCalls = 0
    extensionHandlerCalls = 0
    promptSessionIds: string[] = []

    resumeBehavior: (call: number) => Promise<SessionResponse> = async () => ({})
    loadBehavior: (call: number) => Promise<SessionResponse> = async () => ({})
    newSessionBehavior: (call: number) => Promise<SessionResponse> = async () => ({ sessionId: 'new-session' })

    private pendingOperationRejects = new Set<(error: Error) => void>()

    setPermissionHandler(): void {
        this.permissionHandlerCalls += 1
    }

    setExtensionHandler(): void {
        this.extensionHandlerCalls += 1
    }

    clearStderrBuffer(): void {}
    getStderrError(): null { return null }

    async init(): Promise<void> {
        this.initCalls += 1
        this.connected = true
    }

    async close(): Promise<void> {
        this.closeCalls += 1
        this.connected = false
        for (const reject of this.pendingOperationRejects) {
            reject(new Error('Connection closed'))
        }
        this.pendingOperationRejects.clear()
    }

    dispose(): void {
        this.connected = false
    }

    hangUntilClose(): Promise<never> {
        return new Promise((_, reject) => {
            this.pendingOperationRejects.add(reject)
        })
    }

    async newSession(): Promise<SessionResponse> {
        this.newSessionCalls += 1
        return this.newSessionBehavior(this.newSessionCalls)
    }

    async resumeSession(): Promise<SessionResponse> {
        this.resumeSessionCalls += 1
        return this.resumeBehavior(this.resumeSessionCalls)
    }

    async loadSession(): Promise<SessionResponse> {
        this.loadSessionCalls += 1
        return this.loadBehavior(this.loadSessionCalls)
    }

    async setSessionModel(): Promise<Record<string, never>> { return {} }
    async setSessionConfigOption(): Promise<Record<string, never>> { return {} }

    async prompt(params: { sessionId: string }): Promise<{ stopReason: string }> {
        this.promptCalls += 1
        this.promptSessionIds.push(params.sessionId)
        return { stopReason: 'end_turn' }
    }

    async cancelActivePrompt(): Promise<undefined> {
        return undefined
    }

    async waitForSessionUpdateProcessing(): Promise<void> {}
    dequeueSessionUpdate(): undefined { return undefined }
    async drainSessionUpdatesUntilIdle(): Promise<number> { return 0 }

    waitForSessionUpdate(_sessionId: string, options: { signal?: AbortSignal } = {}): Promise<never> {
        return new Promise((_, reject) => {
            if (options.signal?.aborted) {
                reject(new Error('Session update wait aborted'))
                return
            }
            options.signal?.addEventListener(
                'abort',
                () => reject(new Error('Session update wait aborted')),
                { once: true },
            )
        })
    }
}

function providerWith(manager: RecoveryClientManager, timeoutMs = 10): AcpProvider {
    const provider = new AcpProvider({
        name: 'recovery-test-acp',
        command: 'fake',
        args: [],
        sessionOpenTimeoutMs: timeoutMs,
    })
    ;(provider as any).clientManager = manager
    ;(provider as any).initialized = true
    return provider
}

async function collectEvents(provider: AcpProvider, sessionId: string | null = 'existing-session'): Promise<AgentEvent[]> {
    const handle = provider.startQuery('continue', {
        cwd: '/repo',
        ...(sessionId ? { sessionId } : {}),
        signal: new AbortController().signal,
    })
    const events: AgentEvent[] = []
    for await (const event of handle.events) events.push(event)
    return events
}

describe('AcpProvider session-open recovery', () => {
    it('restarts a wedged ACP process and resumes the same provider session before prompting', async () => {
        const manager = new RecoveryClientManager()
        manager.resumeBehavior = call => call === 1
            ? manager.hangUntilClose()
            : Promise.resolve({})
        const provider = providerWith(manager)

        const events = await collectEvents(provider)

        expect(manager.closeCalls).toBe(1)
        expect(manager.initCalls).toBe(1)
        expect(manager.resumeSessionCalls).toBe(2)
        expect(manager.newSessionCalls).toBe(0)
        expect(manager.promptCalls).toBe(1)
        expect(manager.promptSessionIds).toEqual(['existing-session'])
        expect(manager.permissionHandlerCalls).toBe(2)
        expect(manager.extensionHandlerCalls).toBe(2)
        expect(events).toEqual(expect.arrayContaining([
            expect.objectContaining({
                kind: 'session_init',
                sessionId: 'existing-session',
                isNewSession: false,
            }),
            expect.objectContaining({ kind: 'result', status: 'success' }),
        ]))
    })

    it('creates a replacement only after the restarted process explicitly rejects the old session', async () => {
        const manager = new RecoveryClientManager()
        manager.agentCapabilities = { agentCapabilities: { loadSession: true } }
        manager.resumeBehavior = call => call === 1
            ? manager.hangUntilClose()
            : Promise.reject(new Error('session not found'))
        manager.loadBehavior = async () => {
            throw new Error('session not found')
        }
        manager.newSessionBehavior = async () => ({ sessionId: 'replacement-session' })
        const provider = providerWith(manager)

        const events = await collectEvents(provider)

        expect(manager.closeCalls).toBe(1)
        expect(manager.resumeSessionCalls).toBe(2)
        expect(manager.loadSessionCalls).toBe(1)
        expect(manager.newSessionCalls).toBe(1)
        expect(manager.promptCalls).toBe(1)
        expect(manager.promptSessionIds).toEqual(['replacement-session'])
        expect(events).toEqual(expect.arrayContaining([
            expect.objectContaining({
                kind: 'session_init',
                sessionId: 'replacement-session',
                isNewSession: true,
            }),
            expect.objectContaining({ kind: 'result', status: 'success' }),
        ]))
    })

    it('uses a clean process for replacement when both resume attempts time out', async () => {
        const manager = new RecoveryClientManager()
        manager.resumeBehavior = () => manager.hangUntilClose()
        manager.newSessionBehavior = async () => ({ sessionId: 'replacement-session' })
        const provider = providerWith(manager)

        await collectEvents(provider)

        expect(manager.closeCalls).toBe(2)
        expect(manager.initCalls).toBe(2)
        expect(manager.resumeSessionCalls).toBe(2)
        expect(manager.newSessionCalls).toBe(1)
        expect(manager.promptCalls).toBe(1)
        expect(manager.promptSessionIds).toEqual(['replacement-session'])
    })

    it('restarts and retries when initial session creation times out', async () => {
        const manager = new RecoveryClientManager()
        manager.supportsResumeSession = false
        manager.newSessionBehavior = call => call === 1
            ? manager.hangUntilClose()
            : Promise.resolve({ sessionId: 'created-after-restart' })
        const provider = providerWith(manager)

        const events = await collectEvents(provider, null)

        expect(manager.closeCalls).toBe(1)
        expect(manager.initCalls).toBe(1)
        expect(manager.newSessionCalls).toBe(2)
        expect(manager.promptCalls).toBe(1)
        expect(manager.promptSessionIds).toEqual(['created-after-restart'])
        expect(events).toEqual(expect.arrayContaining([
            expect.objectContaining({
                kind: 'session_init',
                sessionId: 'created-after-restart',
                isNewSession: false,
            }),
            expect.objectContaining({ kind: 'result', status: 'success' }),
        ]))
    })

    it('cancels session recovery without creating a replacement or sending a prompt', async () => {
        const manager = new RecoveryClientManager()
        manager.resumeBehavior = () => manager.hangUntilClose()
        const provider = providerWith(manager, 1_000)
        const handle = provider.startQuery('continue', {
            cwd: '/repo',
            sessionId: 'existing-session',
            signal: new AbortController().signal,
        })

        await new Promise(resolve => setTimeout(resolve, 0))
        expect(manager.resumeSessionCalls).toBe(1)
        await handle.interrupt()
        await new Promise(resolve => setTimeout(resolve, 0))

        expect(manager.closeCalls).toBe(1)
        expect(manager.newSessionCalls).toBe(0)
        expect(manager.promptCalls).toBe(0)
        await expect(handle.events[Symbol.asyncIterator]().next()).resolves.toEqual({
            done: true,
            value: undefined,
        })
    })

    it('cancels a hanging session/new before a provider session ID exists', async () => {
        const manager = new RecoveryClientManager()
        manager.supportsResumeSession = false
        manager.newSessionBehavior = () => manager.hangUntilClose()
        const provider = providerWith(manager, 1_000)
        const handle = provider.startQuery('start', {
            cwd: '/repo',
            signal: new AbortController().signal,
        })

        await new Promise(resolve => setTimeout(resolve, 0))
        expect(manager.newSessionCalls).toBe(1)
        await handle.interrupt()
        await new Promise(resolve => setTimeout(resolve, 0))

        expect(manager.closeCalls).toBe(1)
        expect(manager.newSessionCalls).toBe(1)
        expect(manager.promptCalls).toBe(0)
        await expect(handle.events[Symbol.asyncIterator]().next()).resolves.toEqual({
            done: true,
            value: undefined,
        })
    })
})
