import { createHash, randomUUID } from 'node:crypto'
import {
  type MalinkAttachment,
  type MalinkArtifactReference,
  type Mlp3Event,
  type Mlp3SessionProjection,
  type JsonValue,
} from '@malink/protocol'
import type {
  ChannelEditContext,
  ChannelMessage,
  ChannelPort,
  ChannelSendContext,
  ChannelSendResult,
  ChannelToolGroupPresentation,
  DecisionRequest,
  DecisionResponse,
  SessionStatus,
} from '@/bridge/channelPort'
import type { SessionExtensionInteractionRequest } from '@/runtime/sessionExtensions'
import type { MatrixGatewayRoomConfig } from '@/gateway/matrix/config'
import {
  MatrixMlp3ContentTooLargeError,
  type GatewayMlp3ContentLayer,
} from '@/gateway/matrix/mlp3Content'
import type { MatrixTransport } from './transport'
import { uploadMlp3Attachment } from './mlp3Attachment'

export interface MatrixMlp3PortOptions {
  contentLayer: GatewayMlp3ContentLayer
  transport: MatrixTransport
  room: MatrixGatewayRoomConfig
  workspaceId: string
  projectId: string
  sessionId: string
  threadRootEventId: string
  projection(): Mlp3SessionProjection
  now?: () => number
  onLog?: (message: string) => void
  onStatusChange?: (status: SessionStatus) => void
  artifactReferences?: MatrixMlp3ArtifactReferenceHandler
}

export interface MatrixMlp3ArtifactReferenceHandler {
  prepare(messageId: string, message: ChannelMessage): Promise<{
    message: ChannelMessage
    references: MalinkArtifactReference[]
  }>
  published(input: {
    messageId: string
    messageVersion: number
    body: string
    format: 'plain' | 'markdown'
    final: boolean
    partIndex?: number
    partCount?: number
    projection: Mlp3SessionProjection
    references: MalinkArtifactReference[]
    attachments: MalinkAttachment[]
  }): Promise<void>
  upload(
    attachment: NonNullable<ChannelMessage['attachments']>[number],
  ): Promise<MalinkAttachment>
}

interface PendingDecision {
  kind: 'decision' | 'extension'
  decisionType?: DecisionRequest['type']
  extensionId?: string
  allowedValues: Set<string>
  fallbackValue: string
  timeout?: ReturnType<typeof setTimeout>
  resolve(value: DecisionResponse): void
}

export interface ResolvedV3Decision {
  kind: 'decision' | 'extension'
  decisionType?: DecisionRequest['type']
  extensionId?: string
}

/**
 * MLP/3 Matrix projection for one Malink session thread.
 *
 * Logical IDs and versions are authoritative. Matrix relations are emitted as
 * indexing hints, but a missing or rewritten physical relation cannot change
 * the Malink projection.
 */
export class MatrixMlp3Port implements ChannelPort {
  readonly fileReferenceHints = false
  readonly coalesceAssistantText = true
  // Matrix replacements are durable room events subject to the same account-
  // wide message limit as new chat messages. Preserve one logical bubble, but
  // publish it only at semantic boundaries just like an ordinary chat client.
  readonly streamAssistantText = false
  // Publish the first bounded tool snapshot immediately so remote clients can
  // show current work. DeliveryOutbox coalesces subsequent replacements into
  // this window, while a final snapshot bypasses the wait.
  readonly toolActivityDebounceMs = 10_000
  private readonly pendingDecisions = new Map<string, PendingDecision>()
  private readonly operationIds = new WeakMap<ChannelMessage, string>()
  private readonly attachmentUploads = new Map<string, Promise<MalinkAttachment[]>>()
  private readonly physicalEventIds = new Map<string, string>()
  private readonly messageVersions = new Map<string, number>()
  private readonly messageTimestamps = new Map<string, number>()
  private causationCommandId: string | null = null
  private lastOccurredAt = -1

  constructor(private readonly options: MatrixMlp3PortOptions) {}

  setCausationCommandId(commandId: string | null): void {
    this.causationCommandId = commandId
  }

  observeMessageVersion(messageId: string, version: number): void {
    this.messageVersions.set(
      messageId,
      Math.max(this.messageVersions.get(messageId) ?? 0, version),
    )
  }

