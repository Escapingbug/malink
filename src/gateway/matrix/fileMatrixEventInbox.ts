import { createHash } from 'node:crypto'
import { AtomicJsonFile } from '@malink/security/node'
import { canonicalJson } from '@malink/protocol'
import type { MatrixIncomingEvent } from '@/channel/matrix'

export type MatrixEventInboxStatus = 'pending' | 'quarantined'

export interface MatrixEventInboxRecord {
  key: string
  event: MatrixIncomingEvent
  receivedAt: number
  status: MatrixEventInboxStatus
  error?: string
}

interface MatrixEventInboxState {
  version: 1
  records: Record<string, MatrixEventInboxRecord>
}

const DEFAULT_MAX_RECORDS = 10_000
const MAX_QUARANTINE_ERROR_LENGTH = 4_096

/**
 * Crash-safe boundary between Matrix /sync and command authorization.
 *
 * A /sync cursor may advance only after every mapped event listener has
 * returned. MatrixNodeSdkGatewayClient awaits this store's stage operation,
 * so process death can produce duplicate inbox records but cannot skip an
 * event whose sync token was already committed.
 */
export class FileMatrixEventInbox {
  private readonly file: AtomicJsonFile<MatrixEventInboxState>

  constructor(
    path: string,
    private readonly maxRecords = DEFAULT_MAX_RECORDS,
  ) {
    if (!Number.isSafeInteger(maxRecords) || maxRecords < 1) {
      throw new RangeError('Matrix event inbox limit must be a positive integer')
    }
    this.file = new AtomicJsonFile(path)
  }

  initialize(): Promise<void> {
    return this.file.transaction(defaultState, state => {
      validateState(state)
      return { result: undefined, changed: false }
    })
  }

  stage(eventInput: MatrixIncomingEvent, receivedAt = Date.now()): Promise<boolean> {
    const event = structuredClone(eventInput)
    const key = matrixEventInboxKey(event)
    return this.file.transaction(defaultState, state => {
      validateState(state)
      const current = state.records[key]
      if (current) {
        if (canonicalJson(current.event) !== canonicalJson(event)) {
          throw new Error(`Matrix event ${event.eventId} changed after durable receipt`)
        }
        return { result: false, changed: false }
      }
      if (Object.keys(state.records).length >= this.maxRecords) {
        throw new Error(`Matrix event inbox exceeded ${this.maxRecords} retained records`)
      }
      state.records[key] = {
        key,
        event,
        receivedAt,
        status: 'pending',
      }
      return { result: true, changed: true }
    })
  }

  pending(): Promise<MatrixEventInboxRecord[]> {
    return this.file.transaction(defaultState, state => {
      validateState(state)
      return {
        result: Object.values(state.records)
          .filter(record => record.status === 'pending')
          .sort((left, right) =>
            left.receivedAt - right.receivedAt || left.key.localeCompare(right.key))
          .map(record => structuredClone(record)),
        changed: false,
      }
    })
  }

  complete(event: MatrixIncomingEvent): Promise<void> {
    const key = matrixEventInboxKey(event)
    return this.file.transaction(defaultState, state => {
      validateState(state)
      if (!state.records[key]) return { result: undefined, changed: false }
      delete state.records[key]
      return { result: undefined, changed: true }
    })
  }

  quarantine(event: MatrixIncomingEvent, error: unknown): Promise<void> {
    const key = matrixEventInboxKey(event)
    const message = formatError(error).slice(0, MAX_QUARANTINE_ERROR_LENGTH)
    return this.file.transaction(defaultState, state => {
      validateState(state)
      const record = state.records[key]
      if (!record) throw new Error(`Matrix event ${event.eventId} is not in the durable inbox`)
      if (record.status === 'quarantined' && record.error === message) {
        return { result: undefined, changed: false }
      }
      record.status = 'quarantined'
      record.error = message
      return { result: undefined, changed: true }
    })
  }

  counts(): Promise<{ pending: number; quarantined: number }> {
    return this.file.transaction(defaultState, state => {
      validateState(state)
      let pending = 0
      let quarantined = 0
      for (const record of Object.values(state.records)) {
        if (record.status === 'pending') pending += 1
        else quarantined += 1
      }
      return { result: { pending, quarantined }, changed: false }
    })
  }
}

export function matrixEventInboxKey(event: MatrixIncomingEvent): string {
  return createHash('sha256')
    .update('malink-matrix-event-inbox:v1\0')
    .update(event.roomId)
    .update('\0')
    .update(event.eventId)
    .digest('hex')
}

function defaultState(): MatrixEventInboxState {
  return { version: 1, records: {} }
}

function validateState(state: MatrixEventInboxState): void {
  if (
    state.version !== 1
    || !state.records
    || typeof state.records !== 'object'
    || Array.isArray(state.records)
  ) {
    throw new Error('Invalid Matrix event inbox state')
  }
  for (const [key, record] of Object.entries(state.records)) {
    if (
      record.key !== key
      || matrixEventInboxKey(record.event) !== key
      || !Number.isSafeInteger(record.receivedAt)
      || record.receivedAt < 0
      || (record.status !== 'pending' && record.status !== 'quarantined')
      || (record.error !== undefined && typeof record.error !== 'string')
    ) {
      throw new Error(`Invalid Matrix event inbox record ${key}`)
    }
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
