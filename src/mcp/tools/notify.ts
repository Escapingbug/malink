/**
 * MCP Notify Tools — schedule_reminder, cancel_reminder, send_message, send_file
 * 
 * These tools allow the agent to proactively schedule reminders and send
 * messages. Reminder and message identity is provided via
 * MALINK_CONVERSATION_ID and uses the legacy daemon API. File delivery instead
 * uses MALINK_SESSION_ID plus the Gateway owner socket, so it is available on
 * the first turn and routes directly to SemanticSessionRuntime.
 *
 * Some agents (e.g. Cursor's `agent` CLI) don't support resumeSession, and their
 * loadSession only works after the session has been persisted (i.e. after at least
 * one prompt completes). For those agents, the flow is:
 *   1. newSession with base MCP config → get sessionId; send_file is available
 *   2. Skip Phase 2 → prompt directly (other session-scoped tools are unavailable)
 *   3. After prompt completes → loadSession with full MCP config
 *   4. On next turn, session-scoped tools are available
 * Other session-scoped tools remain unavailable until provider identity exists.
 */

import { z } from 'zod'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { readFileSync, existsSync } from 'node:fs'
import { GatewayAdminClient } from '@/gateway/admin/client'
import {
    MCP_RUNTIME_FILE_DELIVERY_HANDLED,
    MCP_RUNTIME_FILE_DELIVERY_UNAVAILABLE,
} from '@/runtime/mcpFileDelivery'

/** Read the daemon API port from the well-known file */
function getDaemonApiPort(): number | null {
    const portFile = join(homedir(), '.config', 'malink', 'daemon.api.port')
    if (!existsSync(portFile)) return null
    try {
        return parseInt(readFileSync(portFile, 'utf-8').trim(), 10)
    } catch {
        return null
    }
}

interface ReminderApiInfo {
    taskId: string
    triggerAt: number
    message: string
    context?: string
    recurringMs?: number
}

interface ListRemindersApiResponse {
    reminders?: ReminderApiInfo[]
}

interface CancelReminderApiResponse {
    ok?: boolean
    cancelledCount?: number
    taskIds?: string[]
}

export function createScheduleReminderHandler() {
    return async (args: { delayMs: number; message: string; context?: string; recurringMs?: number }) => {
        const apiPort = getDaemonApiPort()
        if (!apiPort) {
            return {
                isError: true,
                content: [{ type: 'text' as const, text: 'Daemon API not available. Is the malink daemon running?' }],
            }
        }

        // Session identity comes from env, injected by AcpProvider during loadSession/resumeSession.
        // See buildMalinkMcpFullConfig() in src/providers/acp/index.ts.
        // On the first turn of a new session, this env var may not be set yet because
        // some agents (e.g. Cursor's `agent` CLI) only support loadSession after the
        // session has been persisted (i.e. after the first prompt completes).
        const conversationId = process.env.MALINK_CONVERSATION_ID
        if (!conversationId) {
            return {
                isError: true,
                content: [{ type: 'text' as const, text: 'Session identity not available yet. Schedule_reminder requires a session context that is established after the first turn. Please retry on the next message — it will be available then.' }],
            }
        }

        const triggerAt = Date.now() + args.delayMs
        const requestBody = {
            sessionId: conversationId,
            triggerAt,
            message: args.message,
            context: args.context,
            ...(args.recurringMs ? { recurringMs: args.recurringMs } : {}),
        }

        try {
            const res = await fetch(`http://127.0.0.1:${apiPort}/api/schedule`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(requestBody),
            })

            if (!res.ok) {
                const err = await res.text()
                return {
                    isError: true,
                    content: [{ type: 'text' as const, text: `Schedule failed: ${err}` }],
                }
            }

            const data = await res.json() as { taskId: string }
            const fireTime = new Date(triggerAt).toLocaleTimeString()
            const recurringNote = args.recurringMs
                ? ` (repeats every ${args.recurringMs / 1000}s)`
                : ''
            return {
                content: [{
                    type: 'text' as const,
                    text: `Reminder scheduled for ${fireTime}${recurringNote} (task ID: ${data.taskId}). Message: "${args.message}"`,
                }],
            }
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e)
            return {
                isError: true,
                content: [{ type: 'text' as const, text: `Failed to connect to daemon: ${msg}` }],
            }
        }
    }
}

function formatReminderLine(reminder: ReminderApiInfo): string {
    const repeat = reminder.recurringMs
        ? `repeats every ${reminder.recurringMs}ms`
        : 'one-shot'
    const context = reminder.context ? ` context="${reminder.context}"` : ''
    return `${reminder.taskId}: next=${new Date(reminder.triggerAt).toISOString()} ${repeat}${context} message="${reminder.message}"`
}

