import { describe, expect, it } from 'vitest'
import { AcpProvider } from '@/providers/acp'

describe('AcpProvider working directory', () => {
    it('binds an uninitialized session provider to its project cwd', () => {
        const provider = new AcpProvider({
            name: 'codex-test',
            command: 'fake',
            args: [],
        })
        const initialManager = (provider as any).clientManager

        provider.prepareWorkingDirectory('/projects/one')

        expect((provider as any).clientManagerConfig.cwd).toBe('/projects/one')
        expect((provider as any).clientManager).not.toBe(initialManager)

        const boundManager = (provider as any).clientManager
        provider.prepareWorkingDirectory('/projects/two')
        expect((provider as any).clientManagerConfig.cwd).toBe('/projects/one')
        expect((provider as any).clientManager).toBe(boundManager)
    })

    it('preserves an explicit provider-profile cwd', () => {
        const provider = new AcpProvider({
            name: 'codex-test',
            command: 'fake',
            args: [],
            cwd: '/provider/runtime',
        })
        const initialManager = (provider as any).clientManager

        provider.prepareWorkingDirectory('/projects/one')

        expect((provider as any).clientManagerConfig.cwd).toBe('/provider/runtime')
        expect((provider as any).clientManager).toBe(initialManager)
    })
})
