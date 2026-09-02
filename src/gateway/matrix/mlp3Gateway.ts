import { createHash, randomUUID } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import {
  MALINK_MATRIX_EXTENSION,
  canonicalJson,
  matrixGatewayCapabilitiesSchema,
  type Mlp3Command,
  type Mlp3Event,
  type Mlp3EventPayload,
  type Mlp3SessionProjection,
  type JsonValue,
  type MatrixGatewayCapabilities,
  type NativeClientRelease,
  type PairingOperation,
  type ProviderCommand,
  type ProviderSessionEntry,
  type GatewayEnrollmentPending,
  type GatewayUpdateStatus,
} from '@malink/protocol'
import type {
  GatewayAgentUpdateBeginResult,
  GatewayAgentUpdateInstruction,
} from '@/ops/gatewayUpdateSupervisor'
import {
  AGENT_PERMISSION_MODES,
  isAgentPermissionMode,
  type AgentProvider,
  type ModelEntry,
} from '@/providers/provider'
import { createProviderInstance, getProvider, listProviders } from '@/providers/registry'
import type { AgentActivityPhase, TopicSession } from '@/bridge/channelPort'
import { createTopicSession, createTopicSessionRecord } from '@/bridge/topicSession'
import {
  MatrixMlp3Port,
  uploadMlp3Attachment,
  type MatrixIncomingEvent,
} from '@/channel/matrix'
import {
  validateMatrixGatewayConfig,
  type MatrixGatewayConfig,
  type MatrixGatewayRoomConfig,
} from './config'
import {
  createMatrixJsSdkGatewayClient,
  type MatrixGatewayClient,
} from './client'
import {
  FileMlp3CommandJournal,
  type Mlp3CommandJournalRecord,
  type Mlp3CommandTerminal,
} from './fileMlp3CommandJournal'
import {
  FileMatrixEventInbox,
  matrixEventInboxKey,
} from './fileMatrixEventInbox'
import {
  FileMlp3RuntimeStateStore,
  type PersistedMlp3Project,
  type PersistedMlp3Session,
} from './fileMlp3RuntimeState'
import {
  MatrixMlp3CommandAuthorizer,
  canApprovePrivilegedExecution,
  type Mlp3CommandAuthorizationRejection,
} from './mlp3Authorizer'
import { GatewayMlp3ContentLayer } from './mlp3Content'
import { FileNativeClientReleaseStore } from './fileNativeClientReleaseStore'
import {
  FileMlp3ArtifactStore,
  type ArtifactMessageContext,
} from './fileMlp3ArtifactStore'
import { gatewayProjectIdentity } from './project'
import { materializePromptInput } from './media'
import { SessionExtensionRegistry } from '@/runtime/sessionExtensions'
import type {
  PrivilegeExecutor,
  PrivilegedExecutionInput,
  PrivilegedExecutionResult,
} from '@/privilege'
import type { SendFileCommandResult } from '@/runtime/semanticSessionRuntime'
import {
  FileGatewayWebPushService,
  type GatewayWebPushService,
} from './webPush'
import {
  boundedProviderHistoryEventPayload,
  boundedProviderHistoryResult,
  boundedProviderSessionInspection,
  providerSessionsPage,
} from './providerHistoryTransport'

interface Mlp3SessionRuntime {
  record: PersistedMlp3Session
  port: MatrixMlp3Port
  session: TopicSession
  capabilityProvider: AgentProvider | null
  activity: { phase: Mlp3SessionProjection['activity'] }
  activeTurnId: string | null
}

interface V3ProjectRuntime {
  config: MatrixGatewayRoomConfig
  project: PersistedMlp3Project
  sessions: Map<string, Mlp3SessionRuntime>
  deletingCommandId: string | null
}

type Mlp3CommandOf<TOperation extends Mlp3Command['operation']> = Extract<
  Mlp3Command,
  { operation: TOperation }
>

interface ScheduledPromptCommand {
  command: Mlp3CommandOf<'prompt.submit'>
  cancelled: boolean
  agentDispatchStarted: boolean
  cancellation?: Promise<void>
}

export interface MatrixMlp3GatewayDependencies {
  client?: MatrixGatewayClient
  providerFactory?: (
    room: MatrixGatewayRoomConfig,
    session: Readonly<PersistedMlp3Session>,
  ) => AgentProvider | undefined
  sessionFactory?: (
    room: MatrixGatewayRoomConfig,
    port: MatrixMlp3Port,
    session: Readonly<PersistedMlp3Session>,
  ) => TopicSession
  now?: () => number
  onLog?: (message: string) => void
  onRejected?: (event: MatrixIncomingEvent, error: unknown) => void
  isTrustedDeviceActive?: (deviceId: string) => Promise<boolean>
  listTrustedDevices?: () => Promise<readonly import('./config').MatrixGatewayTrustedDevice[]>
  sessionExtensionRegistry?: SessionExtensionRegistry
  createDeviceInvitation?: (input: {
    requestedByDeviceId: string
    commandId: string
    lifetimeMs?: number
    allowedOperations?: PairingOperation[]
  }) => Promise<{ pairingLink: string; expiresAt: number }>
  createGatewayEnrollmentInvitation?: (input: {
    requestedByDeviceId: string
    commandId: string
    lifetimeMs?: number
  }) => Promise<{ enrollmentLink: string; expiresAt: number }>
  approveGatewayEnrollment?: (input: {
    requestedByDeviceId: string
    commandId: string
    enrollmentId: string
  }) => Promise<{ gatewayNodeId: string; gatewayName: string }>
  updateGatewayProfile?: (input: {
    requestedByDeviceId: string
    commandId: string
    gatewayNodeId: string
    gatewayName: string
  }) => Promise<{ gatewayNodeId: string; gatewayName: string; computerName: string }>
  pendingGatewayEnrollments?: () => Promise<readonly GatewayEnrollmentPending[]>
  privilegeExecutor?: PrivilegeExecutor
  webPushService?: GatewayWebPushService
  workspaceGatewayDirectory?: () => Promise<import('@malink/protocol').SignedWorkspaceGatewayDirectory | undefined>
  assertDirectoryAccess?: (input: {
    cwd: string
    operation: 'session.create' | 'prompt.submit' | 'provider.history'
  }) => Promise<void>
  createProject?: (input: {
    sourceRoom: MatrixGatewayRoomConfig
    requestedByDeviceId: string
    commandId: string
    name: string
    cwd: string
    provider?: string
    createDirectory?: boolean
  }) => Promise<{
    room: MatrixGatewayRoomConfig
    gatewayNodeId: string
    alreadyExisted: boolean
  }>
  onProjectCreated?: (room: MatrixGatewayRoomConfig) => Promise<void>
  updateProjectMetadata?: (input: {
    sourceRoom: MatrixGatewayRoomConfig
    requestedByDeviceId: string
    commandId: string
    name: string
  }) => Promise<MatrixGatewayRoomConfig>
  validateProjectDeletion?: (input: {
    sourceRoom: MatrixGatewayRoomConfig
    requestedByDeviceId: string
    commandId: string
    projectId: string
  }) => Promise<void>
  deleteProject?: (input: {
    sourceRoom: MatrixGatewayRoomConfig
    requestedByDeviceId: string
    commandId: string
    projectId: string
  }) => Promise<void>
  onProjectDeleted?: (room: MatrixGatewayRoomConfig) => Promise<void>
  gatewayUpdateSupervisor?: {
    status(): Promise<GatewayUpdateStatus>
    stage(releaseId: string): Promise<GatewayUpdateStatus>
    scheduleApply(releaseId: string): Promise<GatewayUpdateStatus>
    agentInstruction(releaseId: string): Promise<GatewayAgentUpdateInstruction>
    beginAgentUpdate(
      releaseId: string,
      maintenanceSessionId: string,
      ownerCommandId: string,
    ): Promise<GatewayAgentUpdateBeginResult>
    failAgentUpdate(
      releaseId: string,
      ownerCommandId: string,
      detail: string,
    ): Promise<GatewayUpdateStatus>
  }
}

export type MatrixMlp3GatewayState =
  | 'stopped'
  | 'starting'
  | 'running'
  | 'draining'
  | 'stopping'

export interface WorkspaceInboxFileInput {
  requestId: string
  path: string
  filename?: string
  caption?: string
  sourceLabel?: string
}

export interface WorkspaceInboxFileResult {
  fileId: string
  eventId: string
  delivery: 'delivered' | 'queued'
}

export interface SessionFileDeliveryInput {
  path: string
  filename?: string
  caption?: string
  type?: 'document' | 'file' | 'markdown' | 'code' | 'image'
  language?: string
}

export interface PublishNativeClientReleaseResult {
  changed: boolean
  release: NativeClientRelease
  projectCount: number
}

/**
 * Matrix-native MLP/3 Gateway.
 *
 * Commands are durable independent timeline objects. Execution is serialized
 * only within a session, while different session threads run concurrently.
 * There is no workspace revision, device sequence or global command lane.
 */
export class MatrixMlp3GatewayRunner {
  private readonly client: MatrixGatewayClient
  private readonly inbox: FileMatrixEventInbox
  private readonly journal: FileMlp3CommandJournal
  private readonly runtimeState: FileMlp3RuntimeStateStore
  private readonly nativeClientReleases: FileNativeClientReleaseStore
  private readonly artifacts: FileMlp3ArtifactStore
  private readonly authorizer: MatrixMlp3CommandAuthorizer
  private readonly content: GatewayMlp3ContentLayer
  private readonly extensions: SessionExtensionRegistry
  private readonly webPush: GatewayWebPushService
  private readonly projects = new Map<string, V3ProjectRuntime>()
  private readonly sessionChains = new Map<string, Promise<void>>()
  private readonly scheduledPromptCommands = new Map<string, ScheduledPromptCommand>()
  private readonly activeCommands = new Map<string, Promise<void>>()
  private readonly executionTasks = new Set<Promise<void>>()
  private readonly terminalDeliveriesInFlight = new Set<string>()
  private readonly queuedInboxEvents = new Set<string>()
  private eventChain: Promise<void> = Promise.resolve()
  private unsubscribe: (() => void) | null = null
  private state: MatrixMlp3GatewayState = 'stopped'
  private stopPromise: Promise<void> | null = null
  private updateDrainState: 'open' | 'waiting' | 'sealed' = 'open'
  private readonly deferredUpdateCommands = new Map<string, {
    project: V3ProjectRuntime
    record: Mlp3CommandJournalRecord
  }>()
  private publishedClientReleases: NativeClientRelease[] = []
  private readonly runtimeEpoch = randomUUID()
  private gatewayNodeStatusTimer: ReturnType<typeof setTimeout> | null = null
  private gatewayNodeStatusFingerprint: string | null = null
  private gatewayNodeStatusLastPublishedAt = 0
  private gatewayNodeStatusControlRoomId: string | null | undefined

  constructor(
    private readonly config: MatrixGatewayConfig,
    private readonly dependencies: MatrixMlp3GatewayDependencies = {},
  ) {
    validateMatrixGatewayConfig(config)
    this.client = dependencies.client
      ?? createMatrixJsSdkGatewayClient(config.connection, dependencies.onLog)
    this.inbox = new FileMatrixEventInbox(
      `${config.replayLedgerPath}.v3-matrix-inbox.json`,
      config.startupEventQueueLimit ?? 10_000,
    )
    this.journal = new FileMlp3CommandJournal(`${config.replayLedgerPath}.v3-commands.jsonl`)
    this.runtimeState = new FileMlp3RuntimeStateStore(
      `${config.replayLedgerPath}.v3-runtime-state.json`,
      config.gatewayId,
    )
    this.nativeClientReleases = new FileNativeClientReleaseStore(
      `${config.replayLedgerPath}.v3-client-releases.json`,
      config.gatewayId,
    )
    this.artifacts = new FileMlp3ArtifactStore(
      `${config.replayLedgerPath}.v3-artifacts.json`,
      config.gatewayId,
      { onLog: dependencies.onLog },
    )
    this.authorizer = new MatrixMlp3CommandAuthorizer(config.gatewayId, this.journal)
    this.content = new GatewayMlp3ContentLayer(
      config.gatewayId,
      config.applicationSecurity,
      config.trustedDevices,
      dependencies.listTrustedDevices,
      dependencies.onLog,
    )
    this.extensions = dependencies.sessionExtensionRegistry ?? new SessionExtensionRegistry()
    this.webPush = dependencies.webPushService ?? new FileGatewayWebPushService(
      config.webPush?.statePath ?? `${config.replayLedgerPath}.v3-web-push.json`,
      {
        ...(config.webPush?.subject ? { subject: config.webPush.subject } : {}),
        now: () => this.now(),
        onLog: dependencies.onLog,
        canDeliver: (deviceId, projectId) => this.canDeliverWebPush(deviceId, projectId),
      },
    )
  }

  getState(): MatrixMlp3GatewayState {
    return this.state
  }

  async receiveWorkspaceFile(
    input: WorkspaceInboxFileInput,
  ): Promise<WorkspaceInboxFileResult> {
    if (this.state !== 'running') {
      throw new Error(`Cannot receive a workspace file while Gateway is ${this.state}`)
    }
    const projects = (
      await Promise.all([...this.projects.values()].map(async project => ({
        project,
        active: await this.content.hasActiveDevices(project.config.roomId),
      })))
    ).filter(candidate => candidate.active).map(candidate => candidate.project)
    if (projects.length === 0) {
      throw new Error('The workspace file inbox has no active Malink device')
    }
    const attachment = await uploadMlp3Attachment(this.client, {
      path: input.path,
      ...(input.filename ? { filename: input.filename } : {}),
    })
    const eventId = workspaceInboxEventId(input.requestId)
    const occurredAt = this.now()
    let delivery: WorkspaceInboxFileResult['delivery'] = 'delivered'
    for (const project of projects) {
      const event: Mlp3Event = {
        kind: 'malink.event',
        version: 3,
        eventId,
        workspaceId: this.config.gatewayId,
        // Each project ID is a cryptographic route binding only. The logical
        // event has no session ID and is replicated once per active room so a
        // workspace device can receive it regardless of its paired project.
        projectId: project.project.projectId,
        occurredAt,
        payload: {
          type: 'inbox.file.received',
          fileId: input.requestId,
          ...(input.caption ? { caption: input.caption } : {}),
          source: {
            kind: 'local-cli',
            ...(input.sourceLabel ? { label: input.sourceLabel } : {}),
          },
          attachment,
        },
      }
      const sent = await this.content.queueEvent(project.config, event, this.client)
      if (sent.status === 'queued') delivery = 'queued'
    }
    return { fileId: input.requestId, eventId, delivery }
  }

  async start(): Promise<void> {
    if (this.state === 'running') return
    if (this.state !== 'stopped') throw new Error(`Cannot start MLP/3 Gateway while ${this.state}`)
    this.state = 'starting'
    try {
      await this.inbox.initialize()
      await this.journal.initialize()
      await this.runtimeState.initialize(this.config.rooms)
      await this.nativeClientReleases.initialize()
      await this.artifacts.initialize()
      this.publishedClientReleases = await this.nativeClientReleases.releases()
      await this.content.initialize()
      await this.createProjectRuntimes()
      for (const record of await this.journal.terminalByOperation('project.delete')) {
        if (record.terminal?.outcome !== 'succeeded') continue
        const project = this.projectForRecord(record)
        if (project) project.deletingCommandId = record.command.commandId
      }
      await this.webPush.initialize()
      this.unsubscribe = this.client.onRoomEvent(event => this.receiveEvent(event))
      await this.client.initializeCrypto(this.config.crypto)
      await this.client.start()
      await this.client.waitUntilReady(this.config.connection.initialSyncTimeoutMs)
      await this.client.pinTrustedDevices?.(this.config.trustedDevices)
      for (const project of this.projects.values()) {
        await this.client.assertRoomEncrypted(project.config.roomId)
        await this.content.provisionProject(project.config, this.client)
        if (project.deletingCommandId) continue
        await this.prepareSessionThreads(project)
        await this.publishSessionRecovery(project)
        await this.publishWorkspaceSnapshot(project)
        await this.publishProjectSnapshot(project)
      }
      this.state = 'running'
      this.scheduleGatewayNodeStatusObservation(
        Math.min(1_000, this.gatewayNodeStatusHeartbeatIntervalMs()),
      )
      await this.recoverJournal()
      await this.drainInbox()
      await this.eventChain
    } catch (error) {
      await this.cleanup()
      this.state = 'stopped'
      throw error
    }
  }