export function createListRemindersHandler() {
    return async (_args: Record<string, never> = {}) => {
        const apiPort = getDaemonApiPort()
        if (!apiPort) {
            return {
                isError: true,
                content: [{ type: 'text' as const, text: 'Daemon API not available.' }],
            }
        }

        const conversationId = process.env.MALINK_CONVERSATION_ID
        if (!conversationId) {
            return {
                isError: true,
                content: [{ type: 'text' as const, text: 'Session identity not available yet. List_reminders requires a session context that is established after the first turn. Please retry on the next message.' }],
            }
        }

        try {
            const res = await fetch(`http://127.0.0.1:${apiPort}/api/reminders`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sessionId: conversationId }),
            })

            if (!res.ok) {
                const err = await res.text()
                return {
                    isError: true,
                    content: [{ type: 'text' as const, text: `List reminders failed: ${err}` }],
                }
            }

            const data = await res.json() as ListRemindersApiResponse
            const reminders = data.reminders ?? []
            if (reminders.length === 0) {
                return {
                    content: [{ type: 'text' as const, text: 'No pending reminders for this session.' }],
                }
            }

            return {
                content: [{ type: 'text' as const, text: `Pending reminders:\n${reminders.map(formatReminderLine).join('\n')}` }],
            }
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e)
            return {
                isError: true,
                content: [{ type: 'text' as const, text: `Failed to connect to daemon: ${msg}` }],
            }
        }
    }
}

export function createCancelReminderHandler() {
    return async (args: { taskId?: string; all?: boolean }) => {
        const apiPort = getDaemonApiPort()
        if (!apiPort) {
            return {
                isError: true,
                content: [{ type: 'text' as const, text: 'Daemon API not available.' }],
            }
        }

        if (!args.taskId && !args.all) {
            return {
                isError: true,
                content: [{ type: 'text' as const, text: 'Cancel_reminder requires taskId, or all=true to cancel all pending reminders for this session. Use list_reminders to discover task IDs.' }],
            }
        }

        const requestBody: { taskId?: string; sessionId?: string; all?: boolean } = {}
        if (args.taskId) {
            requestBody.taskId = args.taskId
        } else {
            const conversationId = process.env.MALINK_CONVERSATION_ID
            if (!conversationId) {
                return {
                    isError: true,
                    content: [{ type: 'text' as const, text: 'Session identity not available yet. Cancelling all reminders requires a session context that is established after the first turn. Please retry on the next message.' }],
                }
            }
            requestBody.sessionId = conversationId
            requestBody.all = true
        }

        try {
            const res = await fetch(`http://127.0.0.1:${apiPort}/api/cancel`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(requestBody),
            })

            if (!res.ok) {
                const err = await res.text()
                return {
                    isError: true,
                    content: [{ type: 'text' as const, text: `Cancel failed: ${err}` }],
                }
            }

            const data = await res.json() as CancelReminderApiResponse
            const cancelledCount = data.cancelledCount ?? (data.ok === false ? 0 : 1)
            if (cancelledCount === 0) {
                return {
                    isError: true,
                    content: [{ type: 'text' as const, text: args.taskId ? `No pending reminder found for ${args.taskId}.` : 'No pending reminders found for this session.' }],
                }
            }

            if (args.all) {
                const ids = data.taskIds?.length ? ` (${data.taskIds.join(', ')})` : ''
                return {
                    content: [{ type: 'text' as const, text: `Cancelled ${cancelledCount} reminder(s) for this session${ids}.` }],
                }
            }

            return {
                content: [{ type: 'text' as const, text: `Reminder ${args.taskId} cancelled.` }],
            }
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e)
            return {
                isError: true,
                content: [{ type: 'text' as const, text: `Failed to connect to daemon: ${msg}` }],
            }
        }
    }
}

export function createSendMessageHandler() {
    return async (args: { message: string }) => {
        const apiPort = getDaemonApiPort()
        if (!apiPort) {
            return {
                isError: true,
                content: [{ type: 'text' as const, text: 'Daemon API not available.' }],
            }
        }

        const conversationId = process.env.MALINK_CONVERSATION_ID
        if (!conversationId) {
            return {
                isError: true,
                content: [{ type: 'text' as const, text: 'Session identity not available yet. Send_message requires a session context that is established after the first turn. Please retry on the next message — it will be available then.' }],
            }
        }

        try {
            const res = await fetch(`http://127.0.0.1:${apiPort}/api/send`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sessionId: conversationId, message: args.message }),
            })

            if (!res.ok) {
                const err = await res.text()
                return {
                    isError: true,
                    content: [{ type: 'text' as const, text: `Send failed: ${err}` }],
                }
            }

            return {
                content: [{ type: 'text' as const, text: `Message sent: "${args.message}"` }],
            }
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e)
            return {
                isError: true,
                content: [{ type: 'text' as const, text: `Failed to connect to daemon: ${msg}` }],
            }
        }
    }
}

