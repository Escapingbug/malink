import { AtomicJsonFile } from '@malink/security/node'
import {
  matrixGatewayCapabilitiesSchema,
  providerControlSchema,
  providerControlValuesSchema,
  type MatrixGatewayCapabilities,
  type ProviderControl,
  type ProviderControlValues,
  type ProviderCommand,
  type SessionExtensionBinding,
} from '@malink/protocol'
import type { MatrixGatewayRoomConfig } from './config'
import { gatewayProjectIdentity } from './project'

export type Mlp3SessionLifecycle = 'active' | 'archived' | 'deleted'
export type Mlp3SessionScope = 'project' | 'scratch'

export interface PersistedProviderHistoryRoom {
  roomId: string
  historyId: string
  snapshotId: string
  materializedFrontier: number
  nextPageIndex: number
  totalMessages: number
}

export interface PersistedMlp3SessionArchiveCleanup {
  commandId: string
  requestedAt: number
  matrixThreadDeleted: boolean
  providerHistoryDeleted: boolean
  scratchDirectoryDeleted: boolean
}

export interface PersistedMlp3Session {
  id: string
  scope: Mlp3SessionScope
  cwd: string
  sourceCommandId: string
  threadRootEventId: string
  title: string
  createdAt: number
  updatedAt: number
  stateVersion: number
  lifecycle: Mlp3SessionLifecycle
  provider: string
  model: string | null
  reasoningEffort: string | null
  permissionMode: string
  controlValues: ProviderControlValues
  providerControls: ProviderControl[]
  providerSessionId: string | null
  providerHistory: PersistedProviderHistoryRoom | null
  archiveCleanup: PersistedMlp3SessionArchiveCleanup | null
  extensions: SessionExtensionBinding[]
  extensionRevision: number
  inheritedFromProjectExtensionRevision: number | null
  availableCommands: ProviderCommand[]
}

export interface PersistedMlp3Project {
  roomId: string
  projectId: string
  name: string
  cwd: string
  provider: string
  model: string | null
  reasoningEffort: string | null
  permissionMode: string
  controlValues: ProviderControlValues
  snapshotVersion: number
  capabilitySnapshotVersion: number
  capabilities: MatrixGatewayCapabilities | null
  workspaceSnapshotFingerprint: string | null
  defaultExtensions: SessionExtensionBinding[]
  extensionDefaultsRevision: number
  sessions: PersistedMlp3Session[]
}

interface V3RuntimeState {
  version: 3
  workspaceId: string
  projects: Record<string, PersistedMlp3Project>
}

/**
 * Authoritative Gateway metadata for MLP/3. It deliberately contains no
 * revision epoch, command sequence, current session or directory generation.
 */
export class FileMlp3RuntimeStateStore {
  private readonly file: AtomicJsonFile<V3RuntimeState>

  constructor(
    path: string,
    private readonly workspaceId: string,
  ) {
    this.file = new AtomicJsonFile(path)
  }

  async initialize(rooms: readonly MatrixGatewayRoomConfig[]): Promise<void> {
    await this.file.transaction(
      () => defaultState(this.workspaceId),
      state => {
        validateStateHeader(state, this.workspaceId)
        let changed = false
        // The first MLP/3 release omitted these fields. Migrate every retained
        // project, not only currently configured rooms, so skipped-version
        // upgrades cannot preserve an empty capability cache indefinitely.
        for (const existing of Object.values(state.projects)) {
          if (!Number.isSafeInteger(existing.capabilitySnapshotVersion)) {
            existing.capabilitySnapshotVersion = 0
            changed = true
          }
          if (existing.capabilities === undefined) {
            existing.capabilities = null
            changed = true
          }
          if (existing.workspaceSnapshotFingerprint === undefined) {
            existing.workspaceSnapshotFingerprint = null
            changed = true
          }
          if (!Array.isArray(existing.defaultExtensions)) {
            existing.defaultExtensions = []
            changed = true
          }
          if (!Number.isSafeInteger(existing.extensionDefaultsRevision)) {
            existing.extensionDefaultsRevision = 1
            changed = true
          }
          if (!existing.controlValues || typeof existing.controlValues !== 'object') {
            existing.controlValues = legacyControlValues(existing)
            changed = true
          }
          if (Array.isArray(existing.sessions)) {
            for (const session of existing.sessions) {
              if (session.scope !== 'project' && session.scope !== 'scratch') {
                session.scope = 'project'
                changed = true
              }
              if (typeof session.cwd !== 'string' || !session.cwd) {
                session.cwd = existing.cwd
                changed = true
              }
              if (!Number.isSafeInteger(session.extensionRevision)) {
                session.extensionRevision = 1
                changed = true
              }
              if (session.inheritedFromProjectExtensionRevision === undefined) {
                session.inheritedFromProjectExtensionRevision = null
                changed = true
              }
              if (!Array.isArray(session.availableCommands)) {
                session.availableCommands = []
                changed = true
              }
              if (!session.controlValues || typeof session.controlValues !== 'object') {
                session.controlValues = legacyControlValues(session)
                changed = true
              }
              if (!Array.isArray(session.providerControls)) {
                session.providerControls = []
                changed = true
              }
              if (session.providerHistory === undefined) {
                session.providerHistory = null
                changed = true
              }
              if (session.archiveCleanup === undefined) {
                // Archived records written before durable background cleanup
                // remain explicit-retry tombstones. They must not begin an
                // O(history) Matrix migration merely because the Gateway was
                // upgraded or restarted.
                session.archiveCleanup = null
                changed = true
              }
            }
          }
        }
        for (const room of rooms) {
          const existing = state.projects[room.roomId]
          if (!existing) {
            state.projects[room.roomId] = defaultProject(room)
            changed = true
            continue
          }
        }
        validateState(state, this.workspaceId)
        return { result: undefined, changed }
      },
    )
  }

