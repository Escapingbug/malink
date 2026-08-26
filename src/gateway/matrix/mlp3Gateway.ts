import { createHash, randomUUID } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import {
  MALINK_MATRIX_EXTENSION,
  matrixGatewayCapabilitiesSchema,
  type Mlp3Command,
  type Mlp3Event,
  type Mlp3EventPayload,
  type Mlp3SessionProjection,
  type JsonValue,
  type MatrixGatewayCapabilities,
  type NativeClientRelease,
  type ProviderCommand,
  type ProviderSessionEntry,
  type GatewayEnrollmentPending,
} from '@malink/protocol'
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
  FileMlp3RuntimeStateStore,
  type PersistedMlp3Project,
  type PersistedMlp3Session,
} from './fileMlp3RuntimeState'
import {
  MatrixMlp3CommandAuthorizer,
  canApprovePrivilegedExecution,
} from './mlp3Authorizer'
import { GatewayMlp3ContentLayer } from './mlp3Content'
import { FileNativeClientReleaseStore } from './fileNativeClientReleaseStore'
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
}

type Mlp3CommandOf<TOperation extends Mlp3Command['operation']> = Extract<
  Mlp3Command,
  { operation: TOperation }
>

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
  pendingGatewayEnrollments?: () => Promise<readonly GatewayEnrollmentPending[]>
  privilegeExecutor?: PrivilegeExecutor
  webPushService?: GatewayWebPushService
  workspaceGatewayDirectory?: () => Promise<import('@malink/protocol').SignedWorkspaceGatewayDirectory | undefined>
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
}