type SendFileType = 'document' | 'file' | 'markdown' | 'code' | 'image'

interface SendFileApiResponse {
    ok: boolean
    result?: {
        status?: string
        deliveryId?: string
        path?: string
        filename?: string
        type?: string
        message?: string
    }
}

interface McpTextToolResult {
    isError?: boolean
    content: Array<{ type: 'text'; text: string }>
}

export function createSendFileHandler(): (
    args: { path: string; caption?: string; filename?: string; type?: SendFileType; language?: string },
) => Promise<McpTextToolResult> {
    return async (args) => {
        const runtimeSessionId = process.env.MALINK_SESSION_ID?.trim()
        if (runtimeSessionId) {
            const socketPath = process.env.MALINK_GATEWAY_ADMIN_SOCKET?.trim()
            if (socketPath) {
                try {
                    const result = await new GatewayAdminClient({ socketPath }).sendSessionFile({
                        sessionId: runtimeSessionId,
                        path: args.path,
                        ...(args.caption ? { caption: args.caption } : {}),
                        ...(args.filename ? { filename: args.filename } : {}),
                        ...(args.type ? { type: args.type } : {}),
                        ...(args.language ? { language: args.language } : {}),
                    })
                    return formatRuntimeSendFileResult(args.path, result)
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error)
                    return runtimeFileDeliveryFallback(
                        `Gateway-local delivery was unavailable (${message}); the active session runtime will complete the request.`,
                    )
                }
            }
            return runtimeFileDeliveryFallback(
                'Gateway-local delivery is not configured; the active session runtime will complete the request.',
            )
        }

        const apiPort = getDaemonApiPort()
        if (!apiPort) {
            return {
                isError: true,
                content: [{ type: 'text' as const, text: 'Daemon API not available.' }],
            }
        }

        const conversationId = process.env.MALINK_CONVERSATION_ID
        if (!conversationId) {
            return {
                isError: true,
                content: [{ type: 'text' as const, text: 'Session identity not available yet. Send_file requires a session context that is established after the first turn. Please retry on the next message — it will be available then.' }],
            }
        }

        const requestBody = {
            sessionId: conversationId,
            path: args.path,
            ...(args.caption ? { caption: args.caption } : {}),
            ...(args.filename ? { filename: args.filename } : {}),
            ...(args.type ? { type: args.type } : {}),
            ...(args.language ? { language: args.language } : {}),
        }

        try {
            const res = await fetch(`http://127.0.0.1:${apiPort}/api/send-file`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(requestBody),
            })

            if (!res.ok) {
                const err = await res.text()
                return {
                    isError: true,
                    content: [{ type: 'text' as const, text: `Send file failed: ${err}` }],
                }
            }

            const data = await res.json() as SendFileApiResponse
            const result = data.result
            if (result?.status === 'queued' && result.deliveryId) {
                return {
                    content: [{
                        type: 'text' as const,
                        text: `File delivery queued: "${args.path}" (delivery ID: ${result.deliveryId}). The upload may still be in progress; call get_delivery_status with this delivery ID to check whether it is pending, queued, sent, or failed.`,
                    }],
                }
            }

            if (result?.status === 'failed') {
                return {
                    isError: true,
                    content: [{ type: 'text' as const, text: `Send file failed: ${result.message ?? 'unknown error'}` }],
                }
            }

            return {
                content: [{ type: 'text' as const, text: `File delivered: "${args.path}"` }],
            }
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e)
            return {
                isError: true,
                content: [{ type: 'text' as const, text: `Failed to connect to daemon: ${msg}` }],
            }
        }
    }
}

function formatRuntimeSendFileResult(
    path: string,
    result: NonNullable<Awaited<ReturnType<GatewayAdminClient['sendSessionFile']>>>,
): McpTextToolResult {
    const marker = MCP_RUNTIME_FILE_DELIVERY_HANDLED
    if (result.status === 'queued') {
        return {
            content: [{
                type: 'text' as const,
                text: `${marker}\nFile delivery queued: "${path}"${result.deliveryId ? ` (delivery ID: ${result.deliveryId})` : ''}.`,
            }],
        }
    }
    if (result.status === 'failed') {
        return {
            isError: true,
            content: [{
                type: 'text' as const,
                text: `${marker}\nSend file failed: ${result.message ?? 'unknown error'}`,
            }],
        }
    }
    return {
        content: [{ type: 'text' as const, text: `${marker}\nFile delivered: "${path}"` }],
    }
}

