/**
 * AcpProvider — ACP-based agent provider implementation.
 *
 * Uses the Agent Client Protocol to communicate with an ACP-compliant
 * agent subprocess via stdio. Session management is explicit:
 * - session/new creates a session
 * - session/prompt sends a prompt and blocks until the turn completes
 * - session/cancel interrupts the current turn but preserves the session
 *
 * During a prompt, session/update notifications arrive via the Client
 * callback and are forwarded to the PushableAsyncIterable for consumption.
 */

import type {
    AgentProvider,
    AgentQueryConfig,
    AgentQueryHandle,
    AgentQueryInput,
    ModelEntry,
    ProviderSessionHistory,
    SessionEntry,
} from '@/providers/provider'
import type { AgentEvent } from '@/providers/types'
import type { RichMediaPart, RichUserInput } from '@/runtime/semantic'
import { normalizeUserInput } from '@/runtime/semantic'
import { PushableAsyncIterable } from '@/utils/PushableAsyncIterable'
import { AcpClientManager, type AcpClientManagerConfig, type AcpExtensionHandler } from './AcpClientManager'
import { adaptStopReason, mapSessionUpdate, parseRawInput as _parseRawInput, type AcpDebugLog } from './eventAdapter'
import { unwrapToolOutput } from '@/utils/unwrapToolOutput'
import type {
    SessionNotification,
    SessionUpdate,
    ContentBlock as AcpContentBlock,
    SessionConfigOption,
    SessionModelState,
} from '@agentclientprotocol/sdk'
import { resolve, dirname } from 'node:path'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const ACP_TAIL_DRAIN_IDLE_MS = 100
const ACP_TAIL_DRAIN_MAX_MS = 1_000
const ACP_HISTORY_DRAIN_IDLE_MS = 150
const ACP_HISTORY_DRAIN_MAX_MS = 3_000
const DEFAULT_ACP_SESSION_OPEN_TIMEOUT_MS = 30_000
const MAX_AGENT_ERROR_SUMMARY_LENGTH = 1_500

export class AcpSessionOpenTimeoutError extends Error {
    readonly operation: string
    readonly timeoutMs: number

    constructor(operation: string, timeoutMs: number) {
        super(`${operation} timed out after ${timeoutMs}ms`)
        this.name = 'AcpSessionOpenTimeoutError'
        this.operation = operation
        this.timeoutMs = timeoutMs
    }
}

/**
 * Resolve the command used to launch the malink MCP stdio server.
 *
 * Built code runs from dist and can launch dist/mcp/stdio.js directly. Source
 * runs under tsx, so the MCP server must also be launched through tsx.
 */
interface MalinkMcpServerCommand {
    command: string
    args: string[]
}

interface MalinkMcpResolutionOptions {
    moduleUrl?: string
    cwd?: string
    nodePath?: string
    pathExists?: (path: string) => boolean
}