  stop(): Promise<void> {
    if (this.state === 'stopped') return Promise.resolve()
    if (this.stopPromise) return this.stopPromise
    const stopping = this.stopOnce().finally(() => {
      if (this.stopPromise === stopping) this.stopPromise = null
    })
    this.stopPromise = stopping
    return stopping
  }

  private async stopOnce(): Promise<void> {
    // While draining, Matrix listeners keep durably staging new events but no
    // new command execution begins. The replacement process resumes those
    // records after it owns the Matrix crypto store and sync cursor.
    this.state = 'draining'
    await this.eventChain
    while (this.executionTasks.size > 0) {
      await Promise.allSettled([...this.executionTasks])
    }
    this.state = 'stopping'
    await this.cleanup()
    this.state = 'stopped'
  }

  async inboxCounts(): Promise<{ pending: number; quarantined: number }> {
    return this.inbox.counts()
  }

  async healthSnapshot(): Promise<{
    runtimeEpoch: string
    activeTurns: number
    activeCommands: number
    pendingInboxEvents: number
    quarantinedInboxEvents: number
    matrixReady: boolean | null
    lastMatrixSyncAt: number | null
  }> {
    const inbox = await this.inbox.counts()
    const matrix = this.client.getSyncHealth?.()
    let activeTurns = 0
    for (const project of this.projects.values()) {
      for (const runtime of project.sessions.values()) {
        if (runtime.activeTurnId !== null) activeTurns += 1
      }
    }
    return {
      runtimeEpoch: this.runtimeEpoch,
      activeTurns,
      activeCommands: this.activeCommands.size,
      pendingInboxEvents: inbox.pending,
      quarantinedInboxEvents: inbox.quarantined,
      matrixReady: matrix?.ready ?? null,
      lastMatrixSyncAt: matrix?.lastSyncAt ?? null,
    }
  }

  async syncState(roomId?: string): Promise<void> {
    const projects = roomId
      ? [this.projects.get(roomId)].filter((value): value is V3ProjectRuntime => value !== undefined)
      : [...this.projects.values()]
    for (const project of projects) {
      await this.publishWorkspaceSnapshot(project)
      await this.publishProjectSnapshot(project)
    }
  }

  async provisionCurrentState(): Promise<void> {
    if (this.state !== 'running') {
      throw new Error(`Cannot provision MLP/3 state while Gateway is ${this.state}`)
    }
    for (const project of this.projects.values()) {
      await this.content.provisionProject(project.config, this.client)
      await this.publishWorkspaceSnapshot(project)
      await this.publishProjectSnapshot(project)
    }
  }

  async provisionPairingDevice(deviceId: string, roomId: string): Promise<void> {
    if (this.state !== 'running') {
      throw new Error(`Cannot provision MLP/3 pairing while Gateway is ${this.state}`)
    }
    const project = this.projects.get(roomId)
    if (!project) {
      throw new Error(`Cannot provision pairing for unknown Matrix room ${roomId}`)
    }
    await this.content.provisionPairingDevice(
      project.config,
      deviceId,
      this.client,
    )
    // Existing clients already left durable snapshot pointers in Room State,
    // so additive pairing only needs the addressed key grant. A brand-new
    // Gateway has no pointers yet and must publish its first readable
    // authoritative snapshot before making pairing observable.
    if (!this.content.hasDeliveredAuthoritativePointers(project.config)) {
      await this.publishWorkspaceSnapshot(project)
      await this.publishProjectSnapshot(project)
    }
  }

  publishNativeClientRelease(
    input: NativeClientRelease,
  ): Promise<PublishNativeClientReleaseResult> {
    if (this.state !== 'running') {
      throw new Error(`Cannot publish a native client release while Gateway is ${this.state}`)
    }
    const operation = this.eventChain.then(async () => {
      const published = await this.nativeClientReleases.publish(input)
      this.publishedClientReleases = published.releases
      // Publish even for an idempotent retry. If the previous admin request
      // committed the local release but lost a Matrix acknowledgement, the
      // durable MLP outbox and stable snapshot ID finish the same publication.
      const activeProjects: V3ProjectRuntime[] = []
      for (const project of this.projects.values()) {
        if (await this.content.hasActiveDevices(project.config.roomId)) {
          activeProjects.push(project)
        }
      }
      for (const project of activeProjects) await this.publishWorkspaceSnapshot(project)
      return {
        changed: published.changed,
        release: published.release,
        projectCount: activeProjects.length,
      }
    })
    this.eventChain = operation.then(() => undefined, () => undefined)
    return operation
  }

  async requestPrivilegedExecution(
    sessionId: string,
    input: PrivilegedExecutionInput,
  ): Promise<PrivilegedExecutionResult> {
    for (const project of this.projects.values()) {
      const runtime = project.sessions.get(sessionId)
      if (!runtime) continue
      if (!runtime.session.requestPrivilegedExecution) {
        throw new Error('This session does not support privileged execution')
      }
      return await runtime.session.requestPrivilegedExecution(input)
    }
    throw new Error(`Unknown active Malink session ${sessionId}`)
  }

  async sendSessionFile(
    sessionId: string,
    input: SessionFileDeliveryInput,
  ): Promise<SendFileCommandResult> {
    for (const project of this.projects.values()) {
      const runtime = project.sessions.get(sessionId)
      if (!runtime) continue
      const result = await runtime.session.dispatch({
        kind: 'command',
        name: 'send_file',
        args: JSON.stringify(input),
        source: 'mcp',
      })
      if (!isSendFileCommandResult(result)) {
        throw new Error('Session runtime returned an invalid file delivery result')
      }
      return result
    }
    throw new Error(`Unknown active Malink session ${sessionId}`)
  }

  private async receiveEvent(event: MatrixIncomingEvent): Promise<void> {
    await this.inbox.stage(event, this.now())
    if (this.state === 'running') this.enqueue(event)
  }

  private enqueue(event: MatrixIncomingEvent): void {
    const inboxKey = matrixEventInboxKey(event)
    if (this.queuedInboxEvents.has(inboxKey)) return
    this.queuedInboxEvents.add(inboxKey)
    const processEvent = async (): Promise<void> => {
      try {
        await this.handleEvent(event)
        await this.inbox.complete(event)
      } catch (error) {
        this.dependencies.onRejected?.(event, error)
        this.log(`[mlp3/matrix] rejected ${event.eventId}: ${formatError(error)}`)
        await this.inbox.quarantine(event, error)
      } finally {
        this.queuedInboxEvents.delete(inboxKey)
      }
    }
    this.eventChain = this.eventChain.then(processEvent, processEvent)
  }

  private async drainInbox(): Promise<void> {
    for (const record of await this.inbox.pending()) this.enqueue(record.event)
  }

  private async handleEvent(event: MatrixIncomingEvent): Promise<void> {
    // MLP/3 timeline objects are standard Matrix events whose application
    // payload is already AES-GCM encrypted and signed. Requiring Megolm here
    // would make the persistent Android /sync lane unable to consume them.
    if (event.eventType !== 'm.room.message' || event.encrypted) return
    const project = this.projects.get(event.roomId)
    if (!project) return
    const extension = asRecord(event.content[MALINK_MATRIX_EXTENSION])
    if (extension?.version !== 3 || !extension.envelope) return
    const opened = await this.content.openIncoming(extension, project.config)
    if (!opened) return
    if (event.sender !== opened.trustedDevice.matrixUserId) {
      throw new Error('Malink command Matrix sender does not match its device certificate')
    }
    if (
      this.dependencies.isTrustedDeviceActive
      && !(await this.dependencies.isTrustedDeviceActive(opened.authenticatedDeviceId))
    ) {
      throw new Error(`Malink device ${opened.authenticatedDeviceId} has been revoked`)
    }
    const authorized = await this.authorizer.authorize(
      opened.signed,
      opened.trustedDevice,
      project.config.roomId,
      project.project.projectId,
      event.eventId,
      this.now(),
    )
    this.log(
      `[mlp3/matrix] command ${authorized.command.commandId} `
      + `${authorized.command.operation} ${authorized.claim.kind}`,
    )
    this.observeRelationHint(project, authorized.command, event)
    const record = authorized.claim.record
    if (authorized.claim.kind === 'duplicate') {
      await this.publishCommandReconciliation(project, record).catch(error => {
        this.log(
          `[mlp3/matrix] command ${record.command.commandId} reconciliation failed: `
          + formatError(error),
        )
      })
    }
    if (record.status === 'terminal') {
      if (!record.terminalDeliveryEventId) this.scheduleTerminalRedelivery(project, record)
      return
    }
    if (project.deletingCommandId) {
      await this.failCommand(
        project,
        authorized.command,
        new Error('This project is being deleted and no longer accepts commands'),
      )
      return
    }
    if (authorized.rejection) {
      // A duplicate that was already dispatched was authorized under the
      // policy active at dispatch time. Never reinterpret in-flight execution
      // as a later authorization failure.
      if (record.status === 'dispatched') return
      await this.rejectCommandAuthorization(project, authorized.command, authorized.rejection)
      return
    }
    const activeKey = commandKey(authorized.command)
    if (record.status === 'dispatched' || this.activeCommands.has(activeKey)) return
    if (this.shouldDeferForGatewayUpdate(authorized.command)) {
      this.deferredUpdateCommands.set(activeKey, { project, record })
      this.log(
        `[mlp3/matrix] deferred ${authorized.command.commandId} while Gateway update drains`,
      )
      return
    }
    this.scheduleExecution(project, record)
  }

  private shouldDeferForGatewayUpdate(command: Mlp3Command): boolean {
    if (this.updateDrainState === 'open') return false
    if (this.updateDrainState === 'sealed') return true
    if (command.operation === 'gateway.update.status') return false
    return command.operation !== 'turn.cancel' && command.operation !== 'decision.answer'
  }

  private resumeDeferredUpdateCommands(): void {
    const deferred = [...this.deferredUpdateCommands.values()]
    this.deferredUpdateCommands.clear()
    for (const { project, record } of deferred) this.scheduleExecution(project, record)
  }

  private scheduleExecution(
    project: V3ProjectRuntime,
    journalRecord: Mlp3CommandJournalRecord,
  ): Promise<void> {
    const command = journalRecord.command
    const activeKey = commandKey(command)
    const scheduledPrompt = command.operation === 'prompt.submit'
      ? {
          command,
          cancelled: false,
          agentDispatchStarted: false,
        } satisfies ScheduledPromptCommand
      : undefined
    const scheduledPromptKey = scheduledPrompt
      ? promptScheduleKey(project, scheduledPrompt.command.sessionId, scheduledPrompt.command.commandId)
      : undefined
    if (scheduledPrompt && scheduledPromptKey) {
      this.scheduledPromptCommands.set(scheduledPromptKey, scheduledPrompt)
    }
    const sessionKey = command.operation === 'project.create'
      ? `${this.config.gatewayId}\0project-create`
      : command.operation === 'gateway.profile.update'
      ? `${this.config.gatewayId}\0gateway-profile`
      : command.operation === 'project.delete'
      ? `${this.config.gatewayId}\0project-delete`
      : command.operation === 'project.update'
      || command.operation === 'provider.sessions.list'
      || command.operation === 'provider.session.inspect'
      ? `${project.config.roomId}\0project-settings`
      : command.operation === 'notification.subscribe'
        || command.operation === 'notification.unsubscribe'
        ? `${project.config.roomId}\0notification-settings\0${command.deviceId}`
        : `${project.config.roomId}\0${command.sessionId ?? command.commandId}`
    const bypassSessionQueue = command.operation === 'turn.cancel'
      || command.operation === 'decision.answer'
    if (command.operation === 'project.delete') {
      project.deletingCommandId = command.commandId
    }
    const previous = bypassSessionQueue
      ? Promise.resolve()
      : command.operation === 'project.delete'
        ? Promise.all(
            [
              this.sessionChains.get(sessionKey),
              ...[...this.sessionChains.entries()]
                .filter(([key]) => key.startsWith(`${project.config.roomId}\0`))
                .map(([, chain]) => chain),
            ]
              .filter((chain): chain is Promise<void> => chain !== undefined)
              .map(chain => chain.catch(() => undefined)),
          ).then(() => undefined)
        : this.sessionChains.get(sessionKey) ?? Promise.resolve()
    const task = previous.catch(() => undefined).then(async () => {
      try {
        if (await waitForScheduledPromptCancellation(scheduledPrompt)) return
        await this.journal.markDispatched(command, this.now())
        if (await waitForScheduledPromptCancellation(scheduledPrompt)) return
        await this.execute(project, journalRecord)
      } catch (error) {
        this.log(`[mlp3/matrix] command ${command.commandId} failed: ${formatError(error)}`)
        await this.failCommand(project, command, error)
      }
    }).finally(() => {
      this.executionTasks.delete(task)
      if (this.activeCommands.get(activeKey) === task) this.activeCommands.delete(activeKey)
      if (!bypassSessionQueue && this.sessionChains.get(sessionKey) === task) {
        this.sessionChains.delete(sessionKey)
      }
      if (
        scheduledPromptKey
        && this.scheduledPromptCommands.get(scheduledPromptKey) === scheduledPrompt
      ) {
        this.scheduledPromptCommands.delete(scheduledPromptKey)
      }
      if (
        command.operation === 'project.delete'
        && project.deletingCommandId === command.commandId
        && this.projects.has(project.config.roomId)
      ) {
        void this.journal.get(command).then(record => {
          if (record?.terminal?.outcome !== 'succeeded') project.deletingCommandId = null
        })
      }
    })
    if (!bypassSessionQueue) this.sessionChains.set(sessionKey, task)
    this.activeCommands.set(activeKey, task)
    this.executionTasks.add(task)
    return task
  }

  private async execute(
    project: V3ProjectRuntime,
    journalRecord: Mlp3CommandJournalRecord,
  ): Promise<void> {
    const command = journalRecord.command
    switch (command.operation) {
      case 'session.create':
        await this.createSession(project, command, journalRecord.matrixEventId)
        return
      case 'prompt.submit':
        await this.executePrompt(project, command)
        return
      case 'turn.cancel':
        await this.cancelTurn(project, command)
        return
      case 'decision.answer':
        await this.answerDecision(project, command)
        return
      case 'artifact.materialize':
        await this.materializeArtifact(project, command)
        return
      case 'session.update':
        await this.updateSession(project, command)
        return
      case 'session.set_lifecycle':
        await this.setSessionLifecycle(project, command)
        return
      case 'project.update':
        await this.updateProject(project, command)
        return
      case 'project.delete':
        await this.deleteProject(project, command)
        return
      case 'project.create':
        await this.createProject(project, command)
        return
      case 'provider.sessions.list':
        await this.listProviderSessions(project, command)
        return
      case 'provider.session.inspect':
        await this.inspectProviderSession(project, command)
        return
      case 'device.invitation.create':
        await this.createInvitation(project, command)
        return
      case 'gateway.enrollment.invitation.create':
        await this.createGatewayEnrollmentInvitation(project, command)
        return
      case 'gateway.enrollment.approve':
        await this.approveGatewayEnrollment(project, command)
        return
      case 'gateway.profile.update':
        await this.updateGatewayProfile(project, command)
        return
      case 'notification.subscribe':
        await this.subscribeNotifications(project, command)
        return
      case 'notification.unsubscribe':
        await this.unsubscribeNotifications(project, command)
        return
      case 'gateway.update.stage':
        await this.stageGatewayUpdate(project, command, journalRecord.matrixEventId)
        return
      case 'gateway.update.apply':
        await this.applyGatewayUpdate(project, command)
        return
      case 'gateway.update.status':
        await this.reportGatewayUpdateStatus(project, command)
        return
    }
  }