  async send(
    message: ChannelMessage,
    context: ChannelSendContext = {},
  ): Promise<ChannelSendResult> {
    const messageOptions = readMessageOptions(message.replyMarkup)
    const messageId = messageOptions.idempotencyKey ?? this.operationIdFor(message)
    const prepared = await this.prepareArtifacts(messageId, message)
    message = prepared.message
    const presentation = message.presentation ?? messageOptions.ui
    const liveToolGroup = isToolGroupPresentation(presentation)
    const attachments = await this.uploadAttachments(messageId, message.attachments)
    const parts = splitMessage(message)
    const transportPresentation = liveToolGroup
      ? compactToolPresentation(presentation)
      : presentation
    const version = this.nextMessageVersion(messageId)
    const artifactAttachmentIds = new Set(prepared.references.map(reference => reference.id))
    for (const [index, part] of parts.entries()) {
      const logicalPartId = partId(messageId, index, parts.length)
      const projection = this.options.projection()
      const references = referencesInBody(prepared.references, normalizedBody(part))
      const partAttachments = attachmentsForPart(
        attachments,
        references,
        artifactAttachmentIds,
        index,
      )
      if (references.length > 0) {
        await this.options.artifactReferences?.published({
          messageId,
          messageVersion: version,
          body: normalizedBody(part),
          format: part.format === 'markdown' ? 'markdown' : 'plain',
          final: true,
          ...(parts.length > 1 ? { partIndex: index, partCount: parts.length } : {}),
          projection,
          references,
          attachments: partAttachments,
        })
      }
      const queued = await this.sendAssistantEvent({
        eventId: eventId('assistant', logicalPartId, version),
        messageId,
        messageVersion: version,
        body: normalizedBody(part),
        format: part.format === 'markdown' ? 'markdown' : 'plain',
        final: true,
        ...(parts.length > 1 ? { partIndex: index, partCount: parts.length } : {}),
        ...(transportPresentation !== undefined
          ? { ui: transportPresentation as JsonValue }
          : {}),
        ...(partAttachments.length > 0 ? { attachments: partAttachments } : {}),
        ...(references.length > 0 ? { artifactReferences: references } : {}),
      }, {
        occurredAt: this.messageTimestamp(messageId),
        ...(liveToolGroup && context.finalSnapshot
          ? { priority: 'normal' as const }
          : {}),
      })
      this.observeAssistantDelivery(
        queued.confirmation,
        logicalPartId,
        index === 0 ? messageId : undefined,
        version,
      )
    }
    return { messageId }
  }

  async edit(
    messageIdInput: string | number,
    message: ChannelMessage,
    context: ChannelEditContext = {},
  ): Promise<void> {
    const messageId = String(messageIdInput)
    const messageOptions = readMessageOptions(message.replyMarkup)
    const prepared = await this.prepareArtifacts(messageId, message)
    message = prepared.message
    const presentation = message.presentation ?? messageOptions.ui
    const toolGroup = isToolGroupPresentation(presentation)
    const attachments = await this.uploadAttachments(messageId, message.attachments)
    // Tool output is execution data, not chat history. Final snapshots carry
    // the same bounded metadata as live snapshots and must never expand into
    // a raw textual transcript that Matrix then has to fragment and retry.
    const parts = splitMessage(message)
    const transportPresentation = toolGroup
      ? compactToolPresentation(presentation)
      : presentation
    const version = this.nextMessageVersion(messageId)
    const artifactAttachmentIds = new Set(prepared.references.map(reference => reference.id))

    for (const [index, part] of parts.entries()) {
      const logicalPartId = partId(messageId, index, parts.length)
      const physicalTarget = this.physicalEventIds.get(logicalPartId)
        ?? (index === 0 ? this.physicalEventIds.get(messageId) : undefined)
      const projection = this.options.projection()
      const references = referencesInBody(prepared.references, normalizedBody(part))
      const partAttachments = attachmentsForPart(
        attachments,
        references,
        artifactAttachmentIds,
        index,
      )
      if (references.length > 0) {
        await this.options.artifactReferences?.published({
          messageId,
          messageVersion: version,
          body: normalizedBody(part),
          format: part.format === 'markdown' ? 'markdown' : 'plain',
          final: context.terminal ?? !context.progressive,
          ...(parts.length > 1 ? { partIndex: index, partCount: parts.length } : {}),
          projection,
          references,
          attachments: partAttachments,
        })
      }
      const queued = await this.sendAssistantEvent({
        eventId: eventId('assistant', logicalPartId, version),
        messageId,
        messageVersion: version,
        body: normalizedBody(part),
        format: part.format === 'markdown' ? 'markdown' : 'plain',
        final: context.terminal ?? !context.progressive,
        ...(parts.length > 1 ? { partIndex: index, partCount: parts.length } : {}),
        ...(transportPresentation !== undefined
          ? { ui: transportPresentation as JsonValue }
          : {}),
        ...(partAttachments.length > 0 ? { attachments: partAttachments } : {}),
        ...(references.length > 0 ? { artifactReferences: references } : {}),
      }, {
        occurredAt: this.messageTimestamp(messageId),
        ...(toolGroup && context.finalSnapshot
          ? { priority: 'normal' as const }
          : {}),
        ...(physicalTarget
          ? {
              relation: {
                rel_type: 'm.replace',
                event_id: physicalTarget,
              },
            }
          : {}),
      })
      this.observeAssistantDelivery(
        queued.confirmation,
        logicalPartId,
        index === 0 ? messageId : undefined,
        version,
      )
    }
  }

