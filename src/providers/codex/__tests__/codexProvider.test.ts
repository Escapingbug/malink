import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseCodexModels } from '../index'

const { acpProviderConfigs } = vi.hoisted(() => ({
    acpProviderConfigs: [] as Array<{ name: string; command: string; args: string[] }>,
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
    },
}))

describe('CodexProvider', () => {
    const temporaryDirectories: string[] = []

    afterEach(() => {
        for (const directory of temporaryDirectories.splice(0)) {
            rmSync(directory, { recursive: true, force: true })
        }
        acpProviderConfigs.splice(0, acpProviderConfigs.length)
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