  private async stageGatewayUpdate(
    project: V3ProjectRuntime,
    command: Mlp3CommandOf<'gateway.update.stage'>,
    rootEventId?: string,
  ): Promise<void> {
    if (!rootEventId) throw new Error('Gateway update command lost its Matrix thread root')
    const supervisor = this.requireGatewayUpdateSupervisor()
    let status = await supervisor.stage(command.payload.releaseId)
    if (['agent_required', 'agent_running', 'failed'].includes(status.phase)) {
      const instruction = await supervisor.agentInstruction(command.payload.releaseId)
      const maintenanceSessionId = this.maintenanceAgentSessionId(instruction.releaseId)
      const begin = await supervisor.beginAgentUpdate(
        command.payload.releaseId,
        maintenanceSessionId,
        command.commandId,
      )
      if (begin.started) {
        const runtime = await this.maintenanceAgentRuntime(
          project,
          command,
          rootEventId,
          instruction,
        )
        try {
          await this.runPrompt(
            project,
            runtime,
            command,
            { text: maintenanceAgentPrompt(instruction) },
            {
              settleCommand: false,
              childTurnId: this.maintenanceAgentTurnId(
                command.commandId,
                instruction.releaseId,
              ),
            },
          )
        } catch (error) {
          await supervisor.failAgentUpdate(
            command.payload.releaseId,
            command.commandId,
            formatError(error).slice(0, 4_096) || 'Maintenance Agent failed',
          ).catch(failureError => {
            this.log(
              `[mlp3/matrix] could not record maintenance Agent failure: `
              + formatError(failureError),
            )
          })
          throw gatewayUpdateAgentCommandError(error)
        }
        status = await supervisor.status()
        if (status.phase === 'agent_running') {
          status = await supervisor.failAgentUpdate(
            command.payload.releaseId,
            command.commandId,
            'The maintenance Agent finished without submitting a staged Gateway release. '
              + 'Open the maintenance session to review its report, fix the reported release '
              + 'or validation problem, then retry the signed update.',
          )
        }
      } else {
        status = await this.waitForMaintenanceAgent(command.payload.releaseId)
      }
      if (
        !['staged', 'scheduled', 'activating', 'probation', 'committed'].includes(status.phase)
        || status.releaseId !== command.payload.releaseId
        || status.targetBuildId !== instruction.buildId
      ) {
        throw new Error(
          `Maintenance Agent did not stage Gateway update ${command.payload.releaseId}; `
          + `supervisor reported ${status.phase}`,
        )
      }
    }
    await this.settleAndDeliver(
      project,
      command,
      this.eventFor(project, undefined, command, 'gateway-update-staged', {
        type: 'gateway.update.status',
        status,
      }),
      'succeeded',
      status,
    )
    await this.publishGatewayUpdateStatus()
  }

  private async maintenanceAgentRuntime(
    project: V3ProjectRuntime,
    command: Mlp3CommandOf<'gateway.update.stage'>,
    rootEventId: string,
    instruction: GatewayAgentUpdateInstruction,
  ): Promise<Mlp3SessionRuntime> {
    const sessionId = this.maintenanceAgentSessionId(instruction.releaseId)
    const existing = project.sessions.get(sessionId)
    if (existing) return existing
    const existingRecord = project.project.sessions.find(session => session.id === sessionId)
    if (existingRecord) {
      if (existingRecord.lifecycle !== 'active') {
        throw new Error(`Gateway maintenance session ${sessionId} is archived`)
      }
      const runtime = this.createSessionRuntime(project, existingRecord)
      project.sessions.set(sessionId, runtime)
      return runtime
    }
    const createdAt = this.now()
    const cwd = this.scratchSessionDirectory(sessionId)
    await mkdir(cwd, { recursive: true, mode: 0o700 })
    const record: PersistedMlp3Session = {
      id: sessionId,
      scope: 'scratch',
      cwd,
      sourceCommandId: command.commandId,
      threadRootEventId: rootEventId,
      title: `Gateway update ${instruction.versionName}`,
      createdAt,
      updatedAt: createdAt,
      stateVersion: 1,
      lifecycle: 'active',
      provider: project.project.provider,
      model: project.project.model,
      reasoningEffort: project.project.reasoningEffort,
      permissionMode: 'bypassPermissions',
      providerSessionId: null,
      extensions: [],
      extensionRevision: 1,
      inheritedFromProjectExtensionRevision: null,
      availableCommands: [],
    }
    project.project.sessions.push(record)
    try {
      const runtime = this.createSessionRuntime(project, record)
      project.sessions.set(sessionId, runtime)
      await this.persist(project)
      return runtime
    } catch (error) {
      project.sessions.delete(sessionId)
      project.project.sessions = project.project.sessions.filter(candidate => candidate !== record)
      await this.removeScratchSessionDirectory(record).catch(() => undefined)
      throw error
    }
  }

  private maintenanceAgentSessionId(releaseId: string): string {
    return gatewayMaintenanceSessionId(this.config.gatewayNodeId, releaseId)
  }

  private maintenanceAgentTurnId(commandId: string, releaseId: string): string {
    return `gateway-update-turn-${createHash('sha256')
      .update(`${this.config.gatewayNodeId}\0${releaseId}\0${commandId}`)
      .digest('hex')
      .slice(0, 40)}`
  }

  private async waitForMaintenanceAgent(releaseId: string): Promise<GatewayUpdateStatus> {
    for (let attempt = 0; attempt < 7_200; attempt += 1) {
      const status = await this.requireGatewayUpdateSupervisor().status()
      if (
        status.releaseId === releaseId
        && ['staged', 'scheduled', 'activating', 'probation', 'committed'].includes(status.phase)
      ) return status
      if (status.releaseId !== releaseId || status.phase === 'failed') {
        throw new Error(
          status.detail
            ?? `Maintenance Agent did not stage Gateway update ${releaseId}; `
              + `supervisor reported ${status.phase}`,
        )
      }
      await new Promise(resolveDelay => setTimeout(resolveDelay, 1_000))
    }
    throw new Error(`Timed out waiting for the maintenance Agent to stage ${releaseId}`)
  }

  private async applyGatewayUpdate(
    project: V3ProjectRuntime,
    command: Mlp3CommandOf<'gateway.update.apply'>,
  ): Promise<void> {
    const supervisor = this.requireGatewayUpdateSupervisor()
    if (this.updateDrainState !== 'open') {
      throw new Error('Another Gateway update is already draining this runtime')
    }
    this.updateDrainState = 'waiting'
    let scheduled = false
    try {
      if (command.payload.mode === 'force') await this.interruptActiveTurnsForUpdate()
      await this.drainGatewayForUpdate(project, command)
      // No business command or turn is active at this instant, and the sealed
      // gate synchronously prevents another one from starting before the
      // supervisor records its activation timer.
      this.updateDrainState = 'sealed'
      const status = await supervisor.scheduleApply(command.payload.releaseId)
      scheduled = true
      await this.settleAndDeliver(
        project,
        command,
        this.eventFor(project, undefined, command, 'gateway-update-scheduled', {
          type: 'gateway.update.status',
          status,
        }),
        'succeeded',
        status,
      )
      // The supervisor's activation delay starts only after the local request
      // returns. Queue the shared snapshot before that independent process
      // restarts this Gateway.
      await this.publishGatewayUpdateStatus()
    } finally {
      if (!scheduled) {
        this.updateDrainState = 'open'
        this.resumeDeferredUpdateCommands()
      }
    }
  }

  private async reportGatewayUpdateStatus(
    project: V3ProjectRuntime,
    command: Mlp3CommandOf<'gateway.update.status'>,
  ): Promise<void> {
    const status = await this.requireGatewayUpdateSupervisor().status()
    await this.settleAndDeliver(
      project,
      command,
      this.eventFor(project, undefined, command, 'gateway-update-status', {
        type: 'gateway.update.status',
        status,
      }),
      'succeeded',
      status,
    )
  }

  private requireGatewayUpdateSupervisor(): NonNullable<
    MatrixMlp3GatewayDependencies['gatewayUpdateSupervisor']
  > {
    const supervisor = this.dependencies.gatewayUpdateSupervisor
    if (!supervisor) {
      throw new Error('Gateway online updates are not installed on this computer')
    }
    return supervisor
  }

  private activeTurnCount(): number {
    let count = 0
    for (const project of this.projects.values()) {
      for (const runtime of project.sessions.values()) {
        if (runtime.activeTurnId !== null) count += 1
      }
    }
    return count
  }

  /**
   * Close the business-command gate first, then drain work that was already
   * running. Commands accepted after the gate closes remain in the durable
   * journal for the replacement Gateway to resume after activation.
   */
  private async drainGatewayForUpdate(
    project: V3ProjectRuntime,
    command: Mlp3CommandOf<'gateway.update.apply'>,
  ): Promise<void> {
    let published = false
    while (this.activeTurnCount() > 0 || this.otherActiveCommandCount(command) > 0) {
      if (!published) {
        const current = await this.requireGatewayUpdateSupervisor().status()
        await this.emitBestEffort(project, undefined, this.eventFor(
          project,
          undefined,
          command,
          'gateway-update-waiting-for-idle',
          {
            type: 'gateway.update.status',
            status: {
              ...current,
              phase: 'waiting_for_idle',
              activeTurns: this.activeTurnCount(),
              updatedAt: this.now(),
            },
          },
        ))
        published = true
      }
      await new Promise(resolveDelay => setTimeout(resolveDelay, 500))
      if (this.state !== 'running') {
        throw new Error('Gateway stopped while waiting to apply its update')
      }
    }
  }

  private otherActiveCommandCount(command: Mlp3Command): number {
    const currentKey = commandKey(command)
    let count = 0
    for (const key of this.activeCommands.keys()) {
      if (key !== currentKey) count += 1
    }
    return count
  }

  private async interruptActiveTurnsForUpdate(): Promise<void> {
    const cancellations: Promise<unknown>[] = []
    for (const project of this.projects.values()) {
      for (const runtime of project.sessions.values()) {
        if (runtime.activeTurnId === null) continue
        cancellations.push(runtime.session.dispatch({
          kind: 'cancel',
          reason: 'replace',
          source: 'channel',
          user: { id: 'gateway-update', username: 'gateway-update' },
        }))
      }
    }
    await Promise.allSettled(cancellations)
    const deadline = this.now() + 10_000
    while (this.activeTurnCount() > 0 && this.now() < deadline) {
      await new Promise(resolveDelay => setTimeout(resolveDelay, 100))
    }
    if (this.activeTurnCount() > 0) {
      throw new Error('Active Agent turns did not stop for the forced Gateway update')
    }
  }

  private async publishGatewayUpdateStatus(): Promise<void> {
    await this.publishGatewayNodeStatus(true).catch(error => {
      this.log(`[mlp3/matrix] Gateway node status publication failed: ${formatError(error)}`)
    })
  }

  /**
   * Observe the local supervisor frequently but publish to Matrix only when
   * its semantic status changes or one shared heartbeat becomes due. Client
   * count and project count therefore do not multiply status traffic.
   */
  private scheduleGatewayNodeStatusObservation(delayMs: number): void {
    if (this.gatewayNodeStatusTimer !== null) clearTimeout(this.gatewayNodeStatusTimer)
    if (this.state !== 'running') return
    this.gatewayNodeStatusTimer = setTimeout(() => {
      this.gatewayNodeStatusTimer = null
      const observe = this.eventChain.then(() => this.publishGatewayNodeStatus(false))
      this.eventChain = observe.then(() => undefined, error => {
        this.log(`[mlp3/matrix] Gateway node status observation failed: ${formatError(error)}`)
      })
      void observe.catch(() => undefined).finally(() => {
        this.scheduleGatewayNodeStatusObservation(this.gatewayNodeStatusObservationIntervalMs())
      })
    }, delayMs)
    this.gatewayNodeStatusTimer.unref?.()
  }

  private gatewayNodeStatusHeartbeatIntervalMs(): number {
    return this.config.gatewayHeartbeatIntervalMs ?? 5 * 60_000
  }

  private gatewayNodeStatusObservationIntervalMs(): number {
    return Math.min(2_000, Math.max(250, this.gatewayNodeStatusHeartbeatIntervalMs() / 4))
  }

  private async publishGatewayNodeStatus(force: boolean): Promise<void> {
    if (this.state !== 'running') return
    const update = await this.dependencies.gatewayUpdateSupervisor?.status().catch(error => {
      this.log(`[mlp3/matrix] Gateway update status unavailable: ${formatError(error)}`)
      return undefined
    })
    if (!update) return
    const fingerprint = canonicalJson(update as JsonValue)
    const now = this.now()
    if (
      !force
      && fingerprint === this.gatewayNodeStatusFingerprint
      && now - this.gatewayNodeStatusLastPublishedAt < this.gatewayNodeStatusHeartbeatIntervalMs()
    ) return
    const project = await this.gatewayNodeStatusProject()
    if (!project) return
    const observedAt = Math.max(now, this.gatewayNodeStatusLastPublishedAt + 1)
    const event: Mlp3Event = {
      kind: 'malink.event',
      version: 3,
      eventId: logicalGatewayNodeStatusEventId(
        this.config.gatewayId,
        this.config.gatewayNodeId,
        observedAt,
      ),
      workspaceId: this.config.gatewayId,
      projectId: project.project.projectId,
      occurredAt: observedAt,
      payload: {
        // Reuse the existing compatible event shape. The absence of a
        // causationCommandId distinguishes this shared observation from a
        // manual gateway.update.status command result.
        type: 'gateway.update.status',
        status: update,
      },
    }
    await this.content.queueEvent(project.config, event, this.client)
    this.gatewayNodeStatusFingerprint = fingerprint
    this.gatewayNodeStatusLastPublishedAt = observedAt
  }

  private async gatewayNodeStatusProject(): Promise<V3ProjectRuntime | null> {
    if (this.gatewayNodeStatusControlRoomId === undefined) {
      const directory = await this.dependencies.workspaceGatewayDirectory?.().catch(error => {
        this.log(`[mlp3/matrix] Gateway status control route unavailable: ${formatError(error)}`)
        return undefined
      })
      this.gatewayNodeStatusControlRoomId = directory?.directory.gateways.find(gateway =>
        gateway.gatewayNodeId === this.config.gatewayNodeId
      )?.transport.roomId ?? null
    }
    const controlRoomId = this.gatewayNodeStatusControlRoomId
    const controlProject = controlRoomId ? this.projects.get(controlRoomId) : undefined
    if (
      controlProject
      && await this.content.hasActiveDevices(controlProject.config.roomId)
    ) return controlProject
    const projects = [...this.projects.values()].sort((left, right) =>
      left.project.projectId.localeCompare(right.project.projectId),
    )
    for (const project of projects) {
      if (await this.content.hasActiveDevices(project.config.roomId)) return project
    }
    return null
  }

  private async subscribeNotifications(
    project: V3ProjectRuntime,
    command: Mlp3CommandOf<'notification.subscribe'>,
  ): Promise<void> {
    await this.webPush.upsertSubscription(command.deviceId, command.payload.subscription, this.now())
    await this.settleAndDeliver(
      project,
      command,
      this.eventFor(project, undefined, command, 'notification-subscription-enabled', {
        type: 'notification.subscription.changed',
        enabled: true,
      }),
      'succeeded',
    )
  }

  private async unsubscribeNotifications(
    project: V3ProjectRuntime,
    command: Mlp3CommandOf<'notification.unsubscribe'>,
  ): Promise<void> {
    await this.webPush.removeSubscription(command.deviceId, command.payload.endpoint)
    await this.settleAndDeliver(
      project,
      command,
      this.eventFor(project, undefined, command, 'notification-subscription-disabled', {
        type: 'notification.subscription.changed',
        enabled: false,
      }),
      'succeeded',
    )
  }

