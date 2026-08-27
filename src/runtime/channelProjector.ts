import type {
    ChannelMessage,
    ChannelToolGroupPresentation,
    ChannelToolPresentationItem,
} from '@/bridge/channelPort'
import type { ConversationEvent } from './semantic'
import { escapeHtml } from '@/utils/formatting'
import { formatToolBubble } from '@/channel/telegram/toolBubble'

export interface ProjectedMessage {
    message: ChannelMessage
    toolUseId?: string
    isToolEvent: boolean
    /** This message contains a flushed fragment of the current assistant turn. */
    isAssistantText?: boolean
    isTerminal: boolean
    /** Turn-boundary tool snapshot; durable chat transports may include deferred full detail. */
    isFinalToolSnapshot?: boolean
    semanticEvent?: ConversationEvent
}

export interface ChannelProjectorOptions {
    verboseLevel?: 0 | 1 | 2
    /** Keep normal-mode tools in one turn-scoped group across streamed text flushes. */
    preserveNormalToolGroup?: boolean
}

interface ProjectedToolState {
    toolName: string
    phase: 'started' | 'updated' | 'completed' | 'failed'
    input?: unknown
    output?: unknown
    isError?: boolean
    displayTitle?: string
    category?: 'read' | 'edit' | 'write' | 'execute' | 'search' | 'agent' | 'unknown'
    content?: Array<{ type: 'content'; contentType: string; text?: string } | { type: 'diff'; path?: string; oldText?: string; newText?: string } | { type: 'terminal'; terminalId?: string }>
    startedAt: number
    updatedAt: number
}

// The presentation layer uses a bounded 4 KiB invocation field. Preserve that
// full budget here so long commands remain inspectable instead of being
// permanently truncated before they reach the client.
const MAX_TOOL_DETAIL_CHARS = 4 * 1_024
const MAX_TOOL_COMMAND_CHARS = 4 * 1_024
const MAX_TOOL_PLAN_CHARS = 8 * 1_024
const MAX_TOOL_TODO_ITEMS = 32
const MAX_TOOL_TODO_CONTENT_CHARS = 256

export class ChannelProjector {
    private textBuffer = ''
    private toolStates = new Map<string, ProjectedToolState>()
    private normalToolGroupKey: string | null = null
    private normalToolGroupIndex = 0
    private normalToolGroupToolIds: string[] = []

    project(event: ConversationEvent, options: ChannelProjectorOptions = {}): ProjectedMessage[] {
        switch (event.kind) {
            case 'assistant_text_delta':
                this.textBuffer += event.text
                return []

            case 'tool':
                return this.projectToolByVerbosity(event, options)

            case 'decision_request':
                return [
                    ...this.flushText(event, true, true),
                    {
                        message: {
                            text: `<b>${escapeHtml(event.title)}</b>${event.body ? `\n\n${escapeHtml(event.body)}` : ''}`,
                            format: 'html',
                            replyMarkup: {
                                inline_keyboard: [
                                    event.options.map(option => ({
                                        text: option.label,
                                        callback_data: `decision:${event.decisionId}:${option.id}`,
                                    })),
                                ],
                            },
                        },
                        isToolEvent: false,
                        isTerminal: false,
                        semanticEvent: event,
                    },
                ]

            case 'mode_change':
                return [
                    ...this.flushText(event, true, true),
                    {
                        message: { text: `Mode: <code>${escapeHtml(event.mode)}</code>`, format: 'html' },
                        isToolEvent: false,
                        isTerminal: false,
                        semanticEvent: event,
                    },
                ]

            case 'command_result':
                // Suppress messages for available_commands_update and config_option_update
                const commandLower = event.command.toLowerCase()
                if (commandLower.includes('available_commands') || commandLower.includes('commands_update') || commandLower.includes('config_option')) {
                    return []
                }
                const commandText = formatCommandResult(event.command, event.output)
                if (!commandText) return this.flushText(event, true, true)
                return [
                    ...this.flushText(event, true, true),
                    {
                        message: {
                            text: commandText,
                            format: 'html',
                        },
                        isToolEvent: false,
                        isTerminal: false,
                        semanticEvent: event,
                    },
                ]

            case 'turn_finished':
                return this.projectTurnFinished(event, options)

            case 'turn_started':
            case 'provider_raw':
                return []
        }
    }

