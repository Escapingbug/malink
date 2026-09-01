import { createHash } from 'node:crypto'
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  MALINK_MATRIX_EXTENSION,
  MLP3_MATRIX_PROJECT_KEY_GRANT_EVENT_TYPE,
  MLP3_MATRIX_WORKSPACE_POINTER_EVENT_TYPE,
  mlp3CurrentPointerSchema,
  mlp3ProjectKeyGrantStateSchema,
  type Mlp3Command,
  type Mlp3Event,
  type SessionExtensionDescriptor,
} from '@malink/protocol'
import {
  base64UrlDecode,
  exportDeviceKeyPair,
  generateDeviceKeyPair,
  openMlp3Envelope,
  openMlp3ProjectKeyGrant,
  sealMlp3Envelope,
  signMlp3Command,
} from '@malink/security'
import {
  InMemoryMatrixTransport,
  type MatrixIncomingEvent,
} from '@/channel/matrix'
import type {
  MatrixApplicationTimelineEventRequest,
  MatrixSendEventResult,
} from '@/channel/matrix/transport'
import type {
  MatrixGatewayClient,
  MatrixGatewayEventListener,
} from '@/gateway/matrix/client'
import type {
  MatrixGatewayConfig,
  MatrixGatewayCryptoConfig,
  MatrixGatewayTrustedDevice,
} from '@/gateway/matrix/config'
import {
  gatewayMaintenanceSessionId,
  MatrixMlp3GatewayRunner,
} from '@/gateway/matrix/mlp3Gateway'
import { gatewayProjectIdentity } from '@/gateway/matrix/project'
import type { GatewayWebPushService } from '@/gateway/matrix/webPush'
import { createTopicSessionRecord } from '@/bridge/topicSession'
import type { TopicSession } from '@/bridge/channelPort'
import { clearProviderRegistryForTesting, registerProvider } from '@/providers/registry'
import {
  normalizeDeclarativeExtensionConfig,
  SessionExtensionRegistry,
  type SessionExtensionProvider,
} from '@/runtime/sessionExtensions'