  private async createSession(
    project: V3ProjectRuntime,
    command: Mlp3CommandOf<'session.create'>,
    rootEventId?: string,
  ): Promise<void> {
    if (!command.sessionId) throw new Error('Session create command is missing its session ID')
    if (!rootEventId) throw new Error('Session create command lost its Matrix thread root')
    const existing = project.project.sessions.find(session => session.id === command.sessionId)
    if (existing) {
      if (existing.lifecycle === 'deleted') {
        throw new Error(`Session ${command.sessionId} is permanently deleted`)
      }
      const event = this.eventFor(project, existing, command, 'session-ready', {
        type: 'session.ready',
        rootCommandId: existing.sourceCommandId,
        originDeviceId: command.deviceId,
        ...(command.payload.initialPrompt
          ? { initialPrompt: command.payload.initialPrompt }
          : {}),
        projection: terminalProjection(existing, 'idle', this.extensions),
        provider: existing.provider,
        ...(existing.model ? { model: existing.model } : {}),
        ...(existing.reasoningEffort ? { reasoningEffort: existing.reasoningEffort } : {}),
        permissionMode: existing.permissionMode,
        extensionBindings: existing.extensions,
      })
      await this.settleAndDeliver(project, command, event, 'succeeded')
      return
    }
    if (command.payload.providerSessionId) {
      const managed = project.project.sessions.find(session =>
        session.lifecycle === 'active'
        && session.provider === (command.payload.provider ?? project.project.provider)
        && session.providerSessionId === command.payload.providerSessionId
      )
      if (managed) {
        throw new Error(`Provider session is already managed by Malink session ${managed.id}`)
      }
    }
    const settings = this.resolveCreateSettings(project, command)
    const createdAt = this.now()
    const scope = command.payload.scope ?? 'project'
    const cwd = scope === 'scratch'
      ? this.scratchSessionDirectory(command.sessionId)
      : project.project.cwd
    if (scope === 'project') {
      await this.dependencies.assertDirectoryAccess?.({
        cwd,
        operation: 'session.create',
      })
    }
    if (scope === 'scratch') await mkdir(cwd, { recursive: true, mode: 0o700 })
    const record: PersistedMlp3Session = {
      id: command.sessionId,
      scope,
      cwd,
      sourceCommandId: command.commandId,
      threadRootEventId: rootEventId,
      title: command.payload.title?.trim()
        || titleFromPrompt(command.payload.initialPrompt?.text ?? '')
        || 'New session',
      createdAt,
      updatedAt: createdAt,
      stateVersion: 1,
      lifecycle: 'active',
      provider: settings.provider,
      model: settings.model,
      reasoningEffort: settings.reasoningEffort,
      permissionMode: settings.permissionMode,
      providerSessionId: command.payload.providerSessionId ?? null,
      extensions: this.extensions.normalizeBindings(
        command.payload.extensions ?? project.project.defaultExtensions,
      ),
      extensionRevision: 1,
      inheritedFromProjectExtensionRevision: command.payload.extensions === undefined
        ? project.project.extensionDefaultsRevision
        : null,
      availableCommands: [],
    }
    project.project.sessions.push(record)
    let runtime: Mlp3SessionRuntime | null = null
    try {
      runtime = this.createSessionRuntime(project, record)
      project.sessions.set(record.id, runtime)
      await this.persist(project)
    } catch (error) {
      project.sessions.delete(record.id)
      project.project.sessions = project.project.sessions.filter(candidate => candidate !== record)
      if (runtime) await this.destroySessionRuntime(runtime, 'delete').catch(() => undefined)
      if (scope === 'scratch') await this.removeScratchSessionDirectory(record).catch(() => undefined)
      throw error
    }
    const ready = this.eventFor(project, record, command, 'session-ready', {
      type: 'session.ready',
      rootCommandId: command.commandId,
      originDeviceId: command.deviceId,
      ...(command.payload.initialPrompt
        ? { initialPrompt: command.payload.initialPrompt }
        : {}),
      projection: terminalProjection(record, 'idle', this.extensions),
      provider: record.provider,
      ...(record.model ? { model: record.model } : {}),
      ...(record.reasoningEffort ? { reasoningEffort: record.reasoningEffort } : {}),
      permissionMode: record.permissionMode,
      extensionBindings: record.extensions,
    })
    if (!command.payload.initialPrompt) {
      await this.settleAndDeliver(project, command, ready, 'succeeded')
      return
    }
    await this.emitBestEffort(project, record, ready)
    await this.runPrompt(project, runtime, command, command.payload.initialPrompt)
  }

  private async executePrompt(
    project: V3ProjectRuntime,
    command: Mlp3CommandOf<'prompt.submit'>,
  ): Promise<void> {
    const runtime = this.requireActiveSession(project, command.sessionId)
    if (runtime.record.title === 'New session') {
      runtime.record.title = titleFromPrompt(command.payload.text)
        || command.payload.attachments?.[0]?.name
        || 'New session'
    }
    await this.runPrompt(project, runtime, command, command.payload)
  }

  private async runPrompt(
    project: V3ProjectRuntime,
    runtime: Mlp3SessionRuntime,
    command: Mlp3Command,
    prompt: { text: string; attachments?: import('@malink/protocol').MalinkAttachment[] },
    options: { settleCommand?: boolean; childTurnId?: string } = {},
  ): Promise<void> {
    if (options.childTurnId && options.settleCommand !== false) {
      throw new Error('A child Agent turn cannot settle its parent command')
    }
    // Composite operations such as a Gateway update can run a visible Agent
    // turn before their own authoritative terminal result exists. Give that
    // child turn a separate causal identity: clients infer command completion
    // from causal terminal events, so reusing the parent command ID would let
    // turn.completed settle gateway.update.stage before its signed status.
    const eventCommand = options.childTurnId
      ? { ...command, commandId: options.childTurnId }
      : command
    if (await this.waitForPromptCancellation(project, eventCommand)) return
    if (runtime.record.scope !== 'scratch') {
      await this.dependencies.assertDirectoryAccess?.({
        cwd: runtime.record.cwd,
        operation: 'prompt.submit',
      })
    }
    if (await this.waitForPromptCancellation(project, eventCommand)) return
    this.transition(runtime, 'queued')
    await this.persist(project)
    if (await this.waitForPromptCancellation(project, eventCommand)) return
    await this.emitBestEffort(project, runtime.record, this.eventFor(
      project,
      runtime.record,
      eventCommand,
      'turn-queued',
      {
        type: 'turn.queued',
        turnId: eventCommand.commandId,
        originDeviceId: command.deviceId,
        text: prompt.text,
        ...(prompt.attachments ? { attachments: prompt.attachments } : {}),
        projection: projection(runtime.record, runtime.activity.phase, this.extensions),
      },
    ))
    if (await this.waitForPromptCancellation(project, eventCommand)) return
    this.transition(runtime, 'working')
    await this.persist(project)
    if (await this.waitForPromptCancellation(project, eventCommand)) return
    runtime.port.setCausationCommandId(eventCommand.commandId)
    runtime.activeTurnId = eventCommand.commandId
    let dispatchFailure: { error: unknown } | null = null
    try {
      const richInput = await materializePromptInput(
        prompt,
        this.client,
        `${this.config.replayLedgerPath}.v3-attachments`,
      )
      if (await this.waitForPromptCancellation(project, eventCommand)) return
      await this.emitBestEffort(project, runtime.record, this.eventFor(
        project,
        runtime.record,
        eventCommand,
        'turn-started',
        {
          type: 'turn.started',
          turnId: eventCommand.commandId,
          projection: projection(runtime.record, runtime.activity.phase, this.extensions),
        },
      ))
      if (!this.beginPromptAgentDispatch(project, eventCommand)) {
        await this.waitForPromptCancellation(project, eventCommand)
        return
      }
      await runtime.session.dispatch({
        kind: 'user_message',
        text: prompt.text,
        richInput,
        source: 'channel',
        user: { id: command.deviceId, username: command.deviceId },
      })
    } catch (error) {
      dispatchFailure = { error }
    } finally {
      const causalDelivery = runtime.port.causalDeliveryBarrier(eventCommand.commandId)
      runtime.port.setCausationCommandId(null)
      runtime.activeTurnId = null
      try {
        // The terminal event is deliberately not staged until the newest
        // version of every assistant/tool message in this turn is physically
        // accepted by Matrix. This prevents urgent turn.completed delivery
        // from overtaking the final answer under account-wide backpressure.
        await causalDelivery
      } catch (deliveryError) {
        if (dispatchFailure) {
          throw new AggregateError(
            [dispatchFailure.error, deliveryError],
            'Agent execution and causal Matrix delivery both failed',
          )
        }
        throw deliveryError
      }
    }
    if (dispatchFailure) throw dispatchFailure.error
    runtime.record.providerSessionId = runtime.session.sessionRecord.conversationId
    this.transition(runtime, 'idle')
    await this.persist(project)
    const completed = this.eventFor(project, runtime.record, eventCommand, 'turn-completed', {
      type: 'turn.completed',
      turnId: eventCommand.commandId,
      outcome: 'succeeded',
      projection: terminalProjection(runtime.record, runtime.activity.phase, this.extensions),
    })
    if (options.settleCommand === false) await this.emitBestEffort(project, runtime.record, completed)
    else await this.settleAndDeliver(project, command, completed, 'succeeded')
    this.log(`[mlp3/matrix] turn ${command.commandId} completed`)
  }

  private async cancelTurn(
    project: V3ProjectRuntime,
    command: Mlp3CommandOf<'turn.cancel'>,
  ): Promise<void> {
    const runtime = this.requireActiveSession(project, command.sessionId)
    if (await this.cancelScheduledPrompt(project, runtime, command.payload.turnId)) {
      const completed = this.eventFor(project, runtime.record, command, 'queued-turn-cancelled', {
        type: 'turn.completed',
        turnId: command.payload.turnId,
        outcome: 'cancelled',
        projection: terminalProjection(runtime.record, runtime.activity.phase, this.extensions),
      })
      await this.settleAndDeliver(project, command, completed, 'succeeded')
      this.log(`[mlp3/matrix] queued turn ${command.payload.turnId} cancelled before dispatch`)
      return
    }
    if (runtime.activeTurnId === null) {
      if (runtime.activity.phase !== 'idle') {
        this.transition(runtime, 'idle')
        await this.persist(project)
      }
      const completed = this.eventFor(project, runtime.record, command, 'turn-already-settled', {
        type: 'turn.completed',
        turnId: command.payload.turnId,
        outcome: 'cancelled',
        projection: terminalProjection(runtime.record, 'idle', this.extensions),
      })
      await this.settleAndDeliver(project, command, completed, 'succeeded')
      this.log(`[mlp3/matrix] turn ${command.payload.turnId} was already inactive; converged cancel`)
      return
    }
    if (runtime.activeTurnId !== command.payload.turnId) {
      throw new Error(`Turn ${command.payload.turnId} is not active`)
    }
    await runtime.session.dispatch({
      kind: 'cancel',
      reason: 'user',
      source: 'channel',
      user: { id: command.deviceId, username: command.deviceId },
    })
    this.transition(runtime, 'idle')
    await this.persist(project)
    const completed = this.eventFor(project, runtime.record, command, 'turn-cancelled', {
      type: 'turn.completed',
      turnId: command.payload.turnId,
      outcome: 'cancelled',
      projection: terminalProjection(runtime.record, runtime.activity.phase, this.extensions),
    })
    await this.settleAndDeliver(project, command, completed, 'succeeded')
  }

  private async cancelScheduledPrompt(
    project: V3ProjectRuntime,
    runtime: Mlp3SessionRuntime,
    turnId: string,
  ): Promise<boolean> {
    const key = promptScheduleKey(project, runtime.record.id, turnId)
    const scheduled = this.scheduledPromptCommands.get(key)
    if (!scheduled || scheduled.agentDispatchStarted) return false
    if (scheduled.cancelled) {
      await scheduled.cancellation
      return true
    }
    scheduled.cancelled = true
    const cancellation = this.settleScheduledPromptCancellation(
      project,
      runtime,
      scheduled.command,
    )
    scheduled.cancellation = cancellation
    await cancellation
    return true
  }

  private async settleScheduledPromptCancellation(
    project: V3ProjectRuntime,
    runtime: Mlp3SessionRuntime,
    command: Mlp3CommandOf<'prompt.submit'>,
  ): Promise<void> {
    if (runtime.activeTurnId === command.commandId) {
      runtime.activeTurnId = null
      this.transition(runtime, 'idle')
      await this.persist(project)
    } else if (runtime.activeTurnId === null && runtime.activity.phase !== 'idle') {
      this.transition(runtime, 'idle')
      await this.persist(project)
    }
    const completed = this.eventFor(project, runtime.record, command, 'cancelled-before-dispatch', {
      type: 'turn.completed',
      turnId: command.commandId,
      outcome: 'cancelled',
      projection: terminalProjection(runtime.record, runtime.activity.phase, this.extensions),
    })
    await this.settleAndDeliver(project, command, completed, 'succeeded')
  }

  private waitForPromptCancellation(
    project: V3ProjectRuntime,
    command: Mlp3Command,
  ): Promise<boolean> {
    if (command.operation !== 'prompt.submit' || !command.sessionId) {
      return Promise.resolve(false)
    }
    return waitForScheduledPromptCancellation(
      this.scheduledPromptCommands.get(
        promptScheduleKey(project, command.sessionId, command.commandId),
      ),
    )
  }

  private beginPromptAgentDispatch(
    project: V3ProjectRuntime,
    command: Mlp3Command,
  ): boolean {
    if (command.operation !== 'prompt.submit' || !command.sessionId) return true
    const scheduled = this.scheduledPromptCommands.get(
      promptScheduleKey(project, command.sessionId, command.commandId),
    )
    if (!scheduled) return true
    if (scheduled.cancelled) return false
    scheduled.agentDispatchStarted = true
    return true
  }

  private async answerDecision(
    project: V3ProjectRuntime,
    command: Mlp3CommandOf<'decision.answer'>,
  ): Promise<void> {
    const runtime = this.requireActiveSession(project, command.sessionId)
    if (runtime.port.decisionType(command.payload.requestId) === 'privilege') {
      const devices = this.dependencies.listTrustedDevices
        ? await this.dependencies.listTrustedDevices()
        : this.config.trustedDevices
      const device = devices.find(candidate => candidate.deviceId === command.deviceId)
      if (!canApprovePrivilegedExecution(device)) {
        throw new Error(
          `Malink device ${command.deviceId} is not authorized to approve privileged execution`,
        )
      }
    }
    const decision = runtime.port.resolveDecision(
      command.payload.requestId,
      command.payload.decision,
      command.payload.totp,
    )
    if (!decision) {
      throw new Error(`Unknown or invalid decision request ${command.payload.requestId}`)
    }
    runtime.record.updatedAt = this.now()
    runtime.record.stateVersion += 1
    await this.persist(project)
    const resolved = decision.kind === 'extension'
      ? this.eventFor(project, runtime.record, command, 'extension-interaction-resolved', {
        type: 'extension.interaction.resolved',
        requestId: command.payload.requestId,
        extensionId: decision.extensionId ?? 'unknown',
        actionId: command.payload.decision,
        projection: projection(runtime.record, runtime.activity.phase, this.extensions),
      })
      : this.eventFor(project, runtime.record, command, 'decision-resolved', {
        type: 'decision.resolved',
        requestId: command.payload.requestId,
        decision: command.payload.decision,
        projection: projection(runtime.record, runtime.activity.phase, this.extensions),
      })
    await this.settleAndDeliver(project, command, resolved, 'succeeded')
  }

  private async materializeArtifact(
    project: V3ProjectRuntime,
    command: Mlp3CommandOf<'artifact.materialize'>,
  ): Promise<void> {
    const runtime = this.requireActiveSession(project, command.sessionId)
    const artifactContext: ArtifactMessageContext = {
      roomId: project.config.roomId,
      projectId: project.project.projectId,
      sessionId: runtime.record.id,
      threadRootEventId: runtime.record.threadRootEventId,
      cwd: runtime.record.cwd,
    }
    const materialized = await this.artifacts.materialize(
      artifactContext,
      command.payload.referenceId,
      command.payload.expectedStatRevision,
      this.client,
    )
    runtime.port.observeMessageVersion(
      materialized.messageId,
      materialized.messageVersion,
    )
    const event = this.eventFor(
      project,
      runtime.record,
      command,
      materialized.status === 'changed' ? 'artifact-stat-changed' : 'artifact-materialized',
      {
        type: 'assistant.message',
        messageId: materialized.messageId,
        messageVersion: materialized.messageVersion,
        body: materialized.body,
        format: materialized.format,
        final: materialized.final,
        ...(materialized.partIndex === undefined ? {} : { partIndex: materialized.partIndex }),
        ...(materialized.partCount === undefined ? {} : { partCount: materialized.partCount }),
        projection: projection(runtime.record, runtime.activity.phase, this.extensions),
        ui: {
          kind: 'artifact_materialization',
          version: 1,
          referenceId: materialized.referenceId,
          status: materialized.status,
        },
        ...(materialized.attachments.length > 0
          ? { attachments: materialized.attachments }
          : {}),
        artifactReferences: materialized.references,
      },
    )
    await this.settleAndDeliver(project, command, event, 'succeeded', {
      status: materialized.status,
      referenceId: materialized.referenceId,
    })
  }