export function resolveMalinkMcpServerCommand(options: MalinkMcpResolutionOptions = {}): MalinkMcpServerCommand {
    const moduleUrl = options.moduleUrl ?? import.meta.url
    const cwd = options.cwd ?? process.cwd()
    const nodePath = options.nodePath ?? process.execPath
    const pathExists = options.pathExists ?? existsSync
    const moduleDir = getModuleDir(moduleUrl)

    const builtCandidates = [
        ...(moduleDir ? [resolve(moduleDir, 'mcp', 'stdio.js')] : []),
        resolve(cwd, 'dist', 'mcp', 'stdio.js'),
    ]

    for (const entry of builtCandidates) {
        if (pathExists(entry)) {
            return { command: nodePath, args: [entry] }
        }
    }

    const sourceCandidates = [
        ...(moduleDir ? [resolve(moduleDir, '..', '..', 'mcp', 'stdio.ts')] : []),
        resolve(cwd, 'src', 'mcp', 'stdio.ts'),
    ]

    for (const entry of sourceCandidates) {
        if (!pathExists(entry)) continue
        const projectRoot = resolve(dirname(entry), '..', '..')
        const tsxCli = resolve(projectRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs')
        if (pathExists(tsxCli)) {
            return { command: nodePath, args: [tsxCli, entry] }
        }
        return { command: 'tsx', args: [entry] }
    }

    return { command: nodePath, args: [builtCandidates[0] ?? resolve(cwd, 'dist', 'mcp', 'stdio.js')] }
}

function getModuleDir(moduleUrl: string): string | null {
    try {
        return dirname(fileURLToPath(moduleUrl))
    } catch {
        return null
    }
}

interface ToolCallSnapshot {
    toolName: string
    input: unknown
    rawInput?: string
    toolKind?: string
    locations?: Array<{ path: string; line?: number }>
}

export function formatAgentQueryError(error: unknown, context: { provider: string; phase: string; sessionId?: string | null }): string {
    const lines: string[] = [
        `Provider: ${context.provider}`,
        `Phase: ${context.phase}`,
    ]
    if (context.sessionId) {
        lines.push(`Session: ${context.sessionId.slice(0, 12)}`)
    }

    if (error instanceof Error) {
        lines.push(`Error: ${error.name}: ${error.message}`)
        appendErrorFields(lines, error)
        appendCause(lines, error.cause)
        appendStackPreview(lines, error.stack)
    } else {
        lines.push(`Error: ${formatUnknownError(error)}`)
        appendErrorFields(lines, error)
    }

    return truncateErrorSummary(lines.join('\n'))
}

function mapSessionUpdateWithToolState(update: SessionUpdate, toolCalls: Map<string, ToolCallSnapshot>, debugLog?: AcpDebugLog): AgentEvent[] {
    return normalizeToolEvents(mapSessionUpdate(update, debugLog), toolCalls)
}

function normalizeToolEvents(events: AgentEvent[], toolCalls: Map<string, ToolCallSnapshot>): AgentEvent[] {
    return events.map(event => {
        if (event.kind === 'tool_use') {
            const toolUseId = event.toolUseId
            if (!toolUseId) return event

            const existing = toolCalls.get(toolUseId)
            const toolName = existing && isMissingToolName(event.toolName) ? existing.toolName : event.toolName
            const input = existing && (event.input === undefined || event.input === null) ? existing.input : event.input
            const normalized = {
                ...event,
                toolName,
                input,
                ...(event.rawInput === undefined && existing?.rawInput !== undefined ? { rawInput: existing.rawInput } : {}),
                ...(event.toolKind === undefined && existing?.toolKind !== undefined ? { toolKind: existing.toolKind } : {}),
                ...(event.locations === undefined && existing?.locations !== undefined ? { locations: existing.locations } : {}),
            }

            toolCalls.set(toolUseId, {
                toolName: normalized.toolName,
                input: normalized.input,
                rawInput: normalized.rawInput,
                toolKind: normalized.toolKind,
                locations: normalized.locations,
            })
            return normalized
        }

        if (event.kind === 'tool_result') {
            const toolUseId = event.toolUseId
            if (!toolUseId || event.toolName) return event
            const existing = toolCalls.get(toolUseId)
            return existing?.toolName ? { ...event, toolName: existing.toolName } : event
        }

        return event
    })
}

function appendErrorFields(lines: string[], error: unknown): void {
    if (!error || typeof error !== 'object') return
    const record = error as Record<string, unknown>
    for (const key of ['code', 'status', 'statusCode', 'requestId', 'request_id', 'type']) {
        const value = record[key]
        if (value !== undefined && value !== null && value !== '') {
            lines.push(`${key}: ${String(value)}`)
        }
    }

    const response = record.response
    if (response && typeof response === 'object') {
        const responseRecord = response as Record<string, unknown>
        const status = responseRecord.status ?? responseRecord.statusCode
        const statusText = responseRecord.statusText
        if (status !== undefined || statusText !== undefined) {
            lines.push(`response: ${[status, statusText].filter(Boolean).join(' ')}`)
        }
    }
}

function appendCause(lines: string[], cause: unknown): void {
    if (!cause) return
    if (cause instanceof Error) {
        lines.push(`Cause: ${cause.name}: ${cause.message}`)
        appendErrorFields(lines, cause)
        return
    }
    lines.push(`Cause: ${formatUnknownError(cause)}`)
}

function appendStackPreview(lines: string[], stack: string | undefined): void {
    if (!stack) return
    const stackLines = stack
        .split(/\r?\n/)
        .slice(1, 5)
        .map(line => line.trim())
        .filter(Boolean)
    if (stackLines.length > 0) {
        lines.push(`Stack:\n${stackLines.join('\n')}`)
    }
}

function formatUnknownError(error: unknown): string {
    if (typeof error === 'string') return error
    try {
        return JSON.stringify(error)
    } catch {
        return String(error)
    }
}

function truncateErrorSummary(summary: string): string {
    if (summary.length <= MAX_AGENT_ERROR_SUMMARY_LENGTH) return summary
    return `${summary.slice(0, MAX_AGENT_ERROR_SUMMARY_LENGTH - 20)}\n... <truncated>`
}

function isMissingToolName(toolName: string | undefined): boolean {
    return !toolName || toolName === 'tool_call'
}

/**
 * Build the malink MCP server config for ACP mcpServers.
 *
 * Two variants:
 * - Base config (no provider sessionId): used for session/new. Registers context
 *   resources/tools and send_file, which routes by the stable Malink session ID.
 *   Other notify tools still require provider session identity.
 * - Full config (with sessionId): used for session/load or session/resume, where sessionId is known.
 *   Injects MALINK_CONVERSATION_ID into env so MCP subprocess can identify its session.
 *   Registers all tools including the remaining notify tools
 *   (schedule_reminder, cancel_reminder, send_message).
 *
 * Note: Some agents (e.g. Cursor's `agent` CLI) don't support session/resume, and their
 * session/load only works on persisted sessions (i.e. after at least one prompt completes).
 * For such agents, the flow is:
 *   1. newSession with base MCP config → get sessionId; send_file is available
 *   2. Skip Phase 2 (no resume/load) → prompt directly
 *   3. After prompt completes, attempt loadSession with full MCP config
 *   4. If loadSession succeeds, MCP tools with session identity become available on next turn
 *   If loadSession fails, send_file remains available but the other
 *   session-scoped MCP tools are unavailable.
 */
function buildMalinkMcpBaseConfig(config?: AgentQueryConfig): Array<{
    type: 'stdio'
    name: string
    command: string
    args: string[]
    env: Array<{ name: string; value: string }>
}> {
    const mcpServer = resolveMalinkMcpServerCommand()

    return [{
        type: 'stdio' as const,
        name: 'malink',
        command: mcpServer.command,
        args: mcpServer.args,
        env: malinkMcpEnvironment(config),
    }]
}

function buildMalinkMcpFullConfig(sessionId: string, config?: AgentQueryConfig): Array<{
    type: 'stdio'
    name: string
    command: string
    args: string[]
    env: Array<{ name: string; value: string }>
}> {
    const mcpServer = resolveMalinkMcpServerCommand()

    return [{
        type: 'stdio' as const,
        name: 'malink',
        command: mcpServer.command,
        args: mcpServer.args,
        env: [
            ...malinkMcpEnvironment(config),
            { name: 'MALINK_CONVERSATION_ID', value: sessionId },
        ],
    }]
}

function malinkMcpEnvironment(
    config?: AgentQueryConfig,
): Array<{ name: string; value: string }> {
    return [
        ...(config?.malinkSessionId
            ? [{ name: 'MALINK_SESSION_ID', value: config.malinkSessionId }]
            : []),
        ...(process.env.MALINK_GATEWAY_ADMIN_SOCKET?.trim()
            ? [{
                name: 'MALINK_GATEWAY_ADMIN_SOCKET',
                value: process.env.MALINK_GATEWAY_ADMIN_SOCKET.trim(),
            }]
            : []),
        ...(process.env.MALINK_PRIVILEGE_AVAILABLE === '1'
            ? [{ name: 'MALINK_PRIVILEGE_AVAILABLE', value: '1' }]
            : []),
    ]
}

export function parseRawInput(rawInput: unknown): unknown {
    return _parseRawInput(rawInput)
}

export function extractOutputFromContent(content: Array<unknown>): string | null {
    if (!content || content.length === 0) return null
    const parts: string[] = []
    for (const item of content) {
        const c = item as Record<string, unknown>
        if (c.type === 'content') {
            const inner = c.content as Record<string, unknown> | undefined
            if (inner && inner.type === 'text') {
                parts.push((inner as { type: 'text'; text: string }).text)
            } else {
                parts.push(JSON.stringify(inner))
            }
        } else if (c.type === 'diff') {
            parts.push(JSON.stringify(c))
        } else {
            parts.push(JSON.stringify(c))
        }
    }
    return parts.join('\n')
}

export { mapSessionUpdate as mapUpdateToEvents }

export interface AcpPromptCapabilities {
    image?: boolean
    audio?: boolean
}

export async function buildAcpPrompt(input: AgentQueryInput, capabilities: AcpPromptCapabilities = {}): Promise<AcpContentBlock[]> {
    const richInput = normalizeUserInput(input)
    const blocks: Array<Record<string, unknown>> = []
    const fileReferences: string[] = []

    for (const part of richInput.parts) {
        if (part.type === 'text') {
            if (part.text.length > 0) blocks.push({ type: 'text', text: part.text })
            continue
        }

        if (part.type === 'file') {
            fileReferences.push(`- ${part.filename}: ${part.path} (${part.mimeType}, ${part.sizeBytes} bytes)`)
            continue
        }

        if (capabilities[part.type]) {
            blocks.push(formatMediaContentBlock(part))
        } else {
            blocks.push({
                type: 'text',
                text: `The user uploaded ${part.type} ${part.filename ?? 'input'} (${part.mimeType}${part.sizeBytes !== undefined ? `, ${part.sizeBytes} bytes` : ''}), but this ACP agent does not advertise ${part.type} prompt support.`,
            })
        }
    }

    if (fileReferences.length > 0) {
        blocks.unshift({
            type: 'text',
            text: [
                'The user uploaded the following file(s), cached locally by Malink:',
                ...fileReferences,
                '',
                'Use these local paths if you need to inspect the uploaded file(s).',
            ].join('\n'),
        })
    }

    return blocks as AcpContentBlock[]
}

function formatMediaContentBlock(part: RichMediaPart): Record<string, unknown> {
    return {
        type: part.type,
        mimeType: part.mimeType,
        data: part.data,
        ...(part.source ? { source: part.source } : {}),
    }
}

export interface AcpProviderConfig {
    name: string
    command: string
    args: string[]
    env?: Record<string, string>
    cwd?: string
    /** Maximum time for ACP session/new, session/load, or session/resume. */
    sessionOpenTimeoutMs?: number
}

export class AcpProvider implements AgentProvider {
    readonly name: string
    private clientManager: AcpClientManager
    private _initError: string | null = null
    private initialized = false
    private initPromise: Promise<void> | null = null
    private readonly sessionOpenTimeoutMs: number
    private sessionOpenInProgress = false

    /** Track the active sessionId for the current query (for interrupt support) */
    private activeSessionId: string | null = null

    /** Abort signal for the current query */
    private activeAbortSignal: AbortSignal | null = null

    async listSessions(cwd: string): Promise<SessionEntry[]> {
        await this.init()
        if (!this.isReady()) {
            throw new Error(this.getInitError() ?? `Provider ${this.name} is unavailable`)
        }
        if (!this.clientManager.supportsListSessions) return []

        const entries: SessionEntry[] = []
        let cursor: string | null | undefined
        do {
            const response = await this.clientManager.listSessions({ cwd, ...(cursor ? { cursor } : {}) })
            entries.push(...response.sessions.map(session => ({
                sessionId: session.sessionId,
                title: session.title?.trim() || 'Untitled provider session',
                updated: parseProviderTimestamp(session.updatedAt),
                cwd: session.cwd,
            })))
            cursor = response.nextCursor
        } while (cursor && entries.length < 256)

        return entries.slice(0, 256).sort((left, right) => right.updated - left.updated)
    }

    async getSessionHistory(sessionId: string, cwd: string): Promise<ProviderSessionHistory> {
        await this.init()
        if (!this.isReady()) {
            throw new Error(this.getInitError() ?? `Provider ${this.name} is unavailable`)
        }
        if (!this.clientManager.agentCapabilities?.agentCapabilities?.loadSession) {
            throw new Error(`Provider ${this.name} does not support loading session history`)
        }

        await this.clientManager.loadSession({ sessionId, cwd, mcpServers: [] })
        const notifications = await this.clientManager.collectSessionUpdatesUntilIdle(sessionId, {
            idleMs: ACP_HISTORY_DRAIN_IDLE_MS,
            maxMs: ACP_HISTORY_DRAIN_MAX_MS,
        })
        const messages = collectProviderHistoryMessages(notifications)
        const listed = await this.listSessions(cwd).catch(() => [])
        return {
            sessionId,
            title: listed.find(entry => entry.sessionId === sessionId)?.title ?? 'Provider session',
            messages,
        }
    }

    constructor(config: AcpProviderConfig) {
        this.name = config.name
        this.sessionOpenTimeoutMs = Number.isFinite(config.sessionOpenTimeoutMs)
            && (config.sessionOpenTimeoutMs ?? 0) > 0
            ? config.sessionOpenTimeoutMs!
            : DEFAULT_ACP_SESSION_OPEN_TIMEOUT_MS
        const managerConfig: AcpClientManagerConfig = {
            command: config.command,
            args: config.args,
            env: config.env,
            cwd: config.cwd,
        }
        this.clientManager = new AcpClientManager(managerConfig)
    }

    private async runSessionOpenOperation<T>(operation: string, request: () => Promise<T>): Promise<T> {
        let timer: ReturnType<typeof setTimeout> | undefined
        this.sessionOpenInProgress = true
        const timeout = new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
                reject(new AcpSessionOpenTimeoutError(operation, this.sessionOpenTimeoutMs))
            }, this.sessionOpenTimeoutMs)
        })

        try {
            return await Promise.race([request(), timeout])
        } finally {
            if (timer) clearTimeout(timer)
            this.sessionOpenInProgress = false
        }
    }

    private configureClientForTurn(events: PushableAsyncIterable<AgentEvent>, config: AgentQueryConfig): void {
        this.clientManager.setPermissionHandler(config.permissionHandler ?? null)
        this.clientManager.setExtensionHandler(this.createExtensionHandler(events, config))
    }

    private async restartClientForSessionRecovery(
        events: PushableAsyncIterable<AgentEvent>,
        config: AgentQueryConfig,
    ): Promise<void> {
        this.activeSessionId = null
        await this.reinit()
        if (!this.isReady()) {
            throw new Error(this.getInitError() ?? `Provider ${this.name} could not restart for session recovery`)
        }
        this.configureClientForTurn(events, config)
        this.clientManager.clearStderrBuffer()
    }

    private async closeTimedOutClient(): Promise<void> {
        try {
            await this.clientManager.close()
        } catch (error) {
            console.error(`[acp:${this.name}] Failed to close timed-out ACP connection: ${error instanceof Error ? error.message : String(error)}`)
            this.clientManager.dispose()
        }
        this.activeSessionId = null
    }

    private async applyProviderConfigOptions(
        sessionId: string,
        config: AgentQueryConfig,
        configOptions: readonly SessionConfigOption[] = [],
    ): Promise<void> {
        const permissionMode = typeof config.providerSettings?.permissionMode === 'string'
            ? config.providerSettings.permissionMode.trim()
            : ''
        // "default" deliberately preserves the agent's configured initial
        // mode (for codex-acp, INITIAL_AGENT_MODE) instead of overriding it.
        if (permissionMode && permissionMode !== 'default') {
            const option = configOptions.find(candidate =>
                candidate.id === 'mode' || candidate.category === 'mode'
            )
            if (option?.type === 'select') {
                const value = permissionMode === 'bypassPermissions'
                    ? 'agent-full-access'
                    : 'agent'
                const supportsValue = option.options.some(candidate =>
                    'value' in candidate
                        ? candidate.value === value
                        : candidate.options.some(grouped => grouped.value === value)
                )
                if (supportsValue) {
                    await this.clientManager.setSessionConfigOption({
                        sessionId,
                        configId: option.id,
                        value,
                    })
                    console.error(`[acp:${this.name}] Set permission mode ${permissionMode} as ACP mode ${value}`)
                }
            }
        }

        const reasoningEffort = typeof config.providerSettings?.reasoningEffort === 'string'
            ? config.providerSettings.reasoningEffort.trim()
            : ''
        if (!reasoningEffort) return

        const option = configOptions.find(candidate =>
            candidate.category === 'thought_level'
            || candidate.id === 'reasoning_effort'
            || candidate.id === 'reasoningEffort'
        )
        if (!option || option.type !== 'select') {
            throw new Error(
                `Provider ${this.name} does not advertise structured reasoning configuration`,
            )
        }

        await this.clientManager.setSessionConfigOption({
            sessionId,
            configId: option.id,
            value: reasoningEffort,
        })
        console.error(`[acp:${this.name}] Set reasoning effort to ${reasoningEffort}`)
    }

    private async applyProviderModel(
        sessionId: string,
        model: string | undefined,
        models: SessionModelState | null | undefined,
        configOptions: readonly SessionConfigOption[] = [],
    ): Promise<void> {
        if (!model) return
        if (models?.availableModels.some(candidate => candidate.modelId === model)) {
            await this.clientManager.setSessionModel({ sessionId, modelId: model })
            console.error(`[acp:${this.name}] Set model to ${model}`)
            return
        }
        const option = configOptions.find(candidate =>
            candidate.category === 'model' || candidate.id === 'model'
        )
        if (option?.type !== 'select') {
            throw new Error(`Provider ${this.name} does not advertise structured model configuration`)
        }
        await this.clientManager.setSessionConfigOption({
            sessionId,
            configId: option.id,
            value: model,
        })
        console.error(`[acp:${this.name}] Set model config to ${model}`)
    }

    async init(): Promise<void> {
        if (this.initialized) return
        if (this.initPromise) return this.initPromise

        this.initPromise = this._doInit()
        return this.initPromise
    }

    private async _doInit(): Promise<void> {
        try {
            await this.clientManager.init()
            this.initialized = true
            console.error(`[acp:${this.name}] Provider initialized`)
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e)
            console.error(`[acp:${this.name}] Init failed: ${msg}`)
            this._initError = msg
            this.initPromise = null // Allow retry
        }
    }

    isReady(): boolean {
        return this.initialized && this.clientManager.connected
    }

    /**
     * Returns true if the provider was previously initialized but is now
     * disconnected (e.g., agent subprocess crashed). Distinguishes from
     * "never initialized" state.
     */
    wasReady(): boolean {
        return this.initialized && !this.clientManager.connected
    }

    getInitError(): string | null {
        return this._initError
    }

    /**
     * Re-initialize the provider after a crash. Closes the dead connection,
     * resets internal state, and spawns a new agent subprocess.
     */
    async reinit(): Promise<void> {
        console.error(`[acp:${this.name}] Reinitializing provider after crash...`)
        try {
            await this.clientManager.close()
        } catch (e) {
            console.error(`[acp:${this.name}] close() during reinit failed: ${e instanceof Error ? e.message : String(e)}`)
        }
        this.initialized = false
        this.initPromise = null
        this._initError = null
        await this.init()
    }

    async destroy(): Promise<void> {
        try {
            await this.clientManager.close()
        } finally {
            this.initialized = false
            this.initPromise = null
            this._initError = null
            this.activeSessionId = null
            this.activeAbortSignal = null
            this.sessionOpenInProgress = false
        }
    }

    startQuery(prompt: AgentQueryInput, config: AgentQueryConfig): AgentQueryHandle {
        const events = new PushableAsyncIterable<AgentEvent>()
        const clientManager = this.clientManager
        let queryCancelled = false

        // Set per-turn handlers on the client manager.
        this.configureClientForTurn(events, config)

        // Fire-and-forget the prompt sequence
        const runQuery = async () => {
            // Clear stderr buffer at the start of each query so we only
            // capture errors from the current turn.
            clientManager.clearStderrBuffer()

            let updateConsumerAbort: AbortController | null = null
            let sessionId = config.sessionId

            try {
                let isResumingSession = false
                /** Whether the session was resumed via loadSession (which replays history).
                 *  resumeSession does NOT replay history, so drain logic is not needed. */
                let needsHistoryDrain = false
                let sessionConfigOptions: readonly SessionConfigOption[] = []
                let sessionModels: SessionModelState | null | undefined

                const throwIfQueryCancelled = (): void => {
                    if (queryCancelled || config.signal?.aborted) {
                        throw new Error('Agent query cancelled during session recovery')
                    }
                }

                const recoverSessionOnce = async (
                    targetSessionId: string,
                    attempt: 'initial' | 'after-restart',
                ): Promise<{
                    configOptions: readonly SessionConfigOption[]
                    models: SessionModelState | null | undefined
                    viaLoad: boolean
                } | null> => {
                    throwIfQueryCancelled()
                    this.activeSessionId = targetSessionId

                    if (clientManager.supportsResumeSession) {
                        try {
                            const resumed = await this.runSessionOpenOperation(
                                `session/resume (${attempt})`,
                                () => clientManager.resumeSession({
                                    sessionId: targetSessionId,
                                    cwd: config.cwd,
                                    mcpServers: buildMalinkMcpFullConfig(targetSessionId, config),
                                }),
                            )
                            console.error(`[acp:${this.name}] Resumed session ${targetSessionId} (${attempt}, no history replay)`)
                            return {
                                configOptions: resumed.configOptions ?? [],
                                models: resumed.models,
                                viaLoad: false,
                            }
                        } catch (error) {
                            if (error instanceof AcpSessionOpenTimeoutError) throw error
                            const message = error instanceof Error ? error.message : String(error)
                            console.error(`[acp:${this.name}] resumeSession failed (${attempt}), falling back to loadSession: ${message}`)
                        }
                    }

                    throwIfQueryCancelled()
                    if (clientManager.agentCapabilities?.agentCapabilities?.loadSession) {
                        try {
                            const loaded = await this.runSessionOpenOperation(
                                `session/load (${attempt})`,
                                () => clientManager.loadSession({
                                    sessionId: targetSessionId,
                                    cwd: config.cwd,
                                    mcpServers: buildMalinkMcpFullConfig(targetSessionId, config),
                                }),
                            )
                            console.error(`[acp:${this.name}] Loaded session ${targetSessionId} (${attempt}, will drain history)`)
                            return {
                                configOptions: loaded.configOptions ?? [],
                                models: loaded.models,
                                viaLoad: true,
                            }
                        } catch (error) {
                            if (error instanceof AcpSessionOpenTimeoutError) throw error
                            const message = error instanceof Error ? error.message : String(error)
                            console.error(`[acp:${this.name}] loadSession failed (${attempt}): ${message}`)
                        }
                    }

                    throwIfQueryCancelled()
                    return null
                }

                const recoverSession = async (targetSessionId: string): Promise<{
                    result: Awaited<ReturnType<typeof recoverSessionOnce>>
                    restarted: boolean
                }> => {
                    try {
                        return {
                            result: await recoverSessionOnce(targetSessionId, 'initial'),
                            restarted: false,
                        }
                    } catch (error) {
                        if (!(error instanceof AcpSessionOpenTimeoutError)) throw error
                        console.error(`[acp:${this.name}] ${error.message}; restarting ACP before retrying the same session ${targetSessionId}`)
                    }

                    throwIfQueryCancelled()
                    await this.restartClientForSessionRecovery(events, config)
                    throwIfQueryCancelled()

                    try {
                        return {
                            result: await recoverSessionOnce(targetSessionId, 'after-restart'),
                            restarted: true,
                        }
                    } catch (error) {
                        if (!(error instanceof AcpSessionOpenTimeoutError)) throw error
                        console.error(`[acp:${this.name}] ${error.message}; the same session could not be recovered after an ACP restart`)
                        throwIfQueryCancelled()
                        // The retry timed out too, so this connection is also wedged. Restart
                        // once more before creating a replacement session on a clean process.
                        await this.restartClientForSessionRecovery(events, config)
                        throwIfQueryCancelled()
                        return { result: null, restarted: true }
                    }
                }

                const createSession = async (reason: 'initial' | 'replacement') => {
                    throwIfQueryCancelled()
                    const request = () => this.runSessionOpenOperation(
                        `session/new (${reason})`,
                        () => clientManager.newSession({
                            cwd: config.cwd,
                            mcpServers: buildMalinkMcpBaseConfig(config),
                        }),
                    )

                    try {
                        return await request()
                    } catch (error) {
                        if (!(error instanceof AcpSessionOpenTimeoutError)) throw error
                        console.error(`[acp:${this.name}] ${error.message}; restarting ACP before retrying session creation`)
                        throwIfQueryCancelled()
                        await this.restartClientForSessionRecovery(events, config)
                        throwIfQueryCancelled()
                        return await request()
                    }
                }

                console.error(`[acp:${this.name}] startQuery: config.sessionId=${config.sessionId?.slice(0, 8) ?? 'null'} → will ${config.sessionId ? 'resume/load' : 'newSession'}`)

                // 1. Create or load session
                if (!sessionId) {
                    // Two-phase session creation:
                    // Phase 1: newSession with base MCP config (no session-dependent tools).
                    //   At this point sessionId doesn't exist yet, so we can't inject it into env.
                    const sessionResponse = await createSession('initial')
                    sessionId = sessionResponse.sessionId
                    sessionConfigOptions = sessionResponse.configOptions ?? []
                    sessionModels = sessionResponse.models
                    this.activeSessionId = sessionId
                    console.error(`[acp:${this.name}] Created session ${sessionId}`)

                    // Phase 2: Reconnect MCP servers with full config (including session env).
                    //   Now sessionId is known, we inject it via mcpServers.env so the MCP subprocess
                    //   can identify which ACP session it belongs to.
                    //
                    //   Prefer resumeSession over loadSession:
                    //   - resumeSession does NOT replay conversation history (correct for a fresh session)
                    //   - loadSession replays the ENTIRE history, which can cause the agent to
                    //     aggregate context from other sessions in the same cwd (cross-session leakage)
                    //
                    //   Some agents (e.g. Cursor's `agent` CLI) don't support resumeSession, and
                    //   their loadSession only works on persisted sessions (after a prompt completes).
                    //   For those, we skip Phase 2 and inject full MCP config after the first prompt.
                    const phaseTwo = await recoverSession(sessionId)
                    if (phaseTwo.result) {
                        sessionConfigOptions = phaseTwo.result.configOptions.length > 0
                            ? phaseTwo.result.configOptions
                            : sessionConfigOptions
                        sessionModels = phaseTwo.result.models ?? sessionModels
                        needsHistoryDrain = phaseTwo.result.viaLoad
                    } else if (phaseTwo.restarted) {
                        // The original new session only existed on the process that timed out.
                        // If it cannot be recovered after restart, create a clean replacement
                        // instead of prompting an unknown session ID.
                        const replacement = await createSession('replacement')
                        sessionId = replacement.sessionId
                        sessionConfigOptions = replacement.configOptions ?? []
                        sessionModels = replacement.models
                        this.activeSessionId = sessionId
                        needsHistoryDrain = false
                        console.error(`[acp:${this.name}] Replaced unrecoverable fresh session with ${sessionId}`)
                    }

                    await this.applyProviderModel(sessionId!, config.model, sessionModels, sessionConfigOptions)
                    await this.applyProviderConfigOptions(sessionId!, config, sessionConfigOptions)
                } else {
                    // Attempt to resume or load an existing session (conversationId from
                    // a previous gateway run). If the agent can't find the session (e.g.
                    // its session data was lost after a subprocess restart), fall back to
                    // creating a fresh session so the user isn't stuck with a broken one.
                    const recovered = await recoverSession(sessionId)
                    const sessionRecovered = recovered.result !== null

                    if (recovered.result) {
                        sessionConfigOptions = recovered.result.configOptions
                        sessionModels = recovered.result.models
                        this.activeSessionId = sessionId
                        isResumingSession = true
                        needsHistoryDrain = recovered.result.viaLoad
                    }

                    if (!sessionRecovered) {
                        // Neither resumeSession nor loadSession could recover the old session.
                        // The agent may have been restarted or the session data was lost.
                        // Create a new session so the user can continue working.
                        console.error(`[acp:${this.name}] Could not recover session ${sessionId}. Creating a new session.`)
                        const sessionResponse = await createSession('replacement')
                        sessionId = sessionResponse.sessionId
                        sessionConfigOptions = sessionResponse.configOptions ?? []
                        sessionModels = sessionResponse.models
                        this.activeSessionId = sessionId
                        isResumingSession = false
                        needsHistoryDrain = false
                        // Do not immediately resume/load this replacement on the same
                        // recovery path. The base MCP config is sufficient for this turn,
                        // and the next turn can attach the full session-scoped MCP config.
                    }

                    await this.applyProviderModel(sessionId!, config.model, sessionModels, sessionConfigOptions)
                    await this.applyProviderConfigOptions(sessionId!, config, sessionConfigOptions)
                }

                // 2. Push session_init event
                if (!events.done) {
                    events.push({
                        kind: 'session_init',
                        sessionId,
                        cwd: config.cwd,
                        // Flag: true when a stale conversationId could not be recovered
                        // and a brand-new session was created instead. The bridge can
                        // use this to notify the user that previous context was lost.
                        isNewSession: !isResumingSession && !!config.sessionId,
                    })
                }

                // 3. Start consuming session updates in background.
                // For loadSession-based resumes, historical updates are filtered by
                // sequence number boundary in AcpClientManager — no need for promptSent flag.

                if (needsHistoryDrain) {
                    const drained = await clientManager.drainSessionUpdatesUntilIdle(sessionId!, {
                        idleMs: ACP_HISTORY_DRAIN_IDLE_MS,
                        maxMs: ACP_HISTORY_DRAIN_MAX_MS,
                    })
                    console.error(`[acp] Drained ${drained} historical updates from resumed session (loadSession path, idle=${ACP_HISTORY_DRAIN_IDLE_MS}ms)`)
                }

                const toolCalls = new Map<string, ToolCallSnapshot>()
                const consumerAbort = new AbortController()
                updateConsumerAbort = consumerAbort
                const pushSessionUpdateEvents = (notification: SessionNotification, source: 'updateConsumer' | 'tailDrain'): void => {
                    const agentEvents = mapSessionUpdateWithToolState(notification.update, toolCalls, config.debugLog)
                    for (const event of agentEvents) {
                        if (events.done) break
                        const eventSummary = event.kind === 'text' ? `text(${(event.text ?? '').length}ch)` : event.kind === 'tool_use' ? `tool_use(${event.toolName} id=${(event.toolUseId ?? '').slice(0,8)})` : event.kind === 'tool_result' ? `tool_result(id=${(event.toolUseId ?? '').slice(0,8)})` : event.kind
                        console.error(`[acp] ${source} → events.push: ${eventSummary}`)
                        events.push(event)
                    }
                }
                const updateConsumer = async () => {
                    while (!events.done && !consumerAbort.signal.aborted) {
                        try {
                            const notification = await clientManager.waitForSessionUpdate(sessionId!, { signal: consumerAbort.signal })
                            if (events.done) break
                            pushSessionUpdateEvents(notification, 'updateConsumer')
                        } catch (e) {
                            if (consumerAbort.signal.aborted) break
                            const msg = e instanceof Error ? e.message : String(e)
                            console.error(`[acp:${this.name}] updateConsumer error: ${msg}`)
                            if (!events.done) {
                                events.push({ kind: 'result', status: 'error', summary: `Session update stream interrupted: ${msg}`.substring(0, 200) })
                                events.end()
                            }
                            break
                        }
                    }
                }

                const updatePromise = updateConsumer()

                // 5. Send the prompt (blocks until turn completes)
                const promptResponse = await clientManager.prompt({
                    sessionId: sessionId!,
                    prompt: await buildAcpPrompt(prompt, clientManager.promptCapabilities),
                })
                console.error(`[acp:${this.name}] Prompt returned: stopReason=${promptResponse.stopReason}, sessionId=${sessionId}`)

                const updateProcessingWaitStartedAt = Date.now()
                console.error(`[acp:${this.name}] Waiting for session/update processing before final drain: sessionId=${sessionId}`)
                await clientManager.waitForSessionUpdateProcessing()
                console.error(`[acp:${this.name}] Session/update processing settled before final drain: sessionId=${sessionId} waitMs=${Date.now() - updateProcessingWaitStartedAt}`)

                // Stop the live consumer before the final drain. Without aborting
                // its pending waiter, late notifications can be delivered to a
                // stale waiter after this turn has already ended.
                updateConsumerAbort.abort()
                await updatePromise.catch(() => {})
                console.error(`[acp:${this.name}] Live update consumer stopped; starting tail drain: sessionId=${sessionId}`)

                // 5b. Drain any remaining queued session updates, including tail
                //     updates that arrive just after the prompt response.
                if (!events.done) {
                    const tailDrainStartedAt = Date.now()
                    let tailDrainedUpdates = 0
                    while (!events.done && Date.now() - tailDrainStartedAt < ACP_TAIL_DRAIN_MAX_MS) {
                        let drainedAny = false
                        let remaining = clientManager.dequeueSessionUpdate(sessionId!)
                        while (remaining) {
                            drainedAny = true
                            tailDrainedUpdates += 1
                            const updateType = (remaining.update as any)?.sessionUpdate ?? '?'
                            console.error(`[acp] tailDrain dequeueSessionUpdate: updateType=${updateType}`)
                            pushSessionUpdateEvents(remaining, 'tailDrain')
                            remaining = clientManager.dequeueSessionUpdate(sessionId!)
                        }
                        if (drainedAny) continue

                        const waitAbort = new AbortController()
                        const timer = setTimeout(() => waitAbort.abort(), ACP_TAIL_DRAIN_IDLE_MS)
                        try {
                            const notification = await clientManager.waitForSessionUpdate(sessionId!, { signal: waitAbort.signal })
                            pushSessionUpdateEvents(notification, 'tailDrain')
                        } catch {
                            break
                        } finally {
                            clearTimeout(timer)
                        }
                    }
                    console.error(`[acp:${this.name}] Tail drain completed: sessionId=${sessionId} drainedUpdates=${tailDrainedUpdates} durationMs=${Date.now() - tailDrainStartedAt}`)
                }

                // 6. Push final result event based on stopReason
                // Also check stderr for fatal errors that the agent may have
                // emitted without reflecting in the ACP protocol response.
                const stderrError = clientManager.getStderrError()
                if (!events.done) {
                    const resultEvent = adaptStopReason(promptResponse.stopReason)
                    if (stderrError && resultEvent.status === 'success') {
                        // Agent wrote a fatal error to stderr but still returned
                        // a successful stop reason — override to error so the
                        // user actually sees what went wrong.
                        resultEvent.status = 'error'
                        resultEvent.summary = truncateErrorSummary(stderrError)
                    }
                    events.push(resultEvent)
                    events.end()
                }
            } catch (e) {
                updateConsumerAbort?.abort()
                if (e instanceof AcpSessionOpenTimeoutError) {
                    await this.closeTimedOutClient()
                }
                const summary = formatAgentQueryError(e, { provider: this.name, phase: 'query', sessionId })
                console.error(`[acp:${this.name}] Query failed: ${summary}`)
                if (!events.done) {
                    events.push({ kind: 'result', status: 'error', summary })
                    events.end()
                }
            } finally {
                this.activeSessionId = null
                this.activeAbortSignal = null
            }
        }

        void runQuery()

        let interruptPromise: Promise<void> | null = null
        const interrupt = async () => {
            interruptPromise ??= (async () => {
                queryCancelled = true
                try {
                    await this.forceCancelActivePrompt()
                } finally {
                    events.end()
                }
            })()
            return interruptPromise
        }

        // Handle abort signal
        if (config.signal) {
            this.activeAbortSignal = config.signal
            const onAbort = () => {
                void interrupt()
            }
            config.signal.addEventListener('abort', onAbort, { once: true })
        }

        const handle: AgentQueryHandle = {
            events,
            interrupt,
        }

        return handle
    }

    protected createExtensionHandler(_events: PushableAsyncIterable<AgentEvent>, _config: AgentQueryConfig): AcpExtensionHandler | null {
        return null
    }

    getAvailableModels(): ModelEntry[] {
        // Models are configured at the agent side, not exposed via ACP
        return []
    }

    getAvailablePermissionModes(): string[] {
        return ['default', 'acceptEdits', 'bypassPermissions']
    }

    clearSessionId(): void {
        // ACP manages session identity internally — no-op
    }

    /**
     * Cancel the active prompt with grace period.
     * 1. Send session/cancel and wait up to 2.5s for prompt to return
     * 2. If the agent does not respond, close the wedged ACP connection. A
     *    later query uses the provider's existing reinit path. Keeping the
     *    connection alive would allow the cancelled turn to accumulate an
     *    unbounded queue of updates with no consumer.
     */
    private async forceCancelActivePrompt(): Promise<void> {
        const clientManager = this.clientManager
        const sid = this.activeSessionId

        if (!sid && this.sessionOpenInProgress) {
            console.error(`[acp:${this.name}] Cancelling session startup by closing the ACP connection`)
            try {
                await clientManager.close()
            } catch (error) {
                console.error(`[acp:${this.name}] Failed to close ACP connection during session startup: ${error instanceof Error ? error.message : String(error)}`)
                clientManager.dispose()
            }
            this.sessionOpenInProgress = false
            return
        }

        if (sid) {
            console.error(`[acp:${this.name}] Cancelling active prompt for session ${sid}`)
            try {
                const response = await clientManager.cancelActivePrompt(2_500)
                if (response) {
                    console.error(`[acp:${this.name}] Prompt cancelled gracefully, stopReason=${response.stopReason}`)
                    return
                }
            } catch (e) {
                console.error(`[acp:${this.name}] cancelActivePrompt error: ${e instanceof Error ? e.message : String(e)}`)
            }

            console.error(`[acp:${this.name}] Agent did not respond to cancel within grace period; closing the ACP connection to discard the cancelled turn`)
            try {
                await clientManager.close()
            } catch (error) {
                console.error(`[acp:${this.name}] Failed to close unresponsive ACP connection: ${error instanceof Error ? error.message : String(error)}`)
                clientManager.dispose()
            }
            this.activeSessionId = null
        }
    }
}

