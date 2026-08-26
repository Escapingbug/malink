import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseCodexModels } from '../index'
import { CodexHistoryUnavailableError } from '../history'

const { acpProviderConfigs, fallbackHistoryCalls } = vi.hoisted(() => ({
    acpProviderConfigs: [] as Array<{ name: string; command: string; args: string[] }>,
    fallbackHistoryCalls: [] as Array<{ sessionId: string; cwd: string }>,
}))

const { spawnSyncMock } = vi.hoisted(() => ({
    spawnSyncMock: vi.fn(),
}))

vi.mock('node:child_process', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:child_process')>()
    return {
        ...actual,
        spawnSync: spawnSyncMock,
    }
})

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
    const temporaryDirectories: string[] = []

    afterEach(() => {
        for (const directory of temporaryDirectories.splice(0)) {
            rmSync(directory, { recursive: true, force: true })
        }
        acpProviderConfigs.splice(0, acpProviderConfigs.length)
        fallbackHistoryCalls.splice(0, fallbackHistoryCalls.length)
    })

    it('falls back to npx when codex-acp is not installed on PATH', async () => {
        const { CodexProvider } = await import('../index')

        const provider = new CodexProvider({ env: { PATH: '' } })

        expect(provider.name).toBe('codex')
        expect(acpProviderConfigs).toEqual([
            {
                name: 'codex',
                command: 'npx',
                args: ['-y', '@agentclientprotocol/codex-acp'],
                env: { PATH: '' },
            },
        ])
    })

    it('launches an installed codex-acp directly', async () => {
        const { CodexProvider } = await import('../index')
        const directory = mkdtempSync(join(tmpdir(), 'malink-codex-acp-'))
        temporaryDirectories.push(directory)
        const command = join(directory, 'codex-acp')
        writeFileSync(command, '#!/bin/sh\n')
        chmodSync(command, 0o755)

        new CodexProvider({ env: { PATH: directory } })

        expect(acpProviderConfigs).toEqual([
            {
                name: 'codex',
                command: 'codex-acp',
                args: [],
                env: { PATH: directory },
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
        spawnSyncMock.mockReturnValue({
            status: 0,
            error: undefined,
            stdout: JSON.stringify({
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
            }),
            stderr: '',
        })

        expect(new CodexProvider().getAvailableModels()).toEqual([
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
        expect(spawnSyncMock).toHaveBeenCalled()
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
            env: { PATH: '', CODEX_PATH: '/opt/codex/bin/codex' },
            processCwd: '/gateway',
        })
        expect(fallbackHistoryCalls).toEqual([])
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
