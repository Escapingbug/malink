/**
 * AgentProvider — ACP-based Cursor Agent (CLI) integration.
 *
 * Uses the Agent Client Protocol to communicate with `agent acp`
 * via stdio JSON-RPC. The `agent` command is the Cursor CLI agent.
 *
 * ACP's session/cancel only stops the current turn — the session persists
 * for the next session/prompt, fixing the "new session after interrupt" bug.
 */

import { spawn } from 'node:child_process'
import { AcpProvider } from '@/providers/acp'
import type { AgentQueryConfig, AgentQueryInput, ModelEntry } from '@/providers/provider'
import type { AgentEvent } from '@/providers/types'
import type { PushableAsyncIterable } from '@/utils/PushableAsyncIterable'
import type { AcpExtensionHandler } from '@/providers/acp/AcpClientManager'
import { createCursorAcpExtensionHandler } from './cursorExtensions'
import { createCursorPermissionHandler } from './cursorPermissions'

const AGENT_ACP_COMMAND = 'agent'
const AGENT_ACP_ARGS = ['acp']
const AGENT_MODELS_ARGS = ['models']
const AGENT_MODEL_PROVIDER = 'cursor'
const AGENT_MODELS_TIMEOUT_MS = 10_000
const AGENT_MODELS_MAX_OUTPUT_BYTES = 4 * 1024 * 1024
const AGENT_MODELS_REFRESH_MS = 5 * 60_000
const AGENT_MODELS_RETRY_MS = 30_000

export interface AgentModelsReaderInput {
    command: string
    args: string[]
    env?: Record<string, string>
    cwd?: string
}

export type AgentModelsReader = (input: AgentModelsReaderInput) => Promise<string>

export interface AgentProviderOptions {
    name?: string
    command?: string
    args?: string[]
    env?: Record<string, string>
    cwd?: string
    modelsCommand?: string
    modelsArgs?: string[]
    modelsReader?: AgentModelsReader
}

export class AgentProvider extends AcpProvider {
    private readonly modelsCommand: string
    private readonly modelsArgs: string[]
    private readonly env?: Record<string, string>
    private readonly cwd?: string
    private readonly modelsReader: AgentModelsReader
    private modelCatalog: ModelEntry[] = []
    private modelRefreshPromise?: Promise<ModelEntry[]>
    private nextModelRefreshAt = 0
    private readonly modelCatalogListeners = new Set<() => void>()

    constructor(options: AgentProviderOptions = {}) {
        super({
            name: options.name ?? 'agent',
            command: options.command ?? AGENT_ACP_COMMAND,
            args: options.args ?? AGENT_ACP_ARGS,
            ...(options.env ? { env: options.env } : {}),
            ...(options.cwd ? { cwd: options.cwd } : {}),
        })
        this.modelsCommand = options.modelsCommand ?? options.command ?? AGENT_ACP_COMMAND
        this.modelsArgs = options.modelsArgs ?? AGENT_MODELS_ARGS
        this.env = options.env
        this.cwd = options.cwd
        this.modelsReader = options.modelsReader ?? readAgentModels
    }

    override startQuery(prompt: AgentQueryInput, config: AgentQueryConfig) {
        return super.startQuery(prompt, {
            ...config,
            permissionHandler: createCursorPermissionHandler(config.permissionHandler, config.cwd),
        })
    }

    getAvailableModels(): ModelEntry[] {
        if (!this.modelRefreshPromise && Date.now() >= this.nextModelRefreshAt) {
            // Capability snapshots run synchronously on the Gateway event
            // loop. A slow or missing Cursor binary must never delay project
            // creation, Matrix sync, or command completion.
            void this.refreshAvailableModels()
        }
        return this.modelCatalog.map(model => ({ ...model }))
    }

    onAvailableModelsRefreshed(listener: () => void): () => void {
        this.modelCatalogListeners.add(listener)
        return () => { this.modelCatalogListeners.delete(listener) }
    }