class TestMatrixClient extends InMemoryMatrixTransport implements MatrixGatewayClient {
  private readonly listeners = new Set<MatrixGatewayEventListener>()
  private readonly timelineGates = new Map<string, {
    started: ReturnType<typeof deferred<void>>
    release: ReturnType<typeof deferred<void>>
  }>()
  initializeCrypto(_config: MatrixGatewayCryptoConfig): Promise<void> { return Promise.resolve() }
  onRoomEvent(listener: MatrixGatewayEventListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  start(): Promise<void> { return Promise.resolve() }
  waitUntilReady(): Promise<void> { return Promise.resolve() }
  assertRoomEncrypted(): Promise<void> { return Promise.resolve() }
  pinTrustedDevices(): Promise<void> { return Promise.resolve() }
  prepareRoomThread(): Promise<void> { return Promise.resolve() }
  stop(): Promise<void> { return Promise.resolve() }
  blockTimelineTransaction(transactionId: string) {
    const gate = { started: deferred<void>(), release: deferred<void>() }
    this.timelineGates.set(transactionId, gate)
    return gate
  }
  override async sendApplicationTimelineEvent(
    request: MatrixApplicationTimelineEventRequest,
  ): Promise<MatrixSendEventResult> {
    const gate = this.timelineGates.get(request.transactionId)
    if (gate) {
      gate.started.resolve()
      await gate.release.promise
      this.timelineGates.delete(request.transactionId)
    }
    return super.sendApplicationTimelineEvent(request)
  }
  emit(event: MatrixIncomingEvent): void {
    for (const listener of this.listeners) listener(event)
  }
}

describe('MatrixMlp3GatewayRunner', () => {
  it('scopes maintenance sessions to one physical Gateway node', () => {
    const first = gatewayMaintenanceSessionId('gateway-node-a', 'release-2')
    const second = gatewayMaintenanceSessionId('gateway-node-b', 'release-2')

    expect(first).not.toBe(second)
    expect(first).toBe(gatewayMaintenanceSessionId('gateway-node-a', 'release-2'))
  })

  it('starts without a recipient so the first device can pair', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'malink-v3-empty-gateway-'))
    const gatewayKeys = await generateDeviceKeyPair()
    const client = new TestMatrixClient()
    const roomId = '!empty-project:example.org'
    const runner = new MatrixMlp3GatewayRunner({
      gatewayId: 'workspace-empty',
      gatewayNodeId: 'gateway-node-empty',
      connection: {
        baseUrl: 'https://matrix.example.org',
        accessToken: 'gateway-token',
        userId: '@gateway:example.org',
        deviceId: 'GATEWAY',
      },
      crypto: {
        backend: 'memory',
        databasePrefix: 'empty-test',
        allowInMemoryForTesting: true,
      },
      rooms: [{
        roomId,
        conversationId: roomId,
        cwd: '/empty-repo',
        providerName: 'test',
      }],
      trustedDevices: [],
      replayLedgerPath: join(directory, 'replay'),
      applicationSecurity: {
        gatewayDeviceId: 'workspace-empty',
        gatewayKeyPair: await exportDeviceKeyPair(gatewayKeys),
        envelopeReplayLedgerPath: join(directory, 'security'),
      },
    }, {
      client,
      listTrustedDevices: async () => [],
    })

    await expect(runner.start()).resolves.toBeUndefined()
    expect(runner.getState()).toBe('running')
    expect(client.delivered).toHaveLength(0)
    expect(client.state.size).toBe(0)
    await runner.stop()
  })

  it('establishes authoritative pointers for the first device before using the pairing fast path', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'malink-v3-first-pair-'))
    const gatewayKeys = await generateDeviceKeyPair()
    const firstPhoneKeys = await generateDeviceKeyPair()
    const secondPhoneKeys = await generateDeviceKeyPair()
    const client = new TestMatrixClient()
    const roomId = '!first-pair-project:example.org'
    const trustedDevices: MatrixGatewayTrustedDevice[] = []
    const runner = new MatrixMlp3GatewayRunner({
      gatewayId: 'workspace-first-pair',
      gatewayNodeId: 'gateway-node-first-pair',
      connection: {
        baseUrl: 'https://matrix.example.org',
        accessToken: 'gateway-token',
        userId: '@gateway:example.org',
        deviceId: 'GATEWAY',
      },
      crypto: {
        backend: 'memory',
        databasePrefix: 'first-pair-test',
        allowInMemoryForTesting: true,
      },
      rooms: [{
        roomId,
        conversationId: roomId,
        cwd: '/first-pair-repo',
        providerName: 'test',
      }],
      trustedDevices: [],
      replayLedgerPath: join(directory, 'replay'),
      applicationSecurity: {
        gatewayDeviceId: 'workspace-first-pair',
        gatewayKeyPair: await exportDeviceKeyPair(gatewayKeys),
        envelopeReplayLedgerPath: join(directory, 'security'),
      },
    }, {
      client,
      listTrustedDevices: async () => trustedDevices,
    })

    await runner.start()
    expect(client.delivered).toHaveLength(0)
    expect(client.state.size).toBe(0)

    trustedDevices.push({
      deviceId: 'phone-1',
      publicKey: firstPhoneKeys.publicJwk,
      allowedRoomIds: [roomId],
      allowedOperations: ['prompt'],
      matrixUserId: '@phone:example.org',
      matrixDeviceId: 'PHONE1',
      matrixDeviceKeys: ['matrix-phone-key-1'],
      certificateExpiresAt: Date.now() + 60_000,
      sequenceEpoch: 'certificate-1',
    })
    await runner.provisionPairingDevice('phone-1', roomId)

    expect(client.delivered).toHaveLength(2)
    expect(client.state.size).toBe(3)

    await runner.provisionPairingDevice('phone-1', roomId)
    expect(client.delivered).toHaveLength(2)
    expect(client.state.size).toBe(3)

    trustedDevices.push({
      deviceId: 'phone-2',
      publicKey: secondPhoneKeys.publicJwk,
      allowedRoomIds: [roomId],
      allowedOperations: ['prompt'],
      matrixUserId: '@phone:example.org',
      matrixDeviceId: 'PHONE2',
      matrixDeviceKeys: ['matrix-phone-key-2'],
      certificateExpiresAt: Date.now() + 60_000,
      sequenceEpoch: 'certificate-2',
    })
    await runner.provisionPairingDevice('phone-2', roomId)

    expect(client.delivered).toHaveLength(2)
    expect(client.state.size).toBe(4)
    await runner.stop()
  })

  it('performs zero Matrix writes on an unchanged Gateway restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'malink-v3-stable-restart-'))
    const gatewayKeys = await generateDeviceKeyPair()
    const phoneKeys = await generateDeviceKeyPair()
    const client = new TestMatrixClient()
    const roomId = '!stable-project:example.org'
    const config: MatrixGatewayConfig = {
      gatewayId: 'workspace-stable',
      gatewayNodeId: 'gateway-node-stable',
      connection: {
        baseUrl: 'https://matrix.example.org',
        accessToken: 'gateway-token',
        userId: '@gateway:example.org',
        deviceId: 'GATEWAY',
      },
      crypto: {
        backend: 'memory',
        databasePrefix: 'stable-restart-test',
        allowInMemoryForTesting: true,
      },
      rooms: [{
        roomId,
        conversationId: roomId,
        cwd: '/stable-repo',
        providerName: 'test',
      }],
      trustedDevices: [{
        deviceId: 'phone-1',
        publicKey: phoneKeys.publicJwk,
        allowedRoomIds: [roomId],
        allowedOperations: ['prompt'],
        matrixUserId: '@phone:example.org',
        matrixDeviceId: 'PHONE',
        matrixDeviceKeys: ['matrix-phone-key'],
        certificateExpiresAt: Date.now() + 60_000,
        sequenceEpoch: 'certificate-1',
      }],
      replayLedgerPath: join(directory, 'replay'),
      applicationSecurity: {
        gatewayDeviceId: 'workspace-stable',
        gatewayKeyPair: await exportDeviceKeyPair(gatewayKeys),
        envelopeReplayLedgerPath: join(directory, 'security'),
      },
    }
    let stateWrites = 0
    const setState = client.setApplicationRoomState.bind(client)
    client.setApplicationRoomState = async request => {
      stateWrites += 1
      return setState(request)
    }

    const first = new MatrixMlp3GatewayRunner(config, { client })
    await first.start()
    await waitFor(() => Promise.resolve(client.delivered.length === 2 && stateWrites === 3))
    await first.stop()
    const firstTimelineWrites = client.delivered.length
    const firstStateWrites = stateWrites
    expect(firstTimelineWrites).toBe(2)
    expect(firstStateWrites).toBe(3)

    const restarted = new MatrixMlp3GatewayRunner(config, { client })
    await restarted.start()
    expect(client.delivered).toHaveLength(firstTimelineWrites)
    expect(stateWrites).toBe(firstStateWrites)
    await restarted.stop()
  })

  it('settles and releases a session creation whose filesystem preflight never returns', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'malink-v3-command-timeout-'))
    const gatewayKeys = await generateDeviceKeyPair()
    const phoneKeys = await generateDeviceKeyPair()
    const client = new TestMatrixClient()
    const roomId = '!timeout-project:example.org'
    const projectId = gatewayProjectIdentity('/timeout-repo').id
    const accessGate = deferred<void>()
    const config: MatrixGatewayConfig = {
      gatewayId: 'workspace-timeout',
      gatewayNodeId: 'gateway-node-timeout',
      connection: {
        baseUrl: 'https://matrix.example.org',
        accessToken: 'gateway-token',
        userId: '@gateway:example.org',
        deviceId: 'GATEWAY',
      },
      crypto: {
        backend: 'memory',
        databasePrefix: 'command-timeout-test',
        allowInMemoryForTesting: true,
      },
      rooms: [{
        roomId,
        conversationId: roomId,
        cwd: '/timeout-repo',
        providerName: 'test',
      }],
      trustedDevices: [{
        deviceId: 'phone-1',
        publicKey: phoneKeys.publicJwk,
        allowedRoomIds: [roomId],
        allowedOperations: ['session.create'],
        matrixUserId: '@phone:example.org',
        matrixDeviceId: 'PHONE',
        matrixDeviceKeys: ['matrix-phone-key'],
        certificateExpiresAt: Date.now() + 60_000,
        sequenceEpoch: 'certificate-timeout',
      }],
      replayLedgerPath: join(directory, 'replay'),
      commandExecutionTimeoutMs: 1_000,
      applicationSecurity: {
        gatewayDeviceId: 'workspace-timeout',
        gatewayKeyPair: await exportDeviceKeyPair(gatewayKeys),
        envelopeReplayLedgerPath: join(directory, 'security'),
      },
    }
    const runner = new MatrixMlp3GatewayRunner(config, {
      client,
      assertDirectoryAccess: async () => accessGate.promise,
      sessionFactory: () => { throw new Error('timed-out creation must not build a runtime') },
    })
    await runner.start()
    const grantState = [...client.state.values()].find(state =>
      state.eventType === MLP3_MATRIX_PROJECT_KEY_GRANT_EVENT_TYPE
      && state.content.deviceId === 'phone-1'
    )
    const grant = mlp3ProjectKeyGrantStateSchema.parse(grantState?.content)
    const keyGrant = await openMlp3ProjectKeyGrant(grant.sealedGrant, {
      expected: {
        grantId: grant.grantId,
        workspaceId: grant.workspaceId,
        projectId: grant.projectId,
        roomId: grant.roomId,
        deviceId: grant.deviceId,
        certificateId: grant.certificateId,
        senderKeyId: grant.sealedGrant.envelope.senderKeyId,
        recipientKeyId: grant.sealedGrant.envelope.recipientKeyId,
      },
      recipientPrivateKey: phoneKeys.privateKey,
      senderPublicKey: gatewayKeys.publicKey,
    })
    const activeKey = keyGrant.keys.find(key => key.keyId === keyGrant.activeKeyId)!
    const command: Mlp3Command = {
      kind: 'malink.command',
      version: 3,
      commandId: 'create-timeout',
      workspaceId: 'workspace-timeout',
      projectId,
      sessionId: 'session-timeout',
      deviceId: 'phone-1',
      certificateId: 'certificate-timeout',
      createdAt: Date.now(),
      operation: 'session.create',
      payload: { operation: 'session.create', title: 'Must not get stuck' },
    }
    const signed = await signMlp3Command(command, phoneKeys.privateKey, phoneKeys.keyId)
    const envelope = await sealMlp3Envelope({
      plaintext: { kind: 'signed_command', value: signed },
      projectKey: base64UrlDecode(activeKey.key),
      roomId,
      projectId,
      keyId: activeKey.keyId,
      logicalEventId: command.commandId,
    })
    client.emit({
      roomId,
      eventId: '$create-timeout',
      eventType: 'm.room.message',
      sender: '@phone:example.org',
      encrypted: false,
      content: {
        msgtype: 'm.notice',
        body: 'Encrypted Malink command',
        [MALINK_MATRIX_EXTENSION]: { version: 3, envelope },
      },
    })

    await waitFor(async () => (await events(client, activeKey.key, roomId, projectId))
      .some(event => event.causationCommandId === command.commandId), 2_500)
    expect((await events(client, activeKey.key, roomId, projectId)).find(event =>
      event.causationCommandId === command.commandId
    )?.payload).toMatchObject({
      type: 'command.rejected',
      code: 'gateway_execution_timeout',
      retryable: true,
    })
    expect(await runner.healthSnapshot()).toMatchObject({
      activeCommands: 0,
      unfinishedCommands: 0,
      expiredCommandExecutions: 1,
    })

    accessGate.resolve()
    await waitFor(async () => (await runner.healthSnapshot()).expiredCommandExecutions === 0)
    expect((await events(client, activeKey.key, roomId, projectId)).some(event =>
      event.causationCommandId === command.commandId
      && event.payload.type === 'session.ready'
    )).toBe(false)
    await runner.stop()
  }, 5_000)

  it('republishes every project after a background model catalog refresh', async () => {
    clearProviderRegistryForTesting()
    const directory = await mkdtemp(join(tmpdir(), 'malink-v3-model-refresh-'))
    const gatewayKeys = await generateDeviceKeyPair()
    const phoneKeys = await generateDeviceKeyPair()
    const client = new TestMatrixClient()
    const firstRoomId = '!model-refresh-first:example.org'
    const secondRoomId = '!model-refresh-second:example.org'
    let models: Array<{ id: string; name: string }> = []
    let refreshQueued = false
    const listeners = new Set<() => void>()
    registerProvider({
      name: 'background-models',
      startQuery() { throw new Error('The catalog provider must not execute a query') },
      isReady: () => true,
      getInitError: () => null,
      getAvailableModels() {
        if (!refreshQueued) {
          refreshQueued = true
          queueMicrotask(() => {
            models = [{ id: 'model-ready', name: 'Ready model' }]
            for (const listener of [...listeners]) listener()
          })
        }
        return models.map(model => ({ ...model }))
      },
      onAvailableModelsRefreshed(listener) {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
      getAvailablePermissionModes: () => ['default'],
    })
    const config: MatrixGatewayConfig = {
      gatewayId: 'workspace-model-refresh',
      gatewayNodeId: 'gateway-node-model-refresh',
      connection: {
        baseUrl: 'https://matrix.example.org',
        accessToken: 'gateway-token',
        userId: '@gateway:example.org',
        deviceId: 'GATEWAY',
      },
      crypto: {
        backend: 'memory',
        databasePrefix: 'model-refresh-test',
        allowInMemoryForTesting: true,
      },
      rooms: [{
        roomId: firstRoomId,
        conversationId: firstRoomId,
        projectName: 'First project',
        cwd: '/first-project',
        providerName: 'background-models',
      }, {
        roomId: secondRoomId,
        conversationId: secondRoomId,
        projectName: 'Second project',
        cwd: '/second-project',
        providerName: 'background-models',
      }],
      trustedDevices: [{
        deviceId: 'phone-1',
        publicKey: phoneKeys.publicJwk,
        allowedRoomIds: [firstRoomId, secondRoomId],
        allowedOperations: ['prompt'],
        matrixUserId: '@phone:example.org',
        matrixDeviceId: 'PHONE',
        matrixDeviceKeys: ['matrix-phone-key'],
        certificateExpiresAt: Date.now() + 60_000,
        sequenceEpoch: 'certificate-1',
      }],
      replayLedgerPath: join(directory, 'replay'),
      applicationSecurity: {
        gatewayDeviceId: 'workspace-model-refresh',
        gatewayKeyPair: await exportDeviceKeyPair(gatewayKeys),
        envelopeReplayLedgerPath: join(directory, 'security'),
      },
    }
    const runner = new MatrixMlp3GatewayRunner(config, { client })
    try {
      await runner.start()
      let projects: Array<{
        name: string
        capabilitySnapshotVersion: number
        capabilities: { models: Array<{ id: string }> }
      }> = []
      await waitFor(async () => {
        const state = JSON.parse(await readFile(
          `${config.replayLedgerPath}.v3-runtime-state.json`,
          'utf8',
        )) as { projects: Record<string, typeof projects[number]> }
        projects = Object.values(state.projects)
        return projects.length === 2
          && projects.every(project => project.capabilities.models[0]?.id === 'model-ready')
      })
      expect(projects.map(project => ({
        name: project.name,
        capabilitySnapshotVersion: project.capabilitySnapshotVersion,
      }))).toEqual([
        { name: 'First project', capabilitySnapshotVersion: 2 },
        { name: 'Second project', capabilitySnapshotVersion: 1 },
      ])
    } finally {
      await runner.stop()
      clearProviderRegistryForTesting()
    }
  })

  it('runs session threads independently and deduplicates by logical command identity', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'malink-v3-gateway-'))
    const gatewayKeys = await generateDeviceKeyPair()
    const phoneKeys = await generateDeviceKeyPair()
    const limitedKeys = await generateDeviceKeyPair()
    const client = new TestMatrixClient()
    const roomId = '!project:example.org'
    const projectId = gatewayProjectIdentity('/repo').id
    const config: MatrixGatewayConfig = {
      gatewayId: 'workspace-1',
      gatewayNodeId: 'gateway-node-1',
      connection: {
        baseUrl: 'https://matrix.example.org',
        accessToken: 'gateway-token',
        userId: '@gateway:example.org',
        deviceId: 'GATEWAY',
      },
      crypto: {
        backend: 'memory',
        databasePrefix: 'test',
        allowInMemoryForTesting: true,
      },
      rooms: [
        {
          roomId: '!unpaired-project:example.org',
          conversationId: 'unpaired-v3',
          cwd: '/unpaired-repo',
          providerName: 'test',
        },
        {
          roomId,
          conversationId: 'unused-v3',
          cwd: '/repo',
          providerName: 'test',
          timeoutSeconds: 1,
        },
      ],
      trustedDevices: [{
        deviceId: 'phone-1',
        publicKey: phoneKeys.publicJwk,
        allowedRoomIds: [roomId],
        allowedOperations: [
          'prompt',
          'cancel',
          'decision',
          'session.settings',
          'session.create',
          'session.archive',
          'session.restore',
          'session.delete',
          'project.settings',
          'provider.sessions.list',
          'provider.session.inspect',
          'device.invite',
          'gateway.update',
        ],
        matrixUserId: '@phone:example.org',
        matrixDeviceId: 'PHONE',
        matrixDeviceKeys: ['matrix-phone-key'],
        certificateExpiresAt: Date.now() + 60_000,
        sequenceEpoch: 'certificate-1',
      }, {
        deviceId: 'limited-device',
        publicKey: limitedKeys.publicJwk,
        allowedRoomIds: [roomId],
        allowedOperations: ['prompt'],
        matrixUserId: '@limited:example.org',
        matrixDeviceId: 'LIMITED',
        matrixDeviceKeys: ['matrix-limited-key'],
        certificateExpiresAt: Date.now() + 60_000,
        sequenceEpoch: 'limited-certificate',
      }],
      replayLedgerPath: join(directory, 'replay'),
      applicationSecurity: {
        gatewayDeviceId: 'workspace-1',
        gatewayKeyPair: await exportDeviceKeyPair(gatewayKeys),
        envelopeReplayLedgerPath: join(directory, 'security'),
      },
    }
    const blocked = deferred<void>()
    const initialPromptBlocked = deferred<void>()
    const updateDrainBlocked = deferred<void>()
    const activeCancelBlocked = deferred<void>()
    let activeCancelRequested = false
    const dispatched: Array<{ sessionId: string; text: string }> = []
    const decisionResults: string[] = []
    const generatedImagePath = join(directory, 'generated-image.png')
    await writeFile(generatedImagePath, 'generated image bytes', 'utf8')
    const sessionExtensions = new Map<string, readonly { id: string }[]>()
    const sessionCwds = new Map<string, string>()
    const rejected: unknown[] = []
    const notificationSubscriptions: string[] = []
    const terminalNotifications: Mlp3Event[] = []
    const createdProjectRequests: string[] = []
    const updatedProjectNames: string[] = []
    const validatedProjectDeletions: string[] = []
    const deletedProjects: string[] = []
    const gatewayProfileUpdates: string[] = []
    const filesystemAccessChecks: Array<{
      cwd: string
      operation: 'session.create' | 'prompt.submit' | 'provider.history'
    }> = []
    let blockFilesystemAccess = false
    let projectCreatedHooks = 0
    const gatewayUpdateCalls: string[] = []
    let gatewayAgentStaged = false
    let gatewayAgentShouldSubmit = true
    let gatewayAgentRunningReleaseId: string | null = null
    let gatewayAgentFailedReleaseId: string | null = null
    const webPushService: GatewayWebPushService = {
      initialize: async () => undefined,
      publicKey: () => 'B'.repeat(87),
      async upsertSubscription(deviceId, subscription) {
        notificationSubscriptions.push(`${deviceId}:${subscription.endpoint}`)
      },
      removeSubscription: async () => undefined,
      async notifyTerminal(event) {
        if (event.payload.type === 'turn.completed' || event.payload.type === 'turn.failed') {
          terminalNotifications.push(event)
        }
      },
      flush: async () => undefined,
      stop: () => undefined,
    }
    registerProvider({
      name: 'test',
      startQuery() { throw new Error('The catalog provider must not execute a query') },
      isReady: () => true,
      getInitError: () => null,
      getAvailableModels: () => [{
        id: 'model-selectable',
        name: 'Selectable model',
        defaultReasoningLevel: 'high',
        supportedReasoningLevels: [{ effort: 'high' }],
      }],
      getAvailablePermissionModes: () => ['default'],
      listSessions: async () => [{
        sessionId: 'provider-session-1',
        title: 'Provider-owned work',
        updated: 42,
        cwd: '/repo',
      }],
      getSessionHistory: async sessionId => ({
        sessionId,
        title: 'Provider-owned work',
        messages: [
          { id: 'provider-message-1', role: 'user', text: 'Earlier prompt' },
          { id: 'provider-message-2', role: 'assistant', text: 'Earlier answer' },
        ],
      }),
    })
    const extensionDescriptor: SessionExtensionDescriptor = {
      id: 'prefix-transform',
      name: 'Prefix transform',
      description: 'Adds a test prefix before provider input.',
      version: '1',
      settings: [{ id: 'prefix', type: 'text', label: 'Prefix', required: true }],
    }
    const extensionProvider: SessionExtensionProvider = {
      descriptor: extensionDescriptor,
      normalizeConfig: config => normalizeDeclarativeExtensionConfig(extensionDescriptor, config),
      create: binding => ({
        id: binding.id,
        summary: { id: binding.id, name: extensionDescriptor.name, version: '1' },
        prepareTurn: async input => ({ kind: 'ready', input }),
        presentEvent: async event => [event],
        lifecycle: async () => undefined,
      }),
    }
    const runner = new MatrixMlp3GatewayRunner(config, {
      client,
      onRejected: (_event, error) => rejected.push(error),
      webPushService,
      assertDirectoryAccess: async input => {
        filesystemAccessChecks.push(input)
        if (blockFilesystemAccess) {
          throw Object.assign(new Error(
            'Grant Full Disk Access to Malink Gateway Host, then retry.',
          ), {
            commandCode: 'local_permission_required',
            retryable: true,
          })
        }
      },
      createProject: async input => {
        createdProjectRequests.push(`${input.name}:${input.cwd}`)
        return {
          gatewayNodeId: 'gateway-node-1',
          alreadyExisted: false,
          room: {
            roomId: '!created-project:example.org',
            conversationId: 'created-project',
            projectId: 'project-created',
            projectName: input.name,
            cwd: input.cwd,
            providerName: input.provider ?? input.sourceRoom.providerName,
          },
        }
      },
      onProjectCreated: async () => { projectCreatedHooks += 1 },
      updateProjectMetadata: async input => {
        updatedProjectNames.push(input.name)
        return { ...input.sourceRoom, projectName: input.name }
      },
      deleteProject: async input => { deletedProjects.push(input.projectId) },
      updateGatewayProfile: async input => {
        gatewayProfileUpdates.push(`${input.gatewayNodeId}:${input.gatewayName}`)
        return {
          gatewayNodeId: input.gatewayNodeId,
          gatewayName: input.gatewayName,
          computerName: 'alice-macbook',
        }
      },
      sessionExtensionRegistry: new SessionExtensionRegistry([extensionProvider]),
      sessionFactory: (room, port, session) => {
        sessionExtensions.set(session.id, session.extensions)
        sessionCwds.set(session.id, room.cwd)
        const sessionRecord = createTopicSessionRecord({
          id: session.id,
          cwd: room.cwd,
          providerName: session.provider,
          groupChatId: -1,
        })
        let dead = false
        return {
          receiveInput: () => undefined,
          async dispatch(input) {
            if (input.kind === 'user_message') {
              await input.onExecutionStarted?.()
              dispatched.push({ sessionId: session.id, text: input.text })
              if (input.text === 'block A') await blocked.promise
              if (input.text === 'block initial prompt') await initialPromptBlocked.promise
              if (input.text === 'finish before update') await updateDrainBlocked.promise
              if (input.text === 'cancel active') {
                await activeCancelBlocked.promise
                return { status: activeCancelRequested ? 'cancelled' : 'succeeded' }
              }
              if (input.text === 'needs permission') {
                const response = await port.requestDecision({
                  type: 'permission',
                  title: 'Allow Bash?',
                  details: 'git status',
                  options: [
                    { label: 'Allow', value: 'allow' },
                    { label: 'Deny', value: 'deny' },
                  ],
                })
                decisionResults.push(response.value)
              }
              if (input.text.includes('SIGNED RELEASE PROMPT') && gatewayAgentShouldSubmit) {
                gatewayAgentStaged = true
              }
              await port.send({
                text: `reply:${input.text}`,
                format: 'markdown',
                replyMarkup: {
                  idempotencyKey: input.text.includes('SIGNED RELEASE PROMPT')
                    ? `reply-${session.id}-${createHash('sha256').update(input.text).digest('hex')}`
                    : `reply-${session.id}-${input.text}`,
                },
              })
            }
            if (input.kind === 'cancel') {
              activeCancelRequested = true
              activeCancelBlocked.resolve()
            }
            if (input.kind === 'command' && input.name === 'send_file') {
              const request = JSON.parse(input.args ?? '{}') as {
                path: string
                filename?: string
                caption?: string
                type?: string
              }
              await port.send({
                text: request.caption ?? request.filename ?? 'attachment',
                format: 'plain',
                attachments: [{
                  type: request.type === 'image' ? 'photo' : 'document',
                  path: request.path,
                  filename: request.filename,
                }],
              })
              return {
                status: 'sent' as const,
                path: request.path,
                filename: request.filename,
                type: request.type,
              }
            }
          },
          async destroy() { dead = true },
          get state() { return dead ? 'dead' : 'idle' },
          sessionRecord,
          channelPort: port,
          getProgress: () => null,
          getDeliveryStatus: () => ({ deliveries: [] }),
          retryDelivery: async () => ({ status: 'not_found' as const }),
        } satisfies TopicSession
      },
      gatewayUpdateSupervisor: {
        async status() {
          gatewayUpdateCalls.push('status')
          if (gatewayAgentStaged) {
            return {
              version: 1,
              phase: 'staged',
              releaseId: 'release-2',
              targetBuildId: 'build-2',
              currentBuildId: 'build-1',
              maintenanceSessionId: 'maintenance-release-2',
              updatedAt: 13,
            }
          }
          if (gatewayAgentRunningReleaseId) {
            return {
              version: 1,
              phase: 'agent_running',
              releaseId: gatewayAgentRunningReleaseId,
              targetBuildId: 'build-2',
              currentBuildId: 'build-1',
              maintenanceSessionId: gatewayMaintenanceSessionId(
                'gateway-node-1',
                gatewayAgentRunningReleaseId,
              ),
              updatedAt: 12,
            }
          }
          if (gatewayAgentFailedReleaseId) {
            return {
              version: 1,
              phase: 'failed',
              releaseId: gatewayAgentFailedReleaseId,
              targetBuildId: 'build-2',
              currentBuildId: 'build-1',
              maintenanceSessionId: gatewayMaintenanceSessionId(
                'gateway-node-1',
                gatewayAgentFailedReleaseId,
              ),
              updatedAt: 13,
            }
          }
          return {
            version: 1,
            phase: 'idle',
            currentBuildId: 'build-1',
            updatedAt: 10,
          }
        },
        async stage(releaseId) {
          gatewayUpdateCalls.push(`stage:${releaseId}`)
          gatewayAgentFailedReleaseId = null
          return {
            version: 1,
            phase: 'agent_required',
            releaseId,
            targetBuildId: 'build-2',
            currentBuildId: 'build-1',
            updatedAt: 11,
          }
        },
        async agentInstruction(releaseId) {
          gatewayUpdateCalls.push(`instruction:${releaseId}`)
          return {
            releaseId,
            buildId: 'build-2',
            versionName: '2.0.0',
            repository: {
              url: 'https://github.com/Escapingbug/malink.git',
              commit: '0123456789abcdef0123456789abcdef01234567',
            },
            prompt: 'Build and test this exact signed commit.',
            workspaceDirectory: '/updates/release-2',
            sourceDirectory: '/updates/release-2/source',
            candidateDirectory: '/updates/release-2/candidate',
            submitCommand: '/current/runtime/node gatewayAgentUpdateCli.js finish',
          }
        },
        async beginAgentUpdate(releaseId, maintenanceSessionId, ownerCommandId) {
          gatewayUpdateCalls.push(`begin:${releaseId}:${maintenanceSessionId}`)
          gatewayAgentRunningReleaseId = releaseId
          return {
            started: true,
            status: {
              version: 1,
              phase: 'agent_running',
              releaseId,
              targetBuildId: 'build-2',
              currentBuildId: 'build-1',
              maintenanceSessionId,
              detail: ownerCommandId,
              updatedAt: 12,
            },
          }
        },
        async failAgentUpdate(releaseId, _ownerCommandId, detail) {
          gatewayUpdateCalls.push(`fail:${releaseId}:${detail}`)
          gatewayAgentRunningReleaseId = null
          gatewayAgentFailedReleaseId = releaseId
          return {
            version: 1,
            phase: 'failed',
            releaseId,
            detail,
            updatedAt: 13,
          }
        },
        async scheduleApply(releaseId) {
          gatewayUpdateCalls.push(`apply:${releaseId}`)
          return {
            version: 1,
            phase: 'scheduled',
            releaseId,
            targetBuildId: 'build-2',
            currentBuildId: 'build-1',
            updatedAt: 12,
          }
        },
      },
    })
    await runner.start()

    const grantState = [...client.state.values()].find(state =>
      state.eventType === MLP3_MATRIX_PROJECT_KEY_GRANT_EVENT_TYPE
      && state.content.deviceId === 'phone-1'
    )
    const grant = mlp3ProjectKeyGrantStateSchema.parse(grantState?.content)
    const keyGrant = await openMlp3ProjectKeyGrant(grant.sealedGrant, {
      expected: {
        grantId: grant.grantId,
        workspaceId: grant.workspaceId,
        projectId: grant.projectId,
        roomId: grant.roomId,
        deviceId: grant.deviceId,
        certificateId: grant.certificateId,
        senderKeyId: grant.sealedGrant.envelope.senderKeyId,
        recipientKeyId: grant.sealedGrant.envelope.recipientKeyId,
      },
      recipientPrivateKey: phoneKeys.privateKey,
      senderPublicKey: gatewayKeys.publicKey,
    })
    const activeKey = keyGrant.keys.find(key => key.keyId === keyGrant.activeKeyId)!
    await waitFor(async () => (await events(client, activeKey.key, roomId, projectId))
      .some(event => event.payload.type === 'workspace.snapshot'))
    const startupEvents = await events(client, activeKey.key, roomId, projectId)
    expect(startupEvents).toContainEqual(expect.objectContaining({
      payload: expect.objectContaining({
        type: 'workspace.snapshot',
        capabilities: expect.objectContaining({
          models: [expect.objectContaining({ id: 'model-selectable' })],
          web_push: { vapid_public_key: 'B'.repeat(87) },
        }),
      }),
    }))
    await waitFor(() => Promise.resolve([...client.state.values()].some(state =>
      state.eventType === MLP3_MATRIX_WORKSPACE_POINTER_EVENT_TYPE
    )))
    const workspacePointerState = [...client.state.values()].find(state =>
      state.eventType === MLP3_MATRIX_WORKSPACE_POINTER_EVENT_TYPE
    )
    expect(mlp3CurrentPointerSchema.parse(workspacePointerState?.content).document)
      .toMatchObject({
        kind: 'workspace.current',
        workspaceId: 'workspace-1',
        projectId,
        roomId,
    })
    await waitFor(async () => (await events(client, activeKey.key, roomId, projectId))
      .some(event => event.payload.type === 'gateway.update.status'
        && event.causationCommandId === undefined))
    expect((await events(client, activeKey.key, roomId, projectId)).find(event =>
      event.payload.type === 'gateway.update.status'
        && event.causationCommandId === undefined
    )?.payload).toMatchObject({
      status: { currentBuildId: 'build-1' },
    })

    await expect(runner.publishNativeClientRelease(nativeRelease(42))).resolves.toMatchObject({
      changed: true,
      projectCount: 1,
      release: { versionCode: 42 },
    })
    const publishedWorkspace = (await events(client, activeKey.key, roomId, projectId))
      .filter(event => event.payload.type === 'workspace.snapshot')
      .at(-1)
    expect(publishedWorkspace?.payload).toMatchObject({
      type: 'workspace.snapshot',
      clientReleases: [{
        platform: 'android',
        channel: 'alpha',
        versionCode: 42,
      }],
    })

    const inboxPath = join(directory, 'workspace-report.txt')
    await writeFile(inboxPath, 'workspace report', 'utf8')
    await expect(runner.receiveWorkspaceFile({
      requestId: 'workspace-file-request-1',
      path: inboxPath,
      caption: 'Generated report',
      sourceLabel: 'review-agent',
    })).resolves.toMatchObject({ delivery: 'queued' })
    await waitFor(async () => (await events(client, activeKey.key, roomId, projectId))
      .some(event => event.payload.type === 'inbox.file.received'))
    expect(client.delivered.some(delivery =>
      delivery.roomId === '!unpaired-project:example.org'
      && delivery.content[MALINK_MATRIX_EXTENSION]
    )).toBe(false)
    const inboxEvent = (await events(client, activeKey.key, roomId, projectId))
      .find(event => event.payload.type === 'inbox.file.received')
    expect(inboxEvent?.sessionId).toBeUndefined()
    expect(inboxEvent?.payload).toMatchObject({
      type: 'inbox.file.received',
      fileId: 'workspace-file-request-1',
    })

    const send = async (
      command: Mlp3Command,
      matrixEventId: string,
      relation?: Record<string, unknown>,
      sender = '@phone:example.org',
      signingKeys = phoneKeys,
    ) => {
      const signed = await signMlp3Command(command, signingKeys.privateKey, signingKeys.keyId)
      const envelope = await sealMlp3Envelope({
        plaintext: { kind: 'signed_command', value: signed },
        projectKey: base64UrlDecode(activeKey.key),
        roomId,
        projectId,
        keyId: activeKey.keyId,
        logicalEventId: command.commandId,
      })
      client.emit({
        roomId,
        eventId: matrixEventId,
        eventType: 'm.room.message',
        sender,
        encrypted: false,
        content: {
          msgtype: 'm.notice',
          body: 'Encrypted Malink command',
          ...(relation ? { 'm.relates_to': relation } : {}),
          [MALINK_MATRIX_EXTENSION]: { version: 3, envelope },
        },
      })
    }
    const base = {
      kind: 'malink.command' as const,
      version: 3 as const,
      workspaceId: 'workspace-1',
      projectId,
      deviceId: 'phone-1',
      certificateId: 'certificate-1',
      createdAt: 1,
    }
    await send({
      ...base,
      commandId: 'project-create-1',
      operation: 'project.create',
      payload: {
        operation: 'project.create',
        name: 'Created remotely',
        cwd: '/srv/created-remotely',
        provider: 'test',
        createDirectory: true,
      },
    }, '$project-create-1')
    await waitFor(async () => (await events(client, activeKey.key, roomId, projectId))
      .some(event => event.causationCommandId === 'project-create-1'))
    expect(createdProjectRequests).toEqual(['Created remotely:/srv/created-remotely'])
    const projectCreatedEvent = (await events(client, activeKey.key, roomId, projectId)).find(event =>
      event.causationCommandId === 'project-create-1'
    )
    if (projectCreatedEvent?.payload.type !== 'project.created') {
      throw new Error(JSON.stringify(projectCreatedEvent?.payload))
    }
    expect(projectCreatedEvent?.payload).toMatchObject({
      type: 'project.created',
      gatewayNodeId: 'gateway-node-1',
      projectId: 'project-created',
      roomId: '!created-project:example.org',
    })
    expect(projectCreatedHooks).toBe(1)

    await send({
      ...base,
      commandId: 'gateway-profile-update-1',
      operation: 'gateway.profile.update',
      payload: {
        operation: 'gateway.profile.update',
        gatewayNodeId: 'gateway-node-1',
        gatewayName: 'Office Mac',
      },
    }, '$gateway-profile-update-1')
    await waitFor(async () => (await events(client, activeKey.key, roomId, projectId))
      .some(event => event.causationCommandId === 'gateway-profile-update-1'))
    expect(gatewayProfileUpdates).toEqual(['gateway-node-1:Office Mac'])
    expect((await events(client, activeKey.key, roomId, projectId)).find(event =>
      event.causationCommandId === 'gateway-profile-update-1'
    )?.payload).toMatchObject({
      type: 'gateway.profile.updated',
      gatewayNodeId: 'gateway-node-1',
      gatewayName: 'Office Mac',
      computerName: 'alice-macbook',
    })

    await send({
      kind: 'malink.command',
      version: 3,
      commandId: 'limited-project-create-1',
      workspaceId: 'workspace-1',
      projectId,
      deviceId: 'limited-device',
      certificateId: 'limited-certificate',
      createdAt: 1,
      operation: 'project.create',
      payload: {
        operation: 'project.create',
        name: 'Denied project',
        cwd: '/srv/denied-project',
      },
    }, '$limited-project-create-1', undefined, '@limited:example.org', limitedKeys)
    await waitFor(async () => (await events(client, activeKey.key, roomId, projectId))
      .some(event => event.causationCommandId === 'limited-project-create-1'))
    expect((await events(client, activeKey.key, roomId, projectId)).find(event =>
      event.causationCommandId === 'limited-project-create-1'
    )?.payload).toMatchObject({
      type: 'command.rejected',
      commandId: 'limited-project-create-1',
      code: 'operation_not_allowed',
      retryable: false,
    })
    expect(createdProjectRequests).toEqual(['Created remotely:/srv/created-remotely'])

    await send({
      ...base,
      commandId: 'gateway-update-stage-1',
      operation: 'gateway.update.stage',
      payload: { operation: 'gateway.update.stage', releaseId: 'release-2' },
    }, '$gateway-update-stage-1')
    await waitFor(async () => (await events(client, activeKey.key, roomId, projectId))
      .some(event =>
        event.causationCommandId === 'gateway-update-stage-1'
        && (
          event.payload.type === 'gateway.update.status'
          || event.payload.type === 'command.rejected'
        )
      ))
    const gatewayStageTerminal = (await events(client, activeKey.key, roomId, projectId))
      .find(event =>
        event.causationCommandId === 'gateway-update-stage-1'
        && (
          event.payload.type === 'gateway.update.status'
          || event.payload.type === 'command.rejected'
        )
      )
    if (gatewayStageTerminal?.payload.type === 'command.rejected') {
      throw new Error(JSON.stringify(gatewayStageTerminal.payload))
    }
    expect((await events(client, activeKey.key, roomId, projectId)).find(event =>
      event.causationCommandId === 'gateway-update-stage-1'
      && event.payload.type === 'gateway.update.status'
    )?.payload).toMatchObject({
      status: { phase: 'staged', releaseId: 'release-2' },
    })
    const gatewayStageEvents = await events(client, activeKey.key, roomId, projectId)
    expect(gatewayStageEvents.some(event =>
      event.causationCommandId === 'gateway-update-stage-1'
      && event.payload.type === 'turn.completed'
    )).toBe(false)
    expect(gatewayStageEvents.some(event =>
      event.causationCommandId?.startsWith('gateway-update-turn-')
      && event.payload.type === 'turn.completed'
      && event.sessionId?.startsWith('gateway-update-')
    )).toBe(true)
    expect(gatewayUpdateCalls).toContain('stage:release-2')
    expect(gatewayUpdateCalls).toContain('instruction:release-2')
    expect(gatewayUpdateCalls).toContain(
      `begin:release-2:${gatewayMaintenanceSessionId('gateway-node-1', 'release-2')}`,
    )
    expect(dispatched.some(item =>
      item.sessionId.startsWith('gateway-update-')
      && item.text.includes('exact Git commit: 0123456789abcdef0123456789abcdef01234567')
    )).toBe(true)
    gatewayAgentStaged = false
    gatewayAgentShouldSubmit = false
    await send({
      ...base,
      commandId: 'gateway-update-stage-no-submit',
      operation: 'gateway.update.stage',
      payload: { operation: 'gateway.update.stage', releaseId: 'release-no-submit' },
    }, '$gateway-update-stage-no-submit')
    await waitFor(async () => (await events(client, activeKey.key, roomId, projectId))
      .some(event =>
        event.causationCommandId === 'gateway-update-stage-no-submit'
        && event.payload.type === 'command.rejected'
      ))
    expect(gatewayUpdateCalls.some(call =>
      call.startsWith('fail:release-no-submit:The maintenance Agent finished without submitting')
    )).toBe(true)
    const failedMaintenanceSessionId = gatewayMaintenanceSessionId(
      'gateway-node-1',
      'release-no-submit',
    )
    await send({
      ...base,
      commandId: 'archive-failed-gateway-update',
      sessionId: failedMaintenanceSessionId,
      operation: 'session.set_lifecycle',
      payload: { operation: 'session.set_lifecycle', state: 'archived' },
    }, '$archive-failed-gateway-update')
    await waitFor(async () => (await events(client, activeKey.key, roomId, projectId))
      .some(event =>
        event.causationCommandId === 'archive-failed-gateway-update'
        && event.payload.type === 'session.lifecycle'
      ))
    expect((await events(client, activeKey.key, roomId, projectId)).find(event =>
      event.causationCommandId === 'archive-failed-gateway-update'
      && event.payload.type === 'session.lifecycle'
    )?.payload).toMatchObject({
      type: 'session.lifecycle',
      state: 'archived',
    })
    gatewayAgentStaged = true
    gatewayAgentShouldSubmit = true
    dispatched.splice(0)
    await send({
      ...base,
      commandId: 'provider-list-1',
      operation: 'provider.sessions.list',
      payload: { operation: 'provider.sessions.list', provider: 'test' },
    }, '$provider-list-1')
    await waitFor(async () => (await events(client, activeKey.key, roomId, projectId))
      .some(event => event.causationCommandId === 'provider-list-1'))
    expect((await events(client, activeKey.key, roomId, projectId)).find(event =>
      event.causationCommandId === 'provider-list-1'
      && event.payload.type === 'provider.sessions.listed'
    )?.payload).toMatchObject({
      type: 'provider.sessions.listed',
      sessions: [{ sessionId: 'provider-session-1' }],
    })

    await send({
      ...base,
      commandId: 'provider-inspect-1',
      operation: 'provider.session.inspect',
      payload: {
        operation: 'provider.session.inspect',
        provider: 'test',
        providerSessionId: 'provider-session-1',
      },
    }, '$provider-inspect-1')
    await waitFor(async () => (await events(client, activeKey.key, roomId, projectId))
      .some(event => event.causationCommandId === 'provider-inspect-1'))
    const inspectedHistory = (await events(client, activeKey.key, roomId, projectId)).find(event =>
      event.causationCommandId === 'provider-inspect-1'
      && event.payload.type === 'provider.session.inspected'
    )?.payload
    expect(inspectedHistory).toMatchObject({
      type: 'provider.session.inspected',
    })
    if (inspectedHistory?.type !== 'provider.session.inspected') {
      throw new Error('Provider history inspection did not complete')
    }
    expect(inspectedHistory.messages).toHaveLength(2)
    expect(inspectedHistory.messages[0]).toMatchObject({
      role: 'user',
      text: 'Earlier prompt',
    })

    await send({
      ...base,
      commandId: 'notification-subscribe-1',
      operation: 'notification.subscribe',
      payload: {
        operation: 'notification.subscribe',
        subscription: {
          endpoint: 'https://push.example.test/subscriptions/browser-1',
          keys: { p256dh: 'A'.repeat(88), auth: 'B'.repeat(22) },
        },
      },
    }, '$notification-subscribe-1')
    await waitFor(async () => (await events(client, activeKey.key, roomId, projectId))
      .some(event =>
        event.causationCommandId === 'notification-subscribe-1'
        && event.payload.type === 'notification.subscription.changed'
      ))
    expect(notificationSubscriptions).toEqual([
      'phone-1:https://push.example.test/subscriptions/browser-1',
    ])
    await send({
      ...base,
      commandId: 'project-defaults-1',
      operation: 'project.update',
      payload: {
        operation: 'project.update',
        patch: {
          name: 'Renamed project',
          model: 'model-selectable',
          reasoningEffort: 'high',
          defaultExtensions: [{ id: 'prefix-transform', config: { prefix: 'SAFE:' } }],
        },
      },
    }, '$project-defaults-1')
    await waitFor(async () => (await events(client, activeKey.key, roomId, projectId))
      .some(event => event.causationCommandId === 'project-defaults-1'))
    const projectUpdateEvents = (await events(client, activeKey.key, roomId, projectId))
      .filter(event => event.causationCommandId === 'project-defaults-1')
    expect(projectUpdateEvents).toHaveLength(1)
    expect(projectUpdateEvents[0]?.payload).toMatchObject({
      type: 'project.snapshot',
      name: 'Renamed project',
      model: 'model-selectable',
      reasoningEffort: 'high',
    })
    expect(updatedProjectNames).toEqual(['Renamed project'])
    const createA: Mlp3Command = {
      ...base,
      commandId: 'create-a',
      sessionId: 'session-a',
      operation: 'session.create',
      payload: {
        operation: 'session.create',
        title: 'A',
        providerSessionId: 'provider-session-1',
      },
    }
    await send(createA, '$root-a-forged-sender', undefined, '@intruder:example.org')
    await waitFor(() => Promise.resolve(rejected.length === 1))
    expect(dispatched).toEqual([])
    await send(createA, '$root-a')
    await waitFor(async () => (await events(client, activeKey.key, roomId, projectId))
      .some(event => event.causationCommandId === 'create-a'))
    expect(sessionExtensions.get('session-a')).toEqual([{
      id: 'prefix-transform',
      config: { prefix: 'SAFE:' },
    }])
    await expect(runner.sendSessionFile('session-a', {
      path: generatedImagePath,
      filename: 'generated-image.png',
      caption: 'Generated image',
      type: 'image',
    })).resolves.toMatchObject({ status: 'sent', type: 'image' })
    await waitFor(async () => (await events(client, activeKey.key, roomId, projectId))
      .some(event => event.payload.type === 'assistant.message'
        && event.payload.body === 'Generated image'))
    const generatedImageEvent = (await events(client, activeKey.key, roomId, projectId))
      .find(event => event.payload.type === 'assistant.message'
        && event.payload.body === 'Generated image')
    expect(generatedImageEvent?.payload).toMatchObject({
      type: 'assistant.message',
      body: 'Generated image',
      attachments: [{
        name: 'generated-image.png',
        mimeType: 'image/png',
      }],
    })
    await send({
      ...base,
      commandId: 'provider-list-managed',
      operation: 'provider.sessions.list',
      payload: { operation: 'provider.sessions.list', provider: 'test' },
    }, '$provider-list-managed')
    await waitFor(async () => (await events(client, activeKey.key, roomId, projectId))
      .some(event => event.causationCommandId === 'provider-list-managed'))
    expect((await events(client, activeKey.key, roomId, projectId)).find(event =>
      event.causationCommandId === 'provider-list-managed'
      && event.payload.type === 'provider.sessions.listed'
    )?.payload).toMatchObject({
      sessions: [{
        sessionId: 'provider-session-1',
        managedSessionId: 'session-a',
      }],
    })

    await send({
      ...base,
      commandId: 'create-scratch',
      sessionId: 'session-scratch',
      operation: 'session.create',
      payload: { operation: 'session.create', scope: 'scratch', title: 'Temporary' },
    }, '$root-scratch')
    await waitFor(async () => (await events(client, activeKey.key, roomId, projectId))
      .some(event => event.causationCommandId === 'create-scratch'))
    const scratchCwd = sessionCwds.get('session-scratch')
    expect(scratchCwd).toBeTruthy()
    expect(scratchCwd).not.toBe('/repo')
    await expect(stat(scratchCwd!)).resolves.toMatchObject({})

    await send({
      ...base,
      commandId: 'create-with-long-initial-prompt',
      sessionId: 'session-long-initial-prompt',
      operation: 'session.create',
      payload: {
        operation: 'session.create',
        title: 'Long initial prompt',
        initialPrompt: { text: 'block initial prompt' },
      },
    }, '$root-long-initial-prompt')
    await waitFor(() => Promise.resolve(
      dispatched.some(item => item.text === 'block initial prompt'),
    ))

    const promptA: Mlp3Command = {
      ...base,
      commandId: 'prompt-a',
      sessionId: 'session-a',
      operation: 'prompt.submit',
      payload: { operation: 'prompt.submit', text: 'block A' },
    }
    await send(promptA, '$prompt-a', {
      rel_type: 'm.thread',
      event_id: '$homeserver-rewrote-this-relation',
    })
    await waitFor(() => Promise.resolve(dispatched.some(item => item.text === 'block A')))
    await new Promise(resolveDelay => setTimeout(resolveDelay, 1_100))
    const longRunningEvents = await events(client, activeKey.key, roomId, projectId)
    expect(longRunningEvents.some(event =>
      ['create-with-long-initial-prompt', 'prompt-a'].includes(event.causationCommandId ?? '')
      && event.payload.type === 'turn.failed'
      && event.payload.code === 'gateway_execution_timeout'
    )).toBe(false)
    expect(await runner.healthSnapshot()).toMatchObject({
      activeTurns: 2,
      activeCommands: 2,
      expiredCommandExecutions: 0,
    })
    initialPromptBlocked.resolve()
    await waitFor(async () => (await events(client, activeKey.key, roomId, projectId))
      .some(event =>
        event.causationCommandId === 'create-with-long-initial-prompt'
        && event.payload.type === 'turn.completed'
      ))
    expect(await runner.healthSnapshot()).toMatchObject({
      activeTurns: 1,
      activeCommands: 1,
      expiredCommandExecutions: 0,
    })

    const queuedPrompt: Mlp3Command = {
      ...base,
      commandId: 'prompt-queued-a',
      sessionId: 'session-a',
      operation: 'prompt.submit',
      payload: { operation: 'prompt.submit', text: 'cancel before Agent dispatch' },
    }
    await send(queuedPrompt, '$prompt-queued-a')
    await send({
      ...base,
      commandId: 'cancel-queued-a',
      sessionId: 'session-a',
      operation: 'turn.cancel',
      payload: { operation: 'turn.cancel', turnId: queuedPrompt.commandId },
    }, '$cancel-queued-a')
    await waitFor(async () => {
      const deliveredEvents = await events(client, activeKey.key, roomId, projectId)
      return deliveredEvents.some(event =>
        event.causationCommandId === queuedPrompt.commandId
        && event.payload.type === 'turn.completed'
        && event.payload.outcome === 'cancelled'
      ) && deliveredEvents.some(event =>
        event.causationCommandId === 'cancel-queued-a'
        && event.payload.type === 'turn.completed'
        && event.payload.outcome === 'cancelled'
      )
    })
    expect(dispatched.some(item => item.text === 'cancel before Agent dispatch')).toBe(false)
    expect((await events(client, activeKey.key, roomId, projectId)).find(event =>
      event.causationCommandId === 'cancel-queued-a'
      && event.payload.type === 'turn.completed'
    )?.payload).toMatchObject({
      type: 'turn.completed',
      turnId: queuedPrompt.commandId,
      outcome: 'cancelled',
      projection: { activity: 'working' },
    })

    await send({
      ...base,
      commandId: 'create-b',
      sessionId: 'session-b',
      operation: 'session.create',
      payload: { operation: 'session.create', title: 'B' },
    }, '$root-b')
    await waitFor(async () => (await events(client, activeKey.key, roomId, projectId))
      .some(event => event.causationCommandId === 'create-b'))

    blockFilesystemAccess = true
    await send({
      ...base,
      commandId: 'prompt-blocked-by-macos',
      sessionId: 'session-b',
      operation: 'prompt.submit',
      payload: { operation: 'prompt.submit', text: 'must not reach provider' },
    }, '$prompt-blocked-by-macos')
    await waitFor(async () => (await events(client, activeKey.key, roomId, projectId))
      .some(event =>
        event.causationCommandId === 'prompt-blocked-by-macos'
        && event.payload.type === 'turn.failed'
      ))
    expect((await events(client, activeKey.key, roomId, projectId)).find(event =>
      event.causationCommandId === 'prompt-blocked-by-macos'
      && event.payload.type === 'turn.failed'
    )?.payload).toMatchObject({
      type: 'turn.failed',
      turnId: 'prompt-blocked-by-macos',
      code: 'local_permission_required',
      message: expect.stringContaining('Malink Gateway Host'),
    })
    expect(dispatched.some(item => item.text === 'must not reach provider')).toBe(false)
    blockFilesystemAccess = false
    expect(filesystemAccessChecks).toEqual(expect.arrayContaining([
      expect.objectContaining({ cwd: '/repo', operation: 'provider.history' }),
      expect.objectContaining({ cwd: '/repo', operation: 'session.create' }),
      expect.objectContaining({ cwd: '/repo', operation: 'prompt.submit' }),
    ]))

    // An exact retry arrives as a different physical Matrix event. It remains
    // the same business command and must not run a second provider turn.
    await send(promptA, '$prompt-a-retry')
    await waitFor(async () => (await events(client, activeKey.key, roomId, projectId))
      .some(event =>
        event.causationCommandId === 'prompt-a'
        && event.payload.type === 'command.reconciled'
        && event.payload.state === 'running'
      ))
    await send(promptA, '$prompt-a-retry-same-running-state')
    blocked.resolve()
    await waitFor(async () => (await events(client, activeKey.key, roomId, projectId))
      .some(event =>
        event.causationCommandId === 'prompt-a'
        && event.payload.type === 'turn.completed'
      ))
    await send(promptA, '$prompt-a-terminal-reconciliation')
    await waitFor(async () => (await events(client, activeKey.key, roomId, projectId))
      .some(event =>
        event.causationCommandId === 'prompt-a'
        && event.payload.type === 'command.reconciled'
        && event.payload.state === 'terminal'
      ))
    await send(promptA, '$prompt-a-retry-same-terminal-state')
    expect((await events(client, activeKey.key, roomId, projectId)).find(event =>
      event.causationCommandId === 'prompt-a'
      && event.payload.type === 'command.reconciled'
      && event.payload.state === 'terminal'
    )?.payload).toMatchObject({
      type: 'command.reconciled',
      commandId: 'prompt-a',
      outcome: 'succeeded',
    })
    expect(dispatched.filter(item => item.text === 'block A')).toHaveLength(1)
    expect(terminalNotifications.filter(event =>
      event.causationCommandId === 'prompt-blocked-by-macos'
      && event.payload.type === 'turn.failed'
    )).toHaveLength(1)
    expect(terminalNotifications.filter(event =>
      event.causationCommandId === 'prompt-a'
      && event.payload.type === 'turn.completed'
    )).toHaveLength(1)

    await send({
      ...base,
      commandId: 'prompt-permission-b',
      sessionId: 'session-b',
      operation: 'prompt.submit',
      payload: { operation: 'prompt.submit', text: 'needs permission' },
    }, '$prompt-permission-b')
    await waitFor(async () => (await events(client, activeKey.key, roomId, projectId))
      .some(event =>
        event.causationCommandId === 'prompt-permission-b'
        && event.payload.type === 'decision.requested'
      ))
    const permissionRequest = (await events(client, activeKey.key, roomId, projectId)).find(event =>
      event.causationCommandId === 'prompt-permission-b'
      && event.payload.type === 'decision.requested'
    )
    if (permissionRequest?.payload.type !== 'decision.requested') {
      throw new Error('The permission request was not delivered')
    }
    await send({
      ...base,
      commandId: 'decision-allow-b',
      sessionId: 'session-b',
      operation: 'decision.answer',
      payload: {
        operation: 'decision.answer',
        requestId: permissionRequest.payload.requestId,
        decision: 'allow',
      },
    }, '$decision-allow-b')
    await waitFor(async () => (await events(client, activeKey.key, roomId, projectId))
      .some(event =>
        event.causationCommandId === 'decision-allow-b'
        && event.payload.type === 'decision.resolved'
      ))
    await waitFor(() => Promise.resolve(decisionResults.length === 1))
    expect(decisionResults).toEqual(['allow'])
    const promptAReconciliations = (await events(client, activeKey.key, roomId, projectId))
      .filter(event =>
        event.causationCommandId === 'prompt-a'
        && event.payload.type === 'command.reconciled'
      )
    expect(promptAReconciliations.filter(event =>
      event.payload.type === 'command.reconciled'
      && event.payload.state === 'running'
    )).toHaveLength(1)
    expect(promptAReconciliations.filter(event =>
      event.payload.type === 'command.reconciled'
      && event.payload.state === 'terminal'
    )).toHaveLength(1)
    expect((await events(client, activeKey.key, roomId, projectId)).find(event =>
      event.causationCommandId === 'decision-allow-b'
    )?.payload).toMatchObject({
      type: 'decision.resolved',
      decision: 'allow',
    })

    await send({
      ...base,
      commandId: 'prompt-cancel-active',
      sessionId: 'session-b',
      operation: 'prompt.submit',
      payload: { operation: 'prompt.submit', text: 'cancel active' },
    }, '$prompt-cancel-active')
    await waitFor(() => Promise.resolve(dispatched.some(item => item.text === 'cancel active')))
    await send({
      ...base,
      commandId: 'cancel-active-b',
      sessionId: 'session-b',
      operation: 'turn.cancel',
      payload: { operation: 'turn.cancel', turnId: 'prompt-cancel-active' },
    }, '$cancel-active-b')
    await waitFor(async () => {
      const deliveredEvents = await events(client, activeKey.key, roomId, projectId)
      return deliveredEvents.some(event =>
        event.causationCommandId === 'prompt-cancel-active'
        && event.payload.type === 'turn.completed'
        && event.payload.outcome === 'cancelled'
      ) && deliveredEvents.some(event =>
        event.causationCommandId === 'cancel-active-b'
        && event.payload.type === 'turn.completed'
        && event.payload.outcome === 'cancelled'
      )
    })
    await send({
      ...base,
      commandId: 'prompt-cancel-active',
      sessionId: 'session-b',
      operation: 'prompt.submit',
      payload: { operation: 'prompt.submit', text: 'cancel active' },
    }, '$prompt-cancel-active-reconcile')
    await waitFor(async () => (await events(client, activeKey.key, roomId, projectId)).some(event =>
      event.causationCommandId === 'prompt-cancel-active'
      && event.payload.type === 'command.reconciled'
      && event.payload.state === 'terminal'
    ))
    expect((await events(client, activeKey.key, roomId, projectId)).find(event =>
      event.causationCommandId === 'prompt-cancel-active'
      && event.payload.type === 'command.reconciled'
      && event.payload.state === 'terminal'
    )?.payload).toMatchObject({ outcome: 'cancelled' })

    const causalText = 'causal barrier'
    const causalMessageId = `reply-session-b-${causalText}`
    const causalGate = client.blockTimelineTransaction(
      assistantTransactionId(causalMessageId),
    )
    await send({
      ...base,
      commandId: 'prompt-causal-barrier',
      sessionId: 'session-b',
      operation: 'prompt.submit',
      payload: { operation: 'prompt.submit', text: causalText },
    }, '$prompt-causal-barrier')
    await causalGate.started.promise
    await waitFor(async () => {
      const health = await runner.healthSnapshot()
      return health.activeTurns === 0 && health.activeCommands === 0
    })
    expect(await runner.healthSnapshot()).toMatchObject({
      activeTurns: 0,
      activeCommands: 0,
    })
    expect((await events(client, activeKey.key, roomId, projectId)).some(event =>
      event.causationCommandId === 'prompt-causal-barrier'
      && event.payload.type === 'turn.completed'
    )).toBe(false)
    causalGate.release.resolve()
    await waitFor(async () => (await events(client, activeKey.key, roomId, projectId))
      .some(event =>
        event.causationCommandId === 'prompt-causal-barrier'
        && event.payload.type === 'turn.completed'
      ))
    const causalEvents = (await events(client, activeKey.key, roomId, projectId))
      .filter(event => event.causationCommandId === 'prompt-causal-barrier')
    expect(causalEvents.map(event => event.payload.type)).toEqual([
      'turn.queued',
      'turn.started',
      'assistant.message',
      'turn.completed',
    ])
    expect(causalEvents.find(event => event.payload.type === 'turn.started')?.payload)
      .toMatchObject({ projection: { activity: 'working' } })
    expect(causalEvents.findIndex(event => event.payload.type === 'assistant.message'))
      .toBeLessThan(causalEvents.findIndex(event => event.payload.type === 'turn.completed'))

    // A cancel can race a completion or arrive from a stale client after a
    // Gateway restart. It must converge the client to idle instead of leaving
    // an unrecoverable "not active" command failure.
    await send({
      ...base,
      commandId: 'cancel-settled-a',
      sessionId: 'session-a',
      operation: 'turn.cancel',
      payload: { operation: 'turn.cancel', turnId: 'prompt-a' },
    }, '$cancel-settled-a')
    await waitFor(async () => (await events(client, activeKey.key, roomId, projectId))
      .some(event =>
        event.causationCommandId === 'cancel-settled-a'
        && event.payload.type === 'turn.completed'
      ))
    expect((await events(client, activeKey.key, roomId, projectId)).find(event =>
      event.causationCommandId === 'cancel-settled-a'
      && event.payload.type === 'turn.completed'
    )?.payload).toMatchObject({
      type: 'turn.completed',
      turnId: 'prompt-a',
      outcome: 'cancelled',
      projection: { activity: 'idle' },
    })

    await send({
      ...base,
      commandId: 'archive-a',
      sessionId: 'session-a',
      operation: 'session.set_lifecycle',
      payload: { operation: 'session.set_lifecycle', state: 'archived' },
    }, '$archive-a')
    await waitFor(async () => (await events(client, activeKey.key, roomId, projectId))
      .some(event => event.causationCommandId === 'archive-a'))
    await send({
      ...base,
      commandId: 'provider-list-after-archive',
      operation: 'provider.sessions.list',
      payload: { operation: 'provider.sessions.list', provider: 'test' },
    }, '$provider-list-after-archive')
    await waitFor(async () => (await events(client, activeKey.key, roomId, projectId))
      .some(event => event.causationCommandId === 'provider-list-after-archive'))
    expect((await events(client, activeKey.key, roomId, projectId)).find(event =>
      event.causationCommandId === 'provider-list-after-archive'
      && event.payload.type === 'provider.sessions.listed'
    )?.payload).toMatchObject({
      sessions: [{
        sessionId: 'provider-session-1',
        latestArchivedSessionId: 'session-a',
        lastArchivedAt: expect.any(Number),
      }],
    })
    expect((await events(client, activeKey.key, roomId, projectId)).find(event =>
      event.causationCommandId === 'provider-list-after-archive'
      && event.payload.type === 'provider.sessions.listed'
    )?.payload).not.toEqual(expect.objectContaining({
      sessions: [expect.objectContaining({ managedSessionId: 'session-a' })],
    }))

    await send({
      ...base,
      commandId: 'prompt-active-during-update',
      sessionId: 'session-b',
      operation: 'prompt.submit',
      payload: { operation: 'prompt.submit', text: 'finish before update' },
    }, '$prompt-active-during-update')
    await waitFor(() => Promise.resolve(
      dispatched.some(item => item.text === 'finish before update'),
    ))

    await send({
      ...base,
      commandId: 'gateway-update-apply-1',
      operation: 'gateway.update.apply',
      payload: {
        operation: 'gateway.update.apply',
        releaseId: 'release-2',
        mode: 'when_idle',
      },
    }, '$gateway-update-apply-1')
    await waitFor(async () => (await events(client, activeKey.key, roomId, projectId))
      .some(event =>
        event.causationCommandId === 'gateway-update-apply-1'
        && event.payload.type === 'gateway.update.status'
        && event.payload.status.phase === 'waiting_for_idle'
      ))
    await send({
      ...base,
      commandId: 'provider-list-during-update-drain',
      operation: 'provider.sessions.list',
      payload: { operation: 'provider.sessions.list', provider: 'test' },
    }, '$provider-list-during-update-drain')
    await new Promise(resolveDelay => setTimeout(resolveDelay, 25))
    expect((await events(client, activeKey.key, roomId, projectId)).some(event =>
      event.causationCommandId === 'provider-list-during-update-drain'
    )).toBe(false)
    expect(gatewayUpdateCalls).not.toContain('apply:release-2')

    updateDrainBlocked.resolve()
    await waitFor(async () => (await events(client, activeKey.key, roomId, projectId))
      .some(event =>
        event.causationCommandId === 'gateway-update-apply-1'
        && event.payload.type === 'gateway.update.status'
        && event.payload.status.phase === 'scheduled'
      ))
    expect(gatewayUpdateCalls).toContain('apply:release-2')
    const eventsBeforeSwitch = await events(client, activeKey.key, roomId, projectId)
    const completedIndex = eventsBeforeSwitch.findIndex(event =>
      event.causationCommandId === 'prompt-active-during-update'
      && event.payload.type === 'turn.completed'
    )
    const scheduledIndex = eventsBeforeSwitch.findIndex(event =>
      event.causationCommandId === 'gateway-update-apply-1'
      && event.payload.type === 'gateway.update.status'
      && event.payload.status.phase === 'scheduled'
    )
    expect(completedIndex).toBeGreaterThanOrEqual(0)
    expect(scheduledIndex).toBeGreaterThan(completedIndex)
    await runner.stop()

    const eventIdsBeforeRestart = new Set(
      (await events(client, activeKey.key, roomId, projectId)).map(event => event.eventId),
    )
    const restarted = new MatrixMlp3GatewayRunner(config, {
      client,
      webPushService,
      validateProjectDeletion: async input => {
        validatedProjectDeletions.push(input.projectId)
      },
      deleteProject: async input => { deletedProjects.push(input.projectId) },
      sessionExtensionRegistry: new SessionExtensionRegistry([extensionProvider]),
      sessionFactory: (room, port, session) => {
        const sessionRecord = createTopicSessionRecord({
          id: session.id,
          cwd: room.cwd,
          providerName: session.provider,
          groupChatId: -1,
        })
        return {
          receiveInput: () => undefined,
          dispatch: async () => undefined,
          destroy: async () => undefined,
          state: 'idle',
          sessionRecord,
          channelPort: port,
          getProgress: () => null,
          getDeliveryStatus: () => ({ deliveries: [] }),
          retryDelivery: async () => ({ status: 'not_found' as const }),
        } satisfies TopicSession
      },
    })
    await restarted.start()
    await waitFor(async () => (await events(client, activeKey.key, roomId, projectId))
      .some(event => event.causationCommandId === 'provider-list-during-update-drain'))
    expect((await events(client, activeKey.key, roomId, projectId)).find(event =>
      event.causationCommandId === 'provider-list-during-update-drain'
      && event.payload.type === 'provider.sessions.listed'
    )?.payload).toMatchObject({ sessions: [{ sessionId: 'provider-session-1' }] })
    expect((await events(client, activeKey.key, roomId, projectId)).filter(event =>
      event.causationCommandId === 'provider-list-during-update-drain'
      && event.payload.type === 'provider.sessions.listed'
    )).toHaveLength(1)
    await waitFor(async () => {
      const recovered = (await events(client, activeKey.key, roomId, projectId)).filter(event =>
        !eventIdsBeforeRestart.has(event.eventId)
        && event.payload.type === 'session.ready'
      )
      return recovered.some(event => event.sessionId === 'session-b')
        && recovered.some(event => event.sessionId === 'session-scratch')
    })
    const recovered = (await events(client, activeKey.key, roomId, projectId)).filter(event =>
      !eventIdsBeforeRestart.has(event.eventId)
      && event.payload.type === 'session.ready'
    )
    expect(recovered.map(event => event.sessionId).sort()).toEqual([
      `gateway-update-node-${createHash('sha256')
        .update('gateway-node-1\0release-2')
        .digest('hex')
        .slice(0, 40)}`,
      'session-b',
      'session-long-initial-prompt',
      'session-scratch',
    ].sort())
    expect(recovered.every(event =>
      event.payload.type === 'session.ready'
      && event.payload.projection.activity === 'idle'
    )).toBe(true)
    await send({
      ...base,
      commandId: 'project-delete-1',
      operation: 'project.delete',
      payload: { operation: 'project.delete' },
    }, '$project-delete-1')
    await waitFor(async () => (await events(client, activeKey.key, roomId, projectId))
      .some(event => event.causationCommandId === 'project-delete-1'))
    const projectDeleteEvents = (await events(client, activeKey.key, roomId, projectId))
      .filter(event => event.causationCommandId === 'project-delete-1')
    expect(projectDeleteEvents).toHaveLength(1)
    expect(projectDeleteEvents[0]?.payload).toMatchObject({
      type: 'project.deleted',
      projectId,
      name: 'Renamed project',
    })
    expect(validatedProjectDeletions).toContain(projectId)
    await waitFor(() => Promise.resolve(deletedProjects.includes(projectId)))
    await restarted.stop()
  }, 30_000)
})