    flush(
        semanticEvent?: ConversationEvent,
        closeNormalToolGroup = true,
        discardWhitespaceOnlyText = false,
    ): ProjectedMessage[] {
        return this.flushText(
            semanticEvent,
            closeNormalToolGroup,
            closeNormalToolGroup,
            discardWhitespaceOnlyText,
        )
    }

    statusMessage(text: string): ProjectedMessage {
        return {
            message: { text, format: 'html' },
            isToolEvent: false,
            isTerminal: false,
        }
    }

    reset(): void {
        this.textBuffer = ''
        this.toolStates.clear()
        this.normalToolGroupKey = null
        this.normalToolGroupIndex = 0
        this.normalToolGroupToolIds = []
    }

    private flushText(
        semanticEvent?: ConversationEvent,
        closeNormalToolGroup = true,
        closeEmptyToolGroup = false,
        discardWhitespaceOnlyText = false,
    ): ProjectedMessage[] {
        const text = this.textBuffer
        if (!text.trim()) {
            if (discardWhitespaceOnlyText) this.textBuffer = ''
            if (closeEmptyToolGroup) this.closeNormalToolGroup()
            return []
        }
        this.textBuffer = ''
        if (closeNormalToolGroup) this.closeNormalToolGroup()
        return [{
            message: { text, format: 'markdown' },
            isToolEvent: false,
            isAssistantText: true,
            isTerminal: semanticEvent?.kind === 'turn_finished',
            semanticEvent,
        }]
    }

    private projectToolByVerbosity(event: Extract<ConversationEvent, { kind: 'tool' }>, options: ChannelProjectorOptions): ProjectedMessage[] {
        const verboseLevel = options.verboseLevel ?? 1
        const messages = this.flushText(
            undefined,
            !options.preserveNormalToolGroup,
            false,
        )
        if (verboseLevel === 0) {
            const state = this.mergeToolState(event)
            if (isExitPlanModeTool(state) && hasExitPlanContent(state)) {
                messages.push({
                    message: {
                        text: this.formatToolState(state),
                        format: 'html',
                        presentation: this.toolGroupPresentation(
                            event.toolCallId,
                            [event.toolCallId],
                        ),
                    },
                    toolUseId: event.toolCallId,
                    isToolEvent: true,
                    isTerminal: event.phase === 'completed' || event.phase === 'failed',
                    semanticEvent: withMergedToolContent(event, state),
                })
            }
            return messages
        }

        if (verboseLevel === 1) {
            messages.push(this.projectNormalToolGroup(
                event,
                Boolean(options.preserveNormalToolGroup),
            ))
            return messages
        }

        messages.push(this.projectVerboseTool(event))
        return messages
    }

    private projectNormalToolGroup(
        event: Extract<ConversationEvent, { kind: 'tool' }>,
        deferCompletionToTurnBoundary: boolean,
    ): ProjectedMessage {
        const groupKey = this.ensureNormalToolGroup()
        const state = this.mergeToolState(event)
        if (!this.normalToolGroupToolIds.includes(event.toolCallId)) {
            this.normalToolGroupToolIds.push(event.toolCallId)
        }

        return {
            message: {
                text: this.formatToolState(state),
                format: 'html',
                presentation: this.toolGroupPresentation(
                    groupKey,
                    this.normalToolGroupToolIds,
                ),
            },
            toolUseId: groupKey,
            isToolEvent: true,
            // A completed tool call is not the turn boundary. Keeping these
            // edits progressive lets DeliveryOutbox replace the whole burst
            // with the final turn-scoped snapshot before Matrix staging.
            isTerminal: !deferCompletionToTurnBoundary
                && (event.phase === 'completed' || event.phase === 'failed'),
            semanticEvent: withMergedToolContent(event, state),
        }
    }

    private ensureNormalToolGroup(): string {
        if (!this.normalToolGroupKey) {
            this.normalToolGroupKey = `normal-tool-group:${++this.normalToolGroupIndex}`
            this.normalToolGroupToolIds = []
        }
        return this.normalToolGroupKey
    }

    private closeNormalToolGroup(): void {
        this.normalToolGroupKey = null
        this.normalToolGroupToolIds = []
    }

