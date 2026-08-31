import { createRequire } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { clearCodexModelCatalogCacheForTesting, parseCodexModels } from '../index'
import { CodexHistoryUnavailableError } from '../history'

const { acpProviderConfigs, fallbackHistoryCalls } = vi.hoisted(() => ({
    acpProviderConfigs: [] as Array<{ name: string; command: string; args: string[] }>,
    fallbackHistoryCalls: [] as Array<{ sessionId: string; cwd: string }>,
}))

vi.mock('@/providers/acp', () => ({
    AcpProvider: class {
        readonly name: string

        constructor(config: { name: string; command: string; args: string[] }) {
            this.name = config.name
            acpProviderConfigs.push(config)
        }

        async getSessionHistory(sessionId: string, cwd: string) {
            fallbackHistoryCalls.push({ sessionId, cwd })
            return {
                sessionId,
                title: 'ACP fallback',
                messages: [],
            }
        }
    },
}))

describe('CodexProvider', () => {
    afterEach(() => {
        acpProviderConfigs.splice(0, acpProviderConfigs.length)
        fallbackHistoryCalls.splice(0, fallbackHistoryCalls.length)
        clearCodexModelCatalogCacheForTesting()
    })

    it('launches the release-pinned codex-acp with the Gateway Node runtime', async () => {
        const { CodexProvider } = await import('../index')
        const codexAcpEntrypoint = createRequire(import.meta.url).resolve(
            '@agentclientprotocol/codex-acp',
        )

        const provider = new CodexProvider({ env: { PATH: '' } })

        expect(provider.name).toBe('codex')
        expect(acpProviderConfigs).toEqual([
            {
                name: 'codex',
                command: process.execPath,
                args: [codexAcpEntrypoint],
                env: { PATH: '' },
            },
        ])
    })

    it('ships the supported Codex ACP and Codex CLI version pair', () => {
        const testRequire = createRequire(import.meta.url)
        const codexAcp = testRequire('@agentclientprotocol/codex-acp/package.json') as {
            version: string
        }
        const codex = testRequire('@openai/codex/package.json') as { version: string }

        expect(codexAcp.version).toBe('1.7.0')
        expect(codex.version).toBe('0.148.0')
    })

    it('ignores an ambient codex-acp on PATH', async () => {
        const { CodexProvider } = await import('../index')
        const codexAcpEntrypoint = createRequire(import.meta.url).resolve(
            '@agentclientprotocol/codex-acp',
        )

        new CodexProvider({ env: { PATH: '/ambient/bin' } })

        expect(acpProviderConfigs).toEqual([
            {
                name: 'codex',
                command: process.execPath,
                args: [codexAcpEntrypoint],
                env: { PATH: '/ambient/bin' },
            },
        ])
    })

    it('supports overriding the ACP command without inheriting npx arguments', async () => {
        const { CodexProvider } = await import('../index')

        new CodexProvider({ command: '/opt/malink/bin/custom-codex-acp' })

        expect(acpProviderConfigs).toEqual([
            {
                name: 'codex',
                command: '/opt/malink/bin/custom-codex-acp',
                args: [],
            },
        ])
    })

    it('lists subscription models from codex debug models', async () => {
        const { CodexProvider } = await import('../index')
        const modelsReader = vi.fn().mockResolvedValue(JSON.stringify({
                models: [
                    {
                        slug: 'gpt-5.5',
                        display_name: 'GPT-5.5',
                        visibility: 'list',
                        default_reasoning_level: 'medium',
                        supported_reasoning_levels: [
                            { effort: 'low', description: 'Fast' },
                            { effort: 'medium', description: 'Balanced' },
                        ],
                    },
                    { slug: 'gpt-hidden', display_name: 'Hidden', visibility: 'hidden' },
                ],
        }))
        const provider = new CodexProvider({ modelsReader })
        const refreshed = vi.fn()
        const unsubscribe = provider.onAvailableModelsRefreshed(refreshed)

        // Snapshot reads never synchronously wait for the external Codex CLI.
        expect(provider.getAvailableModels()).toEqual([])
        await provider.refreshAvailableModels()
        expect(refreshed).toHaveBeenCalledTimes(1)
        unsubscribe()
        expect(provider.getAvailableModels()).toEqual([
            {
                id: 'gpt-5.5',
                name: 'GPT-5.5',
                provider: 'openai',
                defaultReasoningLevel: 'medium',
                supportedReasoningLevels: [
                    { effort: 'low', description: 'Fast' },
                    { effort: 'medium', description: 'Balanced' },
                ],
            },
        ])
        expect(modelsReader).toHaveBeenCalledWith(expect.objectContaining({
            command: process.execPath,
            args: expect.arrayContaining(['cli', 'debug', 'models']),
        }))
        expect(modelsReader).toHaveBeenCalledTimes(1)
    })

    it('reads provider history through the Codex read-only history path', async () => {
        const { CodexProvider } = await import('../index')
        const historyReader = vi.fn().mockResolvedValue({
            sessionId: 'thread-1',
            title: 'Thread title',
            messages: [{ id: 'user-1', role: 'user', text: 'Hello' }],
        })
        const provider = new CodexProvider({
            env: { PATH: '', CODEX_PATH: '/opt/codex/bin/codex' },
            cwd: '/gateway',
            historyReader,
        })

        await expect(provider.getSessionHistory('thread-1', '/project')).resolves.toEqual({
            sessionId: 'thread-1',
            title: 'Thread title',
            messages: [{ id: 'user-1', role: 'user', text: 'Hello' }],
        })
        expect(historyReader).toHaveBeenCalledWith({
            sessionId: 'thread-1',
            cwd: '/project',
            command: '/opt/codex/bin/codex',
            commandArgs: [],
            env: { PATH: '', CODEX_PATH: '/opt/codex/bin/codex' },
            processCwd: '/gateway',
        })
        expect(fallbackHistoryCalls).toEqual([])
    })

    it('reads provider history through the release-pinned Codex CLI', async () => {
        const { CodexProvider } = await import('../index')
        const codexAcpEntrypoint = createRequire(import.meta.url).resolve(
            '@agentclientprotocol/codex-acp',
        )
        const historyReader = vi.fn().mockResolvedValue({
            sessionId: 'thread-bundled',
            title: 'Pinned thread',
            messages: [],
        })
        const provider = new CodexProvider({ env: { PATH: '/ambient/bin' }, historyReader })

        await provider.getSessionHistory('thread-bundled', '/project')

        expect(historyReader).toHaveBeenCalledWith({
            sessionId: 'thread-bundled',
            cwd: '/project',
            command: process.execPath,
            commandArgs: [codexAcpEntrypoint, 'cli'],
            env: { PATH: '/ambient/bin' },
        })
    })

    it('falls back to ACP session loading when Codex thread/read is unavailable', async () => {
        const { CodexProvider } = await import('../index')
        const provider = new CodexProvider({
            historyReader: vi.fn().mockRejectedValue(
                new CodexHistoryUnavailableError('thread/read is unavailable'),
            ),
        })

        await expect(provider.getSessionHistory('thread-2', '/project')).resolves.toEqual({
            sessionId: 'thread-2',
            title: 'ACP fallback',
            messages: [],
        })
        expect(fallbackHistoryCalls).toEqual([{ sessionId: 'thread-2', cwd: '/project' }])
    })
})

describe('parseCodexModels', () => {
    it('parses visible Codex model catalog entries', () => {
        expect(parseCodexModels(JSON.stringify({
            models: [
                { slug: 'gpt-5.5', display_name: 'GPT-5.5', visibility: 'list' },
                {
                    slug: 'gpt-5.3-codex',
                    name: 'GPT-5.3 Codex',
                    default_reasoning_level: 'high',
                    supported_reasoning_levels: [
                        { effort: 'medium' },
                        { effort: 'high', description: 'Deep' },
                    ],
                },
                { slug: 'internal', display_name: 'Internal', visibility: 'hidden' },
            ],
        }))).toEqual([
            { id: 'gpt-5.5', name: 'GPT-5.5', provider: 'openai' },
            {
                id: 'gpt-5.3-codex',
                name: 'GPT-5.3 Codex',
                provider: 'openai',
                defaultReasoningLevel: 'high',
                supportedReasoningLevels: [
                    { effort: 'medium' },
                    { effort: 'high', description: 'Deep' },
                ],
            },
        ])
    })
})
