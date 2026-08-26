import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline'
import type { Readable, Writable } from 'node:stream'
import type { ProviderSessionHistory } from '@/providers/provider'

const CODEX_HISTORY_TIMEOUT_MS = 15_000
const CODEX_HISTORY_STDIN_GRACE_MS = 250
const CODEX_HISTORY_SIGTERM_GRACE_MS = 750
const CODEX_HISTORY_SIGKILL_GRACE_MS = 250
const CODEX_HISTORY_STDERR_LIMIT = 2_000

interface CodexHistoryProcess {
    exitCode: number | null
    signalCode: NodeJS.Signals | null
    pid?: number
    stdin: Writable | null
    stdout: Readable | null
    stderr: Readable | null
    once(event: 'error', listener: (error: Error) => void): this
    once(
        event: 'exit',
        listener: (exitCode: number | null, signal: NodeJS.Signals | null) => void,
    ): this
    removeListener(
        event: 'exit',
        listener: (exitCode: number | null, signal: NodeJS.Signals | null) => void,
    ): this
    kill(signal?: NodeJS.Signals | number): boolean
}

export type SpawnCodexHistoryProcess = (
    command: string,
    args: string[],
    options: {
        cwd?: string
        env: NodeJS.ProcessEnv
        shell: boolean
        stdio: ['pipe', 'pipe', 'pipe']
        windowsHide: boolean
    },
) => CodexHistoryProcess

export interface CodexSessionHistoryReadOptions {
    sessionId: string
    cwd: string
    command: string
    env?: Record<string, string>
    processCwd?: string
    timeoutMs?: number
    spawnProcess?: SpawnCodexHistoryProcess
}

export type CodexSessionHistoryReader = (
    options: CodexSessionHistoryReadOptions,
) => Promise<ProviderSessionHistory>

export class CodexHistoryUnavailableError extends Error {
    constructor(message: string, options: { cause?: unknown } = {}) {
        super(message, options)
        this.name = 'CodexHistoryUnavailableError'
    }
}

export class CodexHistoryRequestError extends Error {
    readonly code?: number
    readonly data?: unknown

    constructor(message: string, options: { code?: number; data?: unknown; cause?: unknown } = {}) {
        super(message, options)
        this.name = 'CodexHistoryRequestError'
        this.code = options.code
        this.data = options.data
    }
}

/**
 * Read Codex history without resuming the thread.
 *
 * ACP `session/load` restores a writable session. Codex rejects that request
 * while another Gateway session owns the thread's writer. App Server's
 * `thread/read` is the provider-native read-only operation and remains valid
 * for both active and inactive threads.
 */
export async function readCodexSessionHistory(
    options: CodexSessionHistoryReadOptions,
): Promise<ProviderSessionHistory> {
    const thread = await readCodexThread(options)
    return parseCodexThreadHistory(options.sessionId, thread, options.cwd)
}

export function parseCodexThreadHistory(
    sessionId: string,
    input: unknown,
    expectedCwd?: string,
): ProviderSessionHistory {
    const thread = asRecord(input)
    if (!thread || thread.id !== sessionId) {
        throw new CodexHistoryRequestError('Codex thread/read returned a different session')
    }
    if (
        expectedCwd
        && (typeof thread.cwd !== 'string' || resolve(thread.cwd) !== resolve(expectedCwd))
    ) {
        throw new CodexHistoryRequestError('Codex thread/read returned a session outside this project')
    }

    const messages: ProviderSessionHistory['messages'] = []
    const indexById = new Map<string, number>()
    let fallbackIndex = 0
    let firstUserText = ''
    const turns = Array.isArray(thread.turns) ? thread.turns : []

    for (const turnValue of turns) {
        const turn = asRecord(turnValue)
        if (!turn || !Array.isArray(turn.items)) continue
        for (const itemValue of turn.items) {
            const item = asRecord(itemValue)
            if (!item) continue

            let role: 'user' | 'assistant'
            let text: string
            if (item.type === 'userMessage') {
                role = 'user'
                text = extractUserMessageText(item.content)
                if (!firstUserText && text.trim()) firstUserText = text
            } else if (item.type === 'agentMessage') {
                role = 'assistant'
                text = typeof item.text === 'string' ? item.text : ''
            } else {
                continue
            }
            if (!text) continue

            const itemId = typeof item.id === 'string' ? item.id.trim() : ''
            const id = itemId || `${role}-${fallbackIndex++}`
            const existingIndex = indexById.get(id)
            if (existingIndex === undefined) {
                indexById.set(id, messages.length)
                messages.push({ id, role, text })
            } else {
                messages[existingIndex] = {
                    ...messages[existingIndex]!,
                    text: `${messages[existingIndex]!.text}${text}`,
                }
            }
        }
    }

    return {
        sessionId,
        title: normalizeTitle(thread.name)
            ?? normalizeTitle(firstUserText)
            ?? normalizeTitle(thread.preview)
            ?? 'Provider session',
        messages: messages
            .slice(-256)
            .map(message => ({ ...message, text: message.text.slice(0, 16 * 1024) })),
    }
}