    private projectTurnFinished(
        event: Extract<ConversationEvent, { kind: 'turn_finished' }>,
        options: ChannelProjectorOptions,
    ): ProjectedMessage[] {
        const messages = [
            ...this.settleDanglingTools(event, options),
            ...this.flushText(event, true, true),
        ]
        if (event.status === 'success') return messages

        messages.push({
            message: {
                text: this.formatTurnFinishedStatus(event),
                format: 'html',
            },
            isToolEvent: false,
            isTerminal: true,
            semanticEvent: event,
        })
        return messages
    }

    private settleDanglingTools(
        event: Extract<ConversationEvent, { kind: 'turn_finished' }>,
        options: ChannelProjectorOptions,
    ): ProjectedMessage[] {
        if (!options.preserveNormalToolGroup) return []
        const dangling = [...this.toolStates.entries()].filter(([, state]) =>
            state.phase === 'started' || state.phase === 'updated'
        )
        const phase = event.status === 'success' ? 'completed' : 'failed'
        for (const [toolCallId, state] of dangling) {
            this.toolStates.set(toolCallId, {
                ...state,
                phase,
                isError: phase === 'failed' ? true : state.isError,
                updatedAt: event.meta.timestamp,
            })
        }

        const verboseLevel = options.verboseLevel ?? 1
        if (verboseLevel === 0) return []

        if (verboseLevel === 1 && this.normalToolGroupKey) {
            const groupKey = this.normalToolGroupKey
            const latestToolId = this.normalToolGroupToolIds.at(-1)
            const latestState = latestToolId
                ? this.toolStates.get(latestToolId)
                : undefined
            if (!latestState) return []
            return [{
                message: {
                    text: this.formatToolState(latestState),
                    format: 'html',
                    presentation: this.toolGroupPresentation(
                        groupKey,
                        this.normalToolGroupToolIds,
                    ),
                },
                toolUseId: groupKey,
                isToolEvent: true,
                isTerminal: true,
                isFinalToolSnapshot: true,
                semanticEvent: event,
            }]
        }

        return dangling.map(([toolCallId]) => {
            const state = this.toolStates.get(toolCallId)!
            return {
                message: {
                    text: this.formatToolState(state),
                    format: 'html' as const,
                    presentation: this.toolGroupPresentation(
                        toolCallId,
                        [toolCallId],
                    ),
                },
                toolUseId: toolCallId,
                isToolEvent: true,
                isTerminal: true,
                semanticEvent: event,
            }
        })
    }

    private formatTurnFinishedStatus(event: Extract<ConversationEvent, { kind: 'turn_finished' }>): string {
        const summary = event.summary?.trim()
        const detail = summary ? `\n<pre>${escapeHtml(summary)}</pre>` : `\n<code>${escapeHtml(event.status)}</code>`

        switch (event.status) {
            case 'cancelled':
                return `⏹️ <b>Task interrupted</b>${detail}`
            case 'max_turns':
                return `⚠️ <b>Task stopped: max turns reached</b>${detail}`
            case 'error':
            default:
                return `❌ <b>Agent error</b>${detail}`
        }
    }

    private projectVerboseTool(event: Extract<ConversationEvent, { kind: 'tool' }>): ProjectedMessage {
        const state = this.mergeToolState(event)
        return {
            message: {
                text: this.formatToolState(state),
                format: 'html',
                presentation: this.toolGroupPresentation(
                    event.toolCallId,
                    [event.toolCallId],
                ),
            },
            toolUseId: event.toolCallId,
            isToolEvent: true,
            isTerminal: event.phase === 'completed' || event.phase === 'failed',
            semanticEvent: withMergedToolContent(event, state),
        }
    }

    private mergeToolState(event: Extract<ConversationEvent, { kind: 'tool' }>): ProjectedToolState {
        const existing = this.toolStates.get(event.toolCallId)

        // Patch merge: preserve canonical toolName from initial event
        // Only use event.toolName if it's a known canonical name, otherwise keep existing
        let toolName: string
        if (existing?.toolName && !isGenericToolName(existing.toolName)) {
            toolName = existing.toolName
        } else if (event.toolName && !isGenericToolName(event.toolName)) {
            toolName = event.toolName
        } else {
            toolName = existing?.toolName || event.toolName || 'tool_call'
        }

        // Merge input: prefer current event's input, fall back to existing
        const input = event.input !== undefined ? event.input : existing?.input

        // Merge output/error so terminal patches can enrich an existing started event.
        const output = event.output !== undefined ? event.output : existing?.output
        const isError = event.isError ?? existing?.isError

        // Merge displayTitle: prefer the latest descriptive title/path.
        const displayTitle = event.displayTitle ?? existing?.displayTitle

        // Merge category
        const category = event.category ?? existing?.category

        // Merge content blocks
        const content = event.content ?? existing?.content

        // Save merged state
        const state = {
            toolName,
            phase: event.phase,
            input,
            output,
            isError,
            displayTitle,
            category,
            content,
            startedAt: existing?.startedAt ?? event.meta.timestamp,
            updatedAt: event.meta.timestamp,
        }
        this.toolStates.set(event.toolCallId, state)
        return state
    }