  requestDecision(request: DecisionRequest): Promise<DecisionResponse> {
    const requestId = randomUUID()
    const fallbackValue = request.type === 'question' ? '' : 'deny'
    const promise = new Promise<DecisionResponse>(resolve => {
      const pending: PendingDecision = {
        kind: 'decision',
        decisionType: request.type,
        allowedValues: new Set(request.options.map(option => option.value)),
        fallbackValue,
        resolve,
      }
      this.pendingDecisions.set(requestId, pending)
      if (request.expiresAt !== undefined) {
        pending.timeout = setTimeout(
          () => this.expireDecision(requestId, fallbackValue),
          Math.max(0, request.expiresAt - Date.now()),
        )
      }
    })
    const event: Mlp3Event = {
      ...this.baseEvent(eventId('decision', requestId, 1)),
      payload: {
        type: 'decision.requested',
        decisionType: request.type,
        requestId,
        title: request.title,
        ...(request.details ? { details: request.details } : {}),
        options: request.options,
        ...(request.expiresAt === undefined ? {} : { expiresAt: request.expiresAt }),
        projection: this.options.projection(),
      },
    }
    void this.options.contentLayer.sendEvent(
      this.options.room,
      event,
      this.options.transport,
      { relation: threadRelation(this.options.threadRootEventId) },
    ).catch(error => {
      this.options.onLog?.(`[mlp3/matrix] decision delivery failed: ${formatError(error)}`)
      this.resolveDecision(requestId, fallbackValue)
    })
    return promise
  }

  requestExtensionInteraction(
    request: SessionExtensionInteractionRequest,
  ): Promise<DecisionResponse> {
    const requestId = randomUUID()
    const promise = new Promise<DecisionResponse>(resolve => {
      this.pendingDecisions.set(requestId, {
        kind: 'extension',
        extensionId: request.extension.id,
        allowedValues: new Set(request.view.actions.map(action => action.id)),
        fallbackValue: request.cancelActionId,
        resolve,
      })
    })
    const event: Mlp3Event = {
      ...this.baseEvent(eventId('extension-interaction', requestId, 1)),
      payload: {
        type: 'extension.interaction.requested',
        requestId,
        extension: request.extension,
        view: request.view,
        cancelActionId: request.cancelActionId,
        projection: this.options.projection(),
      },
    }
    void this.options.contentLayer.sendEvent(
      this.options.room,
      event,
      this.options.transport,
      { relation: threadRelation(this.options.threadRootEventId) },
    ).catch(error => {
      this.options.onLog?.(`[mlp3/matrix] extension interaction delivery failed: ${formatError(error)}`)
      this.resolveDecision(requestId, request.cancelActionId)
    })
    return promise
  }

  resolveDecision(
    requestId: string,
    value: string,
    totp?: string,
  ): ResolvedV3Decision | null {
    const pending = this.pendingDecisions.get(requestId)
    if (!pending || !pending.allowedValues.has(value)) return null
    if (
      pending.decisionType === 'privilege'
      && value !== pending.fallbackValue
      && !/^\d{6}$/u.test(totp ?? '')
    ) return null
    this.pendingDecisions.delete(requestId)
    if (pending.timeout) clearTimeout(pending.timeout)
    pending.resolve({ value, ...(totp ? { totp } : {}) })
    return {
      kind: pending.kind,
      ...(pending.decisionType ? { decisionType: pending.decisionType } : {}),
      ...(pending.extensionId ? { extensionId: pending.extensionId } : {}),
    }
  }