  private async updateSession(
    project: V3ProjectRuntime,
    command: Mlp3CommandOf<'session.update'>,
  ): Promise<void> {
    let runtime = this.requireActiveSession(project, command.sessionId)
    const patch = command.payload.patch
    const provider = runtime.record.provider
    const catalog = getProvider(provider)
    if (!catalog) throw new Error(`Provider ${provider} is not configured`)
    const availableModels = catalog.getAvailableModels()
    const requestedModel = patch.model === undefined ? runtime.record.model : patch.model
    const selectedModel = requestedModel
      ? availableModels.find(item => item.id === requestedModel || item.name === requestedModel)
      : undefined
    if (requestedModel && availableModels.length > 0 && !selectedModel) {
      throw new Error(`Model ${requestedModel} is not available for provider ${provider}`)
    }
    const model = selectedModel?.id ?? requestedModel ?? null
    const modelChanged = model !== runtime.record.model
    const reasoningEffort = patch.reasoningEffort === undefined
      ? modelChanged
        ? selectedModel?.defaultReasoningLevel ?? null
        : runtime.record.reasoningEffort
      : patch.reasoningEffort
    if (availableModels.length > 0) validateReasoningEffort(selectedModel, reasoningEffort)
    const permissionMode = patch.permissionMode ?? runtime.record.permissionMode
    if (!isAgentPermissionMode(permissionMode)) {
      throw new Error(`Permission mode ${permissionMode} is not currently available`)
    }
    if (patch.model !== undefined || modelChanged) {
      await dispatchRuntimeCommand(runtime.session, command, 'model', model ?? '')
    }
    if (patch.reasoningEffort !== undefined || modelChanged) {
      await dispatchRuntimeCommand(
        runtime.session,
        command,
        'reasoningEffort',
        reasoningEffort ?? '',
      )
    }
    if (patch.permissionMode !== undefined) {
      await dispatchRuntimeCommand(runtime.session, command, 'permissionMode', permissionMode)
    }
    runtime.record.title = patch.title ?? runtime.record.title
    runtime.record.model = model
    runtime.record.reasoningEffort = reasoningEffort
    runtime.record.permissionMode = permissionMode
    runtime.record.providerSessionId = runtime.session.sessionRecord.conversationId
    if (patch.extensions !== undefined) {
      const bindings = this.extensions.normalizeBindings(patch.extensions)
      await this.destroySessionRuntime(runtime, 'replace')
      runtime.record.extensions = bindings
      runtime.record.extensionRevision += 1
      runtime.record.inheritedFromProjectExtensionRevision = null
      runtime = this.createSessionRuntime(project, runtime.record)
      project.sessions.set(runtime.record.id, runtime)
    }
    runtime.record.updatedAt = this.now()
    runtime.record.stateVersion += 1
    await this.persist(project)
    const updated = this.eventFor(project, runtime.record, command, 'session-updated', {
      type: 'session.updated',
      projection: terminalProjection(runtime.record, runtime.activity.phase, this.extensions),
      patch: patch.extensions === undefined
        ? patch
        : { ...patch, extensions: runtime.record.extensions },
    })
    await this.settleAndDeliver(project, command, updated, 'succeeded')
  }

  private async setSessionLifecycle(
    project: V3ProjectRuntime,
    command: Mlp3CommandOf<'session.set_lifecycle'>,
  ): Promise<void> {
    const sessionId = command.sessionId
    if (!sessionId) throw new Error('Lifecycle command is missing its session ID')
    const record = project.project.sessions.find(candidate => candidate.id === sessionId)
    if (!record) throw new Error(`Unknown Malink session ${sessionId}`)
    if (command.payload.state === 'active' && record.lifecycle !== 'active') {
      throw new Error('Archived sessions cannot be restored; continue them from Provider History')
    }
    // Legacy delete commands are compatibility aliases for Malink archive.
    // Provider-owned history is never deleted here.
    const target = command.payload.state === 'active' ? 'active' : 'archived'
    const alreadyApplied = record.lifecycle === target
    if (!alreadyApplied) {
      if (target === 'active') {
        record.lifecycle = 'active'
        const runtime = this.createSessionRuntime(project, record)
        project.sessions.set(record.id, runtime)
      } else {
        await this.assertMaintenanceSessionCanBeArchived(record.id)
        const active = project.sessions.get(record.id)
        if (active) {
          await this.destroySessionRuntime(active, 'archive')
          project.sessions.delete(record.id)
        }
        record.lifecycle = target
      }
      record.updatedAt = this.now()
      record.stateVersion += 1
      await this.persist(project)
    }
    const lifecycle = this.eventFor(project, record, command, 'session-lifecycle', {
      type: 'session.lifecycle',
      projection: terminalProjection(record, 'idle', this.extensions),
      state: target,
      ...(alreadyApplied ? { alreadyApplied: true } : {}),
    })
    await this.settleAndDeliver(project, command, lifecycle, 'succeeded')
  }

  private async assertMaintenanceSessionCanBeArchived(sessionId: string): Promise<void> {
    if (!sessionId.startsWith('gateway-update-')) return
    const supervisor = this.dependencies.gatewayUpdateSupervisor
    if (!supervisor) return
    const status = await supervisor.status()
    const ownsSession = status.maintenanceSessionId === sessionId
      || (
        status.releaseId !== undefined
        && this.maintenanceAgentSessionId(status.releaseId) === sessionId
      )
    const failedWithoutUsefulRetry = status.phase === 'failed'
      && !/(?:\bHTTP (?:408|425|429|5\d\d)\b|fetch failed|network(?:error| request)?|timed out|timeout|socket hang up|connection (?:reset|refused)|temporar(?:y|ily)|rate.?limit|too many requests|service unavailable)/iu
        .test(status.detail ?? '')
    if (
      !ownsSession
      || ['idle', 'committed', 'rolled_back'].includes(status.phase)
      || failedWithoutUsefulRetry
    ) return
    throw new Error(
      `Gateway update session ${sessionId} cannot be archived while the update supervisor `
      + `reports ${status.phase}. Wait for it to finish before archiving the session.`,
    )
  }

  private async createInvitation(
    project: V3ProjectRuntime,
    command: Mlp3CommandOf<'device.invitation.create'>,
  ): Promise<void> {
    if (!this.dependencies.createDeviceInvitation) {
      throw new Error('This Gateway host does not support device invitations')
    }
    const trustedDevices = await this.dependencies.listTrustedDevices?.()
    const requestingDevice = trustedDevices?.find(device => device.deviceId === command.deviceId)
    if (trustedDevices && !requestingDevice) {
      throw new Error(`Device ${command.deviceId} is no longer authorized`)
    }
    const invitation = await this.dependencies.createDeviceInvitation({
      requestedByDeviceId: command.deviceId,
      commandId: command.commandId,
      ...(command.payload.lifetimeMs === undefined
        ? {}
        : { lifetimeMs: command.payload.lifetimeMs }),
      ...(requestingDevice?.allowedOperations === undefined
        ? {}
        : { allowedOperations: requestingDevice.allowedOperations }),
    })
    const event = this.eventFor(project, undefined, command, 'invitation-created', {
      type: 'device.invitation.created',
      pairingLink: invitation.pairingLink,
      expiresAt: invitation.expiresAt,
    })
    await this.settleAndDeliver(project, command, event, 'succeeded', {
      pairingLink: invitation.pairingLink,
      expiresAt: invitation.expiresAt,
    })
  }

  private async createGatewayEnrollmentInvitation(
    project: V3ProjectRuntime,
    command: Mlp3CommandOf<'gateway.enrollment.invitation.create'>,
  ): Promise<void> {
    if (!this.dependencies.createGatewayEnrollmentInvitation) {
      throw new Error('This Gateway host does not support Gateway enrollment')
    }
    const invitation = await this.dependencies.createGatewayEnrollmentInvitation({
      requestedByDeviceId: command.deviceId,
      commandId: command.commandId,
      ...(command.payload.lifetimeMs === undefined
        ? {}
        : { lifetimeMs: command.payload.lifetimeMs }),
    })
    const event = this.eventFor(project, undefined, command, 'gateway-enrollment-invitation', {
      type: 'gateway.enrollment.invitation.created',
      enrollmentLink: invitation.enrollmentLink,
      expiresAt: invitation.expiresAt,
    })
    await this.settleAndDeliver(project, command, event, 'succeeded', invitation)
  }

  private async approveGatewayEnrollment(
    project: V3ProjectRuntime,
    command: Mlp3CommandOf<'gateway.enrollment.approve'>,
  ): Promise<void> {
    if (!this.dependencies.approveGatewayEnrollment) {
      throw new Error('This Gateway host does not support Gateway enrollment approval')
    }
    const approved = await this.dependencies.approveGatewayEnrollment({
      requestedByDeviceId: command.deviceId,
      commandId: command.commandId,
      enrollmentId: command.payload.enrollmentId,
    })
    const event = this.eventFor(project, undefined, command, 'gateway-enrollment-approved', {
      type: 'gateway.enrollment.approved',
      enrollmentId: command.payload.enrollmentId,
      gatewayNodeId: approved.gatewayNodeId,
      gatewayName: approved.gatewayName,
    })
    await this.settleAndDeliver(project, command, event, 'succeeded', approved)
    await this.syncState()
  }

  private async updateGatewayProfile(
    project: V3ProjectRuntime,
    command: Mlp3CommandOf<'gateway.profile.update'>,
  ): Promise<void> {
    if (!this.dependencies.updateGatewayProfile) {
      throw new Error('This Gateway host does not support profile updates')
    }
    const updated = await this.dependencies.updateGatewayProfile({
      requestedByDeviceId: command.deviceId,
      commandId: command.commandId,
      gatewayNodeId: command.payload.gatewayNodeId,
      gatewayName: command.payload.gatewayName,
    })
    await this.settleAndDeliver(
      project,
      command,
      this.eventFor(project, undefined, command, 'gateway-profile-updated', {
        type: 'gateway.profile.updated',
        ...updated,
      }),
      'succeeded',
      updated,
    )
  }

  private async updateProject(
    project: V3ProjectRuntime,
    command: Mlp3CommandOf<'project.update'>,
  ): Promise<void> {
    const patch = command.payload.patch
    const catalog = getProvider(project.project.provider)
    const availableModels = catalog?.getAvailableModels() ?? []
    const name = patch.name?.trim() ?? project.project.name
    let model = project.project.model
    let reasoningEffort = project.project.reasoningEffort
    let selectedModel = model
      ? availableModels.find(model =>
        model.id === project.project.model || model.name === project.project.model
      )
      : undefined
    if (patch.model !== undefined) {
      selectedModel = patch.model
        ? availableModels.find(model => model.id === patch.model || model.name === patch.model)
        : undefined
      if (patch.model && availableModels.length > 0 && !selectedModel) {
        throw new Error(
          `Model ${patch.model} is not available for provider ${project.project.provider}`,
        )
      }
      model = selectedModel?.id ?? patch.model
      if (patch.reasoningEffort === undefined) {
        reasoningEffort = selectedModel?.defaultReasoningLevel ?? null
      }
    }
    if (patch.reasoningEffort !== undefined) {
      if (availableModels.length > 0) {
        validateReasoningEffort(selectedModel, patch.reasoningEffort)
      }
      reasoningEffort = patch.reasoningEffort
    }
    const defaultExtensions = patch.defaultExtensions === undefined
      ? project.project.defaultExtensions
      : this.extensions.normalizeBindings(patch.defaultExtensions)
    if (patch.name !== undefined) {
      if (!this.dependencies.updateProjectMetadata) {
        throw new Error('This Gateway host does not support project name updates')
      }
      project.config = await this.dependencies.updateProjectMetadata({
        sourceRoom: project.config,
        requestedByDeviceId: command.deviceId,
        commandId: command.commandId,
        name,
      })
    }
    project.project.name = name
    project.project.model = model
    project.project.reasoningEffort = reasoningEffort
    project.project.defaultExtensions = defaultExtensions
    if (patch.defaultExtensions !== undefined) project.project.extensionDefaultsRevision += 1
    project.project.snapshotVersion += 1
    await this.persist(project)
    const event = this.eventFor(project, undefined, command, 'project-updated', {
      type: 'project.snapshot',
      ...this.projectSnapshot(project),
    })
    event.eventId = logicalSnapshotEventId(project.project)
    // The causal terminal is also the new current snapshot. Reusing it avoids
    // a second timeline event for every settings save.
    await this.settleAndDeliver(project, command, event, 'succeeded', undefined, {
      publishProjectPointer: true,
    })
  }

  private async deleteProject(
    project: V3ProjectRuntime,
    command: Mlp3CommandOf<'project.delete'>,
  ): Promise<void> {
    if (!this.dependencies.validateProjectDeletion || !this.dependencies.deleteProject) {
      throw new Error('This Gateway host does not support project deletion')
    }
    if ([...project.sessions.values()].some(runtime => runtime.activeTurnId !== null)) {
      throw new Error('Wait for active project turns to finish before deleting this project')
    }
    await this.dependencies.validateProjectDeletion({
      sourceRoom: project.config,
      requestedByDeviceId: command.deviceId,
      commandId: command.commandId,
      projectId: project.project.projectId,
    })
    const event = this.eventFor(project, undefined, command, 'project-deleted', {
      type: 'project.deleted',
      projectId: project.project.projectId,
      name: project.project.name,
    })
    // Hold the Gateway-wide deletion lane until the durable outbox confirms
    // the terminal and the catalog mutation completes. This makes the
    // "retain one control route" check atomic across different project rooms.
    await this.settleAndDeliver(project, command, event, 'succeeded', undefined, {
      waitForConfirmation: true,
    })
  }

  private async createProject(
    sourceProject: V3ProjectRuntime,
    command: Mlp3CommandOf<'project.create'>,
  ): Promise<void> {
    if (!this.dependencies.createProject) {
      throw new Error('This Gateway host does not support project creation')
    }
    const created = await this.dependencies.createProject({
      sourceRoom: sourceProject.config,
      requestedByDeviceId: command.deviceId,
      commandId: command.commandId,
      name: command.payload.name,
      cwd: command.payload.cwd,
      ...(command.payload.provider ? { provider: command.payload.provider } : {}),
      ...(command.payload.createDirectory === undefined
        ? {}
        : { createDirectory: command.payload.createDirectory }),
    })
    const project = await this.registerProject(created.room)
    await this.dependencies.onProjectCreated?.(created.room)
    const result = {
      gatewayNodeId: created.gatewayNodeId,
      projectId: project.project.projectId,
      roomId: project.config.roomId,
      conversationId: project.config.conversationId,
      name: project.project.name,
      cwd: project.project.cwd,
      ...(created.alreadyExisted ? { alreadyExisted: true } : {}),
    }
    await this.settleAndDeliver(
      sourceProject,
      command,
      this.eventFor(sourceProject, undefined, command, 'project-created', {
        type: 'project.created',
        ...result,
      }),
      'succeeded',
      result,
    )
  }

  private async listProviderSessions(
    project: V3ProjectRuntime,
    command: Mlp3CommandOf<'provider.sessions.list'>,
  ): Promise<void> {
    await this.dependencies.assertDirectoryAccess?.({
      cwd: project.project.cwd,
      operation: 'provider.history',
    })
    const provider = createProviderInstance(command.payload.provider)
    if (!provider) throw new Error(`Provider ${command.payload.provider} is not configured`)
    try {
      if (!provider.listSessions) {
        throw new Error(`Provider ${command.payload.provider} does not support session history`)
      }
      const listed = (await provider.listSessions(project.project.cwd)).slice(0, 256)
      const sessions = listed.map(entry => {
        const relation = providerSessionMalinkRelation(
          project.project.sessions,
          command.payload.provider,
          entry.sessionId,
        )
        return {
          sessionId: entry.sessionId,
          title: (entry.title.trim() || 'Untitled provider session').slice(0, 512),
          updatedAt: Math.max(0, Math.trunc(entry.updated)),
          ...(entry.cwd ? { cwd: entry.cwd.slice(0, 8_192) } : {}),
          ...relation,
        }
      })
      const payload = providerSessionsPage(
        command.payload.provider,
        sessions,
        command.payload.cursor,
      )
      await this.settleAndDeliver(
        project,
        command,
        this.eventFor(project, undefined, command, 'provider-sessions-listed', payload),
        'succeeded',
        payload,
      )
    } finally {
      await provider.destroy?.().catch(error => {
        this.log(`[mlp3/matrix] provider session-list cleanup failed: ${formatError(error)}`)
      })
    }
  }

