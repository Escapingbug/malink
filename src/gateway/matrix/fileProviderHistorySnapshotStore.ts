import { AtomicJsonFile } from '@malink/security/node'
import type { ProviderHistoryMessage } from '@/providers/provider'

interface ProviderHistorySnapshotRecord {
  sessionId: string
  provider: string
  providerSessionId: string
  snapshotId: string
  title: string
  createdAt: number
  messages: ProviderHistoryMessage[]
}
interface ProviderHistorySnapshotState {
  version: 1
  workspaceId: string
  snapshots: Record<string, ProviderHistorySnapshotRecord>
}

/**
 * Immutable local provider transcript snapshots. Matrix materialization is
 * deliberately lazy, but every later page must read the same source image so
 * provider-side appends or rewrites cannot shift a reverse-pagination offset.
 */
export class FileProviderHistorySnapshotStore {
  private readonly file: AtomicJsonFile<ProviderHistorySnapshotState>

  constructor(path: string, private readonly workspaceId: string) {
    this.file = new AtomicJsonFile(path)
  }

  initialize(): Promise<void> {
    return this.file.transaction(
      () => initialState(this.workspaceId),
      state => {
        validateState(state, this.workspaceId)
        return { result: undefined, changed: false }
      },
    )
  }

  put(input: ProviderHistorySnapshotRecord): Promise<void> {
    const snapshot = structuredClone(input)
    validateSnapshot(snapshot, snapshot.sessionId)
    return this.file.transaction(
      () => initialState(this.workspaceId),
      state => {
        validateState(state, this.workspaceId)
        const current = state.snapshots[snapshot.sessionId]
        if (current) {
          if (current.snapshotId !== snapshot.snapshotId) {
            throw new Error(`Provider history snapshot for ${snapshot.sessionId} is immutable`)
          }
          return { result: undefined, changed: false }
        }
        state.snapshots[snapshot.sessionId] = snapshot
        return { result: undefined, changed: true }
      },
    )
  }

  get(sessionId: string): Promise<ProviderHistorySnapshotRecord | undefined> {
    return this.file.transaction(
      () => initialState(this.workspaceId),
      state => {
        validateState(state, this.workspaceId)
        const snapshot = state.snapshots[sessionId]
        return {
          result: snapshot ? structuredClone(snapshot) : undefined,
          changed: false,
        }
      },
    )
  }

  delete(sessionId: string): Promise<void> {
    return this.file.transaction(
      () => initialState(this.workspaceId),
      state => {
        validateState(state, this.workspaceId)
        if (!state.snapshots[sessionId]) return { result: undefined, changed: false }
        delete state.snapshots[sessionId]
        return { result: undefined, changed: true }
      },
    )
  }
}

function initialState(workspaceId: string): ProviderHistorySnapshotState {
  return { version: 1, workspaceId, snapshots: {} }
}

function validateState(value: ProviderHistorySnapshotState, workspaceId: string): void {
  if (
    value.version !== 1
    || value.workspaceId !== workspaceId
    || !value.snapshots
    || typeof value.snapshots !== 'object'
    || Array.isArray(value.snapshots)
  ) throw new Error('Invalid Provider History snapshot store')
  for (const [sessionId, snapshot] of Object.entries(value.snapshots)) {
    validateSnapshot(snapshot, sessionId)
  }
}

function validateSnapshot(value: ProviderHistorySnapshotRecord, sessionId: string): void {
  if (
    value.sessionId !== sessionId
    || !value.provider
    || !value.providerSessionId
    || !value.snapshotId
    || !value.title
    || !Number.isSafeInteger(value.createdAt)
    || value.createdAt < 0
    || !Array.isArray(value.messages)
  ) throw new Error(`Invalid Provider History snapshot for ${sessionId}`)
  const ids = new Set<string>()
  for (const message of value.messages) {
    if (
      !message.id
      || ids.has(message.id)
      || (message.role !== 'user' && message.role !== 'assistant')
      || typeof message.text !== 'string'
    ) throw new Error(`Invalid Provider History message in snapshot ${sessionId}`)
    ids.add(message.id)
  }
}