  decisionType(requestId: string): DecisionRequest['type'] | 'extension' | null {
    const pending = this.pendingDecisions.get(requestId)
    if (!pending) return null
    return pending.kind === 'extension' ? 'extension' : pending.decisionType ?? 'permission'
  }

  private expireDecision(requestId: string, fallbackValue: string): void {
    const resolved = this.resolveDecision(requestId, fallbackValue)
    if (!resolved || resolved.kind !== 'decision') return
    const event: Mlp3Event = {
      ...this.baseEvent(eventId('decision-expired', requestId, 1)),
      payload: {
        type: 'decision.resolved',
        requestId,
        decision: fallbackValue,
        projection: this.options.projection(),
      },
    }
    void this.options.contentLayer.sendEvent(
      this.options.room,
      event,
      this.options.transport,
      { relation: threadRelation(this.options.threadRootEventId) },
    ).catch(error => {
      this.options.onLog?.(
        `[mlp3/matrix] expired decision delivery failed: ${formatError(error)}`,
      )
    })
  }

  notifyStatus(status: SessionStatus): void {
    try {
      this.options.onStatusChange?.(status)
    } catch (error) {
      this.options.onLog?.(`[mlp3/matrix] status observer failed: ${formatError(error)}`)
    }
  }

  sendChatAction(action: string): void {
    if (!this.options.transport.setTyping) return
    const typing = action === 'typing' || action === 'uploading'
    void this.options.transport.setTyping(
      this.options.room.roomId,
      typing,
      typing ? 30_000 : undefined,
    ).catch(error => {
      this.options.onLog?.(`[mlp3/matrix] typing update failed: ${formatError(error)}`)
    })
  }

  close(): void {
    for (const [requestId, pending] of this.pendingDecisions) {
      this.pendingDecisions.delete(requestId)
      pending.resolve({ value: pending.fallbackValue })
    }
  }

  private async sendAssistantEvent(
    payload: Omit<
      Extract<Mlp3Event['payload'], { type: 'assistant.message' }>,
      'type' | 'projection'
    > & { eventId: string },
    options: {
      relation?: Record<string, unknown>
      occurredAt?: number
      priority?: 'urgent' | 'control' | 'normal' | 'bulk'
    } = {},
  ) {
    const { eventId: logicalEventId, ...eventPayload } = payload
    const event: Mlp3Event = {
      ...this.baseEvent(logicalEventId, options.occurredAt),
      payload: {
        type: 'assistant.message',
        ...eventPayload,
        projection: this.options.projection(),
      },
    }
    const relation = options.relation ?? threadRelation(this.options.threadRootEventId)
    const deliveryOptions = {
      relation,
      ...(options.priority
        ? { priority: options.priority }
        : isToolGroupPresentation(eventPayload.ui)
          ? { priority: 'bulk' as const }
          : {}),
    }
    try {
      return await this.options.contentLayer.enqueueEvent(
        this.options.room,
        event,
        this.options.transport,
        deliveryOptions,
      )
    } catch (error) {
      if (!(error instanceof MatrixMlp3ContentTooLargeError) || eventPayload.ui === undefined) {
        throw error
      }
      const compactUi = compactToolPresentation(eventPayload.ui)
      if (compactUi !== eventPayload.ui) {
        try {
          this.options.onLog?.(
            `[mlp3/matrix] assistant ${logicalEventId} presentation exceeded the `
            + 'Matrix event budget; retrying with bounded tool metadata',
          )
          return await this.options.contentLayer.enqueueEvent(
            this.options.room,
            {
              ...event,
              payload: {
                type: 'assistant.message',
                ...eventPayload,
                ui: compactUi as JsonValue,
                projection: this.options.projection(),
              },
            },
            this.options.transport,
            deliveryOptions,
          )
        } catch (compactError) {
          if (!(compactError instanceof MatrixMlp3ContentTooLargeError)) throw compactError
        }
      }
      // The bounded textual summary is already in body. A pathological
      // presentation must not poison later assistant deliveries.
      const { ui: _ui, ...textualPayload } = eventPayload
      this.options.onLog?.(
        `[mlp3/matrix] assistant ${logicalEventId} presentation exceeded the `
        + 'Matrix event budget; delivered the bounded textual summary',
      )
      return this.options.contentLayer.enqueueEvent(
        this.options.room,
        {
          ...event,
          payload: {
            type: 'assistant.message',
            ...textualPayload,
            projection: this.options.projection(),
          },
        },
        this.options.transport,
        deliveryOptions,
      )
    }
  }