  project(roomId: string): Promise<PersistedMlp3Project> {
    return this.file.transaction(
      () => defaultState(this.workspaceId),
      state => {
        validateState(state, this.workspaceId)
        const project = state.projects[roomId]
        if (!project) throw new Error(`MLP/3 project ${roomId} is not initialized`)
        return { result: structuredClone(project), changed: false }
      },
    )
  }

  updateProject<TResult>(
    roomId: string,
    update: (project: PersistedMlp3Project) => TResult,
  ): Promise<TResult> {
    return this.file.transaction(
      () => defaultState(this.workspaceId),
      state => {
        validateState(state, this.workspaceId)
        const project = state.projects[roomId]
        if (!project) throw new Error(`MLP/3 project ${roomId} is not initialized`)
        const result = update(project)
        validateProject(project, roomId)
        return { result, changed: true }
      },
    )
  }

  saveProject(projectInput: PersistedMlp3Project): Promise<void> {
    const project = structuredClone(projectInput)
    return this.file.transaction(
      () => defaultState(this.workspaceId),
      state => {
        validateState(state, this.workspaceId)
        if (!state.projects[project.roomId]) {
          throw new Error(`MLP/3 project ${project.roomId} is not initialized`)
        }
        validateProject(project, project.roomId)
        state.projects[project.roomId] = project
        return { result: undefined, changed: true }
      },
    )
  }

  deleteProject(roomId: string): Promise<void> {
    return this.file.transaction(
      () => defaultState(this.workspaceId),
      state => {
        validateState(state, this.workspaceId)
        if (!state.projects[roomId]) return { result: undefined, changed: false }
        delete state.projects[roomId]
        return { result: undefined, changed: true }
      },
    )
  }
}

function defaultState(workspaceId: string): V3RuntimeState {
  return { version: 3, workspaceId, projects: {} }
}

function defaultProject(room: MatrixGatewayRoomConfig): PersistedMlp3Project {
  const project = gatewayProjectIdentity(room.cwd, room.projectName)
  return {
    roomId: room.roomId,
    projectId: room.projectId ?? project.id,
    name: project.name,
    cwd: project.cwd,
    provider: room.providerName,
    model: room.model ?? null,
    reasoningEffort: typeof room.providerSettings?.reasoningEffort === 'string'
      ? room.providerSettings.reasoningEffort
      : null,
    permissionMode: typeof room.providerSettings?.permissionMode === 'string'
      ? room.providerSettings.permissionMode
      : 'default',
    controlValues: legacyControlValues({
      model: room.model ?? null,
      reasoningEffort: typeof room.providerSettings?.reasoningEffort === 'string'
        ? room.providerSettings.reasoningEffort
        : null,
      permissionMode: typeof room.providerSettings?.permissionMode === 'string'
        ? room.providerSettings.permissionMode
        : 'default',
    }),
    snapshotVersion: 1,
    capabilitySnapshotVersion: 0,
    capabilities: null,
    workspaceSnapshotFingerprint: null,
    defaultExtensions: [],
    extensionDefaultsRevision: 1,
    sessions: [],
  }
}

function validateStateHeader(value: V3RuntimeState, workspaceId: string): void {
  if (
    value.version !== 3
    || value.workspaceId !== workspaceId
    || !value.projects
    || typeof value.projects !== 'object'
    || Array.isArray(value.projects)
  ) {
    throw new Error('Invalid MLP/3 Gateway runtime state')
  }
}