    async refreshAvailableModels(): Promise<ModelEntry[]> {
        if (this.modelRefreshPromise) return this.modelRefreshPromise
        this.nextModelRefreshAt = Date.now() + AGENT_MODELS_RETRY_MS
        const refresh = this.modelsReader({
            command: this.modelsCommand,
            args: [...this.modelsArgs],
            ...(this.env ? { env: this.env } : {}),
            ...(this.cwd ? { cwd: this.cwd } : {}),
        }).then(output => {
            this.modelCatalog = parseAgentModels(output)
            this.nextModelRefreshAt = Date.now() + AGENT_MODELS_REFRESH_MS
            this.notifyModelCatalogListeners()
            return this.modelCatalog.map(model => ({ ...model }))
        }).catch(error => {
            const message = error instanceof Error ? error.message : String(error)
            console.error(`[agent] Failed to list models: ${message}`)
            return this.modelCatalog.map(model => ({ ...model }))
        }).finally(() => {
            delete this.modelRefreshPromise
        })
        this.modelRefreshPromise = refresh
        return refresh
    }

    private notifyModelCatalogListeners(): void {
        for (const listener of [...this.modelCatalogListeners]) {
            try {
                listener()
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error)
                console.error(`[agent] Model catalog listener failed: ${message}`)
            }
        }
    }

    protected override createExtensionHandler(events: PushableAsyncIterable<AgentEvent>, config: AgentQueryConfig): AcpExtensionHandler | null {
        return createCursorAcpExtensionHandler(events, config)
    }
}

function mergeProcessEnv(env?: Record<string, string>): NodeJS.ProcessEnv {
    return env ? { ...process.env, ...env } : process.env
}

export function readAgentModels(input: AgentModelsReaderInput): Promise<string> {
    return new Promise((resolve, reject) => {
        const isWindows = process.platform === 'win32'
        const child = spawn(
            isWindows ? [input.command, ...input.args].join(' ') : input.command,
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
        const terminate = () => {
            if (!isWindows && child.pid) {
                try {
                    process.kill(-child.pid, 'SIGTERM')
                    return
                } catch {
                    // The process may already have exited; fall back to the
                    // direct child handle for the remaining platform cases.
                }
            }
            child.kill('SIGTERM')
        }
        let timeout: ReturnType<typeof setTimeout>
        const finish = (error?: Error) => {
            if (settled) return
            settled = true
            clearTimeout(timeout)
            if (error) reject(error)
            else resolve(Buffer.concat(stdout).toString('utf-8'))
        }
        const append = (target: Buffer[], chunk: Buffer) => {
            outputBytes += chunk.length
            if (outputBytes > AGENT_MODELS_MAX_OUTPUT_BYTES) {
                terminate()
                finish(new Error(
                    `Cursor Agent model catalog exceeded ${AGENT_MODELS_MAX_OUTPUT_BYTES} bytes`,
                ))
                return
            }
            target.push(chunk)
        }
        child.stdout.on('data', (chunk: Buffer) => append(stdout, chunk))
        child.stderr.on('data', (chunk: Buffer) => append(stderr, chunk))
        child.once('error', error => finish(error))
        child.once('close', code => {
            if (code === 0) {
                finish()
                return
            }
            const detail = Buffer.concat(stderr).toString('utf-8').trim()
            finish(new Error(
                `${input.command} ${input.args.join(' ')} exited with code ${code}`
                + (detail ? `: ${detail.slice(0, 512)}` : ''),
            ))
        })
        timeout = setTimeout(() => {
            terminate()
            finish(new Error(
                `Cursor Agent model catalog timed out after ${AGENT_MODELS_TIMEOUT_MS}ms`,
            ))
        }, AGENT_MODELS_TIMEOUT_MS)
        timeout.unref()
    })
}

export function parseAgentModels(stdout: string): ModelEntry[] {
    const lines = stdout.trim().split('\n')
    const models: ModelEntry[] = []
    for (const line of lines) {
        const separatorIndex = line.indexOf(' - ')
        if (separatorIndex === -1) continue
        const id = line.slice(0, separatorIndex).trim()
        const name = line.slice(separatorIndex + 3).trim()
        if (!id || !name) continue
        models.push({ id, name, provider: AGENT_MODEL_PROVIDER })
    }
    return models
}