  private observeAssistantDelivery(
    confirmation: Promise<{ eventId: string }>,
    logicalPartId: string,
    messageId: string | undefined,
    version: number,
  ): void {
    void confirmation.then(result => {
      this.physicalEventIds.set(logicalPartId, result.eventId)
      if (messageId) this.physicalEventIds.set(messageId, result.eventId)
      this.options.onLog?.(
        `[mlp3/matrix] assistant ${logicalPartId} v${version} delivered`,
      )
    }).catch(error => {
      this.options.onLog?.(
        `[mlp3/matrix] assistant ${logicalPartId} v${version} queued: ${formatError(error)}`,
      )
    })
  }

  private baseEvent(
    logicalEventId: string,
    occurredAt = this.nextOccurredAt(),
  ): Omit<Mlp3Event, 'payload'> {
    return {
      kind: 'malink.event',
      version: 3,
      eventId: logicalEventId,
      workspaceId: this.options.workspaceId,
      projectId: this.options.projectId,
      sessionId: this.options.sessionId,
      occurredAt,
      ...(this.causationCommandId
        ? { causationCommandId: this.causationCommandId }
        : {}),
    }
  }

  private nextMessageVersion(messageId: string): number {
    const next = (this.messageVersions.get(messageId) ?? 0) + 1
    this.messageVersions.set(messageId, next)
    return next
  }

  private messageTimestamp(messageId: string): number {
    const current = this.messageTimestamps.get(messageId)
    if (current !== undefined) return current
    const timestamp = this.nextOccurredAt()
    this.messageTimestamps.set(messageId, timestamp)
    return timestamp
  }

  private nextOccurredAt(): number {
    const wallClock = (this.options.now ?? Date.now)()
    const timestamp = Math.max(wallClock, this.lastOccurredAt + 1)
    this.lastOccurredAt = timestamp
    return timestamp
  }

  private operationIdFor(message: ChannelMessage): string {
    const current = this.operationIds.get(message)
    if (current) return current
    const created = randomUUID()
    this.operationIds.set(message, created)
    return created
  }

  private uploadAttachments(
    operationId: string,
    attachments: ChannelMessage['attachments'],
  ): Promise<MalinkAttachment[]> {
    if (!attachments?.length) return Promise.resolve([])
    const current = this.attachmentUploads.get(operationId)
    if (current) return current
    const upload = Promise.all(attachments.map(async attachment => {
        try {
          const artifactUpload = (
            attachment.optionalArtifact
              ? this.options.artifactReferences?.upload(attachment)
              : undefined
          )
          return await (
            artifactUpload ?? uploadMlp3Attachment(this.options.transport, attachment)
          )
        } catch (error) {
          if (!attachment.optionalArtifact) throw error
          this.options.onLog?.(
            `[mlp3/artifact] eager image upload fell back to a lazy reference: ${formatError(error)}`,
          )
          return null
        }
      })).then(uploaded => uploaded.filter(attachment => attachment !== null))
    this.attachmentUploads.set(operationId, upload)
    void upload.catch(() => this.attachmentUploads.delete(operationId))
    return upload
  }

  private prepareArtifacts(
    messageId: string,
    message: ChannelMessage,
  ): Promise<{ message: ChannelMessage; references: MalinkArtifactReference[] }> {
    return this.options.artifactReferences?.prepare(messageId, message)
      ?? Promise.resolve({ message, references: [] })
  }
}

function splitMessage(message: ChannelMessage): ChannelMessage[] {
  const body = normalizedBody(message)
  if (new TextEncoder().encode(body).byteLength <= MESSAGE_PART_BYTES) return [message]
  const chunks: string[] = []
  let current = ''
  let bytes = 0
  for (const character of body) {
    const size = new TextEncoder().encode(character).byteLength
    if (bytes > 0 && bytes + size > MESSAGE_PART_BYTES) {
      chunks.push(current)
      current = ''
      bytes = 0
    }
    current += character
    bytes += size
  }
  if (current || chunks.length === 0) chunks.push(current)
  return chunks.map(text => ({
    text,
    format: message.format === 'html' ? 'plain' : message.format,
  }))
}