  private async inspectProviderSession(
    project: V3ProjectRuntime,
    command: Mlp3CommandOf<'provider.session.inspect'>,
  ): Promise<void> {
    await this.dependencies.assertDirectoryAccess?.({
      cwd: project.project.cwd,
      operation: 'provider.history',
    })
    const provider = createProviderInstance(command.payload.provider)
    if (!provider) throw new Error(`Provider ${command.payload.provider} is not configured`)
    try {
      if (!provider.getSessionHistory) {
        throw new Error(`Provider ${command.payload.provider} cannot inspect session history`)
      }
      const history = await provider.getSessionHistory(
        command.payload.providerSessionId,
        project.project.cwd,
      )
      const relation = providerSessionMalinkRelation(
        project.project.sessions,
        command.payload.provider,
        command.payload.providerSessionId,
      )
      const payload = boundedProviderSessionInspection({
        type: 'provider.session.inspected' as const,
        provider: command.payload.provider,
        providerSessionId: command.payload.providerSessionId,
        title: (history.title.trim() || 'Provider session').slice(0, 512),
        ...relation,
        messages: history.messages.map((message, index) => ({
          id: message.id.slice(0, 256) || `message-${index + 1}`,
          role: message.role,
          text: message.text,
        })),
      })
      await this.settleAndDeliver(
        project,
        command,
        this.eventFor(project, undefined, command, 'provider-session-inspected', payload),
        'succeeded',
        payload,
      )
    } finally {
      await provider.destroy?.().catch(error => {
        this.log(`[mlp3/matrix] provider history cleanup failed: ${formatError(error)}`)
      })
    }
  }

  private async failCommand(
    project: V3ProjectRuntime,
    command: Mlp3Command,
    error: unknown,
  ): Promise<void> {
    const runtime = command.sessionId ? project.sessions.get(command.sessionId) : undefined
    const failure = commandFailure(error)
    let payload: Mlp3EventPayload
    if (command.operation === 'prompt.submit' && runtime) {
      this.transition(runtime, 'failed')
      await this.persist(project).catch(persistError => {
        this.log(`[mlp3/matrix] failed projection persistence failed: ${formatError(persistError)}`)
      })
      payload = {
        type: 'turn.failed',
        turnId: command.commandId,
        code: failure.code,
        message: formatError(error),
        projection: terminalProjection(runtime.record, runtime.activity.phase, this.extensions),
      }
    } else {
      payload = {
        type: 'command.rejected',
        commandId: command.commandId,
        code: failure.code,
        message: formatError(error),
        retryable: failure.retryable,
      }
    }
    const event = this.eventFor(project, runtime?.record, command, 'command-failed', payload)
    await this.settleAndDeliver(project, command, event, 'failed').catch(deliveryError => {
      this.log(`[mlp3/matrix] failed command result delivery failed: ${formatError(deliveryError)}`)
    })
  }

  private async rejectCommandAuthorization(
    project: V3ProjectRuntime,
    command: Mlp3Command,
    rejection: Mlp3CommandAuthorizationRejection,
  ): Promise<void> {
    const runtime = command.sessionId ? project.sessions.get(command.sessionId) : undefined
    const event = this.eventFor(project, runtime?.record, command, 'authorization-rejected', {
      type: 'command.rejected',
      commandId: command.commandId,
      code: rejection.code,
      message: rejection.message,
      retryable: rejection.retryable,
    })
    await this.settleAndDeliver(project, command, event, 'rejected').catch(deliveryError => {
      this.log(
        `[mlp3/matrix] authorization rejection delivery failed: ${formatError(deliveryError)}`,
      )
    })
  }

  private async settleAndDeliver(
    project: V3ProjectRuntime,
    command: Mlp3Command,
    event: Mlp3Event,
    outcome: Mlp3CommandTerminal['outcome'],
    result?: JsonValue,
    options: { publishProjectPointer?: boolean; waitForConfirmation?: boolean } = {},
  ): Promise<void> {
    const terminalKey = commandKey(command)
    await this.journal.settle(command, {
      outcome,
      eventId: event.eventId,
      event,
      ...(command.sessionId ? { sessionId: command.sessionId } : {}),
      ...(result === undefined ? {} : { result }),
    }, this.now())
    this.terminalDeliveriesInFlight.add(terminalKey)
    try {
      await this.enqueueTerminalNotification(project, event)
      const queued = await this.enqueueEventDelivery(
        project,
        command.sessionId
          ? project.project.sessions.find(session => session.id === command.sessionId)
          : undefined,
        event,
      )
      const completion = queued.confirmation.then(sent => this.completeTerminalDelivery(
        project,
        command,
        event,
        sent.eventId,
        options,
      )).catch(error => {
        this.log(`[mlp3/matrix] terminal delivery queued: ${formatError(error)}`)
      }).finally(() => {
        this.terminalDeliveriesInFlight.delete(terminalKey)
      })
      if (options.waitForConfirmation) await completion
      else void completion
    } catch (error) {
      this.terminalDeliveriesInFlight.delete(terminalKey)
      // The semantic terminal is already fsynced in the command journal and
      // the content layer stages before attempting Matrix delivery. Never
      // reinterpret a transport failure as an execution failure.
      this.log(`[mlp3/matrix] terminal delivery queued: ${formatError(error)}`)
    }
  }

  private async completeTerminalDelivery(
    project: V3ProjectRuntime,
    command: Mlp3Command,
    event: Mlp3Event,
    matrixEventId: string,
    options: { publishProjectPointer?: boolean; waitForConfirmation?: boolean } = {},
  ): Promise<void> {
    if (options.publishProjectPointer) {
      await this.content.publishProjectPointer(
        project.config,
        event,
        matrixEventId,
        this.client,
      )
    }
    await this.journal.markTerminalDelivered(command, matrixEventId, this.now())
    if (command.operation === 'project.delete') {
      await this.finalizeProjectDeletion(project, command)
    }
  }

  private emit(
    project: V3ProjectRuntime,
    record: PersistedMlp3Session | undefined,
    event: Mlp3Event,
  ) {
    return this.content.sendEvent(project.config, event, this.client, {
      relation: record ? threadRelation(record.threadRootEventId) : undefined,
    })
  }

  private enqueueEventDelivery(
    project: V3ProjectRuntime,
    record: PersistedMlp3Session | undefined,
    event: Mlp3Event,
  ) {
    return this.content.enqueueEvent(project.config, event, this.client, {
      relation: record ? threadRelation(record.threadRootEventId) : undefined,
    })
  }

  private async emitBestEffort(
    project: V3ProjectRuntime,
    record: PersistedMlp3Session | undefined,
    event: Mlp3Event,
  ): Promise<void> {
    try {
      await this.content.queueEvent(project.config, event, this.client, {
        relation: record ? threadRelation(record.threadRootEventId) : undefined,
      })
    } catch (error) {
      this.log(`[mlp3/matrix] causal event delivery queued: ${formatError(error)}`)
    }
  }

  private eventFor(
    project: V3ProjectRuntime,
    record: PersistedMlp3Session | undefined,
    command: Mlp3Command,
    stage: string,
    payload: Mlp3EventPayload,
  ): Mlp3Event {
    return {
      kind: 'malink.event',
      version: 3,
      eventId: logicalEventId(command, stage),
      workspaceId: this.config.gatewayId,
      projectId: project.project.projectId,
      ...(record ? { sessionId: record.id } : {}),
      occurredAt: this.now(),
      causationCommandId: command.commandId,
      payload,
    }
  }

  private async recoverJournal(): Promise<void> {
    for (const record of await this.journal.pendingTerminalDeliveries()) {
      const project = this.projectForRecord(record)
      if (project) this.scheduleTerminalRedelivery(project, record)
    }
    for (const record of await this.journal.unfinished()) {
      const project = this.projectForRecord(record)
      if (!project) {
        this.log(`[mlp3/matrix] cannot recover command ${record.command.commandId}: project unavailable`)
        continue
      }
      if (record.status === 'accepted') {
        this.scheduleExecution(project, record)
      } else {
        const interrupted = this.eventFor(
          project,
          record.command.sessionId
            ? project.project.sessions.find(session => session.id === record.command.sessionId)
            : undefined,
          record.command,
          'interrupted',
          {
            type: 'command.rejected',
            commandId: record.command.commandId,
            code: 'execution_interrupted',
            message: 'The Gateway restarted after dispatch. The command was not executed again.',
            retryable: true,
          },
        )
        await this.settleAndDeliver(
          project,
          record.command,
          interrupted,
          'interrupted',
        ).catch(error => {
          this.log(`[mlp3/matrix] interrupted command recovery failed: ${formatError(error)}`)
        })
      }
    }
    for (const record of await this.journal.terminalByOperation('project.delete')) {
      if (
        record.terminal?.outcome !== 'succeeded'
        || record.terminalDeliveryEventId === undefined
      ) continue
      const project = this.projectForRecord(record)
      if (project) await this.finalizeProjectDeletion(project, record.command)
    }
  }

  private scheduleTerminalRedelivery(
    project: V3ProjectRuntime,
    record: Mlp3CommandJournalRecord,
  ): void {
    const originalEvent = record.terminal?.event
    if (!originalEvent) return
    const terminalKey = commandKey(record.command)
    if (this.terminalDeliveriesInFlight.has(terminalKey)) return
    this.terminalDeliveriesInFlight.add(terminalKey)
    const boundedPayload = boundedProviderHistoryEventPayload(record.command, originalEvent.payload)
    const terminalEvent: Mlp3Event = canonicalJson(boundedPayload) === canonicalJson(
      originalEvent.payload,
    )
      ? originalEvent
      : {
          ...originalEvent,
          eventId: providerHistoryRecoveryEventId(record.command),
          occurredAt: this.now(),
          payload: boundedPayload,
        }
    const task = this.enqueueTerminalNotification(project, terminalEvent).then(() => this.emit(
      project,
      record.command.sessionId
        ? project.project.sessions.find(session => session.id === record.command.sessionId)
        : undefined,
      terminalEvent,
    )).then(result => this.completeTerminalDelivery(
      project,
      record.command,
      terminalEvent,
      result.eventId,
      { publishProjectPointer: terminalEvent.payload.type === 'project.snapshot' },
    )).catch(error => {
      this.log(`[mlp3/matrix] terminal redelivery failed: ${formatError(error)}`)
    }).finally(() => {
      this.executionTasks.delete(task)
      this.terminalDeliveriesInFlight.delete(terminalKey)
    })
    this.executionTasks.add(task)
  }

  /**
   * A client whose Matrix transaction was accepted may still miss the signed
   * terminal event before its local cursor advances. It reconciles by sending
   * the exact original signed command under a fresh Matrix transaction. The
   * execution journal has already claimed that immutable command identity, so
   * this path can report durable state without running the operation twice.
   */
  private async publishCommandReconciliation(
    project: V3ProjectRuntime,
    record: Mlp3CommandJournalRecord,
  ): Promise<void> {
    const terminal = record.terminal
    const sessionId = terminal?.sessionId ?? record.command.sessionId
    const payload = commandReconciliationPayload(record)
    const event: Mlp3Event = {
      kind: 'malink.event',
      version: 3,
      eventId: logicalCommandReconciliationEventId(record.command, payload),
      workspaceId: this.config.gatewayId,
      projectId: project.project.projectId,
      ...(sessionId ? { sessionId } : {}),
      occurredAt: this.now(),
      causationCommandId: record.command.commandId,
      payload,
    }
    const session = event.sessionId
      ? project.project.sessions.find(candidate => candidate.id === event.sessionId)
      : undefined
    await this.content.queueEvent(project.config, event, this.client, {
      ...(session ? { relation: threadRelation(session.threadRootEventId) } : {}),
      priority: 'urgent',
    })
    this.log(
      `[mlp3/matrix] reconciled command ${record.command.commandId} as ${record.status}`,
    )
  }

  private async enqueueTerminalNotification(
    project: V3ProjectRuntime,
    event: Mlp3Event,
  ): Promise<void> {
    try {
      let eligibleDeviceIds: string[] | undefined
      try {
        eligibleDeviceIds = await this.webPushDeviceIds(project)
      } catch (error) {
        // Persist the notification against current subscriptions and let the
        // send-time authorization check retry. A temporary registry read must
        // not lose the only durable notification enqueue opportunity.
        this.log(`[mlp3/web-push] target discovery deferred: ${formatError(error)}`)
      }
      await this.webPush.notifyTerminal(event, eligibleDeviceIds)
    } catch (error) {
      // Matrix/MLP terminal durability is authoritative. A notification is an
      // auxiliary delivery and must never reinterpret the command outcome.
      this.log(`[mlp3/web-push] notification enqueue failed: ${formatError(error)}`)
    }
  }

  private async webPushDeviceIds(project: V3ProjectRuntime): Promise<string[]> {
    const devices = this.dependencies.listTrustedDevices
      ? await this.dependencies.listTrustedDevices()
      : this.config.trustedDevices
    const now = this.now()
    return devices
      .filter(device =>
        device.allowedRoomIds.includes(project.config.roomId)
        && device.certificateExpiresAt > now
      )
      .map(device => device.deviceId)
  }

  private async canDeliverWebPush(deviceId: string, projectId: string): Promise<boolean> {
    const project = [...this.projects.values()].find(candidate =>
      candidate.project.projectId === projectId
    )
    if (!project) return false
    return (await this.webPushDeviceIds(project)).includes(deviceId)
  }

  private projectForRecord(record: Mlp3CommandJournalRecord): V3ProjectRuntime | undefined {
    if (record.roomId) return this.projects.get(record.roomId)
    return [...this.projects.values()].find(project =>
      record.command.projectId === undefined
      || project.project.projectId === record.command.projectId,
    )
  }

  private async createProjectRuntimes(): Promise<void> {
    for (const room of this.config.rooms) {
      const project = await this.createProjectRuntime(room)
      this.projects.set(room.roomId, project)
    }
  }

  private async registerProject(room: MatrixGatewayRoomConfig): Promise<V3ProjectRuntime> {
    const requestedProjectId = room.projectId ?? gatewayProjectIdentity(
      room.cwd,
      room.projectName,
    ).id
    const existing = [...this.projects.values()].find(project =>
      project.config.roomId === room.roomId || project.project.projectId === requestedProjectId)
    if (existing) {
      if (
        existing.config.roomId !== room.roomId
        || existing.project.projectId !== requestedProjectId
      ) throw new Error(`Project ${requestedProjectId} conflicts with an active Matrix room`)
      await this.activateProject(existing)
      return existing
    }
    await this.runtimeState.initialize([room])
    const project = await this.createProjectRuntime(room)
    this.projects.set(room.roomId, project)
    if (!this.config.rooms.some(candidate => candidate.roomId === room.roomId)) {
      this.config.rooms.push(room)
    }
    await this.activateProject(project)
    return project
  }

  private async createProjectRuntime(room: MatrixGatewayRoomConfig): Promise<V3ProjectRuntime> {
    const projectState = await this.runtimeState.project(room.roomId)
    const project: V3ProjectRuntime = {
      config: room,
      project: projectState,
      sessions: new Map(),
      deletingCommandId: null,
    }
    for (const record of projectState.sessions) {
      if (record.lifecycle !== 'active') continue
      if (record.scope === 'scratch') {
        const expected = this.scratchSessionDirectory(record.id)
        if (resolve(record.cwd) !== expected) {
          throw new Error(`MLP/3 scratch session ${record.id} has an invalid working directory`)
        }
        await mkdir(expected, { recursive: true, mode: 0o700 })
      }
      project.sessions.set(record.id, this.createSessionRuntime(project, record))
    }
    return project
  }