    private toolGroupPresentation(
        groupId: string,
        toolCallIds: readonly string[],
    ): ChannelToolGroupPresentation {
        return {
            kind: 'tool_group',
            version: 1,
            groupId,
            tools: toolCallIds.flatMap((toolCallId) => {
                const state = this.toolStates.get(toolCallId)
                return state ? [toolPresentationItem(toolCallId, state)] : []
            }),
        }
    }

    private formatToolState(state: ProjectedToolState): string {
        const status = state.phase === 'failed'
            ? 'interrupted'
            : state.phase === 'completed'
                ? 'completed'
                : state.phase === 'updated'
                    ? 'running'
                    : 'pending'

        // Build effective tool name for display
        // Use toolName for canonical tools, displayTitle for path-like titles
        // If toolName is generic (tool_call/tool), use displayTitle if available
        const exitPlan = isExitPlanModeTool(state)
        const boundedDisplayTitle = state.displayTitle
            ? boundedPresentationText(
                state.displayTitle,
                exitPlan ? MAX_TOOL_PLAN_CHARS : MAX_TOOL_DETAIL_CHARS,
            )
            : undefined
        let effectiveToolName = boundedPresentationText(state.toolName, 128)
        if (isGenericToolName(state.toolName) && boundedDisplayTitle) {
            effectiveToolName = boundedDisplayTitle
        }

        const rendered = formatToolBubble({
            toolName: effectiveToolName,
            input: boundedToolInput(state),
            status,
            output: allowedToolOutput(state),
            isError: state.isError,
            displayTitle: boundedDisplayTitle,
            category: state.category,
            content: boundedToolContent(state),
        })
        const changeSummary = toolChangeSummary(state)
        return changeSummary ? `${rendered}\n${changeSummary}` : rendered
    }
}

function toolPresentationItem(
    toolCallId: string,
    state: ProjectedToolState,
): ChannelToolPresentationItem {
    const name = isGenericToolName(state.toolName) && state.displayTitle
        ? state.displayTitle
        : state.toolName
    const detail = toolPresentationDetail(state)
    return {
        id: toolCallId,
        name,
        title: state.displayTitle ?? name,
        ...(detail ? { detail } : {}),
        category: state.category ?? 'unknown',
        phase: state.phase,
        isError: state.phase === 'failed' || Boolean(state.isError),
        startedAt: state.startedAt,
        updatedAt: state.updatedAt,
    }
}

function toolPresentationDetail(state: ProjectedToolState): string | undefined {
    const input = asRecord(state.input) ?? undefined
    const value = state.displayTitle
        ?? pickInputText(input, detailKeysForTool(state.toolName, state.category))
        ?? (typeof state.input === 'string' ? state.input : undefined)
    const detail = value?.trim()
        ? boundedPresentationText(value, MAX_TOOL_DETAIL_CHARS)
        : undefined
    const changeSummary = toolChangeSummary(state)
    return [detail, changeSummary].filter(Boolean).join(' · ') || undefined
}

function detailKeysForTool(
    toolName: string,
    category: ProjectedToolState['category'],
): string[] {
    const normalized = toolName.toLowerCase()
    if (category === 'execute' || ['bash', 'shell', 'terminal'].includes(normalized)) {
        return ['command', 'cmd', 'script']
    }
    if (
        category === 'read'
        || category === 'edit'
        || category === 'write'
        || ['read', 'edit', 'write'].includes(normalized)
    ) {
        return ['file_path', 'filePath', 'path', 'target_file', 'targetFile']
    }
    if (category === 'search') {
        return ['query', 'pattern', 'regex', 'glob', 'url']
    }
    if (category === 'agent') {
        return ['description', 'prompt', 'task']
    }
    return ['description', 'command', 'query', 'path', 'file_path']
}