function referencesInBody(
  references: MalinkArtifactReference[],
  body: string,
): MalinkArtifactReference[] {
  return references.filter(reference => body.includes(`malink-artifact:${reference.id}`))
}

function attachmentsForPart(
  attachments: MalinkAttachment[],
  references: MalinkArtifactReference[],
  artifactAttachmentIds: Set<string>,
  partIndex: number,
): MalinkAttachment[] {
  const referenceIds = new Set(references.map(reference => reference.id))
  return attachments.filter(attachment =>
    referenceIds.has(attachment.id)
    || (partIndex === 0 && !artifactAttachmentIds.has(attachment.id)),
  )
}

function compactToolPresentation(value: unknown): unknown {
  if (!isToolGroupPresentation(value)) return value
  const focusedToolIndex = focusedToolPresentationIndex(value.tools)
  const historicalDetailLimit = Math.min(
    192,
    Math.max(64, Math.floor((4 * 1024) / Math.max(1, value.tools.length - 1))),
  )
  return {
    ...value,
    groupId: compactPreview(value.groupId, 256),
    tools: value.tools.map((tool, index) => {
      const { result: _result, ...summary } = tool
      return {
        ...summary,
        id: compactPreview(tool.id, 256),
        name: compactPreview(tool.name, 64),
        title: compactPreview(tool.title, 128),
        ...(tool.detail?.trim()
          ? {
              detail: index === focusedToolIndex
                ? boundedToolInvocation(tool.detail, 4 * 1024)
                : compactPreview(tool.detail, historicalDetailLimit),
            }
          : {}),
      }
    }),
  } satisfies ChannelToolGroupPresentation
}

function focusedToolPresentationIndex(
  tools: ChannelToolGroupPresentation['tools'],
): number {
  for (let index = tools.length - 1; index >= 0; index -= 1) {
    if (tools[index]?.phase === 'started' || tools[index]?.phase === 'updated') {
      return index
    }
  }
  return Math.max(0, tools.length - 1)
}

function boundedToolInvocation(value: string, limit: number): string {
  const normalized = value.replace(/\r\n?/gu, '\n').trimEnd()
  return normalized.length > limit
    ? `${normalized.slice(0, limit - 1)}…`
    : normalized
}

function compactPreview(value: string, limit: number): string {
  const normalized = value.replace(/\s+/gu, ' ').trim()
  return normalized.length > limit
    ? `${normalized.slice(0, limit - 1)}…`
    : normalized
}

function isToolGroupPresentation(value: unknown): value is ChannelToolGroupPresentation {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return record.kind === 'tool_group'
    && record.version === 1
    && typeof record.groupId === 'string'
    && Array.isArray(record.tools)
    && record.tools.every(tool => {
      if (!tool || typeof tool !== 'object') return false
      const item = tool as Record<string, unknown>
      return typeof item.id === 'string'
        && typeof item.name === 'string'
        && typeof item.title === 'string'
        && (item.detail === undefined || typeof item.detail === 'string')
        && (item.result === undefined || typeof item.result === 'string')
    })
}

const MESSAGE_PART_BYTES = 8 * 1024

function normalizedBody(message: ChannelMessage): string {
  return message.format === 'html' ? htmlToPlainText(message.text) : message.text
}

function readMessageOptions(value: unknown): { idempotencyKey?: string; ui?: unknown } {
  if (!value || typeof value !== 'object') return {}
  const record = value as Record<string, unknown>
  return {
    ...(typeof record.idempotencyKey === 'string' ? { idempotencyKey: record.idempotencyKey } : {}),
    ...('ui' in record
      ? { ui: record.ui }
      : Object.keys(record).some(key => key !== 'idempotencyKey')
        ? { ui: value }
        : {}),
  }
}

function threadRelation(rootEventId: string): Record<string, unknown> {
  return {
    rel_type: 'm.thread',
    event_id: rootEventId,
    is_falling_back: true,
    'm.in_reply_to': { event_id: rootEventId },
  }
}

function partId(messageId: string, index: number, count: number): string {
  return count === 1 ? messageId : `${messageId}.part.${index}`
}

function eventId(kind: string, logicalId: string, version: number): string {
  return createHash('sha256')
    .update(`malink-v3:${kind}\0${logicalId}\0${version}`)
    .digest('base64url')
}

function htmlToPlainText(value: string): string {
  return value
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .trim()
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
