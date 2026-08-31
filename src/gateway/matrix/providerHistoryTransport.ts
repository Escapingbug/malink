import {
  mlp3EventPayloadSchema,
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
  const parsed = mlp3EventPayloadSchema.safeParse(value)
  if (!parsed.success) return value
  const payload = parsed.data
  if (
    command.operation === 'provider.sessions.list'
    && payload.type === 'provider.sessions.listed'
  ) {
    return providerSessionsPage(
      payload.provider,
      payload.sessions,
      command.payload.cursor,
    )
  }
  if (
    command.operation === 'provider.session.inspect'
    && payload.type === 'provider.session.inspected'
  ) {
    return boundedProviderSessionInspection(payload)
  }
  return value
}

export function boundedProviderHistoryEventPayload(
  command: Mlp3Command,
  payload: Mlp3EventPayload,
): Mlp3EventPayload {
  return boundedProviderHistoryResult(command, payload as JsonValue) as Mlp3EventPayload
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