export type MatrixMlp3GatewayState = 'stopped' | 'starting' | 'running' | 'stopping'

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
  private readonly journal: FileMlp3CommandJournal
  private readonly runtimeState: FileMlp3RuntimeStateStore
  private readonly nativeClientReleases: FileNativeClientReleaseStore
  private readonly authorizer: MatrixMlp3CommandAuthorizer
  private readonly content: GatewayMlp3ContentLayer
  private readonly extensions: SessionExtensionRegistry
  private readonly webPush: GatewayWebPushService
  private readonly projects = new Map<string, V3ProjectRuntime>()
  private readonly sessionChains = new Map<string, Promise<void>>()
  private readonly activeCommands = new Map<string, Promise<void>>()
  private readonly executionTasks = new Set<Promise<void>>()
  private startupEvents: MatrixIncomingEvent[] = []
  private startupFailure: Error | null = null
  private eventChain: Promise<void> = Promise.resolve()
  private unsubscribe: (() => void) | null = null
  private state: MatrixMlp3GatewayState = 'stopped'
  private publishedClientReleases: NativeClientRelease[] = []
  private readonly publishedGatewayDirectoryRevisions = new Map<string, number>()
  private readonly publishedGatewayEnrollmentFingerprints = new Map<string, string>()
  private readonly runtimeEpoch = randomUUID()

  constructor(
    private readonly config: MatrixGatewayConfig,
    private readonly dependencies: MatrixMlp3GatewayDependencies = {},
  ) {
    validateMatrixGatewayConfig(config)
    this.client = dependencies.client
      ?? createMatrixJsSdkGatewayClient(config.connection, dependencies.onLog)
    this.journal = new FileMlp3CommandJournal(`${config.replayLedgerPath}.v3-commands.jsonl`)
    this.runtimeState = new FileMlp3RuntimeStateStore(
      `${config.replayLedgerPath}.v3-runtime-state.json`,
      config.gatewayId,
    )
    this.nativeClientReleases = new FileNativeClientReleaseStore(
      `${config.replayLedgerPath}.v3-client-releases.json`,
      config.gatewayId,
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
    this.startupFailure = null
    try {
      await this.journal.initialize()
      await this.runtimeState.initialize(this.config.rooms)
      await this.nativeClientReleases.initialize()
      this.publishedClientReleases = await this.nativeClientReleases.releases()
      await this.content.initialize()
      await this.createProjectRuntimes()
      await this.webPush.initialize()
      this.unsubscribe = this.client.onRoomEvent(event => this.receiveEvent(event))
      await this.client.initializeCrypto(this.config.crypto)
      await this.client.start()
      await this.client.waitUntilReady(this.config.connection.initialSyncTimeoutMs)
      await this.client.pinTrustedDevices?.(this.config.trustedDevices)
      for (const project of this.projects.values()) {
        await this.client.assertRoomEncrypted(project.config.roomId)
        await this.content.provisionProject(project.config, this.client)
        await this.prepareSessionThreads(project)
        await this.publishSessionRecovery(project)
        await this.publishProjectSnapshot(project)
      }
      if (this.startupFailure) throw this.startupFailure
      this.state = 'running'
      await this.recoverJournal()
      const queued = this.startupEvents
      this.startupEvents = []
      for (const event of queued) this.enqueue(event)
      await this.eventChain
    } catch (error) {
      await this.cleanup()
      this.state = 'stopped'
      throw error
    }
  }

  async stop(): Promise<void> {
    if (this.state === 'stopped') return
    this.state = 'stopping'
    await this.eventChain
    while (this.executionTasks.size > 0) {
      await Promise.allSettled([...this.executionTasks])
    }
    await this.cleanup()
    this.state = 'stopped'
  }

  async syncState(roomId?: string): Promise<void> {
    const projects = roomId
      ? [this.projects.get(roomId)].filter((value): value is V3ProjectRuntime => value !== undefined)
      : [...this.projects.values()]
    for (const project of projects) await this.publishProjectSnapshot(project)
  }

  async provisionCurrentState(): Promise<void> {
    if (this.state !== 'running') {
      throw new Error(`Cannot provision MLP/3 state while Gateway is ${this.state}`)
    }
    for (const project of this.projects.values()) {
      await this.content.provisionProject(project.config, this.client)
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
      if (published.changed) {
        for (const project of this.projects.values()) {
          project.project.capabilitySnapshotVersion += 1
          await this.persist(project)
        }
      }
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

  private receiveEvent(event: MatrixIncomingEvent): void {
    if (this.state === 'starting') {
      const limit = this.config.startupEventQueueLimit ?? 1_000
      if (this.startupEvents.length >= limit) {
        this.startupFailure = new Error(`MLP/3 startup event queue exceeded ${limit}`)
      } else {
        this.startupEvents.push(event)
      }
      return
    }
    if (this.state === 'running') this.enqueue(event)
  }

  private enqueue(event: MatrixIncomingEvent): void {
    this.eventChain = this.eventChain
      .then(() => this.handleEvent(event))
      .catch(error => {
        this.dependencies.onRejected?.(event, error)
        this.log(`[mlp3/matrix] rejected ${event.eventId}: ${formatError(error)}`)
      })
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
    if (record.status === 'terminal') {
      if (!record.terminalDeliveryEventId) this.scheduleTerminalRedelivery(project, record)
      return
    }
    const activeKey = commandKey(authorized.command)
    if (record.status === 'dispatched' || this.activeCommands.has(activeKey)) return
    this.scheduleExecution(project, record)
  }

  private scheduleExecution(
    project: V3ProjectRuntime,
    journalRecord: Mlp3CommandJournalRecord,
  ): Promise<void> {
    const command = journalRecord.command
    const activeKey = commandKey(command)
    const sessionKey = command.operation === 'project.create'
      ? `${this.config.gatewayId}\0project-create`
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
    const previous = bypassSessionQueue
      ? Promise.resolve()
      : this.sessionChains.get(sessionKey) ?? Promise.resolve()
    const task = previous.catch(() => undefined).then(async () => {
      try {
        await this.journal.markDispatched(command, this.now())
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
      case 'session.update':
        await this.updateSession(project, command)
        return
      case 'session.set_lifecycle':
        await this.setSessionLifecycle(project, command)
        return
      case 'project.update':
        await this.updateProject(project, command)
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
      case 'notification.subscribe':
        await this.subscribeNotifications(project, command)
        return
      case 'notification.unsubscribe':
        await this.unsubscribeNotifications(project, command)
        return
    }
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
  ): Promise<void> {
    this.transition(runtime, 'queued')
    await this.persist(project)
    await this.emitBestEffort(project, runtime.record, this.eventFor(
      project,
      runtime.record,
      command,
      'turn-queued',
      {
        type: 'turn.queued',
        turnId: command.commandId,
        originDeviceId: command.deviceId,
        text: prompt.text,
        ...(prompt.attachments ? { attachments: prompt.attachments } : {}),
        projection: projection(runtime.record, runtime.activity.phase, this.extensions),
      },
    ))
    this.transition(runtime, 'working')
    await this.persist(project)
    await this.emitBestEffort(project, runtime.record, this.eventFor(
      project,
      runtime.record,
      command,
      'turn-started',
      {
        type: 'turn.started',
        turnId: command.commandId,
        projection: projection(runtime.record, runtime.activity.phase, this.extensions),
      },
    ))
    runtime.port.setCausationCommandId(command.commandId)
    runtime.activeTurnId = command.commandId
    let dispatchFailure: { error: unknown } | null = null
    try {
      const richInput = await materializePromptInput(
        prompt,
        this.client,
        `${this.config.replayLedgerPath}.v3-attachments`,
      )
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
      const causalDelivery = runtime.port.causalDeliveryBarrier(command.commandId)
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
    const completed = this.eventFor(project, runtime.record, command, 'turn-completed', {
      type: 'turn.completed',
      turnId: command.commandId,
      outcome: 'succeeded',
      projection: terminalProjection(runtime.record, runtime.activity.phase, this.extensions),
    })
    await this.settleAndDeliver(project, command, completed, 'succeeded')
    this.log(`[mlp3/matrix] turn ${command.commandId} completed`)
  }

  private async cancelTurn(
    project: V3ProjectRuntime,
    command: Mlp3CommandOf<'turn.cancel'>,
  ): Promise<void> {
    const runtime = this.requireActiveSession(project, command.sessionId)
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
    if (requestedModel && !selectedModel) {
      throw new Error(`Model ${requestedModel} is not available for provider ${provider}`)
    }
    const model = selectedModel?.id ?? null
    const modelChanged = model !== runtime.record.model
    const reasoningEffort = patch.reasoningEffort === undefined
      ? modelChanged
        ? selectedModel?.defaultReasoningLevel ?? null
        : runtime.record.reasoningEffort
      : patch.reasoningEffort
    if (catalog) validateReasoningEffort(selectedModel, reasoningEffort)
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

  private async createInvitation(
    project: V3ProjectRuntime,
    command: Mlp3CommandOf<'device.invitation.create'>,
  ): Promise<void> {
    if (!this.dependencies.createDeviceInvitation) {
      throw new Error('This Gateway host does not support device invitations')
    }
    const invitation = await this.dependencies.createDeviceInvitation({
      requestedByDeviceId: command.deviceId,
      commandId: command.commandId,
      ...(command.payload.lifetimeMs === undefined
        ? {}
        : { lifetimeMs: command.payload.lifetimeMs }),
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

  private async updateProject(
    project: V3ProjectRuntime,
    command: Mlp3CommandOf<'project.update'>,
  ): Promise<void> {
    const patch = command.payload.patch
    const catalog = getProvider(project.project.provider)
    const availableModels = catalog?.getAvailableModels() ?? []
    let selectedModel = project.project.model
      ? availableModels.find(model =>
        model.id === project.project.model || model.name === project.project.model
      )
      : undefined
    if (patch.model !== undefined) {
      selectedModel = patch.model
        ? availableModels.find(model => model.id === patch.model || model.name === patch.model)
        : undefined
      if (patch.model && catalog && !selectedModel) {
        throw new Error(
          `Model ${patch.model} is not available for provider ${project.project.provider}`,
        )
      }
      project.project.model = selectedModel?.id ?? patch.model
      if (patch.reasoningEffort === undefined) {
        project.project.reasoningEffort = selectedModel?.defaultReasoningLevel ?? null
      }
    }
    if (patch.reasoningEffort !== undefined) {
      if (catalog) validateReasoningEffort(selectedModel, patch.reasoningEffort)
      project.project.reasoningEffort = patch.reasoningEffort
    }
    if (patch.defaultExtensions !== undefined) {
      project.project.defaultExtensions = this.extensions.normalizeBindings(
        patch.defaultExtensions,
      )
      project.project.extensionDefaultsRevision += 1
    }
    project.project.snapshotVersion += 1
    await this.persist(project)
    await this.publishProjectSnapshot(project)
    const event: Mlp3Event = {
      kind: 'malink.event',
      version: 3,
      eventId: logicalEventId(command, 'project-updated'),
      workspaceId: this.config.gatewayId,
      projectId: project.project.projectId,
      occurredAt: this.now(),
      causationCommandId: command.commandId,
      payload: {
        type: 'project.snapshot',
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
      },
    }
    await this.settleAndDeliver(project, command, event, 'succeeded')
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
          title: entry.title.trim() || 'Untitled provider session',
          updatedAt: Math.max(0, Math.trunc(entry.updated)),
          ...(entry.cwd ? { cwd: entry.cwd } : {}),
          ...relation,
        }
      })
      const payload = {
        type: 'provider.sessions.listed' as const,
        provider: command.payload.provider,
        sessions,
      }
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
      const payload = {
        type: 'provider.session.inspected' as const,
        provider: command.payload.provider,
        providerSessionId: command.payload.providerSessionId,
        title: history.title.trim() || 'Provider session',
        ...relation,
        messages: limitProviderHistoryMessages(history.messages),
      }
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
    let payload: Mlp3EventPayload
    if (command.operation === 'prompt.submit' && runtime) {
      this.transition(runtime, 'failed')
      await this.persist(project).catch(persistError => {
        this.log(`[mlp3/matrix] failed projection persistence failed: ${formatError(persistError)}`)
      })
      payload = {
        type: 'turn.failed',
        turnId: command.commandId,
        code: 'execution_failed',
        message: formatError(error),
        projection: terminalProjection(runtime.record, runtime.activity.phase, this.extensions),
      }
    } else {
      payload = {
        type: 'command.rejected',
        commandId: command.commandId,
        code: 'execution_failed',
        message: formatError(error),
        retryable: false,
      }
    }
    const event = this.eventFor(project, runtime?.record, command, 'command-failed', payload)
    await this.settleAndDeliver(project, command, event, 'failed').catch(deliveryError => {
      this.log(`[mlp3/matrix] failed command result delivery failed: ${formatError(deliveryError)}`)
    })
  }

  private async settleAndDeliver(
    project: V3ProjectRuntime,
    command: Mlp3Command,
    event: Mlp3Event,
    outcome: Mlp3CommandTerminal['outcome'],
    result?: JsonValue,
  ): Promise<void> {
    await this.journal.settle(command, {
      outcome,
      eventId: event.eventId,
      event,
      ...(command.sessionId ? { sessionId: command.sessionId } : {}),
      ...(result === undefined ? {} : { result }),
    }, this.now())
    await this.enqueueTerminalNotification(project, event)
    try {
      const queued = await this.enqueueEventDelivery(
        project,
        command.sessionId
          ? project.project.sessions.find(session => session.id === command.sessionId)
          : undefined,
        event,
      )
      void queued.confirmation.then(sent =>
        this.journal.markTerminalDelivered(command, sent.eventId, this.now())
      ).catch(error => {
        this.log(`[mlp3/matrix] terminal delivery queued: ${formatError(error)}`)
      })
    } catch (error) {
      // The semantic terminal is already fsynced in the command journal and
      // the content layer stages before attempting Matrix delivery. Never
      // reinterpret a transport failure as an execution failure.
      this.log(`[mlp3/matrix] terminal delivery queued: ${formatError(error)}`)
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
  }

  private scheduleTerminalRedelivery(
    project: V3ProjectRuntime,
    record: Mlp3CommandJournalRecord,
  ): void {
    const terminalEvent = record.terminal?.event
    if (!terminalEvent) return
    const task = this.enqueueTerminalNotification(project, terminalEvent).then(() => this.emit(
      project,
      record.command.sessionId
        ? project.project.sessions.find(session => session.id === record.command.sessionId)
        : undefined,
      terminalEvent,
    )).then(result => this.journal.markTerminalDelivered(
      record.command,
      result.eventId,
      this.now(),
    )).catch(error => {
      this.log(`[mlp3/matrix] terminal redelivery failed: ${formatError(error)}`)
    }).finally(() => this.executionTasks.delete(task))
    this.executionTasks.add(task)
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
    await this.publishProjectSnapshot(project)
  }

  private createSessionRuntime(
    project: V3ProjectRuntime,
    record: PersistedMlp3Session,
  ): Mlp3SessionRuntime {
    const activity = { phase: 'idle' as Mlp3SessionProjection['activity'] }
    let runtime: Mlp3SessionRuntime | undefined
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
    const selectedModel = requestedModel && catalog
      ? catalog.getAvailableModels().find(item =>
        item.id === requestedModel || item.name === requestedModel
      )
      : undefined
    if (requestedModel && catalog && !selectedModel) {
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
    if (catalog) validateReasoningEffort(selectedModel, reasoningEffort)
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
    await this.publishWorkspaceSnapshot(project)
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
      },
    }
    const result = await this.content.sendEvent(project.config, event, this.client)
    await this.content.publishProjectPointer(project.config, event, result.eventId, this.client)
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
          this.runtimeEpoch,
        ),
        workspaceId: this.config.gatewayId,
        projectId: project.project.projectId,
        sessionId: record.id,
        occurredAt: this.now(),
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
    const capabilities = this.discoverCapabilities(project)
    const gatewayDirectory = await this.dependencies.workspaceGatewayDirectory?.()
    const pendingGatewayEnrollments = [
      ...(await this.dependencies.pendingGatewayEnrollments?.() ?? []),
    ].map(enrollment => ({
      ...enrollment,
      approverProjectId: project.project.projectId,
    }))
    const enrollmentFingerprint = JSON.stringify(pendingGatewayEnrollments)
    const directoryChanged = gatewayDirectory !== undefined &&
      gatewayDirectory.directory.revision !==
        this.publishedGatewayDirectoryRevisions.get(project.project.projectId)
    const enrollmentsChanged = enrollmentFingerprint !==
      this.publishedGatewayEnrollmentFingerprints.get(project.project.projectId)
    if (
      JSON.stringify(project.project.capabilities) !== JSON.stringify(capabilities)
      || directoryChanged
      || enrollmentsChanged
    ) {
      project.project.capabilities = capabilities
      project.project.capabilitySnapshotVersion += 1
      if (gatewayDirectory) {
        this.publishedGatewayDirectoryRevisions.set(
          project.project.projectId,
          gatewayDirectory.directory.revision,
        )
      }
      this.publishedGatewayEnrollmentFingerprints.set(
        project.project.projectId,
        enrollmentFingerprint,
      )
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
        protocolMin: 3,
        protocolMax: 3,
        gatewayKeyId: this.config.applicationSecurity.gatewayKeyPair.keyId,
        capabilities: project.project.capabilities,
        ...(this.publishedClientReleases.length > 0
          ? { clientReleases: structuredClone(this.publishedClientReleases) }
          : {}),
        ...(gatewayDirectory ? { gatewayDirectory } : {}),
        ...(pendingGatewayEnrollments.length > 0 ? { pendingGatewayEnrollments } : {}),
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

  private async cleanup(): Promise<void> {
    this.unsubscribe?.()
    this.unsubscribe = null
    this.startupEvents = []
    this.content.stopRetries()
    this.webPush.stop()
    const projects = [...this.projects.values()]
    this.projects.clear()
    for (const project of projects) {
      for (const runtime of project.sessions.values()) {
        await this.destroySessionRuntime(runtime, 'shutdown').catch(error => {
          this.log(`[mlp3/matrix] session shutdown failed: ${formatError(error)}`)
        })
      }
    }
    await this.client.stop().catch(error => {
      this.log(`[mlp3/matrix] Matrix client stop failed: ${formatError(error)}`)
    })
  }

  private now(): number {
    return this.dependencies.now?.() ?? Date.now()
  }

  private log(message: string): void {
    this.dependencies.onLog?.(message)
  }
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

function limitProviderHistoryMessages(
  input: readonly import('@/providers/provider').ProviderHistoryMessage[],
): import('@malink/protocol').ProviderHistoryMessage[] {
  const result: import('@malink/protocol').ProviderHistoryMessage[] = []
  let bytes = 0
  for (const message of input.slice(-256)) {
    const normalized = {
      id: message.id.slice(0, 256) || `message-${result.length + 1}`,
      role: message.role,
      text: message.text.slice(0, 16 * 1024),
    }
    const nextBytes = Buffer.byteLength(JSON.stringify(normalized), 'utf8')
    if (bytes + nextBytes > 90 * 1024) break
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

function logicalSessionRecoveryEventId(
  workspaceId: string,
  projectId: string,
  sessionId: string,
  runtimeEpoch: string,
): string {
  return createHash('sha256')
    .update(
      `malink-v3-session-recovery\0${workspaceId}\0${projectId}\0${sessionId}\0${runtimeEpoch}`,
    )
    .digest('base64url')
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

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
