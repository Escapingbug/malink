import { createHash } from 'node:crypto'
import type { ProviderHistoryMessage } from '@/providers/provider'

export const DEFAULT_PROVIDER_HISTORY_PAGE_MESSAGES = 30
export const MAX_PROVIDER_HISTORY_MESSAGE_PART_CHARS = 12 * 1024

export function providerHistoryDigest(messages: readonly ProviderHistoryMessage[]): string {
  const hash = createHash('sha256')
  for (const message of messages) {
    hash.update(message.id)
    hash.update('\0')
    hash.update(message.role)
    hash.update('\0')
    hash.update(message.text)
    hash.update('\0')
  }
  return hash.digest('base64url')
}

export function providerHistoryIdentity(input: {
  workspaceId: string
  projectId: string
  sessionId: string
  providerSessionId: string
  messages: readonly ProviderHistoryMessage[]
}): { historyId: string; snapshotId: string } {
  const historyId = createHash('sha256')
    .update('malink-provider-history-room-v1\0')
    .update(input.workspaceId)
    .update('\0')
    .update(input.projectId)
    .update('\0')
    .update(input.sessionId)
    .digest('base64url')
  const snapshotId = createHash('sha256')
    .update('malink-provider-history-snapshot-v1\0')
    .update(input.providerSessionId)
    .update('\0')
    .update(providerHistoryDigest(input.messages))
    .digest('base64url')
  return { historyId, snapshotId }
}

export function providerHistoryPage(
  messages: readonly ProviderHistoryMessage[],
  frontier: number,
  limit = DEFAULT_PROVIDER_HISTORY_PAGE_MESSAGES,
): Array<{ message: ProviderHistoryMessage; sourceOrdinal: number }> {
  if (!Number.isSafeInteger(frontier) || frontier < 0 || frontier > messages.length) {
    throw new Error('Provider History materialization frontier is invalid')
  }
  const bounded = Math.max(1, Math.min(100, Math.floor(limit)))
  const end = messages.length - frontier
  const start = Math.max(0, end - bounded)
  const page: Array<{ message: ProviderHistoryMessage; sourceOrdinal: number }> = []
  for (let sourceOrdinal = end - 1; sourceOrdinal >= start; sourceOrdinal -= 1) {
    page.push({ message: messages[sourceOrdinal]!, sourceOrdinal })
  }
  return page
}

export function splitProviderHistoryMessage(text: string): string[] {
  if (text.length <= MAX_PROVIDER_HISTORY_MESSAGE_PART_CHARS) return [text]
  const parts: string[] = []
  for (let offset = 0; offset < text.length; offset += MAX_PROVIDER_HISTORY_MESSAGE_PART_CHARS) {
    parts.push(text.slice(offset, offset + MAX_PROVIDER_HISTORY_MESSAGE_PART_CHARS))
  }
  return parts
}