function runtimeFileDeliveryFallback(message: string): McpTextToolResult {
    return {
        content: [{
            type: 'text' as const,
            text: `${MCP_RUNTIME_FILE_DELIVERY_UNAVAILABLE}\n${message}`,
        }],
    }
}

export function createGetDeliveryStatusHandler() {
    return async (args: { deliveryId?: string; includeText?: boolean }) => {
        const apiPort = getDaemonApiPort()
        if (!apiPort) {
            return {
                isError: true,
                content: [{ type: 'text' as const, text: 'Daemon API not available.' }],
            }
        }

        const conversationId = process.env.MALINK_CONVERSATION_ID
        if (!conversationId) {
            return {
                isError: true,
                content: [{ type: 'text' as const, text: 'Session identity not available yet. Get_delivery_status requires a session context that is established after the first turn. Please retry on the next message.' }],
            }
        }

        try {
            const res = await fetch(`http://127.0.0.1:${apiPort}/api/delivery-status`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    sessionId: conversationId,
                    ...(args.deliveryId ? { deliveryId: args.deliveryId } : {}),
                    ...(args.includeText ? { includeText: true } : {}),
                }),
            })

            if (!res.ok) {
                const err = await res.text()
                return {
                    isError: true,
                    content: [{ type: 'text' as const, text: `Delivery status failed: ${err}` }],
                }
            }

            const data = await res.json() as {
                deliveries?: Array<{
                    id: string
                    kind: string
                    status: string
                    messageId?: string | number
                    createdAt: number
                    completedAt?: number
                    error?: string
                    textChars: number
                    text?: string
                    format?: string
                    retryOf?: string
                    resolvedBy?: string
                    resolvedAt?: number
                    attachments?: Array<{ type: string; path: string; filename?: string }>
                }>
            }
            const deliveries = data.deliveries ?? []
            if (deliveries.length === 0) {
                return {
                    content: [{ type: 'text' as const, text: args.deliveryId ? `No delivery found for ${args.deliveryId}.` : 'No deliveries found for this session.' }],
                }
            }

            const lines = deliveries.map(delivery => {
                const attachment = delivery.attachments?.[0]
                const target = attachment?.filename ?? attachment?.path ?? `${delivery.textChars} text chars`
                const completed = delivery.completedAt ? ` completed=${new Date(delivery.completedAt).toISOString()}` : ''
                const messageId = delivery.messageId !== undefined ? ` messageId=${delivery.messageId}` : ''
                const error = delivery.error ? ` error=${delivery.error}` : ''
                const retryOf = delivery.retryOf ? ` retryOf=${delivery.retryOf}` : ''
                const resolvedBy = delivery.resolvedBy ? ` resolvedBy=${delivery.resolvedBy}` : ''
                const resolvedAt = delivery.resolvedAt ? ` resolvedAt=${new Date(delivery.resolvedAt).toISOString()}` : ''
                const header = `${delivery.id}: ${delivery.status} ${target}${messageId}${completed}${retryOf}${resolvedBy}${resolvedAt}${error}`
                if (!args.includeText || delivery.text === undefined) return header
                return `${header}\nformat=${delivery.format ?? 'unknown'}\ntext:\n${delivery.text}`
            })
            return {
                content: [{ type: 'text' as const, text: `Delivery status:\n${lines.join('\n')}` }],
            }
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e)
            return {
                isError: true,
                content: [{ type: 'text' as const, text: `Failed to connect to daemon: ${msg}` }],
            }
        }
    }
}