  private async activateProject(project: V3ProjectRuntime): Promise<void> {
    await this.client.assertRoomEncrypted(project.config.roomId)
    await this.content.provisionProject(project.config, this.client)
    await this.prepareSessionThreads(project)
    await this.publishSessionRecovery(project)
    await this.publishWorkspaceSnapshot(project)
    await this.publishProjectSnapshot(project)
  }

  private createSessionRuntime(
    project: V3ProjectRuntime,
    record: PersistedMlp3Session,
  ): Mlp3SessionRuntime {
    const activity = { phase: 'idle' as Mlp3SessionProjection['activity'] }
    let runtime: Mlp3SessionRuntime | undefined
    const artifactContext: ArtifactMessageContext = {
      roomId: project.config.roomId,
      projectId: project.project.projectId,
      sessionId: record.id,
      threadRootEventId: record.threadRootEventId,
      cwd: record.cwd,
    }
    const port = new MatrixMlp3Port({
      contentLayer: this.content,
      transport: this.client,
      room: project.config,
      workspaceId: this.config.gatewayId,
      projectId: project.project.projectId,
      sessionId: record.id,
      threadRootEventId: record.threadRootEventId,
      projection: () => projection(record, activity.phase, this.extensions),
      now: () => this.now(),
      onLog: this.dependencies.onLog,
      artifactReferences: {
        prepare: (messageId, message) =>
          this.artifacts.prepare(artifactContext, messageId, message),
        published: input => this.artifacts.published(artifactContext, input),
        upload: attachment => this.artifacts.uploadEagerAttachment(this.client, attachment),
      },
      onStatusChange: status => {
        activity.phase = activityFromStatus(status.activity, status.state)
        if (runtime) runtime.activity.phase = activity.phase
      },
    })
    const effectiveRoom: MatrixGatewayRoomConfig = {
      ...project.config,
      cwd: record.cwd,
      providerName: record.provider,
      ...(record.model ? { model: record.model } : { model: undefined }),
      providerSettings: {
        ...(project.config.providerSettings ?? {}),
        ...(record.reasoningEffort ? { reasoningEffort: record.reasoningEffort } : {}),
        permissionMode: record.permissionMode,
      },
    }
    let session: TopicSession
    let capabilityProvider: AgentProvider | null
    if (this.dependencies.sessionFactory) {
      session = this.dependencies.sessionFactory(effectiveRoom, port, record)
      session.sessionRecord.setConversationId(record.providerSessionId)
      capabilityProvider = getProvider(record.provider) ?? null
    } else {
      const provider = this.dependencies.providerFactory?.(effectiveRoom, record)
        ?? createProviderInstance(record.provider)
      if (!provider) {
        port.close()
        throw new Error(`MLP/3 session ${record.id} provider ${record.provider} is unavailable`)
      }
      capabilityProvider = provider
      const sessionRecord = createTopicSessionRecord({
        id: record.id,
        cwd: record.cwd,
        providerName: record.provider,
        groupChatId: numericCompatibilityId(`${project.config.roomId}\0${record.id}`),
        model: record.model ?? undefined,
        verboseLevel: project.config.verboseLevel,
        timeoutSeconds: project.config.timeoutSeconds,
        providerSettings: effectiveRoom.providerSettings,
        conversationId: record.providerSessionId,
      })
      const extensionInstances = this.extensions.createInstances(record.extensions, {
        sessionId: record.id,
        cwd: record.cwd,
        providerName: record.provider,
        onLog: message => this.log(`[mlp3/extension] ${message}`),
      })
      session = createTopicSession({
        sessionRecord,
        provider,
        channelPort: port,
        extensions: extensionInstances,
        privilegeExecutor: this.dependencies.privilegeExecutor,
        onAvailableCommands: commands => {
          record.availableCommands = commands
        },
      })
    }
    runtime = {
      record,
      port,
      session,
      capabilityProvider,
      activity,
      activeTurnId: null,
    }
    return runtime
  }

  private resolveCreateSettings(
    project: V3ProjectRuntime,
    command: Mlp3CommandOf<'session.create'>,
  ): {
    provider: string
    model: string | null
    reasoningEffort: string | null
    permissionMode: string
  } {
    const provider = command.payload.provider ?? project.project.provider
    const catalog = getProvider(provider)
    if (
      !catalog
      && !this.dependencies.providerFactory
      && !this.dependencies.sessionFactory
    ) {
      throw new Error(`Provider ${provider} is not configured`)
    }
    const providerChanged = provider !== project.project.provider
    const requestedModel = command.payload.model !== undefined
      ? command.payload.model
      : providerChanged
        ? null
        : project.project.model
    const availableModels = catalog?.getAvailableModels() ?? []
    const selectedModel = requestedModel
      ? availableModels.find(item =>
        item.id === requestedModel || item.name === requestedModel
      )
      : undefined
    if (requestedModel && availableModels.length > 0 && !selectedModel) {
      throw new Error(`Model ${requestedModel} is not available for provider ${provider}`)
    }
    const model = selectedModel?.id ?? requestedModel
    const usesProjectModel = !providerChanged
      && command.payload.model === undefined
      && model === project.project.model
    const reasoningEffort = command.payload.reasoningEffort !== undefined
      ? command.payload.reasoningEffort
      : usesProjectModel
        ? project.project.reasoningEffort
        : selectedModel?.defaultReasoningLevel ?? null
    if (availableModels.length > 0) validateReasoningEffort(selectedModel, reasoningEffort)
    const permissionMode = command.payload.permissionMode ?? project.project.permissionMode
    if (!isAgentPermissionMode(permissionMode)) {
      throw new Error(`Permission mode ${permissionMode} is not currently available`)
    }
    return {
      provider,
      model,
      reasoningEffort,
      permissionMode,
    }
  }

  private requireActiveSession(
    project: V3ProjectRuntime,
    sessionId: string | undefined,
  ): Mlp3SessionRuntime {
    if (!sessionId) throw new Error('Command is missing its session ID')
    const runtime = project.sessions.get(sessionId)
    if (!runtime) throw new Error(`Malink session ${sessionId} is not active`)
    return runtime
  }

  private transition(
    runtime: Mlp3SessionRuntime,
    activity: Mlp3SessionProjection['activity'],
  ): void {
    runtime.activity.phase = activity
    runtime.record.updatedAt = this.now()
    runtime.record.stateVersion += 1
  }

  private persist(project: V3ProjectRuntime): Promise<void> {
    return this.runtimeState.saveProject(project.project)
  }

  private scratchRoot(): string {
    return resolve(dirname(this.config.replayLedgerPath), 'scratch-sessions')
  }

  private scratchSessionDirectory(sessionId: string): string {
    const component = createHash('sha256')
      .update(`malink-scratch-session\0${sessionId}`)
      .digest('hex')
    return join(this.scratchRoot(), component)
  }

  private async removeScratchSessionDirectory(record: PersistedMlp3Session): Promise<void> {
    const expected = this.scratchSessionDirectory(record.id)
    if (resolve(record.cwd) !== expected) {
      throw new Error(`Refusing to remove unexpected scratch directory ${record.cwd}`)
    }
    await rm(expected, { recursive: true, force: true })
  }

  private async publishProjectSnapshot(project: V3ProjectRuntime): Promise<void> {
    // A brand-new Gateway must be able to reach the pairing-ready state before
    // any recipient exists. Pairing's onProvisioned hook calls
    // provisionCurrentState() after the first certificate is committed, which
    // publishes the key grant and this snapshot in the correct order.
    if (!await this.content.hasActiveDevices(project.config.roomId)) return
    const occurredAt = Math.max(0, ...project.project.sessions.map(session => session.updatedAt))
    const event: Mlp3Event = {
      kind: 'malink.event',
      version: 3,
      eventId: logicalSnapshotEventId(project.project),
      workspaceId: this.config.gatewayId,
      projectId: project.project.projectId,
      occurredAt,
      payload: {
        type: 'project.snapshot',
        ...this.projectSnapshot(project),
      },
    }
    const result = await this.content.sendEvent(project.config, event, this.client)
    await this.content.publishProjectPointer(project.config, event, result.eventId, this.client)
  }

  private projectSnapshot(project: V3ProjectRuntime) {
    return {
      name: project.project.name,
      cwd: project.project.cwd,
      provider: project.project.provider,
      ...(project.project.model ? { model: project.project.model } : {}),
      ...(project.project.reasoningEffort
        ? { reasoningEffort: project.project.reasoningEffort }
        : {}),
      permissionMode: project.project.permissionMode,
      installedExtensions: this.extensions.descriptors(),
      defaultExtensions: project.project.defaultExtensions,
      extensionDefaultsRevision: project.project.extensionDefaultsRevision,
      snapshotVersion: project.project.snapshotVersion,
    }
  }

  private async publishSessionRecovery(project: V3ProjectRuntime): Promise<void> {
    for (const runtime of project.sessions.values()) {
      const record = runtime.record
      const event: Mlp3Event = {
        kind: 'malink.event',
        version: 3,
        eventId: logicalSessionRecoveryEventId(
          this.config.gatewayId,
          project.project.projectId,
          record.id,
          record.stateVersion,
        ),
        workspaceId: this.config.gatewayId,
        projectId: project.project.projectId,
        sessionId: record.id,
        occurredAt: record.updatedAt,
        payload: {
          type: 'session.ready',
          projection: terminalProjection(record, 'idle', this.extensions),
          provider: record.provider,
          ...(record.model ? { model: record.model } : {}),
          ...(record.reasoningEffort ? { reasoningEffort: record.reasoningEffort } : {}),
          permissionMode: record.permissionMode,
          extensionBindings: record.extensions,
        },
      }
      await this.content.queueEvent(project.config, event, this.client, {
        relation: threadRelation(record.threadRootEventId),
      })
    }
  }

  private async publishWorkspaceSnapshot(project: V3ProjectRuntime): Promise<void> {
    if (!await this.content.hasActiveDevices(project.config.roomId)) return
    const capabilities = this.discoverCapabilities(project)
    const pendingGatewayEnrollments = [
      ...(await this.dependencies.pendingGatewayEnrollments?.() ?? []),
    ].map(enrollment => ({
      ...enrollment,
      approverProjectId: project.project.projectId,
    }))
    const gatewayUpdate = await this.dependencies.gatewayUpdateSupervisor?.status().catch(error => {
      this.log(`[mlp3/matrix] Gateway update status unavailable: ${formatError(error)}`)
      return undefined
    })
    const snapshotContent = {
      protocolMin: 3 as const,
      protocolMax: 3 as const,
      gatewayKeyId: this.config.applicationSecurity.gatewayKeyPair.keyId,
      capabilities,
      ...(this.publishedClientReleases.length > 0
        ? { clientReleases: structuredClone(this.publishedClientReleases) }
        : {}),
      ...(pendingGatewayEnrollments.length > 0 ? { pendingGatewayEnrollments } : {}),
      ...(gatewayUpdate ? { gatewayUpdate } : {}),
    }
    const fingerprint = createHash('sha256')
      .update(canonicalJson(snapshotContent as JsonValue))
      .digest('base64url')
    if (project.project.workspaceSnapshotFingerprint !== fingerprint) {
      project.project.capabilities = capabilities
      project.project.workspaceSnapshotFingerprint = fingerprint
      project.project.capabilitySnapshotVersion += 1
      await this.persist(project)
    }
    if (project.project.capabilitySnapshotVersion < 1 || !project.project.capabilities) {
      throw new Error(`MLP/3 capabilities are unavailable for ${project.project.projectId}`)
    }
    const occurredAt = this.now()
    const event: Mlp3Event = {
      kind: 'malink.event',
      version: 3,
      eventId: logicalWorkspaceSnapshotEventId(
        this.config.gatewayId,
        project.project.projectId,
        project.project.capabilitySnapshotVersion,
      ),
      workspaceId: this.config.gatewayId,
      projectId: project.project.projectId,
      occurredAt,
      payload: {
        type: 'workspace.snapshot',
        ...snapshotContent,
        snapshotVersion: project.project.capabilitySnapshotVersion,
      },
    }
    const result = await this.content.sendEvent(project.config, event, this.client)
    await this.content.publishWorkspacePointer(
      project.config,
      event,
      result.eventId,
      this.client,
    )
  }

  private discoverCapabilities(project: V3ProjectRuntime): MatrixGatewayCapabilities {
    let models: MatrixGatewayCapabilities['models'] = []
    let providers: NonNullable<MatrixGatewayCapabilities['providers']> = []
    try {
      const mapModels = (providerName: string) =>
        (getProvider(providerName)?.getAvailableModels() ?? []).map(model => ({
        id: model.id,
        name: model.name,
        ...(model.defaultReasoningLevel
          ? { default_reasoning_level: model.defaultReasoningLevel }
          : {}),
        ...(model.supportedReasoningLevels
          ? {
              supported_reasoning_levels: model.supportedReasoningLevels.map(level => ({
                effort: level.effort,
                ...(level.description ? { description: level.description } : {}),
              })),
            }
          : {}),
        }))
      models = mapModels(project.project.provider)
      providers = listProviders().map(providerName => {
        const provider = getProvider(providerName)!
        return {
          id: providerName,
          name: providerName,
          models: providerName === project.project.provider ? models : mapModels(providerName),
          can_list_sessions: typeof provider.listSessions === 'function',
          can_inspect_sessions: typeof provider.getSessionHistory === 'function',
        }
      })
    } catch (error) {
      this.log(
        `[mlp3/matrix] model capability discovery failed for ${project.project.provider}: `
        + formatError(error),
      )
      if (project.project.capabilities) {
        return matrixGatewayCapabilitiesSchema.parse({
          ...project.project.capabilities,
          web_push: { vapid_public_key: this.webPush.publicKey() },
        })
      }
    }
    return matrixGatewayCapabilitiesSchema.parse({
      models,
      providers,
      permission_modes: AGENT_PERMISSION_MODES.map(mode => ({ ...mode })),
      can_create_session: true,
      can_select_session: false,
      can_archive_session: true,
      can_delete_session: false,
      session_extensions: this.extensions.descriptors().map(extension => ({
        id: extension.id,
        name: extension.name,
        description: extension.description,
        version: extension.version,
        settings: extension.settings.map(setting => setting.type === 'text'
          ? {
              id: setting.id,
              type: setting.type,
              label: setting.label,
              ...(setting.description ? { description: setting.description } : {}),
              ...(setting.required ? { required: true } : {}),
              ...(setting.placeholder ? { placeholder: setting.placeholder } : {}),
              ...(setting.defaultValue === undefined
                ? {}
                : { default_value: setting.defaultValue }),
            }
          : {
              id: setting.id,
              type: setting.type,
              label: setting.label,
              ...(setting.description ? { description: setting.description } : {}),
              ...(setting.defaultValue === undefined
                ? {}
                : { default_value: setting.defaultValue }),
            }),
      })),
      web_push: { vapid_public_key: this.webPush.publicKey() },
    })
  }

  private async prepareSessionThreads(project: V3ProjectRuntime): Promise<void> {
    if (!this.client.prepareRoomThread) return
    for (const record of project.project.sessions) {
      if (record.lifecycle === 'deleted') continue
      await this.client.prepareRoomThread(project.config.roomId, record.threadRootEventId)
    }
  }

  private observeRelationHint(
    project: V3ProjectRuntime,
    command: Mlp3Command,
    event: MatrixIncomingEvent,
  ): void {
    if (command.operation === 'session.create' || !command.sessionId) return
    const expected = project.project.sessions.find(session => session.id === command.sessionId)
      ?.threadRootEventId
    const relation = asRecord(event.content['m.relates_to'])
    const observed = typeof relation?.event_id === 'string' ? relation.event_id : undefined
    if (expected && observed && expected !== observed) {
      this.log(
        `[mlp3/matrix] relation hint mismatch for ${command.commandId}; `
        + `logical session ${command.sessionId} remains authoritative`,
      )
    }
  }

  private async destroySessionRuntime(
    runtime: Mlp3SessionRuntime,
    reason: 'archive' | 'delete' | 'replace' | 'shutdown',
  ): Promise<void> {
    try {
      await runtime.session.destroy(reason)
    } finally {
      runtime.port.close()
    }
  }