function nativeRelease(versionCode: number) {
  return {
    platform: 'android' as const,
    channel: 'alpha',
    architecture: 'arm64-v8a' as const,
    packageName: 'id.my.anciety.malink',
    versionCode,
    versionName: `0.1.0-alpha.${versionCode}`,
    buildId: `android-alpha-${versionCode}`,
    publishedAt: 1_787_400_000_000 + versionCode,
    minimumAndroid: 31,
    nativeBridgeMinimum: 1,
    nativeBridgeMaximum: 1,
    importance: 'recommended' as const,
    releaseNotes: ['Gateway-published update'],
    artifact: {
      url: `https://rd.anciety.my.id/native-updates/releases/android/alpha/${versionCode}/malink.apk`,
      size: 1_024,
      sha256: 'a'.repeat(64),
      signingCertificateSha256: 'b'.repeat(64),
    },
  }
}

async function events(
  client: TestMatrixClient,
  key: string,
  roomId: string,
  projectId: string,
) {
  const result = []
  for (const delivery of client.delivered) {
    const extension = delivery.content[MALINK_MATRIX_EXTENSION] as Record<string, unknown> | undefined
    if (!extension?.envelope) continue
    const opened = await openMlp3Envelope(extension.envelope, {
      projectKey: base64UrlDecode(key),
      roomId,
      projectId,
      keyId: (extension.envelope as { keyId: string }).keyId,
    })
    if (opened.plaintext.kind === 'signed_event') result.push(opened.plaintext.value.event)
  }
  return result
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

function assistantTransactionId(messageId: string, version = 1): string {
  const logicalEventId = createHash('sha256')
    .update(`malink-v3:assistant\0${messageId}\0${version}`)
    .digest('base64url')
  return `malink.v3.${createHash('sha256').update(logicalEventId).digest('hex')}`
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`Condition was not met within ${timeoutMs}ms`)
}