function parseProviderTimestamp(value: string | null | undefined): number {
    if (!value) return 0
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0
}

function collectProviderHistoryMessages(
    notifications: readonly SessionNotification[],
): ProviderSessionHistory['messages'] {
    const messages: ProviderSessionHistory['messages'] = []
    const indexById = new Map<string, number>()
    let fallbackIndex = 0

    for (const notification of notifications) {
        const update = notification.update
        if (
            update.sessionUpdate !== 'user_message_chunk'
            && update.sessionUpdate !== 'agent_message_chunk'
        ) continue
        if (update.content.type !== 'text') continue
        const role = update.sessionUpdate === 'user_message_chunk' ? 'user' : 'assistant'
        const id = update.messageId?.trim() || `${role}-${fallbackIndex++}`
        const existingIndex = indexById.get(id)
        if (existingIndex === undefined) {
            indexById.set(id, messages.length)
            messages.push({ id, role, text: update.content.text })
        } else {
            messages[existingIndex] = {
                ...messages[existingIndex]!,
                text: `${messages[existingIndex]!.text}${update.content.text}`,
            }
        }
    }

    return messages
        .filter(message => message.text.length > 0)
        .slice(-256)
        .map(message => ({ ...message, text: message.text.slice(0, 16 * 1024) }))
}