function pickInputText(
    input: Record<string, unknown> | undefined,
    keys: readonly string[],
): string | undefined {
    if (!input) return undefined
    for (const key of keys) {
        const value = input[key]
        if (typeof value === 'string' && value.trim()) return value.trim()
    }
    return undefined
}

function normalizePresentationText(value: string): string {
    return value.replace(/\r\n?/gu, '\n').trimEnd()
}

function boundedPresentationText(value: string, limit: number): string {
    const normalized = normalizePresentationText(value).trim()
    return normalized.length > limit
        ? `${normalized.slice(0, Math.max(0, limit - 1))}…`
        : normalized
}

function boundedToolInput(state: ProjectedToolState): Record<string, unknown> | undefined {
    const input = asRecord(state.input)
    if (!input) return undefined
    const bounded: Record<string, unknown> = {}
    const stringLimits: Record<string, number> = {
        command: MAX_TOOL_COMMAND_CHARS,
        cmd: MAX_TOOL_COMMAND_CHARS,
        script: MAX_TOOL_COMMAND_CHARS,
        file_path: MAX_TOOL_DETAIL_CHARS,
        filePath: MAX_TOOL_DETAIL_CHARS,
        path: MAX_TOOL_DETAIL_CHARS,
        target_file: MAX_TOOL_DETAIL_CHARS,
        targetFile: MAX_TOOL_DETAIL_CHARS,
        pattern: MAX_TOOL_DETAIL_CHARS,
        query: MAX_TOOL_DETAIL_CHARS,
        regex: MAX_TOOL_DETAIL_CHARS,
        glob: MAX_TOOL_DETAIL_CHARS,
        url: MAX_TOOL_DETAIL_CHARS,
        description: MAX_TOOL_DETAIL_CHARS,
        prompt: MAX_TOOL_DETAIL_CHARS,
        task: MAX_TOOL_DETAIL_CHARS,
        name: MAX_TOOL_DETAIL_CHARS,
        subagent_type: 128,
        plan: MAX_TOOL_PLAN_CHARS,
        content: MAX_TOOL_PLAN_CHARS,
    }
    for (const [key, limit] of Object.entries(stringLimits)) {
        const value = input[key]
        if (typeof value === 'string') bounded[key] = boundedPresentationText(value, limit)
    }
    if (Array.isArray(input.todos)) {
        bounded.todos = input.todos.slice(0, MAX_TOOL_TODO_ITEMS).flatMap((value) => {
            const todo = asRecord(value)
            if (!todo || typeof todo.content !== 'string') return []
            return [{
                content: boundedPresentationText(todo.content, MAX_TOOL_TODO_CONTENT_CHARS),
                status: typeof todo.status === 'string' ? todo.status : 'pending',
            }]
        })
    }
    return bounded
}

function boundedToolContent(state: ProjectedToolState): ProjectedToolState['content'] {
    return state.content?.map((item) => {
        if (item.type === 'diff') {
            return {
                type: 'diff' as const,
                ...(item.path
                    ? { path: boundedPresentationText(item.path, MAX_TOOL_DETAIL_CHARS) }
                    : {}),
            }
        }
        if (item.type === 'content') {
            return {
                type: 'content' as const,
                contentType: boundedPresentationText(item.contentType, 128),
                ...(isExitPlanModeTool(state) && item.text
                    ? { text: boundedPresentationText(item.text, MAX_TOOL_PLAN_CHARS) }
                    : {}),
            }
        }
        return {
            type: 'terminal' as const,
            ...(item.terminalId
                ? { terminalId: boundedPresentationText(item.terminalId, 256) }
                : {}),
        }
    })
}

function toolChangeSummary(state: ProjectedToolState): string | undefined {
    const normalizedName = state.toolName.toLowerCase()
    if (
        state.category !== 'edit'
        && state.category !== 'write'
        && normalizedName !== 'edit'
        && normalizedName !== 'write'
        && normalizedName !== 'edit_file'
        && normalizedName !== 'write_file'
    ) return undefined

    const diffs = state.content?.filter((item): item is Extract<NonNullable<ProjectedToolState['content']>[number], { type: 'diff' }> =>
        item.type === 'diff'
    ) ?? []
    if (diffs.length === 0) return undefined
    const changes = diffs.map(diff => changedLineCounts(diff.oldText, diff.newText))
    const added = changes.reduce((total, change) => total + change.added, 0)
    const deleted = changes.reduce((total, change) => total + change.deleted, 0)
    const files = new Set(diffs.flatMap(diff => diff.path ? [diff.path] : [])).size
    const fileLabel = files > 1 ? `${files} files · ` : ''
    return `${fileLabel}+${added} -${deleted} lines`
}