  private async finalizeProjectDeletion(
    project: V3ProjectRuntime,
    command: Mlp3CommandOf<'project.delete'>,
  ): Promise<void> {
    if (!this.projects.has(project.config.roomId)) return
    if (!this.dependencies.deleteProject) {
      throw new Error('This Gateway host does not support project deletion')
    }
    await this.dependencies.deleteProject({
      sourceRoom: project.config,
      requestedByDeviceId: command.deviceId,
      commandId: command.commandId,
      projectId: project.project.projectId,
    })
    // The project catalog is the restart authority and is removed first. A
    // stale runtime record can then never resurrect execution after a crash.
    await this.runtimeState.deleteProject(project.config.roomId)
    this.projects.delete(project.config.roomId)
    const configIndex = this.config.rooms.findIndex(room => room.roomId === project.config.roomId)
    if (configIndex >= 0) this.config.rooms.splice(configIndex, 1)
    for (const runtime of project.sessions.values()) {
      await this.destroySessionRuntime(runtime, 'delete').catch(error => {
        this.log(`[mlp3/matrix] deleted project session shutdown failed: ${formatError(error)}`)
      })
    }
    project.sessions.clear()
    await this.dependencies.onProjectDeleted?.(project.config).catch(error => {
      // The catalog mutation is already authoritative. Workspace control sync
      // is idempotent and its periodic lane will retry the same signed state.
      this.log(`[mlp3/matrix] deleted project directory publication deferred: ${formatError(error)}`)
    })
  }

  private async cleanup(): Promise<void> {
    if (this.gatewayNodeStatusTimer !== null) {
      clearTimeout(this.gatewayNodeStatusTimer)
      this.gatewayNodeStatusTimer = null
    }
    this.content.stopRetries()
    this.webPush.stop()
    // Stop /sync before removing the listener. A response already being
    // processed must finish staging its events before its cursor can commit.
    await this.client.stop().catch(error => {
      this.log(`[mlp3/matrix] Matrix client stop failed: ${formatError(error)}`)
    })
    this.unsubscribe?.()
    this.unsubscribe = null
    this.deferredUpdateCommands.clear()
    const projects = [...this.projects.values()]
    this.projects.clear()
    for (const project of projects) {
      for (const runtime of project.sessions.values()) {
        await this.destroySessionRuntime(runtime, 'shutdown').catch(error => {
          this.log(`[mlp3/matrix] session shutdown failed: ${formatError(error)}`)
        })
      }
    }
  }

  private now(): number {
    return this.dependencies.now?.() ?? Date.now()
  }

  private log(message: string): void {
    this.dependencies.onLog?.(message)
  }
}

/**
 * Stable per-node maintenance session identity.
 *
 * gatewayId is intentionally not accepted here: it is the shared Workspace
 * trust-domain ID after a second Gateway joins, so using it would make every
 * node updating the same release publish the same session ID.
 */
export function gatewayMaintenanceSessionId(
  gatewayNodeId: string,
  releaseId: string,
): string {
  return `gateway-update-node-${createHash('sha256')
    .update(`${gatewayNodeId}\0${releaseId}`)
    .digest('hex')
    .slice(0, 40)}`
}

function isSendFileCommandResult(value: unknown): value is SendFileCommandResult {
  if (!value || typeof value !== 'object') return false
  const status = (value as { status?: unknown }).status
  return status === 'queued' || status === 'sent' || status === 'failed'
}

function projection(
  record: PersistedMlp3Session,
  activity: Mlp3SessionProjection['activity'],
  extensions: SessionExtensionRegistry,
): Mlp3SessionProjection {
  return {
    title: record.title,
    scope: record.scope,
    cwd: record.cwd,
    lifecycle: record.lifecycle,
    activity,
    updatedAt: record.updatedAt,
    stateVersion: record.stateVersion,
    extensions: extensions.summaries(record.extensions),
    extensionRevision: record.extensionRevision,
  }
}

const AVAILABLE_COMMANDS_PROJECTION_BUDGET_BYTES = 16 * 1024

/**
 * Provider command catalogs are mutable session metadata, not per-message
 * timeline data. Publish a bounded copy only at durable session boundaries so
 * every assistant/tool event stays chat-sized even when ACP reports hundreds
 * of skills with long descriptions.
 */
function terminalProjection(
  record: PersistedMlp3Session,
  activity: Mlp3SessionProjection['activity'],
  extensions: SessionExtensionRegistry,
): Mlp3SessionProjection {
  return {
    ...projection(record, activity, extensions),
    availableCommands: boundedAvailableCommands(record.availableCommands),
  }
}

function boundedAvailableCommands(commands: readonly ProviderCommand[]): ProviderCommand[] {
  const result: ProviderCommand[] = []
  let bytes = 2
  for (const command of commands.slice(0, 256)) {
    const normalized: ProviderCommand = {
      name: command.name.slice(0, 256),
      description: command.description.slice(0, 512),
      inputHint: command.inputHint === null ? null : command.inputHint.slice(0, 256),
    }
    const nextBytes = Buffer.byteLength(JSON.stringify(normalized), 'utf8') + 1
    if (bytes + nextBytes > AVAILABLE_COMMANDS_PROJECTION_BUDGET_BYTES) break
    result.push(normalized)
    bytes += nextBytes
  }
  return result
}

function providerSessionMalinkRelation(
  sessions: readonly PersistedMlp3Session[],
  provider: string,
  providerSessionId: string,
): Pick<
  ProviderSessionEntry,
  'managedSessionId' | 'latestArchivedSessionId' | 'lastArchivedAt'
> {
  const related = sessions.filter(session =>
    session.provider === provider
    && session.providerSessionId === providerSessionId
    && session.lifecycle !== 'deleted'
  )
  const managed = related.find(session => session.lifecycle === 'active')
  const archived = related
    .filter(session => session.lifecycle === 'archived')
    .sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id))[0]
  return {
    ...(managed ? { managedSessionId: managed.id } : {}),
    ...(archived
      ? {
          latestArchivedSessionId: archived.id,
          lastArchivedAt: archived.updatedAt,
        }
      : {}),
  }
}

function validateReasoningEffort(
  model: ModelEntry | undefined,
  reasoningEffort: string | null,
): void {
  if (!reasoningEffort) return
  if (!model) throw new Error('Select a model before setting reasoning effort')
  if (!(model.supportedReasoningLevels ?? []).some(level => level.effort === reasoningEffort)) {
    throw new Error(
      `Reasoning effort ${reasoningEffort} is not available for model ${model.id}`,
    )
  }
}

function activityFromStatus(
  activity: AgentActivityPhase | undefined,
  state: import('@/core/types').SessionState,
): Mlp3SessionProjection['activity'] {
  if (activity === 'failed' || state === 'dead') return 'failed'
  if (activity === 'starting') return 'queued'
  if (activity === 'working' || activity === 'stopping' || state === 'querying' || state === 'canceling') {
    return 'working'
  }
  return 'idle'
}

async function dispatchRuntimeCommand(
  session: TopicSession,
  command: Mlp3Command,
  name: string,
  args: string,
): Promise<void> {
  await session.dispatch({
    kind: 'command',
    name,
    args,
    source: 'channel',
    user: { id: command.deviceId, username: command.deviceId },
  })
}

function threadRelation(rootEventId: string): Record<string, unknown> {
  return {
    rel_type: 'm.thread',
    event_id: rootEventId,
    is_falling_back: true,
    'm.in_reply_to': { event_id: rootEventId },
  }
}

function promptScheduleKey(
  project: V3ProjectRuntime,
  sessionId: string,
  commandId: string,
): string {
  return `${project.config.roomId}\0${sessionId}\0${commandId}`
}

async function waitForScheduledPromptCancellation(
  scheduled: ScheduledPromptCommand | undefined,
): Promise<boolean> {
  if (!scheduled?.cancelled) return false
  await scheduled.cancellation
  return true
}

function logicalEventId(command: Mlp3Command, stage: string): string {
  return createHash('sha256')
    .update(`malink-v3-event\0${command.deviceId}\0${command.certificateId}\0${command.commandId}\0${stage}`)
    .digest('base64url')
}

function workspaceInboxEventId(requestId: string): string {
  return createHash('sha256')
    .update(`malink-v3-workspace-inbox\0${requestId}`)
    .digest('base64url')
}

function logicalSnapshotEventId(project: PersistedMlp3Project): string {
  return createHash('sha256')
    .update(`malink-v3-project-snapshot\0${project.projectId}\0${project.snapshotVersion}`)
    .digest('base64url')
}

function logicalWorkspaceSnapshotEventId(
  workspaceId: string,
  projectId: string,
  snapshotVersion: number,
): string {
  return createHash('sha256')
    .update(`malink-v3-workspace-snapshot\0${workspaceId}\0${projectId}\0${snapshotVersion}`)
    .digest('base64url')
}

function logicalGatewayNodeStatusEventId(
  workspaceId: string,
  gatewayNodeId: string,
  observedAt: number,
): string {
  return createHash('sha256')
    .update(`malink-v3-gateway-node-status\0${workspaceId}\0${gatewayNodeId}\0${observedAt}`)
    .digest('base64url')
}

function logicalSessionRecoveryEventId(
  workspaceId: string,
  projectId: string,
  sessionId: string,
  stateVersion: number,
): string {
  return createHash('sha256')
    .update(
      `malink-v3-session-recovery\0${workspaceId}\0${projectId}\0${sessionId}\0${stateVersion}`,
    )
    .digest('base64url')
}

function logicalCommandReconciliationEventId(
  command: Mlp3Command,
  payload: Extract<Mlp3EventPayload, { type: 'command.reconciled' }>,
): string {
  return createHash('sha256')
    .update(
      `malink-v3-command-reconciliation\0${command.deviceId}\0${command.certificateId}`
      + `\0${command.commandId}\0${canonicalJson(payload)}`,
    )
    .digest('base64url')
}

function commandReconciliationPayload(
  record: Mlp3CommandJournalRecord,
): Extract<Mlp3EventPayload, { type: 'command.reconciled' }> {
  if (record.status === 'accepted') {
    return {
      type: 'command.reconciled',
      commandId: record.command.commandId,
      state: 'accepted',
      acceptedAt: record.acceptedAt,
    }
  }
  if (record.status === 'dispatched') {
    return {
      type: 'command.reconciled',
      commandId: record.command.commandId,
      state: 'running',
      acceptedAt: record.acceptedAt,
      ...(record.dispatchedAt === undefined ? {} : { dispatchedAt: record.dispatchedAt }),
    }
  }
  const terminal = record.terminal
  if (!terminal) throw new Error('A terminal command journal record has no terminal outcome')
  const outcome = reconciledCommandOutcome(terminal)
  const error = reconciledCommandError(terminal, outcome)
  const result = terminal.result === undefined
    ? undefined
    : boundedProviderHistoryResult(record.command, terminal.result)
  return {
    type: 'command.reconciled',
    commandId: record.command.commandId,
    state: 'terminal',
    acceptedAt: record.acceptedAt,
    ...(record.dispatchedAt === undefined ? {} : { dispatchedAt: record.dispatchedAt }),
    ...(record.terminalAt === undefined ? {} : { terminalAt: record.terminalAt }),
    outcome,
    ...(result === undefined ? {} : { result }),
    ...(error ? { error } : {}),
  }
}

function providerHistoryRecoveryEventId(command: Mlp3Command): string {
  return createHash('sha256')
    .update(`malink-v3-provider-history-recovery\0${command.commandId}`)
    .digest('base64url')
}

function reconciledCommandOutcome(
  terminal: Mlp3CommandTerminal,
): 'succeeded' | 'failed' | 'cancelled' | 'rejected' | 'interrupted' {
  return terminal.event?.payload.type === 'turn.completed'
      && terminal.event.payload.outcome === 'cancelled'
    ? 'cancelled'
    : terminal.outcome
}

function reconciledCommandError(
  terminal: Mlp3CommandTerminal,
  outcome: ReturnType<typeof reconciledCommandOutcome>,
): { code: string; message: string; retryable: boolean } | undefined {
  if (outcome === 'succeeded' || outcome === 'cancelled') return undefined
  const payload = terminal.event?.payload
  if (payload?.type === 'turn.failed') {
    return { code: payload.code, message: payload.message, retryable: false }
  }
  if (payload?.type === 'command.rejected') {
    return { code: payload.code, message: payload.message, retryable: payload.retryable }
  }
  return {
    code: terminal.code ?? (outcome === 'interrupted' ? 'execution_interrupted' : 'gateway_failed'),
    message: terminal.error
      ?? (outcome === 'interrupted'
        ? 'The Gateway restarted after dispatch. The command was not executed again.'
        : 'The Gateway recorded this command as failed.'),
    retryable: outcome === 'interrupted',
  }
}

function commandKey(command: Mlp3Command): string {
  return `${command.deviceId}\0${command.certificateId}\0${command.commandId}`
}

function titleFromPrompt(text: string): string {
  const normalized = text.replace(/\s+/gu, ' ').trim()
  if (!normalized) return ''
  return normalized.length <= 64 ? normalized : `${normalized.slice(0, 61)}...`
}

function numericCompatibilityId(value: string): number {
  const hex = createHash('sha256').update(value).digest('hex').slice(0, 12)
  return -Math.max(1, Number.parseInt(hex, 16))
}

function maintenanceAgentPrompt(instruction: GatewayAgentUpdateInstruction): string {
  return `You are the local Malink Gateway maintenance Agent for signed release ${instruction.releaseId}.

The release signer authorized this exact update target:
- version: ${instruction.versionName}
- build ID: ${instruction.buildId}
- Git repository: ${instruction.repository.url}
- exact Git commit: ${instruction.repository.commit}

Supervisor-owned paths:
- workspace: ${instruction.workspaceDirectory}
- source checkout: ${instruction.sourceDirectory}
- candidate release: ${instruction.candidateDirectory}

The candidate directory starts as a local copy of the active Gateway. Work only in the update workspace and a Git worktree or clone for the exact signed commit. Never modify the active current release, supervisor state, release signer, Matrix state, or durable Gateway data.

Follow the signed release Prompt below. Resolve local runtime, dependency, build, and test issues autonomously. The final candidate must contain regular files at runtime/node, ops/matrix-local-gateway.js, ops/gatewayUpdateSupervisorMain.js, ops/gatewayAgentUpdateCli.js, and ops/gatewayJournalRepairCli.js. Do not leave symbolic links in the candidate.

Never execute candidate/ops/matrix-local-gateway.js, candidate/ops/gatewayUpdateSupervisorMain.js,
or any other candidate entrypoint. Changing cwd or supplying --help does not isolate production
MALINK_* environment variables. Candidate runtime validation belongs exclusively to the supervisor.

After every required test passes and the candidate is complete, run this exact owner-only finish command unchanged:

${instruction.submitCommand}

Do not report success unless that command returns a Gateway update status whose phase is staged.

SIGNED RELEASE PROMPT
${instruction.prompt}`
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function commandFailure(error: unknown): { code: string; retryable: boolean } {
  if (!error || typeof error !== 'object') {
    return { code: 'execution_failed', retryable: false }
  }
  const candidate = error as { commandCode?: unknown; retryable?: unknown }
  if (
    typeof candidate.commandCode === 'string'
    && /^[a-z][a-z0-9_]{0,127}$/u.test(candidate.commandCode)
  ) {
    return {
      code: candidate.commandCode,
      retryable: candidate.retryable === true,
    }
  }
  return { code: 'execution_failed', retryable: false }
}

function gatewayUpdateAgentCommandError(error: unknown): unknown {
  const message = formatError(error)
  if (!/(?:fetch failed|network(?:error| request)?|timed out|timeout|socket hang up|connection (?:reset|refused)|temporar(?:y|ily)|rate.?limit|too many requests|service unavailable|\bHTTP (?:408|425|429|5\d\d)\b)/iu.test(message)) {
    return error
  }
  return Object.assign(new Error(message, {
    ...(error instanceof Error ? { cause: error } : {}),
  }), {
    commandCode: 'gateway_update_agent_transient_failure',
    retryable: true,
  })
}