function validateState(value: V3RuntimeState, workspaceId: string): void {
  validateStateHeader(value, workspaceId)
  for (const [roomId, project] of Object.entries(value.projects)) {
    validateProject(project, roomId)
  }
}

function validateProject(project: PersistedMlp3Project, roomId: string): void {
  if (
    project.roomId !== roomId
    || !project.projectId
    || !project.name
    || !project.cwd
    || !project.provider
    || !validProviderControlValues(project.controlValues)
    || !Number.isSafeInteger(project.snapshotVersion)
    || project.snapshotVersion < 1
    || !Number.isSafeInteger(project.capabilitySnapshotVersion)
    || project.capabilitySnapshotVersion < 0
    || !(project.capabilities === null || typeof project.capabilities === 'object')
    || !(project.workspaceSnapshotFingerprint === null
      || typeof project.workspaceSnapshotFingerprint === 'string')
    || !Array.isArray(project.defaultExtensions)
    || !Number.isSafeInteger(project.extensionDefaultsRevision)
    || project.extensionDefaultsRevision < 1
    || !Array.isArray(project.sessions)
  ) {
    throw new Error(`Invalid MLP/3 project state for ${roomId}`)
  }
  if (project.capabilities !== null) {
    matrixGatewayCapabilitiesSchema.parse(project.capabilities)
  }
  const ids = new Set<string>()
  for (const session of project.sessions) {
    if (
      !session.id
      || ids.has(session.id)
      || !['project', 'scratch'].includes(session.scope)
      || !session.cwd
      || !session.sourceCommandId
      || !session.threadRootEventId
      || !session.title
      || !Number.isSafeInteger(session.createdAt)
      || !Number.isSafeInteger(session.updatedAt)
      || !Number.isSafeInteger(session.stateVersion)
      || session.stateVersion < 1
      || !['active', 'archived', 'deleted'].includes(session.lifecycle)
      || !session.provider
      || !session.permissionMode
      || !validProviderControlValues(session.controlValues)
      || !Array.isArray(session.providerControls)
      || !Array.isArray(session.extensions)
      || !Number.isSafeInteger(session.extensionRevision)
      || session.extensionRevision < 1
      || !Array.isArray(session.availableCommands)
      || !validProviderHistoryRoom(session.providerHistory)
      || !validArchiveCleanup(session.archiveCleanup)
      || (session.archiveCleanup !== null && session.lifecycle !== 'archived')
      || (
        session.inheritedFromProjectExtensionRevision !== null
        && (
          !Number.isSafeInteger(session.inheritedFromProjectExtensionRevision)
          || session.inheritedFromProjectExtensionRevision < 1
        )
      )
    ) {
      throw new Error(`Invalid MLP/3 session ${session.id || '<missing>'} in ${roomId}`)
    }
    session.providerControls.forEach(control => providerControlSchema.parse(control))
    ids.add(session.id)
  }
}

function legacyControlValues(value: {
  model?: string | null
  reasoningEffort?: string | null
  permissionMode?: string | null
}): ProviderControlValues {
  return {
    ...(value.model ? { model: value.model } : {}),
    ...(value.reasoningEffort ? { reasoningEffort: value.reasoningEffort } : {}),
    ...(value.permissionMode ? { permissionMode: value.permissionMode } : {}),
  }
}

function validProviderControlValues(value: unknown): value is ProviderControlValues {
  return providerControlValuesSchema.safeParse(value).success
}

function validArchiveCleanup(value: PersistedMlp3SessionArchiveCleanup | null): boolean {
  return value === null || (
    typeof value.commandId === 'string'
    && value.commandId.length > 0
    && Number.isSafeInteger(value.requestedAt)
    && value.requestedAt >= 0
    && typeof value.matrixThreadDeleted === 'boolean'
    && typeof value.providerHistoryDeleted === 'boolean'
    && typeof value.scratchDirectoryDeleted === 'boolean'
  )
}

function validProviderHistoryRoom(value: PersistedProviderHistoryRoom | null): boolean {
  return value === null || (
    Boolean(value.roomId)
    && Boolean(value.historyId)
    && Boolean(value.snapshotId)
    && Number.isSafeInteger(value.materializedFrontier)
    && value.materializedFrontier >= 0
    && Number.isSafeInteger(value.nextPageIndex)
    && value.nextPageIndex >= 0
    && Number.isSafeInteger(value.totalMessages)
    && value.totalMessages >= 0
    && value.materializedFrontier <= value.totalMessages
  )
}