async function readCodexThread(options: CodexSessionHistoryReadOptions): Promise<unknown> {
    const spawnProcess = options.spawnProcess ?? spawn
    let child: CodexHistoryProcess
    try {
        child = spawnProcess(
            options.command,
            ['app-server', '--listen', 'stdio://'],
            {
                ...(options.processCwd ? { cwd: options.processCwd } : {}),
                env: { ...process.env, ...options.env },
                shell: process.platform === 'win32',
                stdio: ['pipe', 'pipe', 'pipe'],
                windowsHide: true,
            },
        )
    } catch (error) {
        throw new CodexHistoryUnavailableError(
            `Could not start Codex App Server for provider history: ${formatError(error)}`,
            { cause: error },
        )
    }

    if (!child.stdin || !child.stdout || !child.stderr) {
        await terminateHistoryProcess(child)
        throw new CodexHistoryUnavailableError('Codex App Server did not expose stdio for provider history')
    }

    const lines = createInterface({ input: child.stdout })
    let stderr = ''
    child.stderr.on('data', chunk => {
        stderr = `${stderr}${String(chunk)}`.slice(-CODEX_HISTORY_STDERR_LIMIT)
    })

    try {
        return await new Promise<unknown>((resolve, reject) => {
            let settled = false
            const timeout = setTimeout(() => {
                fail(new CodexHistoryRequestError(
                    `Codex thread/read timed out after ${options.timeoutMs ?? CODEX_HISTORY_TIMEOUT_MS}ms`,
                ))
            }, options.timeoutMs ?? CODEX_HISTORY_TIMEOUT_MS)

            const finish = (value: unknown) => {
                if (settled) return
                settled = true
                clearTimeout(timeout)
                resolve(value)
            }
            const fail = (error: unknown) => {
                if (settled) return
                settled = true
                clearTimeout(timeout)
                reject(error)
            }
            const send = (value: unknown) => {
                try {
                    child.stdin!.write(`${JSON.stringify(value)}\n`)
                } catch (error) {
                    fail(new CodexHistoryUnavailableError(
                        `Could not write to Codex App Server: ${formatError(error)}`,
                        { cause: error },
                    ))
                }
            }
            const onProcessError = (error: Error) => {
                fail(new CodexHistoryUnavailableError(
                    `Could not start Codex App Server for provider history: ${error.message}`,
                    { cause: error },
                ))
            }
            const onProcessExit = (exitCode: number | null, signal: NodeJS.Signals | null) => {
                fail(new CodexHistoryUnavailableError(
                    `Codex App Server exited before returning provider history (exit=${exitCode ?? 'null'}, signal=${signal ?? 'null'})${stderr.trim() ? `: ${stderr.trim()}` : ''}`,
                ))
            }

            child.once('error', onProcessError)
            child.once('exit', onProcessExit)
            lines.on('line', line => {
                let response: Record<string, unknown>
                try {
                    const parsed = JSON.parse(line) as unknown
                    const record = asRecord(parsed)
                    if (!record) return
                    response = record
                } catch {
                    return
                }

                if (response.id === 1) {
                    if (response.error !== undefined) {
                        fail(jsonRpcError('initialize', response.error))
                        return
                    }
                    send({
                        jsonrpc: '2.0',
                        id: 2,
                        method: 'thread/read',
                        params: { threadId: options.sessionId, includeTurns: true },
                    })
                    return
                }
                if (response.id !== 2) return
                if (response.error !== undefined) {
                    fail(jsonRpcError('thread/read', response.error))
                    return
                }
                const result = asRecord(response.result)
                if (!result || result.thread === undefined) {
                    fail(new CodexHistoryRequestError('Codex thread/read returned an invalid response'))
                    return
                }
                finish(result.thread)
            })

            send({
                jsonrpc: '2.0',
                id: 1,
                method: 'initialize',
                params: {
                    clientInfo: {
                        name: 'malink-provider-history',
                        title: 'Malink Provider History',
                        version: '0.1.0',
                    },
                    capabilities: {
                        experimentalApi: true,
                        requestAttestation: false,
                    },
                },
            })
        })
    } finally {
        lines.close()
        await terminateHistoryProcess(child)
    }
}

function jsonRpcError(phase: 'initialize' | 'thread/read', input: unknown): Error {
    const error = asRecord(input)
    const code = typeof error?.code === 'number' ? error.code : undefined
    const message = typeof error?.message === 'string' && error.message.trim()
        ? error.message.trim()
        : 'Unknown Codex App Server error'
    if (code === -32601) {
        return new CodexHistoryUnavailableError(`Codex App Server does not support ${phase}: ${message}`)
    }
    return new CodexHistoryRequestError(`Codex ${phase} failed: ${message}`, {
        code,
        data: error?.data,
    })
}

async function terminateHistoryProcess(child: CodexHistoryProcess): Promise<void> {
    if (!processRunning(child)) return
    try { child.stdin?.end() } catch {}
    if (await waitForExit(child, CODEX_HISTORY_STDIN_GRACE_MS)) return
    try { child.kill('SIGTERM') } catch {}
    if (await waitForExit(child, CODEX_HISTORY_SIGTERM_GRACE_MS)) return
    try { child.kill('SIGKILL') } catch {}
    await waitForExit(child, CODEX_HISTORY_SIGKILL_GRACE_MS)
}

function waitForExit(child: CodexHistoryProcess, timeoutMs: number): Promise<boolean> {
    return new Promise(resolve => {
        if (!processRunning(child)) {
            resolve(true)
            return
        }
        const onExit = () => {
            clearTimeout(timeout)
            resolve(true)
        }
        const timeout = setTimeout(() => {
            child.removeListener('exit', onExit)
            resolve(false)
        }, timeoutMs)
        child.once('exit', onExit)
    })
}

function processRunning(child: CodexHistoryProcess): boolean {
    return child.exitCode === null && child.signalCode === null
}

function extractUserMessageText(input: unknown): string {
    if (!Array.isArray(input)) return ''
    return input.flatMap(value => {
        const part = asRecord(value)
        return part?.type === 'text' && typeof part.text === 'string' ? [part.text] : []
    }).join('')
}

function normalizeTitle(value: unknown): string | null {
    if (typeof value !== 'string') return null
    const normalized = value.replace(/\s+/g, ' ').trim()
    return normalized || null
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null
}

function formatError(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}