export function createRetryDeliveryHandler() {
    return async (args: { deliveryId: string }) => {
        const apiPort = getDaemonApiPort()
        if (!apiPort) {
            return {
                isError: true,
                content: [{ type: 'text' as const, text: 'Daemon API not available.' }],
            }
        }

        const conversationId = process.env.MALINK_CONVERSATION_ID
        if (!conversationId) {
            return {
                isError: true,
                content: [{ type: 'text' as const, text: 'Session identity not available yet. Retry_delivery requires a session context that is established after the first turn. Please retry on the next message.' }],
            }
        }

        try {
            const res = await fetch(`http://127.0.0.1:${apiPort}/api/retry-delivery`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    sessionId: conversationId,
                    deliveryId: args.deliveryId,
                }),
            })

            if (!res.ok) {
                const err = await res.text()
                return {
                    isError: true,
                    content: [{ type: 'text' as const, text: `Retry delivery failed: ${err}` }],
                }
            }

            const result = await res.json() as {
                status: 'sent' | 'failed' | 'not_found'
                deliveryId?: string
                retryOf?: string
                messageId?: string | number
                message?: string
            }
            if (result.status === 'not_found') {
                return {
                    isError: true,
                    content: [{ type: 'text' as const, text: result.message ?? `No delivery found for ${args.deliveryId}.` }],
                }
            }
            if (result.status === 'failed') {
                return {
                    isError: true,
                    content: [{ type: 'text' as const, text: `Delivery retry failed for ${result.retryOf ?? args.deliveryId}: ${result.message ?? 'unknown error'}` }],
                }
            }

            const messageId = result.messageId !== undefined ? ` messageId=${result.messageId}` : ''
            return {
                content: [{ type: 'text' as const, text: `Delivery resent: ${result.retryOf ?? args.deliveryId} -> ${result.deliveryId ?? 'unknown'}${messageId}` }],
            }
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e)
            return {
                isError: true,
                content: [{ type: 'text' as const, text: `Failed to connect to daemon: ${msg}` }],
            }
        }
    }
}

/** Register all notify tools on an MCP server */
export function registerNotifyTools(server: any): void {
    server.tool(
        'schedule_reminder',
        'Schedule a timed reminder. When the timer fires, the agent will be invoked with the specified message. Can be one-shot or recurring.',
        {
            delayMs: z.number().positive().describe('Delay in milliseconds before the reminder fires'),
            message: z.string().describe('The message to inject when the reminder fires'),
            context: z.string().optional().describe('Why the agent is being invoked (for logging)'),
            recurringMs: z.number().positive().optional().describe('If set, repeat every this many milliseconds after each firing'),
        },
        createScheduleReminderHandler(),
    )

    server.tool(
        'list_reminders',
        'List pending reminders for the current Malink session, including task IDs that can be passed to cancel_reminder.',
        {},
        createListRemindersHandler(),
    )

    server.tool(
        'cancel_reminder',
        'Cancel a previously scheduled reminder by task ID, or cancel all pending reminders for the current session with all=true.',
        {
            taskId: z.string().optional().describe('The task ID returned by schedule_reminder or list_reminders'),
            all: z.boolean().optional().describe('If true and taskId is omitted, cancel all pending reminders for this session'),
        },
        createCancelReminderHandler(),
    )

    server.tool(
        'send_message',
        'Send an immediate message to the user via the channel, injecting it into the current session.',
        {
            message: z.string().describe('The message to send'),
        },
        createSendMessageHandler(),
    )

    registerSendFileTool(server)

    server.tool(
        'get_delivery_status',
        'Check asynchronous channel delivery status for files or messages queued by Malink. Pass deliveryId to inspect a specific delivery; set includeText to recover retained message text.',
        {
            deliveryId: z.string().optional().describe('Optional delivery ID returned by send_file. If omitted, recent deliveries for the session are listed.'),
            includeText: z.boolean().optional().describe('Include retained message text in the response. Use for failed deliveries whose channel message was not shown.'),
        },
        createGetDeliveryStatusHandler(),
    )

    server.tool(
        'retry_delivery',
        'Retry a retained channel delivery by ID.',
        {
            deliveryId: z.string().describe('Delivery ID to retry, such as delivery-123.'),
        },
        createRetryDeliveryHandler(),
    )
}

/**
 * File delivery is available from the first Agent turn because it can route by
 * the stable Malink session ID. The other notify tools still require a provider
 * conversation ID and remain part of registerNotifyTools.
 */
export function registerSendFileTool(server: any): void {
    server.tool(
        'send_file',
        'Send an immediate file attachment to the user via the channel. The path must be readable and inside the session working directory or an allowed Malink directory.',
        {
            path: z.string().describe('Local file path to send as an attachment'),
            caption: z.string().optional().describe('Optional caption to send with the file'),
            filename: z.string().optional().describe('Optional display filename for the attachment'),
            type: z.enum(['document', 'file', 'markdown', 'code', 'image']).optional().describe('How to send the file: document/file sends the raw file, markdown renders markdown text, code renders a fenced code block, image sends an image attachment that clients can preview'),
            language: z.string().optional().describe('Optional language tag for code rendering'),
        },
        createSendFileHandler(),
    )
}
