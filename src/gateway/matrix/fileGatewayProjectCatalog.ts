import { canonicalJson } from '@malink/protocol'
import { AtomicJsonFile, type FileStoreOptions } from '@malink/security/node'
import type { MatrixGatewayRoomConfig } from './config'
import { gatewayProjectIdentity } from './project'

interface GatewayProjectCatalogState {
  version: 1
  gatewayNodeId: string
  projects: MatrixGatewayRoomConfig[]
}

/** Durable authority for the Matrix rooms owned by one Gateway node. */
export class FileGatewayProjectCatalog {
  private readonly file: AtomicJsonFile<GatewayProjectCatalogState>

  constructor(
    path: string,
    private readonly gatewayNodeId: string,
    options: FileStoreOptions = {},
  ) {
    this.file = new AtomicJsonFile(path, options)
  }

  async initialize(configured: readonly MatrixGatewayRoomConfig[]): Promise<void> {
    await this.file.transaction(
      () => initialState(this.gatewayNodeId),
      state => {
        validateState(state, this.gatewayNodeId)
        let changed = false
        for (const room of configured) {
          validateRoom(room)
          const index = state.projects.findIndex(project => project.roomId === room.roomId)
          if (index < 0) {
            state.projects.push(structuredClone(room))
            changed = true
            continue
          }
          const replacement = structuredClone(room)
          if (canonicalJson(state.projects[index]) !== canonicalJson(replacement)) {
            state.projects[index] = replacement
            changed = true
          }
        }
        state.projects.sort((left, right) => left.roomId.localeCompare(right.roomId))
        validateState(state, this.gatewayNodeId)
        return { result: undefined, changed }
      },
    )
  }

  list(): Promise<MatrixGatewayRoomConfig[]> {
    return this.file.transaction(
      () => initialState(this.gatewayNodeId),
      state => {
        validateState(state, this.gatewayNodeId)
        return { result: structuredClone(state.projects), changed: false }
      },
    )
  }

  findByProjectId(projectId: string): Promise<MatrixGatewayRoomConfig | undefined> {
    return this.file.transaction(
      () => initialState(this.gatewayNodeId),
      state => {
        validateState(state, this.gatewayNodeId)
        const room = state.projects.find(project => roomProjectId(project) === projectId)
        return { result: room ? structuredClone(room) : undefined, changed: false }
      },
    )
  }

  add(roomInput: MatrixGatewayRoomConfig): Promise<MatrixGatewayRoomConfig> {
    const room = structuredClone(roomInput)
    validateRoom(room)
    return this.file.transaction(
      () => initialState(this.gatewayNodeId),
      state => {
        validateState(state, this.gatewayNodeId)
        const projectId = roomProjectId(room)
        const existing = state.projects.find(project =>
          project.roomId === room.roomId || roomProjectId(project) === projectId)
        if (existing) {
          if (canonicalJson(existing) !== canonicalJson(room)) {
            throw new Error(`Gateway project ${projectId} conflicts with an existing route`)
          }
          return { result: structuredClone(existing), changed: false }
        }
        state.projects.push(room)
        state.projects.sort((left, right) => left.roomId.localeCompare(right.roomId))
        validateState(state, this.gatewayNodeId)
        return { result: structuredClone(room), changed: true }
      },
    )
  }
}

function initialState(gatewayNodeId: string): GatewayProjectCatalogState {
  return { version: 1, gatewayNodeId, projects: [] }
}

function roomProjectId(room: MatrixGatewayRoomConfig): string {
  return room.projectId ?? gatewayProjectIdentity(room.cwd, room.projectName).id
}

function validateState(state: GatewayProjectCatalogState, gatewayNodeId: string): void {
  if (
    state.version !== 1
    || state.gatewayNodeId !== gatewayNodeId
    || !Array.isArray(state.projects)
    || state.projects.length > 256
  ) throw new TypeError('Gateway project catalog is invalid')
  for (const room of state.projects) validateRoom(room)
  assertUnique(state.projects.map(room => room.roomId), 'room ID')
  assertUnique(state.projects.map(room => room.conversationId), 'conversation ID')
  assertUnique(state.projects.map(roomProjectId), 'project ID')
}

function validateRoom(room: MatrixGatewayRoomConfig): void {
  for (const [label, value] of [
    ['room ID', room.roomId],
    ['conversation ID', room.conversationId],
    ['working directory', room.cwd],
    ['provider', room.providerName],
  ] as const) {
    if (!value.trim()) throw new TypeError(`Gateway project ${label} is required`)
  }
  if (room.projectId !== undefined && !room.projectId.trim()) {
    throw new TypeError('Gateway project ID is required')
  }
  if (room.projectName !== undefined && !room.projectName.trim()) {
    throw new TypeError('Gateway project name is required')
  }
}

function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) {
    throw new TypeError(`Gateway project catalog has duplicate ${label}`)
  }
}
