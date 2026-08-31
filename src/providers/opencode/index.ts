/**
 * OpencodeProvider — ACP-based opencode integration.
 *
 * Uses the Agent Client Protocol to communicate with `opencode acp`
 * via stdio JSON-RPC. This replaces the previous SDK-based approach
 * (HTTP REST + SSE) which had session management bugs due to
 * implicit session creation and fire-and-forget prompt handling.
 *
 * ACP's explicit session lifecycle (session/new → session/prompt → session/cancel)
 * guarantees session continuity:
 * - cancel only stops the current turn, session persists
 * - prompt must include sessionId, no implicit new session creation
 */

import { spawn } from 'node:child_process'
import { AcpProvider } from '@/providers/acp'
import type { ModelEntry, SessionEntry } from '@/providers/provider'

const OPENCODE_ACP_COMMAND = 'opencode'
const OPENCODE_ACP_ARGS = ['acp']
const OPENCODE_MODELS_REFRESH_MS = 5 * 60_000
const OPENCODE_MODELS_RETRY_MS = 30_000

export interface OpencodeModelsReaderInput {
    command: string
    env?: Record<string, string>
    cwd?: string
}

export type OpencodeModelsReader = (
    input: OpencodeModelsReaderInput,
) => Promise<string>

export interface OpencodeProviderOptions {
    name?: string
    command?: string
    args?: string[]
    env?: Record<string, string>
    cwd?: string
    modelProviders?: string[]
    modelsReader?: OpencodeModelsReader
}

function mergeProcessEnv(env?: Record<string, string>): NodeJS.ProcessEnv {
    return env ? { ...process.env, ...env } : process.env
}

function spawnJson(command: string, args: string[], options: { timeoutMs?: number; cwd?: string; env?: Record<string, string> } = {}): Promise<string> {
    const timeoutMs = options.timeoutMs ?? 10_000
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
            env: mergeProcessEnv(options.env),
            ...(options.cwd ? { cwd: options.cwd } : {}),
        })
        const chunks: Buffer[] = []
        let timer: ReturnType<typeof setTimeout> | undefined
        child.stdout.on('data', (d: Buffer) => chunks.push(d))
        child.stderr.on('data', () => {})
        child.on('close', (code) => {
            if (timer) clearTimeout(timer)
            if (code === 0) {
                resolve(Buffer.concat(chunks).toString('utf-8'))
            } else {
                reject(new Error(`${command} ${args.join(' ')} exited with code ${code}`))
            }
        })
        child.on('error', (error) => {
            if (timer) clearTimeout(timer)
            reject(error)
        })
        timer = setTimeout(() => {
            child.kill()
            reject(new Error(`${command} ${args.join(' ')} timed out after ${timeoutMs}ms`))
        }, timeoutMs).unref()
    })
}

export class OpencodeProvider extends AcpProvider {
    private readonly command: string
    private readonly env?: Record<string, string>
    private readonly processCwd?: string
    private readonly modelProviders: Set<string>
    private readonly modelsReader: OpencodeModelsReader
    private modelCatalog: ModelEntry[] = []
    private modelRefreshPromise?: Promise<ModelEntry[]>
    private nextModelRefreshAt = 0
    private readonly modelCatalogListeners = new Set<() => void>()

    constructor(options: OpencodeProviderOptions = {}) {
        const command = options.command ?? OPENCODE_ACP_COMMAND
        const args = options.args ?? OPENCODE_ACP_ARGS
        super({
            name: options.name ?? 'opencode',
            command,
            args,
            ...(options.env ? { env: options.env } : {}),
            ...(options.cwd ? { cwd: options.cwd } : {}),
        })
        this.command = command
        this.env = options.env
        this.processCwd = options.cwd
        this.modelProviders = new Set((options.modelProviders ?? []).map(provider => provider.toLowerCase()))
        this.modelsReader = options.modelsReader ?? (input => spawnJson(
            input.command,
            ['models'],
            {
                timeoutMs: 10_000,
                ...(input.cwd ? { cwd: input.cwd } : {}),
                ...(input.env ? { env: input.env } : {}),
            },
        ))
    }

    async listSessions(cwd: string): Promise<SessionEntry[]> {
        try {
            const output = await spawnJson(this.command, ['session', 'list', '--format', 'json'], {
                timeoutMs: 10_000,
                cwd,
                env: this.env,
            })
            const allSessions = JSON.parse(output) as Array<{
                id: string
                title: string
                updated: number
                directory: string
            }>

            const normalizedCwd = cwd.replace(/\\/g, '/').toLowerCase()
            return allSessions
                .filter(s => !cwd || s.directory.replace(/\\/g, '/').toLowerCase() === normalizedCwd)
                .map(s => ({
                    sessionId: s.id,
                    title: s.title,
                    updated: s.updated,
                    cwd: s.directory,
                    firstMessage: '',
                }))
        } catch (e) {
            console.error(`[opencode] Failed to list sessions: ${e instanceof Error ? e.message : e}`)
            return []
        }
    }

    async getSessionFirstMessage(sessionId: string): Promise<string> {
        try {
            const sql = `SELECT p.data FROM part p JOIN message m ON p.message_id = m.id WHERE m.session_id = '${sessionId}' AND json_extract(m.data, '$.role') = 'user' AND json_extract(p.data, '$.type') = 'text' ORDER BY p.time_created ASC LIMIT 1`
            const output = await spawnJson(this.command, ['db', sql, '--format', 'json'], {
                timeoutMs: 10_000,
                cwd: this.processCwd,
                env: this.env,
            })
            const rows = JSON.parse(output) as Array<{ data: string }>
            if (rows.length === 0) return ''
            const part = JSON.parse(rows[0].data) as { type: string; text: string }
            return part.text ?? ''
        } catch (e) {
            console.error(`[opencode] Failed to get first message: ${e instanceof Error ? e.message : e}`)
            return ''
        }
    }

    getAvailableModels(): ModelEntry[] {
        if (!this.modelRefreshPromise && Date.now() >= this.nextModelRefreshAt) {
            // Capability snapshots run synchronously on the Gateway event loop.
            // A slow or missing opencode binary must never block project
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
        this.nextModelRefreshAt = Date.now() + OPENCODE_MODELS_RETRY_MS
        const refresh = this.modelsReader({
            command: this.command,
            ...(this.env ? { env: this.env } : {}),
            ...(this.processCwd ? { cwd: this.processCwd } : {}),
        }).then(output => {
            this.modelCatalog = parseOpencodeModels(output, this.modelProviders)
            this.nextModelRefreshAt = Date.now() + OPENCODE_MODELS_REFRESH_MS
            this.notifyModelCatalogListeners()
            return this.modelCatalog.map(model => ({ ...model }))
        }).catch(error => {
            const message = error instanceof Error ? error.message : String(error)
            console.error(`[opencode] Failed to list models: ${message}`)
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
                console.error(`[opencode] Model catalog listener failed: ${message}`)
            }
        }
    }

    resolveModel(model: string): string | undefined {
        const normalized = model.trim()
        return normalized || undefined
    }
}

export function parseOpencodeModels(
    output: string,
    modelProviders: ReadonlySet<string> = new Set(),
): ModelEntry[] {
    return output.trim().split('\n')
        .filter(line => line.includes('/'))
        .map(line => {
            const id = line.trim()
            const parts = id.split('/')
            const name = parts.length > 1 ? parts.slice(1).join('/') : id
            return { id, name, provider: parts[0] }
        })
        .filter(model => modelProviders.size === 0 || modelProviders.has(
            (model.provider ?? '').toLowerCase(),
        ))
}
