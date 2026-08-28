/**
 * CodexProvider — ACP-based OpenAI Codex integration.
 *
 * Codex CLI does not expose a native ACP subcommand, so Malink launches
 * The Agent Client Protocol codex-acp adapter as a stdio ACP agent.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import { AcpProvider } from '@/providers/acp'
import type { ModelEntry, ProviderSessionHistory } from '@/providers/provider'
import {
    CodexHistoryUnavailableError,
    readCodexSessionHistory,
    type CodexSessionHistoryReader,
} from './history'

const CODEX_ACP_PACKAGE = '@agentclientprotocol/codex-acp'
const CODEX_CLI_SUBCOMMAND = 'cli'
const CODEX_MODELS_ARGS = ['debug', 'models']
const CODEX_MODEL_PROVIDER = 'openai'
const CODEX_MODELS_TIMEOUT_MS = 10_000
const CODEX_MODELS_MAX_OUTPUT_BYTES = 4 * 1024 * 1024
const CODEX_MODELS_REFRESH_MS = 5 * 60_000
const CODEX_MODELS_RETRY_MS = 30_000

interface CommandLaunch {
    command: string
    args: string[]
}

export interface CodexProviderOptions {
    name?: string
    command?: string
    args?: string[]
    env?: Record<string, string>
    cwd?: string
    modelsCommand?: string
    modelsArgs?: string[]
    modelsReader?: CodexModelsReader
    historyReader?: CodexSessionHistoryReader
}

export interface CodexModelsReaderInput {
    command: string
    args: string[]
    env?: Record<string, string>
    cwd?: string
}

export type CodexModelsReader = (input: CodexModelsReaderInput) => Promise<string>

interface CodexModelCatalog {
    models?: Array<{
        slug?: unknown
        display_name?: unknown
        name?: unknown
        visibility?: unknown
        default_reasoning_level?: unknown
        supported_reasoning_levels?: unknown
    }>
}

interface CachedCodexModelCatalog {
    models: ModelEntry[]
    nextRefreshAt: number
    refreshPromise?: Promise<ModelEntry[]>
}

const modelCatalogCache = new Map<string, CachedCodexModelCatalog>()

export class CodexProvider extends AcpProvider {
    private readonly modelsCommand: string
    private readonly modelsArgs: string[]
    private readonly env?: Record<string, string>
    private readonly cwd?: string
    private readonly modelsReader: CodexModelsReader
    private readonly modelCatalogKey: string
    private readonly historyCommand: string
    private readonly historyArgs: string[]
    private readonly historyReader: CodexSessionHistoryReader

    constructor(options: CodexProviderOptions = {}) {
        const defaultLaunch = resolveDefaultCodexAcpLaunch()
        const defaultCodexCli = resolveDefaultCodexCliLaunch(options.env)
        super({
            name: options.name ?? 'codex',
            command: options.command ?? defaultLaunch.command,
            args: options.args ?? (options.command ? [] : defaultLaunch.args),
            ...(options.env ? { env: options.env } : {}),
            ...(options.cwd ? { cwd: options.cwd } : {}),
        })
        const usesDefaultCodexCli = options.modelsCommand === undefined
        this.modelsCommand = options.modelsCommand ?? defaultCodexCli.command
        this.modelsArgs = [
            ...(usesDefaultCodexCli ? defaultCodexCli.args : []),
            ...(options.modelsArgs ?? CODEX_MODELS_ARGS),
        ]
        this.env = options.env
        this.cwd = options.cwd
        this.modelsReader = options.modelsReader ?? readCodexModels
        this.modelCatalogKey = codexModelCatalogKey({
            command: this.modelsCommand,
            args: this.modelsArgs,
            ...(this.env ? { env: this.env } : {}),
            ...(this.cwd ? { cwd: this.cwd } : {}),
        })
        const customHistoryCommand = options.env?.CODEX_PATH?.trim() || options.modelsCommand
        this.historyCommand = customHistoryCommand || defaultCodexCli.command
        this.historyArgs = customHistoryCommand ? [] : defaultCodexCli.args
        this.historyReader = options.historyReader ?? readCodexSessionHistory
    }

    async getSessionHistory(sessionId: string, cwd: string): Promise<ProviderSessionHistory> {
        try {
            return await this.historyReader({
                sessionId,
                cwd,
                command: this.historyCommand,
                commandArgs: this.historyArgs,
                ...(this.env ? { env: this.env } : {}),
                ...(this.cwd ? { processCwd: this.cwd } : {}),
            })
        } catch (error) {
            if (!(error instanceof CodexHistoryUnavailableError)) throw error
            return super.getSessionHistory(sessionId, cwd)
        }
    }

    getAvailableModels(): ModelEntry[] {
        const cached = this.cachedModelCatalog()
        if (!cached.refreshPromise && Date.now() >= cached.nextRefreshAt) {
            // Capability snapshots are synchronous and run on the Gateway main
            // event loop. Refresh in the background so a slow Codex process can
            // never starve Matrix sync, admin requests, or ACP stdio handling.
            void this.refreshAvailableModels()
        }
        return cached.models.map(model => ({ ...model }))
    }

    async refreshAvailableModels(): Promise<ModelEntry[]> {
        const cached = this.cachedModelCatalog()
        if (cached.refreshPromise) return cached.refreshPromise

        cached.nextRefreshAt = Date.now() + CODEX_MODELS_RETRY_MS
        const refresh = this.modelsReader({
            command: this.modelsCommand,
            args: [...this.modelsArgs],
            ...(this.env ? { env: this.env } : {}),
            ...(this.cwd ? { cwd: this.cwd } : {}),
        }).then(stdout => {
            const models = parseCodexModels(stdout)
            cached.models = models
            cached.nextRefreshAt = Date.now() + CODEX_MODELS_REFRESH_MS
            return models.map(model => ({ ...model }))
        }).catch(error => {
            const message = error instanceof Error ? error.message : String(error)
            console.error(`[codex] Failed to list models: ${message}`)
            return cached.models.map(model => ({ ...model }))
        }).finally(() => {
            delete cached.refreshPromise
        })
        cached.refreshPromise = refresh
        return refresh
    }

    private cachedModelCatalog(): CachedCodexModelCatalog {
        let cached = modelCatalogCache.get(this.modelCatalogKey)
        if (!cached) {
            cached = { models: [], nextRefreshAt: 0 }
            modelCatalogCache.set(this.modelCatalogKey, cached)
        }
        return cached
    }
}

export function resolveDefaultCodexAcpLaunch(): CommandLaunch {
    return {
        command: process.execPath,
        args: [resolveCodexAcpEntrypoint()],
    }
}

function resolveDefaultCodexCliLaunch(env?: Record<string, string>): CommandLaunch {
    const configuredCodex = env?.CODEX_PATH?.trim()
    if (configuredCodex) return { command: configuredCodex, args: [] }
    const acp = resolveDefaultCodexAcpLaunch()
    return {
        command: acp.command,
        args: [...acp.args, CODEX_CLI_SUBCOMMAND],
    }
}

function resolveCodexAcpEntrypoint(): string {
    return createRequire(import.meta.url).resolve(CODEX_ACP_PACKAGE)
}

function mergeProcessEnv(env?: Record<string, string>): NodeJS.ProcessEnv {
    return env ? { ...process.env, ...env } : process.env
}

export function readCodexModels(input: CodexModelsReaderInput): Promise<string> {
    return new Promise((resolve, reject) => {
        const isWindows = process.platform === 'win32'
        const child = spawn(
            isWindows ? `${input.command} ${input.args.join(' ')}` : input.command,
            isWindows ? [] : input.args,
            {
                stdio: ['ignore', 'pipe', 'pipe'],
                windowsHide: true,
                env: mergeProcessEnv(input.env),
                ...(input.cwd ? { cwd: input.cwd } : {}),
                detached: !isWindows,
                shell: isWindows,
            },
        )
        const stdout: Buffer[] = []
        const stderr: Buffer[] = []
        let outputBytes = 0
        let settled = false
        const finish = (error?: Error) => {
            if (settled) return
            settled = true
            clearTimeout(timeout)
            if (error) reject(error)
            else resolve(Buffer.concat(stdout).toString('utf-8'))
        }
        const rejectForOutputLimit = () => {
            terminateModelProcess(child)
            finish(new Error(
                `Codex model catalog exceeded ${CODEX_MODELS_MAX_OUTPUT_BYTES} bytes`,
            ))
        }

        child.stdout?.on('data', (chunk: Buffer) => {
            outputBytes += chunk.length
            if (outputBytes > CODEX_MODELS_MAX_OUTPUT_BYTES) {
                rejectForOutputLimit()
                return
            }
            stdout.push(chunk)
        })
        child.stderr?.on('data', (chunk: Buffer) => {
            if (Buffer.concat(stderr).length < 32 * 1024) stderr.push(chunk)
        })
        child.once('error', error => finish(error))
        child.once('close', code => {
            if (code === 0) {
                finish()
                return
            }
            const detail = Buffer.concat(stderr).toString('utf-8').trim()
            finish(new Error(
                `${input.command} ${input.args.join(' ')} exited with code ${code}`
                + (detail ? `: ${detail.slice(0, 1_000)}` : ''),
            ))
        })
        const timeout = setTimeout(() => {
            terminateModelProcess(child)
            finish(new Error(`Codex model catalog timed out after ${CODEX_MODELS_TIMEOUT_MS}ms`))
        }, CODEX_MODELS_TIMEOUT_MS)
        timeout.unref()
    })
}

function terminateModelProcess(child: ChildProcess): void {
    if (child.exitCode !== null || child.signalCode !== null) return
    if (process.platform !== 'win32' && child.pid) {
        try {
            process.kill(-child.pid, 'SIGKILL')
            return
        } catch {
            // Fall back to the direct child when the process group is gone.
        }
    }
    child.kill('SIGKILL')
}

function codexModelCatalogKey(input: CodexModelsReaderInput): string {
    return JSON.stringify({
        command: input.command,
        args: input.args,
        cwd: input.cwd ?? '',
        env: Object.entries(input.env ?? {}).sort(([left], [right]) => left.localeCompare(right)),
    })
}

export function clearCodexModelCatalogCacheForTesting(): void {
    modelCatalogCache.clear()
}

export function parseCodexModels(stdout: string): ModelEntry[] {
    const catalog = JSON.parse(stdout) as CodexModelCatalog
    const models = Array.isArray(catalog.models) ? catalog.models : []
    const entries: ModelEntry[] = []

    for (const model of models) {
        if (model.visibility !== undefined && model.visibility !== 'list') continue
        const id = typeof model.slug === 'string' ? model.slug.trim() : ''
        if (!id) continue
        const name = typeof model.display_name === 'string'
            ? model.display_name.trim()
            : typeof model.name === 'string'
                ? model.name.trim()
                : id
        entries.push({
            id,
            name: name || id,
            provider: CODEX_MODEL_PROVIDER,
            ...parseReasoningMetadata(model),
        })
    }

    return entries
}

function parseReasoningMetadata(model: { default_reasoning_level?: unknown; supported_reasoning_levels?: unknown }): Pick<ModelEntry, 'defaultReasoningLevel' | 'supportedReasoningLevels'> {
    const defaultReasoningLevel = typeof model.default_reasoning_level === 'string'
        ? model.default_reasoning_level.trim()
        : ''
    const supported = Array.isArray(model.supported_reasoning_levels)
        ? model.supported_reasoning_levels
            .map((entry) => {
                if (!entry || typeof entry !== 'object') return null
                const record = entry as Record<string, unknown>
                const effort = typeof record.effort === 'string' ? record.effort.trim() : ''
                if (!effort) return null
                const description = typeof record.description === 'string' && record.description.trim()
                    ? record.description.trim()
                    : undefined
                return { effort, ...(description ? { description } : {}) }
            })
            .filter((entry): entry is { effort: string; description?: string } => entry !== null)
        : []

    return {
        ...(defaultReasoningLevel ? { defaultReasoningLevel } : {}),
        ...(supported.length > 0 ? { supportedReasoningLevels: supported } : {}),
    }
}
