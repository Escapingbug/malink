import { describe, expect, it } from 'vitest'
import { AcpProvider } from '@/providers/acp'
import { AgentProvider } from '@/providers/agent'
import type { AgentEvent } from '@/providers/types'

type SessionResponse = {
    sessionId?: string
    configOptions?: []
    models?: {
        currentModelId: string
        availableModels: Array<{ modelId: string; name: string }>
    }
}

type SessionRequest = {
    mcpServers?: unknown[]
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
    setSessionModelCalls: Array<{ sessionId: string; modelId: string }> = []
    permissionHandlerCalls = 0
    extensionHandlerCalls = 0
    promptSessionIds: string[] = []
    resumeMcpServerCounts: number[] = []
    newSessionMcpServerCounts: number[] = []

    resumeBehavior: (call: number, request: SessionRequest) => Promise<SessionResponse> = async () => ({})
    loadBehavior: (call: number) => Promise<SessionResponse> = async () => ({})
    newSessionBehavior: (call: number, request: SessionRequest) => Promise<SessionResponse> = async () => ({ sessionId: 'new-session' })

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

    async newSession(request: SessionRequest): Promise<SessionResponse> {
        this.newSessionCalls += 1
        this.newSessionMcpServerCounts.push(request.mcpServers?.length ?? 0)
        return this.newSessionBehavior(this.newSessionCalls, request)
    }

    async resumeSession(request: SessionRequest): Promise<SessionResponse> {
        this.resumeSessionCalls += 1
        this.resumeMcpServerCounts.push(request.mcpServers?.length ?? 0)
        return this.resumeBehavior(this.resumeSessionCalls, request)
    }

    async loadSession(): Promise<SessionResponse> {
        this.loadSessionCalls += 1
        return this.loadBehavior(this.loadSessionCalls)
    }

    async setSessionModel(params: { sessionId: string; modelId: string }): Promise<Record<string, never>> {
        this.setSessionModelCalls.push(params)
        return {}
    }
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

function providerWithManagers(managers: RecoveryClientManager[], timeoutMs = 10): AcpProvider {
    if (managers.length === 0) throw new Error('At least one fake manager is required')
    const provider = new AcpProvider({
        name: 'recovery-test-acp',
        command: 'fake',
        args: [],
        sessionOpenTimeoutMs: timeoutMs,
    })
    let nextManager = 1
    ;(provider as any).clientManager = managers[0]
    ;(provider as any).createClientManager = () => {
        const manager = managers[nextManager]
        nextManager += 1
        if (!manager) throw new Error(`Unexpected ACP manager replacement #${nextManager}`)
        return manager
    }
    ;(provider as any).initialized = true
    return provider
}

function providerWith(manager: RecoveryClientManager, timeoutMs = 10): AcpProvider {
    return providerWithManagers([manager], timeoutMs)
}

function cursorProviderWith(manager: RecoveryClientManager): AgentProvider {
    const provider = new AgentProvider({
        command: 'fake',
        args: [],
        modelsReader: async () => '',
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
    it('maps a Cursor CLI model alias to the ACP session model before the first prompt', async () => {
        const manager = new RecoveryClientManager()
        manager.supportsResumeSession = false
        manager.agentCapabilities = { agentCapabilities: { loadSession: true } }
        manager.loadBehavior = async () => {
            throw Object.assign(new Error('Invalid params'), { code: -32602 })
        }
        manager.newSessionBehavior = async () => ({
            sessionId: 'cursor-session',
            models: {
                currentModelId: 'auto-smart[optimize_for=balanced]',
                availableModels: [
                    { modelId: 'auto-smart[optimize_for=balanced]', name: 'Auto Balance' },
                    { modelId: 'composer-2.5[fast=true]', name: 'composer-2.5' },
                ],
            },
        })
        const provider = cursorProviderWith(manager)
        const handle = provider.startQuery('hello', {
            cwd: '/repo',
            model: 'composer-2.5',
            signal: new AbortController().signal,
        })
        const events: AgentEvent[] = []
        for await (const event of handle.events) events.push(event)

        expect(manager.loadSessionCalls).toBe(1)
        expect(manager.setSessionModelCalls).toEqual([{
            sessionId: 'cursor-session',
            modelId: 'composer-2.5[fast=true]',
        }])
        expect(manager.promptSessionIds).toEqual(['cursor-session'])
        expect(events).toEqual(expect.arrayContaining([
            expect.objectContaining({
                kind: 'session_init',
                sessionId: 'cursor-session',
                controls: expect.arrayContaining([
                    expect.objectContaining({
                        id: 'model',
                        value: 'composer-2.5[fast=true]',
                    }),
                ]),
            }),
            expect.objectContaining({ kind: 'result', status: 'success' }),
        ]))
    })

    it('keeps a fresh Cursor session usable when a stale model cannot be mapped safely', async () => {
        const manager = new RecoveryClientManager()
        manager.supportsResumeSession = false
        manager.agentCapabilities = { agentCapabilities: { loadSession: false } }
        manager.newSessionBehavior = async () => ({
            sessionId: 'cursor-session',
            models: {
                currentModelId: 'auto-smart[optimize_for=balanced]',
                availableModels: [
                    { modelId: 'auto-smart[optimize_for=balanced]', name: 'Auto Balance' },
                    { modelId: 'composer-2.5[fast=true]', name: 'composer-2.5' },
                ],
            },
        })
        const provider = cursorProviderWith(manager)
        const handle = provider.startQuery('hello', {
            cwd: '/repo',
            model: 'removed-model',
            signal: new AbortController().signal,
        })
        const events: AgentEvent[] = []
        for await (const event of handle.events) events.push(event)

        expect(manager.setSessionModelCalls).toEqual([])
        expect(manager.promptSessionIds).toEqual(['cursor-session'])
        expect(events).toEqual(expect.arrayContaining([
            expect.objectContaining({
                kind: 'session_init',
                controls: expect.arrayContaining([
                    expect.objectContaining({
                        id: 'model',
                        value: 'auto-smart[optimize_for=balanced]',
                    }),
                ]),
            }),
            expect.objectContaining({ kind: 'result', status: 'success' }),
        ]))
    })

    it('restarts a wedged ACP process and resumes the same provider session before prompting', async () => {
        const wedgedManager = new RecoveryClientManager()
        const recoveredManager = new RecoveryClientManager()
        wedgedManager.resumeBehavior = () => wedgedManager.hangUntilClose()
        const provider = providerWithManagers([wedgedManager, recoveredManager])

        const events = await collectEvents(provider)

        expect(wedgedManager.closeCalls).toBe(1)
        expect(wedgedManager.resumeSessionCalls).toBe(1)
        expect(recoveredManager.initCalls).toBe(1)
        expect(recoveredManager.resumeSessionCalls).toBe(1)
        expect(recoveredManager.newSessionCalls).toBe(0)
        expect(recoveredManager.promptCalls).toBe(1)
        expect(recoveredManager.promptSessionIds).toEqual(['existing-session'])
        expect(wedgedManager.permissionHandlerCalls).toBe(1)
        expect(recoveredManager.permissionHandlerCalls).toBe(1)
        expect(recoveredManager.extensionHandlerCalls).toBe(1)
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
        const wedgedManager = new RecoveryClientManager()
        const recoveredManager = new RecoveryClientManager()
        wedgedManager.resumeBehavior = () => wedgedManager.hangUntilClose()
        recoveredManager.agentCapabilities = { agentCapabilities: { loadSession: true } }
        recoveredManager.resumeBehavior = () => Promise.reject(new Error('session not found'))
        recoveredManager.loadBehavior = async () => {
            throw new Error('session not found')
        }
        recoveredManager.newSessionBehavior = async () => ({ sessionId: 'replacement-session' })
        const provider = providerWithManagers([wedgedManager, recoveredManager])

        const events = await collectEvents(provider)

        expect(wedgedManager.closeCalls).toBe(1)
        expect(wedgedManager.resumeSessionCalls).toBe(1)
        expect(recoveredManager.initCalls).toBe(1)
        expect(recoveredManager.resumeSessionCalls).toBe(1)
        expect(recoveredManager.loadSessionCalls).toBe(1)
        expect(recoveredManager.newSessionCalls).toBe(1)
        expect(recoveredManager.promptCalls).toBe(1)
        expect(recoveredManager.promptSessionIds).toEqual(['replacement-session'])
        expect(events).toEqual(expect.arrayContaining([
            expect.objectContaining({
                kind: 'session_init',
                sessionId: 'replacement-session',
                isNewSession: true,
            }),
            expect.objectContaining({ kind: 'result', status: 'success' }),
        ]))
    })

    it('preserves the same session without MCP when both full recovery attempts time out', async () => {
        const firstManager = new RecoveryClientManager()
        const secondManager = new RecoveryClientManager()
        const degradedManager = new RecoveryClientManager()
        firstManager.resumeBehavior = () => firstManager.hangUntilClose()
        secondManager.resumeBehavior = () => secondManager.hangUntilClose()
        const provider = providerWithManagers([firstManager, secondManager, degradedManager])

        const events = await collectEvents(provider)

        expect(firstManager.closeCalls).toBe(1)
        expect(secondManager.closeCalls).toBe(1)
        expect(firstManager.resumeMcpServerCounts).toEqual([1])
        expect(secondManager.resumeMcpServerCounts).toEqual([1])
        expect(degradedManager.resumeMcpServerCounts).toEqual([0])
        expect(degradedManager.newSessionCalls).toBe(0)
        expect(degradedManager.promptSessionIds).toEqual(['existing-session'])
        expect(events).toEqual(expect.arrayContaining([
            expect.objectContaining({
                kind: 'text',
                text: expect.stringContaining('recovered without Malink tools'),
            }),
            expect.objectContaining({ kind: 'result', status: 'success' }),
        ]))
    })

    it('uses a clean process for replacement when full and degraded recovery time out', async () => {
        const firstManager = new RecoveryClientManager()
        const secondManager = new RecoveryClientManager()
        const degradedManager = new RecoveryClientManager()
        const replacementManager = new RecoveryClientManager()
        firstManager.resumeBehavior = () => firstManager.hangUntilClose()
        secondManager.resumeBehavior = () => secondManager.hangUntilClose()
        degradedManager.resumeBehavior = () => degradedManager.hangUntilClose()
        replacementManager.newSessionBehavior = async () => ({ sessionId: 'replacement-session' })
        const provider = providerWithManagers([
            firstManager,
            secondManager,
            degradedManager,
            replacementManager,
        ])

        await collectEvents(provider)

        expect(firstManager.closeCalls).toBe(1)
        expect(secondManager.closeCalls).toBe(1)
        expect(degradedManager.closeCalls).toBe(1)
        expect(replacementManager.initCalls).toBe(1)
        expect(replacementManager.newSessionMcpServerCounts).toEqual([1])
        expect(replacementManager.promptSessionIds).toEqual(['replacement-session'])
    })

    it('restarts and retries when initial session creation times out', async () => {
        const wedgedManager = new RecoveryClientManager()
        const recoveredManager = new RecoveryClientManager()
        wedgedManager.supportsResumeSession = false
        recoveredManager.supportsResumeSession = false
        wedgedManager.newSessionBehavior = () => wedgedManager.hangUntilClose()
        recoveredManager.newSessionBehavior = () => Promise.resolve({ sessionId: 'created-after-restart' })
        const provider = providerWithManagers([wedgedManager, recoveredManager])

        const events = await collectEvents(provider, null)

        expect(wedgedManager.closeCalls).toBe(1)
        expect(wedgedManager.newSessionCalls).toBe(1)
        expect(recoveredManager.initCalls).toBe(1)
        expect(recoveredManager.newSessionCalls).toBe(1)
        expect(recoveredManager.promptCalls).toBe(1)
        expect(recoveredManager.promptSessionIds).toEqual(['created-after-restart'])
        expect(events).toEqual(expect.arrayContaining([
            expect.objectContaining({
                kind: 'session_init',
                sessionId: 'created-after-restart',
                isNewSession: false,
            }),
            expect.objectContaining({ kind: 'result', status: 'success' }),
        ]))
    })

    it('continues a newly created session without MCP after both full creation attempts time out', async () => {
        const firstManager = new RecoveryClientManager()
        const secondManager = new RecoveryClientManager()
        const degradedManager = new RecoveryClientManager()
        firstManager.supportsResumeSession = false
        secondManager.supportsResumeSession = false
        degradedManager.supportsResumeSession = false
        firstManager.newSessionBehavior = () => firstManager.hangUntilClose()
        secondManager.newSessionBehavior = () => secondManager.hangUntilClose()
        degradedManager.newSessionBehavior = () => Promise.resolve({ sessionId: 'degraded-session' })
        const provider = providerWithManagers([firstManager, secondManager, degradedManager])

        const events = await collectEvents(provider, null)

        expect(firstManager.newSessionMcpServerCounts).toEqual([1])
        expect(secondManager.newSessionMcpServerCounts).toEqual([1])
        expect(degradedManager.newSessionMcpServerCounts).toEqual([0])
        expect(degradedManager.resumeSessionCalls).toBe(0)
        expect(degradedManager.promptSessionIds).toEqual(['degraded-session'])
        expect(events).toEqual(expect.arrayContaining([
            expect.objectContaining({
                kind: 'text',
                text: expect.stringContaining('recovered without Malink tools'),
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