function changedLineCounts(
    oldText: string | undefined,
    newText: string | undefined,
): { added: number; deleted: number } {
    const oldLines = textLines(oldText)
    const newLines = textLines(newText)
    let prefix = 0
    while (
        prefix < oldLines.length
        && prefix < newLines.length
        && oldLines[prefix] === newLines[prefix]
    ) prefix += 1

    let suffix = 0
    while (
        suffix < oldLines.length - prefix
        && suffix < newLines.length - prefix
        && oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
    ) suffix += 1

    return {
        added: newLines.length - prefix - suffix,
        deleted: oldLines.length - prefix - suffix,
    }
}

function textLines(value: string | undefined): string[] {
    if (!value) return []
    const normalized = value.replace(/\r\n?/gu, '\n')
    const lines = normalized.split('\n')
    if (normalized.endsWith('\n')) lines.pop()
    return lines
}

function isGenericToolName(toolName: string | undefined): boolean {
    return !toolName || toolName === 'tool' || toolName === 'tool_call'
}

function withMergedToolContent(
    event: Extract<ConversationEvent, { kind: 'tool' }>,
    state: ProjectedToolState,
): Extract<ConversationEvent, { kind: 'tool' }> {
    return state.content && state.content !== event.content ? { ...event, content: state.content } : event
}

function allowedToolOutput(state: ProjectedToolState): string | undefined {
    if (isExitPlanModeTool(state) && typeof state.output === 'string') {
        return boundedPresentationText(state.output, MAX_TOOL_PLAN_CHARS)
    }
    if (state.category !== 'search' || typeof state.output !== 'string') return undefined
    const output = state.output.trim()
    return /^\d+ (matches|match|files|file)( \(truncated\))?$/.test(output) ? output : undefined
}

function isExitPlanModeTool(state: ProjectedToolState): boolean {
    return state.toolName === 'ExitPlanMode' || state.toolName === 'exit_plan_mode'
}

function hasExitPlanContent(state: ProjectedToolState): boolean {
    if (!isExitPlanModeTool(state)) return false
    if (typeof state.output === 'string' && state.output.trim()) return true
    if (typeof state.displayTitle === 'string' && state.displayTitle.trim()) return true
    const input = state.input as Record<string, unknown> | undefined
    return typeof input?.plan === 'string' && input.plan.trim().length > 0
        || typeof input?.content === 'string' && input.content.trim().length > 0
}

function formatUnknown(value: unknown): string {
    if (typeof value === 'string') return value
    try {
        return JSON.stringify(value, null, 2)
    } catch {
        return String(value)
    }
}

