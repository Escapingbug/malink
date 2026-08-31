import {
  mlp3EventSchema,
  mlp3EventPayloadSchema,
  providerSessionEntrySchema,
  type JsonValue,
  type Mlp3Command,
  type Mlp3EventPayload,
  type ProviderHistoryMessage,
  type ProviderSessionEntry,
} from '@malink/protocol'

// MLP events are signed, encrypted and Base64 encoded before they enter a
// Matrix timeline. Keep provider-owned history well below the 40 KiB sealed
// timeline limit so multibyte titles and paths cannot strand a successful
// command between the command journal and the Matrix outbox.
export const PROVIDER_HISTORY_PLAINTEXT_BUDGET_BYTES = 18 * 1024

const PROVIDER_HISTORY_CURSOR_PREFIX = 'provider-history-offset-v1:'
const MAX_PROVIDER_SESSIONS = 256
const MAX_PROVIDER_MESSAGES = 256

type ProviderSessionsListedPayload = Extract<
  Mlp3EventPayload,
  { type: 'provider.sessions.listed' }
>

type ProviderSessionInspectedPayload = Extract<
  Mlp3EventPayload,
  { type: 'provider.session.inspected' }
>

export function providerSessionsPage(
  provider: string,
  input: readonly ProviderSessionEntry[],
  cursor?: string,
): ProviderSessionsListedPayload {
  const sessions = input.slice(0, MAX_PROVIDER_SESSIONS)
  const offset = parseProviderHistoryCursor(cursor, sessions.length)
  const page: ProviderSessionEntry[] = []

  for (let index = offset; index < sessions.length; index += 1) {
    const candidate = [...page, sessions[index]!]
    const hasMore = index + 1 < sessions.length
    const payload: ProviderSessionsListedPayload = {
      type: 'provider.sessions.listed',
      provider,
      sessions: candidate,
      ...(hasMore ? { nextCursor: providerHistoryCursor(index + 1) } : {}),
    }
    if (jsonBytes(payload) > PROVIDER_HISTORY_PLAINTEXT_BUDGET_BYTES) {
      if (page.length === 0) {
        throw new Error(
          `Provider session ${sessions[index]!.sessionId} is too large for a Matrix history page`,
        )
      }
      break
    }
    page.push(sessions[index]!)
  }

  const nextOffset = offset + page.length
  return {
    type: 'provider.sessions.listed',
    provider,
    sessions: page,
    ...(nextOffset < sessions.length
      ? { nextCursor: providerHistoryCursor(nextOffset) }
      : {}),
  }
}

export function boundedProviderSessionInspection(
  input: Omit<ProviderSessionInspectedPayload, 'messages'> & {
    messages: readonly ProviderHistoryMessage[]
  },
): ProviderSessionInspectedPayload {
  const messages: ProviderHistoryMessage[] = []
  // A preview should retain the newest usable context. Build in reverse and
  // restore chronological order after the byte budget is satisfied.
  for (const message of input.messages.slice(-MAX_PROVIDER_MESSAGES).reverse()) {
    const normalized: ProviderHistoryMessage = {
      id: message.id,
      role: message.role,
      text: truncateUtf8(message.text, 12 * 1024),
    }
    const candidate = [normalized, ...messages]
    if (jsonBytes({ ...input, messages: candidate }) > PROVIDER_HISTORY_PLAINTEXT_BUDGET_BYTES) {
      break
    }
    messages.unshift(normalized)
  }
  return mlp3EventPayloadSchema.parse({ ...input, messages }) as ProviderSessionInspectedPayload
}

/**
 * Older Gateway releases could durably journal an oversized Provider History
 * result before discovering that its encrypted Matrix event was too large.
 * Reconciliation/redelivery uses the same additive cursor contract to make
 * those already-journaled results deliverable without executing the provider
 * operation again.
 */
export function boundedProviderHistoryResult(
  command: Mlp3Command,
  value: JsonValue,
): JsonValue {
  const payload = normalizeProviderHistoryPayload(value)
  if (!payload) return value
  if (
    command.operation === 'provider.sessions.list'
    && payload.type === 'provider.sessions.listed'
  ) {
    return providerSessionsPage(
      command.payload.provider,
      payload.sessions,
      command.payload.cursor,
    )
  }
  if (
    command.operation === 'provider.session.inspect'
    && payload.type === 'provider.session.inspected'
  ) {
    return boundedProviderSessionInspection({
      ...payload,
      provider: command.payload.provider,
      providerSessionId: command.payload.providerSessionId,
    })
  }
  return value
}

export function boundedProviderHistoryEventPayload(
  command: Mlp3Command,
  payload: Mlp3EventPayload,
): Mlp3EventPayload {
  return boundedProviderHistoryResult(command, payload as JsonValue) as Mlp3EventPayload
}

/**
 * A few pre-pagination Gateways persisted Provider History terminal events
 * whose individual provider-owned strings exceeded the MLP schema. Those
 * entries are still structurally trustworthy journal records and must remain
 * readable so recovery can replace their payload with a bounded event. Keep
 * this exception narrow: the complete event envelope and a normalized known
 * Provider History payload must pass the current MLP/3 schema.
 */
