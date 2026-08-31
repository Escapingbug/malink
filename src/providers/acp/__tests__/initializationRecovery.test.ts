import { describe, expect, it } from 'vitest'
import { AcpProvider } from '@/providers/acp'
import { AcpInitializeTimeoutError } from '@/providers/acp/AcpClientManager'

class InitializationClientManager {
    connected = false
    initCalls = 0
    closeCalls = 0
    disposeCalls = 0

    constructor(
        private readonly initialize: () => Promise<void>,
    ) {}

    async init(): Promise<void> {
        this.initCalls += 1
        await this.initialize()
        this.connected = true
    }

    async close(): Promise<void> {
        this.closeCalls += 1
        this.connected = false
    }

    dispose(): void {
        this.disposeCalls += 1
        this.connected = false
    }
}

function providerWithManagers(managers: InitializationClientManager[]): AcpProvider {
    if (managers.length === 0) throw new Error('At least one fake manager is required')
    const provider = new AcpProvider({
        name: 'initialization-test-acp',
        command: 'fake',
        args: [],
    })
    let nextManager = 1
    ;(provider as any).clientManager = managers[0]
    ;(provider as any).createClientManager = () => {
        const manager = managers[nextManager]
        nextManager += 1
        if (!manager) throw new Error(`Unexpected ACP manager replacement #${nextManager}`)
        return manager
    }
    return provider
}

describe('AcpProvider initialization recovery', () => {
    it('retries one timed-out initialize on a clean ACP process', async () => {
        const timedOut = new InitializationClientManager(async () => {
            throw new AcpInitializeTimeoutError(30_000)
        })
        const recovered = new InitializationClientManager(async () => undefined)
        const provider = providerWithManagers([timedOut, recovered])

        await provider.init()

        expect(timedOut.initCalls).toBe(1)
        expect(timedOut.closeCalls).toBe(1)
        expect(recovered.initCalls).toBe(1)
        expect(provider.isReady()).toBe(true)
        expect(provider.getInitError()).toBeNull()
    })

    it('stops after the retry also times out and remains retryable by a later turn', async () => {
        const first = new InitializationClientManager(async () => {
            throw new AcpInitializeTimeoutError(30_000)
        })
        const second = new InitializationClientManager(async () => {
            throw new AcpInitializeTimeoutError(30_000)
        })
        const provider = providerWithManagers([first, second])

        await provider.init()

        expect(first.initCalls).toBe(1)
        expect(first.closeCalls).toBe(1)
        expect(second.initCalls).toBe(1)
        expect(provider.isReady()).toBe(false)
        expect(provider.getInitError()).toBe('ACP initialize timed out after 30000ms')
    })

    it('does not retry a deterministic initialize failure', async () => {
        const failed = new InitializationClientManager(async () => {
            throw new Error('authentication configuration is invalid')
        })
        const unused = new InitializationClientManager(async () => undefined)
        const provider = providerWithManagers([failed, unused])

        await provider.init()

        expect(failed.initCalls).toBe(1)
        expect(failed.closeCalls).toBe(0)
        expect(unused.initCalls).toBe(0)
        expect(provider.isReady()).toBe(false)
        expect(provider.getInitError()).toBe('authentication configuration is invalid')
    })
})