function formatCommandResult(command: string, output: unknown): string | null {
    const commandLower = command.toLowerCase()

    // available_commands_update: show as a list of commands
    if (commandLower.includes('available_commands') || commandLower.includes('commands_update')) {
        const commands = Array.isArray(output) ? output : []
        if (commands.length === 0) {
            return '💡 Provider commands updated (0 available). Use /help to see them.'
        }
        const lines = commands.map((cmd: any) => {
            const name = cmd.name || cmd.command || 'unknown'
            const desc = cmd.description || ''
            const hint = cmd.inputHint || cmd.input?.hint || ''
            const prefix = String(name).startsWith('/') ? '' : '/'
            return `• <code>${prefix}${escapeHtml(String(name))}</code>${desc ? ` - ${escapeHtml(String(desc))}` : ''}${hint ? ` <i>(${escapeHtml(String(hint))})</i>` : ''}`
        })
        return `💡 Provider commands updated (${commands.length} available). Use /help to see them.\n${lines.join('\n')}`
    }

    // plan: show plan content
    if (commandLower === 'plan') {
        const entriesText = formatPlanEntries(output)
        if (entriesText) return entriesText

        const planText = extractPlanContent(output)
        if (planText) {
            return `<b>📋 Plan</b>\n${escapeHtml(planText)}`
        }
        return null
    }

    // usage_update: show token/cost info
    if (commandLower.includes('usage')) {
        const usage = asRecord(output)
        if (usage) {
            const parts: string[] = ['<b>📊 Usage</b>']
            const inputTokens = usage.inputTokens ?? usage.input_tokens ?? usage.promptTokens ?? usage.prompt_tokens
            const outputTokens = usage.outputTokens ?? usage.output_tokens ?? usage.completionTokens ?? usage.completion_tokens
            const totalTokens = usage.totalTokens ?? usage.total_tokens
            const cost = usage.costUSD ?? usage.costUsd ?? usage.cost_usd ?? usage.totalCost ?? usage.total_cost
            if (inputTokens !== undefined || outputTokens !== undefined) {
                parts.push(`Tokens: ${inputTokens ?? 0} in / ${outputTokens ?? 0} out`)
            }
            if (totalTokens !== undefined) {
                parts.push(`Total: ${totalTokens}`)
            }
            if (cost !== undefined) {
                parts.push(`Cost: $${cost}`)
            }
            if (parts.length === 1) parts.push('Updated')
            return parts.join('\n')
        }
    }

    // session_info_update: show session info
    if (commandLower.includes('session_info')) {
        const info = asRecord(output)
        if (info) {
            const parts: string[] = ['<b>ℹ️ Session Info</b>']
            if (info.model) parts.push(`Model: <code>${escapeHtml(String(info.model))}</code>`)
            if (info.cwd) parts.push(`CWD: <code>${escapeHtml(String(info.cwd))}</code>`)
            if (info.sessionId) parts.push(`Session: <code>${escapeHtml(String(info.sessionId))}</code>`)
            return parts.join('\n')
        }
    }

    // config_option_update: show config changes
    if (commandLower.includes('config_option')) {
        // Try to extract configOptions array from output
        let configArray: Array<{ name?: string; value?: unknown; description?: string }> = []

        if (Array.isArray(output)) {
            configArray = output as Array<{ name?: string; value?: unknown; description?: string }>
        } else {
            const record = asRecord(output)
            if (record) {
                // Try common field names for config options array
                const options = record.configOptions ?? record.options ?? record.config
                if (Array.isArray(options)) {
                    configArray = options as Array<{ name?: string; value?: unknown; description?: string }>
                }
            }
        }

        if (configArray.length > 0) {
            const parts: string[] = ['<b>⚙️ Config Update</b>']
            for (const opt of configArray) {
                const name = opt.name ?? 'unknown'
                const value = opt.value !== undefined ? String(opt.value) : ''
                const desc = opt.description ? ` - ${opt.description}` : ''
                parts.push(`• ${escapeHtml(name)}: <code>${escapeHtml(value)}</code>${desc ? ` ${escapeHtml(desc)}` : ''}`)
            }
            return parts.join('\n')
        }

        // Fallback: don't dump JSON, just show a short message
        return '⚙️ <b>Config updated</b>'
    }

    // Default: fallback to JSON dump with proper escaping
    return `<b>${escapeHtml(command)}</b>\n<pre>${escapeHtml(formatUnknown(output))}</pre>`
}

function extractPlanContent(output: unknown): string | null {
    if (typeof output === 'string') return output
    const record = asRecord(output)
    if (!record) return null

    // Try common field names for plan content
    const content = record.content || record.text || record.description || record.plan
    if (typeof content === 'string') return content

    // If output has options (decision request), don't try to extract plan
    if (record.options || record.choices) return null

    return null
}

function formatPlanEntries(output: unknown): string | null {
    const record = asRecord(output)
    const entries = Array.isArray(record?.entries) ? record.entries : undefined
    if (!entries) return null

    const lines = entries.flatMap((entry) => {
        const item = asRecord(entry)
        const content = typeof item?.content === 'string' ? item.content.trim() : ''
        if (!content) return []
        return `${planEntryStatusIcon(item?.status)} ${escapeHtml(content)}`
    })

    if (lines.length === 0) return null
    return `<b>📋 Tasks</b>\n${lines.join('\n')}`
}

function planEntryStatusIcon(status: unknown): string {
    switch (status) {
        case 'completed':
            return '✅'
        case 'in_progress':
            return '🔄'
        case 'cancelled':
            return '⏹️'
        case 'pending':
        default:
            return '⬜'
    }
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' ? value as Record<string, unknown> : null
}