export function isRecoverableLegacyProviderHistoryEvent(value: unknown): boolean {
  if (!isRecord(value)) return false
  const payload = normalizeProviderHistoryPayload(value.payload)
  if (!payload) return false
  return mlp3EventSchema.safeParse({ ...value, payload }).success
}

function normalizeProviderHistoryPayload(
  value: unknown,
): ProviderSessionsListedPayload | ProviderSessionInspectedPayload | undefined {
  const current = mlp3EventPayloadSchema.safeParse(value)
  if (
    current.success
    && (
      current.data.type === 'provider.sessions.listed'
      || current.data.type === 'provider.session.inspected'
    )
  ) return current.data
  if (!isRecord(value)) return undefined
  if (value.type === 'provider.sessions.listed') return normalizeProviderSessionsPayload(value)
  if (value.type === 'provider.session.inspected') return normalizeProviderInspectionPayload(value)
  return undefined
}

function normalizeProviderSessionsPayload(
  value: Record<string, unknown>,
): ProviderSessionsListedPayload | undefined {
  if (!validOpaqueId(value.provider) || !Array.isArray(value.sessions)) return undefined
  const sessions: ProviderSessionEntry[] = []
  for (const input of value.sessions.slice(0, MAX_PROVIDER_SESSIONS)) {
    if (!isRecord(input) || !validOpaqueId(input.sessionId) || typeof input.title !== 'string') {
      return undefined
    }
    const parsed = providerSessionEntrySchema.safeParse({
      sessionId: input.sessionId,
      title: truncateText(input.title.trim() || 'Untitled provider session', 512),
      updatedAt: input.updatedAt,
      ...(typeof input.cwd === 'string' && input.cwd
        ? { cwd: truncateText(input.cwd, 8_192) }
        : {}),
      ...(input.managedSessionId === undefined
        ? {}
        : { managedSessionId: input.managedSessionId }),
      ...(input.latestArchivedSessionId === undefined
        ? {}
        : { latestArchivedSessionId: input.latestArchivedSessionId }),
      ...(input.lastArchivedAt === undefined ? {} : { lastArchivedAt: input.lastArchivedAt }),
    })
    if (!parsed.success) return undefined
    sessions.push(parsed.data)
  }
  const parsed = mlp3EventPayloadSchema.safeParse({
    type: 'provider.sessions.listed',
    provider: value.provider,
    sessions,
    ...(typeof value.nextCursor === 'string' && value.nextCursor
      ? { nextCursor: value.nextCursor }
      : {}),
  })
  return parsed.success && parsed.data.type === 'provider.sessions.listed'
    ? parsed.data
    : undefined
}

function normalizeProviderInspectionPayload(
  value: Record<string, unknown>,
): ProviderSessionInspectedPayload | undefined {
  if (
    !validOpaqueId(value.provider)
    || !validOpaqueId(value.providerSessionId)
    || typeof value.title !== 'string'
    || !Array.isArray(value.messages)
  ) return undefined
  const messages: ProviderHistoryMessage[] = []
  for (const [index, input] of value.messages.slice(-MAX_PROVIDER_MESSAGES).entries()) {
    if (
      !isRecord(input)
      || typeof input.id !== 'string'
      || (input.role !== 'user' && input.role !== 'assistant')
      || typeof input.text !== 'string'
    ) return undefined
    messages.push({
      id: truncateText(input.id, 256) || `message-${index + 1}`,
      role: input.role,
      text: input.text,
    })
  }
  try {
    return boundedProviderSessionInspection({
      type: 'provider.session.inspected',
      provider: value.provider,
      providerSessionId: value.providerSessionId,
      title: truncateText(value.title.trim() || 'Provider session', 512),
      ...(value.managedSessionId === undefined
        ? {}
        : { managedSessionId: value.managedSessionId as string }),
      ...(value.latestArchivedSessionId === undefined
        ? {}
        : { latestArchivedSessionId: value.latestArchivedSessionId as string }),
      ...(value.lastArchivedAt === undefined
        ? {}
        : { lastArchivedAt: value.lastArchivedAt as number }),
      messages,
    })
  } catch {
    return undefined
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function validOpaqueId(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 256
}

function truncateText(value: string, maximumCharacters: number): string {
  return value.length <= maximumCharacters ? value : value.slice(0, maximumCharacters)
}

function providerHistoryCursor(offset: number): string {
  return `${PROVIDER_HISTORY_CURSOR_PREFIX}${offset}`
}

function parseProviderHistoryCursor(cursor: string | undefined, size: number): number {
  if (cursor === undefined) return 0
  if (!cursor.startsWith(PROVIDER_HISTORY_CURSOR_PREFIX)) {
    throw new Error('Provider History cursor is invalid; refresh the session list')
  }
  const value = Number(cursor.slice(PROVIDER_HISTORY_CURSOR_PREFIX.length))
  if (!Number.isSafeInteger(value) || value < 0 || value > size) {
    throw new Error('Provider History cursor is no longer valid; refresh the session list')
  }
  return value
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}

function truncateUtf8(value: string, maximumBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maximumBytes) return value
  let low = 0
  let high = value.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (Buffer.byteLength(value.slice(0, middle), 'utf8') <= maximumBytes) low = middle
    else high = middle - 1
  }
  return value.slice(0, low)
}
