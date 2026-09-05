import { createHash } from 'node:crypto'
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  MALINK_MATRIX_EXTENSION,
  MLP3_MATRIX_PROVIDER_CATALOG_EVENT_TYPE,
  MLP3_MATRIX_PROJECT_KEY_GRANT_EVENT_TYPE,
  MLP3_MATRIX_WORKSPACE_POINTER_EVENT_TYPE,
  mlp3CurrentPointerSchema,
  mlp3ProjectKeyGrantStateSchema,
  type GatewayRestartStatus,
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
import {
  FileMlp3RuntimeStateStore,
  type PersistedMlp3Session,
} from '@/gateway/matrix/fileMlp3RuntimeState'
import { SqliteMlp3CommandJournal } from '@/gateway/matrix/sqliteMlp3CommandJournal'
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
  readonly deletedThreads: Array<{ roomId: string; threadRootEventId: string }> = []
  readonly retiredRooms: string[] = []
  readonly roomEncryptionFailures = new Set<string>()
  private readonly timelineGates = new Map<string, {
    started: ReturnType<typeof deferred<void>>
    release: ReturnType<typeof deferred<void>>
  }>()
  private nextThreadDeletionGate: {
    started: ReturnType<typeof deferred<void>>
    release: ReturnType<typeof deferred<void>>
  } | null = null
  initializeCrypto(_config: MatrixGatewayCryptoConfig): Promise<void> { return Promise.resolve() }
  onRoomEvent(listener: MatrixGatewayEventListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  start(): Promise<void> { return Promise.resolve() }
  waitUntilReady(): Promise<void> { return Promise.resolve() }
  assertRoomEncrypted(roomId: string): Promise<void> {
    return this.roomEncryptionFailures.has(roomId)
      ? Promise.reject(new Error(`simulated encryption check failure for ${roomId}`))
      : Promise.resolve()
  }
  ensureRoomInvitation(): Promise<void> { return Promise.resolve() }
  ensureProviderHistoryRoom(
    request: Parameters<NonNullable<MatrixGatewayClient['ensureProviderHistoryRoom']>>[0],
  ): Promise<{ roomId: string; alreadyExisted: boolean }> {
    return Promise.resolve({
      roomId: `!history-${request.marker.historyId.slice(0, 16)}:example.org`,
      alreadyExisted: false,
    })
  }
  pinTrustedDevices(): Promise<void> { return Promise.resolve() }
  prepareRoomThread(): Promise<void> { return Promise.resolve() }
  deleteRoomThread(roomId: string, threadRootEventId: string): Promise<void> {
    this.deletedThreads.push({ roomId, threadRootEventId })
    const gate = this.nextThreadDeletionGate
    this.nextThreadDeletionGate = null
    if (!gate) return Promise.resolve()
    gate.started.resolve()
    return gate.release.promise
  }
  retireRoom(roomId: string): Promise<void> {
    this.retiredRooms.push(roomId)
    return Promise.resolve()
  }
  stop(): Promise<void> { return Promise.resolve() }
  blockTimelineTransaction(transactionId: string) {
    const gate = { started: deferred<void>(), release: deferred<void>() }
    this.timelineGates.set(transactionId, gate)
    return gate
  }
  blockNextThreadDeletion() {
    const gate = { started: deferred<void>(), release: deferred<void>() }
    this.nextThreadDeletionGate = gate
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

  it('keeps legacy devices authorized but prevents them from inviting more legacy devices', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'malink-v3-legacy-invite-'))
    const gatewayKeys = await generateDeviceKeyPair()
    const phoneKeys = await generateDeviceKeyPair()
    const roomId = '!legacy-invite:example.org'
    const legacyDevice: MatrixGatewayTrustedDevice = {
      deviceId: 'legacy-phone',
      publicKey: phoneKeys.publicJwk,
      allowedRoomIds: [roomId],
      allowedOperations: ['device.invite'],
      matrixUserId: '@legacy-client:example.org',
      matrixDeviceId: 'LEGACY',
      matrixDeviceKeys: ['legacy-matrix-key'],
      certificateExpiresAt: Date.now() + 60_000,
      sequenceEpoch: 'legacy-certificate',
    }
    let invitationsCreated = 0
    const runner = new MatrixMlp3GatewayRunner({
      gatewayId: 'workspace-legacy-invite',
      gatewayNodeId: 'gateway-node-legacy-invite',
      clientMatrixUserId: '@workspace-client:example.org',
      connection: {
        baseUrl: 'https://matrix.example.org',
        accessToken: 'gateway-token',
        userId: '@gateway:example.org',
        deviceId: 'GATEWAY',
      },
      crypto: {
        backend: 'memory',
        databasePrefix: 'legacy-invite-test',
        allowInMemoryForTesting: true,
      },
      rooms: [{
        roomId,
        conversationId: roomId,
        cwd: '/legacy-invite-repo',
        providerName: 'test',
      }],
      trustedDevices: [legacyDevice],
      replayLedgerPath: join(directory, 'replay'),
      applicationSecurity: {
        gatewayDeviceId: 'workspace-legacy-invite',
        gatewayKeyPair: await exportDeviceKeyPair(gatewayKeys),
        envelopeReplayLedgerPath: join(directory, 'security'),
      },
    }, {
      client: new TestMatrixClient(),
      listTrustedDevices: async () => [legacyDevice],
      createDeviceInvitation: async () => {
        invitationsCreated += 1
        return { pairingLink: 'malink-pair:v1:unused', expiresAt: Date.now() + 60_000 }
      },
    })
    const command = {
      kind: 'malink.command',
      version: 3,
      commandId: 'legacy-invite-command',
      workspaceId: 'workspace-legacy-invite',
      deviceId: legacyDevice.deviceId,
      certificateId: legacyDevice.sequenceEpoch,
      createdAt: Date.now(),
      operation: 'device.invitation.create',
      payload: { operation: 'device.invitation.create' },
    } satisfies Mlp3Command
    const invitationRunner = runner as unknown as {
      createInvitation(project: unknown, command: Mlp3Command): Promise<void>
    }

    await expect(invitationRunner.createInvitation({}, command))
      .rejects.toThrow(/legacy Matrix account cannot invite new devices/)
    expect(invitationsCreated).toBe(0)
  })

  it('keeps legacy archived cleanup off the Gateway startup path', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'malink-v3-archive-migration-'))
    const gatewayKeys = await generateDeviceKeyPair()
    const phoneKeys = await generateDeviceKeyPair()
    const client = new TestMatrixClient()
    const gatewayLogs: string[] = []
    const roomId = '!archive-migration:example.org'
    const replayLedgerPath = join(directory, 'replay')
    const config: MatrixGatewayConfig = {
      gatewayId: 'workspace-archive-migration',
      gatewayNodeId: 'gateway-node-archive-migration',
      connection: {
        baseUrl: 'https://matrix.example.org',
        accessToken: 'gateway-token',
        userId: '@gateway:example.org',
        deviceId: 'GATEWAY',
      },
      crypto: {
        backend: 'memory',
        databasePrefix: 'archive-migration-test',
        allowInMemoryForTesting: true,
      },
      rooms: [{
        roomId,
        conversationId: roomId,
        cwd: '/archive-migration-repo',
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
      replayLedgerPath,
      applicationSecurity: {
        gatewayDeviceId: 'workspace-archive-migration',
        gatewayKeyPair: await exportDeviceKeyPair(gatewayKeys),
        envelopeReplayLedgerPath: join(directory, 'security'),
      },
    }
    const state = new FileMlp3RuntimeStateStore(
      `${replayLedgerPath}.v3-runtime-state.json`,
      config.gatewayId,
    )
    await state.initialize(config.rooms)
    await state.updateProject(roomId, project => {
      const legacy = {
        id: 'legacy-archive',
        scope: 'project',
        cwd: project.cwd,
        sourceCommandId: 'legacy-create',
        threadRootEventId: '$legacy-thread-root',
        title: 'Legacy archive',
        createdAt: 1,
        updatedAt: 2,
        stateVersion: 2,
        lifecycle: 'archived',
        provider: 'test',
        model: null,
        reasoningEffort: null,
        permissionMode: 'default',
        controlValues: { permissionMode: 'default' },
        providerControls: [],
        providerSessionId: 'provider-legacy',
        providerHistory: null,
        archiveCleanup: null,
        extensions: [],
        extensionRevision: 1,
        inheritedFromProjectExtensionRevision: null,
        availableCommands: [],
      } satisfies PersistedMlp3Session
      project.sessions.push(legacy, {
        ...legacy,
        id: 'requested-archive',
        sourceCommandId: 'requested-create',
        threadRootEventId: '$requested-thread-root',
        title: 'Requested archive',
        archiveCleanup: {
          commandId: 'requested-archive-command',
          requestedAt: 2,
          matrixThreadDeleted: false,
          providerHistoryDeleted: true,
          scratchDirectoryDeleted: true,
        },
      })
    })
    const interruptedArchive = {
      kind: 'malink.command',
      version: 3,
      commandId: 'requested-archive-command',
      workspaceId: config.gatewayId,
      projectId: gatewayProjectIdentity('/archive-migration-repo').id,
      sessionId: 'requested-archive',
      deviceId: 'phone-1',
      certificateId: 'certificate-1',
      createdAt: 2,
      operation: 'session.set_lifecycle',
      payload: { operation: 'session.set_lifecycle', state: 'archived' },
    } satisfies Mlp3Command
    const journal = new SqliteMlp3CommandJournal(
      `${replayLedgerPath}.v3-commands.sqlite`,
      `${replayLedgerPath}.v3-commands.jsonl`,
    )
    await journal.initialize()
    await journal.claim(interruptedArchive, 2, {
      roomId,
      matrixEventId: '$requested-archive-command',
    })
    await journal.markDispatched(interruptedArchive, 2)
    await journal.close()

    const runner = new MatrixMlp3GatewayRunner(config, {
      client,
      onLog: message => gatewayLogs.push(message),
    })
    await runner.start()

    const grantState = [...client.state.values()].find(candidate =>
      candidate.eventType === MLP3_MATRIX_PROJECT_KEY_GRANT_EVENT_TYPE
      && candidate.content.deviceId === 'phone-1'
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
    await waitFor(async () => (await events(client, activeKey.key, roomId, grant.projectId))
      .some(event => event.sessionId === 'legacy-archive'))
    expect((await events(client, activeKey.key, roomId, grant.projectId)).find(event =>
      event.sessionId === 'legacy-archive'
    )?.payload).toMatchObject({
      type: 'session.lifecycle',
      state: 'archived',
      projection: {
        lifecycle: 'archived',
        activity: 'idle',
        stateVersion: 2,
      },
    })

    await waitFor(() => Promise.resolve(client.deletedThreads.some(deleted =>
      deleted.threadRootEventId === '$requested-thread-root'
    )))
    await waitFor(async () => (await state.project(roomId)).sessions.length === 1)
    expect((await state.project(roomId)).sessions).toEqual([
      expect.objectContaining({
        id: 'legacy-archive',
        lifecycle: 'archived',
        archiveCleanup: null,
      }),
    ])
    expect(client.deletedThreads).not.toContainEqual(expect.objectContaining({
      threadRootEventId: '$legacy-thread-root',
    }))
    expect((await events(client, activeKey.key, roomId, grant.projectId)).find(event =>
      event.sessionId === 'requested-archive'
      && event.causationCommandId === 'requested-archive-command'
    )?.payload).toMatchObject({
      type: 'session.lifecycle',
      state: 'deleted',
    })
    expect(gatewayLogs).toContain(
      '[mlp3/matrix] 1 archived session cleanup checkpoint(s) remain available for explicit retry',
    )
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

  it('settles timed-out creation and rejects provider restore before session.ready', async () => {
    clearProviderRegistryForTesting()
    registerProvider({
      name: 'restore-fail-test',
      startQuery() { throw new Error('Restore failure must not start a query') },
      isReady: () => true,
      getInitError: () => null,
      getAvailableModels: () => [],
      getAvailablePermissionModes: () => [],
      getSessionHistory: async sessionId => ({
        sessionId,
        title: 'Provider restore failure',
        messages: [],
      }),
    })
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
        providerName: 'restore-fail-test',
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
      sessionFactory: (room, port, session) => {
        if (session.id === 'session-timeout') {
          throw new Error('timed-out creation must not build a runtime')
        }
        const sessionRecord = createTopicSessionRecord({
          id: session.id,
          cwd: room.cwd,
          providerName: session.provider,
          groupChatId: -1,
        })
        return {
          receiveInput: () => undefined,
          dispatch: async () => undefined,
          restoreProviderSession: async () => {
            throw Object.assign(new Error(
              'Close the session in the other Agent client, then retry.',
            ), {
              commandCode: 'provider_session_restore_failed',
              retryable: true,
            })
          },
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
    const sendCommand = async (command: Mlp3Command, eventId: string) => {
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
        eventId,
        eventType: 'm.room.message',
        sender: '@phone:example.org',
        encrypted: false,
        content: {
          msgtype: 'm.notice',
          body: 'Encrypted Malink command',
          [MALINK_MATRIX_EXTENSION]: { version: 3, envelope },
        },
      })
    }
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
    await sendCommand(command, '$create-timeout')

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

    const retiredRoomsBeforeRestore = client.retiredRooms.length
    const restoreCommand: Mlp3Command = {
      ...command,
      commandId: 'create-provider-restore-failure',
      sessionId: 'session-provider-restore-failure',
      createdAt: Date.now(),
      payload: {
        operation: 'session.create',
        providerSessionId: 'provider-session-1',
      },
    }
    await sendCommand(restoreCommand, '$create-provider-restore-failure')
    await waitFor(async () => (await events(client, activeKey.key, roomId, projectId))
      .some(event => event.causationCommandId === restoreCommand.commandId), 2_500)
    const restoreEvents = (await events(client, activeKey.key, roomId, projectId))
      .filter(event => event.causationCommandId === restoreCommand.commandId)
    expect(restoreEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        payload: expect.objectContaining({
          type: 'command.rejected',
          code: 'provider_session_restore_failed',
          retryable: true,
        }),
      }),
    ]))
    expect(restoreEvents).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ payload: expect.objectContaining({ type: 'session.ready' }) }),
    ]))
    expect(client.retiredRooms).toHaveLength(retiredRoomsBeforeRestore + 1)
    await runner.stop()
    clearProviderRegistryForTesting()
  }, 10_000)

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
            models = Array.from({ length: 217 }, (_, index) => ({
              id: `model-${String(index + 1).padStart(3, '0')}`,
              name: `Ready model ${String(index + 1).padStart(3, '0')}`,
            }))
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
      const roomBindings = await Promise.all(config.rooms.map(async room => ({
        roomId: room.roomId,
        projectId: room.projectId ?? gatewayProjectIdentity(room.cwd, room.projectName).id,
        key: await projectKeyForRoom(client, room.roomId, phoneKeys.privateKey, gatewayKeys.publicKey),
      })))
      await waitFor(async () => {
        for (const binding of roomBindings) {
          const catalogEvents = await stateEvents(
            client,
            binding.key,
            binding.roomId,
            binding.projectId,
            MLP3_MATRIX_PROVIDER_CATALOG_EVENT_TYPE,
          )
          if (!catalogEvents.some(event =>
            event.payload.type === 'provider.catalog.page'
            && event.payload.items.some(model => model.id === 'model-217')
          )) return false
          if (!catalogEvents.some(event =>
            event.payload.type === 'provider.catalog.manifest'
            && event.payload.status === 'ready'
            && event.payload.itemCount === 217
          )) return false
        }
        return true
      })
      const catalogStates = [...client.state.values()].filter(state =>
        state.eventType === MLP3_MATRIX_PROVIDER_CATALOG_EVENT_TYPE
      )
      expect(catalogStates.length).toBeGreaterThanOrEqual(10)
      expect(catalogStates.every(state =>
        Buffer.byteLength(JSON.stringify(state.content), 'utf8') <= 40 * 1024
      )).toBe(true)
      let projects: Array<{
        name: string
        capabilitySnapshotVersion: number
        capabilities: { models: Array<{ id: string }> }
      }> = []
      await waitFor(async () => {
        let state: { projects: Record<string, typeof projects[number]> }
        try {
          state = JSON.parse(await readFile(
            `${config.replayLedgerPath}.v3-runtime-state.json`,
            'utf8',
          )) as typeof state
        } catch (error) {
          if (
            error instanceof Error
            && 'code' in error
            && (error as NodeJS.ErrnoException).code === 'ENOENT'
          ) return false
          throw error
        }
        projects = Object.values(state.projects)
        return projects.length === 2
          && projects.every(project => project.capabilities.models.length === 0)
      })
      expect(projects.map(project => ({
        name: project.name,
        capabilitySnapshotVersion: project.capabilitySnapshotVersion,
      }))).toEqual([
        { name: 'First project', capabilitySnapshotVersion: 1 },
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
    const providerSessionRestoreCalls: string[] = []
    const rejected: unknown[] = []
    const notificationSubscriptions: string[] = []
    const terminalNotifications: Mlp3Event[] = []
    const createdProjectRequests: string[] = []
    const updatedProjectNames: string[] = []
    const validatedProjectDeletions: string[] = []
    const deletedProjects: string[] = []
    const gatewayProfileUpdates: string[] = []
    const gatewayRetirements: string[] = []
    const gatewayEnrollmentCancellations: string[] = []
    const gatewayLogs: string[] = []
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
    let gatewayStageFailureReleaseId: string | null = null
    let gatewayRestartStatus: GatewayRestartStatus = {
      version: 1,
      phase: 'idle',
      updatedAt: 10,
    }
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
      getProviderControls: () => [{
        id: 'verbosity',
        label: 'Verbosity',
        renderer: 'select',
        surfaces: ['project-default', 'session-create', 'session-active'],
        updateEffect: 'next-turn',
        status: 'ready',
        options: [
          { value: 'concise', label: 'Concise' },
          { value: 'detailed', label: 'Detailed' },
        ],
        defaultValue: 'concise',
      }],
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
      onLog: message => gatewayLogs.push(message),
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
        const deferred = input.name === 'Created with deferred publication'
        return {
          gatewayNodeId: 'gateway-node-1',
          alreadyExisted: false,
          room: {
            roomId: deferred
              ? '!created-project-deferred:example.org'
              : '!created-project:example.org',
            conversationId: deferred ? 'created-project-deferred' : 'created-project',
            projectId: deferred ? 'project-created-deferred' : 'project-created',
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
      cancelGatewayEnrollment: async input => {
        gatewayEnrollmentCancellations.push(
          `${input.requestedByDeviceId}:${input.enrollmentId}`,
        )
        return {
          gatewayNodeId: 'gateway-node-pending',
          gatewayName: 'Pending Gateway',
        }
      },
      retireWorkspaceGateway: async input => {
        gatewayRetirements.push(
          `${input.gatewayNodeId}:${input.expectedDirectoryRevision}:${input.expectedGatewayKeyId}`,
        )
        return {
          gatewayNodeId: input.gatewayNodeId,
          removedProjectCount: 2,
          directoryRevision: input.expectedDirectoryRevision + 1,
        }
      },
      sessionExtensionRegistry: new SessionExtensionRegistry([extensionProvider]),
      sessionFactory: (room, port, session) => {
        if (session.id === 'session-recovery-failure') {
          throw new Error('simulated recovered-session runtime failure')
        }
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
          async restoreProviderSession() {
            providerSessionRestoreCalls.push(
              `${session.id}:${session.providerSessionId ?? ''}`,
            )
          },
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
          if (gatewayStageFailureReleaseId) {
            return {
              version: 1,
              phase: 'failed',
              releaseId: gatewayStageFailureReleaseId,
              currentBuildId: 'build-1',
              detail: 'Gateway Agent update Prompt signature is invalid',
              updatedAt: 14,
            }
          }
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
          if (releaseId === 'release-stage-failed') {
            gatewayStageFailureReleaseId = releaseId
            throw new Error('Gateway Agent update Prompt signature is invalid')
          }
          gatewayStageFailureReleaseId = null
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
        async scheduleApply(releaseId, allowForwardOnly) {
          gatewayUpdateCalls.push(`apply:${releaseId}`)
          gatewayUpdateCalls.push(`apply-forward-only:${allowForwardOnly === true}`)
          return {
            version: 1,
            phase: 'scheduled',
            releaseId,
            targetBuildId: 'build-2',
            currentBuildId: 'build-1',
            updatedAt: 12,
          }
        },
        async restartStatus() {
          return structuredClone(gatewayRestartStatus)
        },
        async scheduleRestart(mode) {
          gatewayUpdateCalls.push(`restart:${mode}`)
          gatewayRestartStatus = {
            version: 1 as const,
            phase: 'scheduled' as const,
            restartId: 'restart-1',
            mode,
            requestedAt: 20,
            scheduledAt: 25,
            updatedAt: 20,
          }
          return structuredClone(gatewayRestartStatus)
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
          models: [],
          web_push: { vapid_public_key: 'B'.repeat(87) },
        }),
      }),
    }))
    await waitFor(async () => {
      const catalogEvents = await stateEvents(
        client,
        activeKey.key,
        roomId,
        projectId,
        MLP3_MATRIX_PROVIDER_CATALOG_EVENT_TYPE,
      )
      return catalogEvents.some(event =>
        event.payload.type === 'provider.catalog.page'
        && event.payload.items.some(model => model.id === 'model-selectable')
      ) && catalogEvents.some(event =>
        event.payload.type === 'provider.catalog.manifest'
        && event.payload.itemCount === 1
      )
    })
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
    await new Promise(resolveDelay => setTimeout(resolveDelay, 1_100))
    const idleEvents = await events(client, activeKey.key, roomId, projectId)
    expect(idleEvents.some(event =>
      event.payload.type === 'gateway.update.status'
      && event.causationCommandId === undefined
    )).toBe(false)

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

    client.roomEncryptionFailures.add('!created-project-deferred:example.org')
    await send({
      ...base,
      commandId: 'project-create-deferred-1',
      operation: 'project.create',
      payload: {
        operation: 'project.create',
        name: 'Created with deferred publication',
        cwd: '/srv/created-deferred',
        provider: 'test',
      },
    }, '$project-create-deferred-1')
    await waitFor(async () => (await events(client, activeKey.key, roomId, projectId))
      .some(event => event.causationCommandId === 'project-create-deferred-1'))
    expect((await events(client, activeKey.key, roomId, projectId)).find(event =>
      event.causationCommandId === 'project-create-deferred-1'
    )?.payload).toMatchObject({
      type: 'project.created',
      projectId: 'project-created-deferred',
      roomId: '!created-project-deferred:example.org',
    })
    expect(gatewayLogs).toContainEqual(expect.stringContaining(
      'created project activation deferred for project-created-deferred',
    ))
    client.roomEncryptionFailures.delete('!created-project-deferred:example.org')

    await send({
      ...base,
      commandId: 'gateway-enrollment-cancel-1',
      operation: 'gateway.enrollment.cancel',
      payload: {
        operation: 'gateway.enrollment.cancel',
        enrollmentId: 'enrollment-pending-1',
      },
    }, '$gateway-enrollment-cancel-1')
    await waitFor(async () => (await events(client, activeKey.key, roomId, projectId))
      .some(event => event.causationCommandId === 'gateway-enrollment-cancel-1'))
    expect(gatewayEnrollmentCancellations).toEqual([
      'phone-1:enrollment-pending-1',
    ])
    expect((await events(client, activeKey.key, roomId, projectId)).find(event =>
      event.causationCommandId === 'gateway-enrollment-cancel-1'
    )?.payload).toMatchObject({
      type: 'gateway.enrollment.cancelled',
      enrollmentId: 'enrollment-pending-1',
      gatewayNodeId: 'gateway-node-pending',
      gatewayName: 'Pending Gateway',
    })

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
      ...base,
      commandId: 'gateway-retire-1',
      operation: 'gateway.retire',
      payload: {
        operation: 'gateway.retire',
        gatewayNodeId: 'gateway-node-old',
        expectedDirectoryRevision: 7,
        expectedGatewayKeyId: 'r'.repeat(43),
      },
    }, '$gateway-retire-1')
    await waitFor(async () => (await events(client, activeKey.key, roomId, projectId))
      .some(event => event.causationCommandId === 'gateway-retire-1'))
    expect(gatewayRetirements).toEqual([
      `gateway-node-old:7:${'r'.repeat(43)}`,
    ])
    expect((await events(client, activeKey.key, roomId, projectId)).find(event =>
      event.causationCommandId === 'gateway-retire-1'
    )?.payload).toMatchObject({
      type: 'gateway.retired',
      gatewayNodeId: 'gateway-node-old',
      removedProjectCount: 2,
      directoryRevision: 8,
    })

    await send({
      ...base,
      commandId: 'gateway-retire-self-1',
      operation: 'gateway.retire',
      payload: {
        operation: 'gateway.retire',
        gatewayNodeId: 'gateway-node-1',
        expectedDirectoryRevision: 8,
        expectedGatewayKeyId: 'r'.repeat(43),
      },
    }, '$gateway-retire-self-1')
    await waitFor(async () => (await events(client, activeKey.key, roomId, projectId))
      .some(event => event.causationCommandId === 'gateway-retire-self-1'))
    expect(gatewayRetirements).toHaveLength(1)
    expect((await events(client, activeKey.key, roomId, projectId)).find(event =>
      event.causationCommandId === 'gateway-retire-self-1'
    )?.payload).toMatchObject({
      type: 'command.rejected',
      code: 'execution_failed',
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
    expect(createdProjectRequests).toEqual([
      'Created remotely:/srv/created-remotely',
      'Created with deferred publication:/srv/created-deferred',
    ])

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
    await waitFor(async () => (await events(client, activeKey.key, roomId, projectId))
      .some(event => event.causationCommandId === undefined
        && event.payload.type === 'gateway.update.status'
        && event.payload.status.phase === 'staged'))
    const sharedGatewayUpdateEvents = await events(client, activeKey.key, roomId, projectId)
    expect(sharedGatewayUpdateEvents.some(event =>
      event.causationCommandId === undefined
      && event.payload.type === 'gateway.update.status'
      && event.payload.status.phase === 'agent_running'
    )).toBe(true)
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
      state: 'deleted',
    })
    gatewayStageFailureReleaseId = null
    await send({
      ...base,
      commandId: 'gateway-update-stage-invalid-release',
      operation: 'gateway.update.stage',
      payload: { operation: 'gateway.update.stage', releaseId: 'release-stage-failed' },
    }, '$gateway-update-stage-invalid-release')
    await waitFor(async () => (await events(client, activeKey.key, roomId, projectId))
      .some(event =>
        event.causationCommandId === 'gateway-update-stage-invalid-release'
        && event.payload.type === 'command.rejected'
      ))
    await waitFor(async () => (await events(client, activeKey.key, roomId, projectId))
      .some(event =>
        event.causationCommandId === undefined
        && event.payload.type === 'gateway.update.status'
        && event.payload.status.phase === 'failed'
        && event.payload.status.releaseId === 'release-stage-failed'
      ))
    gatewayStageFailureReleaseId = null
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
          controls: { verbosity: 'detailed' },
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
      controls: { verbosity: 'detailed' },
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
    const createdSession = (await events(client, activeKey.key, roomId, projectId)).find(event =>
      event.causationCommandId === 'create-a' && event.payload.type === 'session.ready'
    )
    expect(providerSessionRestoreCalls).toContain(
      'session-a:provider-session-1',
    )
    expect(createdSession?.payload).toMatchObject({
      controls: { verbosity: 'detailed' },
      projection: {
        controls: [{ id: 'verbosity', value: 'detailed' }],
      },
    })
    await send({
      ...base,
      commandId: 'create-provider-defaults',
      sessionId: 'session-provider-defaults',
      operation: 'session.create',
      payload: {
        operation: 'session.create',
        title: 'Provider defaults',
        controls: {},
      },
    }, '$root-provider-defaults')
    await waitFor(async () => (await events(client, activeKey.key, roomId, projectId))
      .some(event => event.causationCommandId === 'create-provider-defaults'))
    const providerDefaultSession = (await events(client, activeKey.key, roomId, projectId)).find(
      event => event.causationCommandId === 'create-provider-defaults'
        && event.payload.type === 'session.ready',
    )?.payload
    expect(providerDefaultSession).toMatchObject({ type: 'session.ready' })
    if (providerDefaultSession?.type !== 'session.ready') {
      throw new Error('Provider-default session was not created')
    }
    expect(providerDefaultSession.controls).not.toHaveProperty('verbosity')
    await send({
      ...base,
      commandId: 'session-controls-1',
      sessionId: 'session-a',
      operation: 'session.update',
      payload: {
        operation: 'session.update',
        patch: { controls: { verbosity: 'concise' } },
      },
    }, '$session-controls-1')
    await waitFor(async () => (await events(client, activeKey.key, roomId, projectId))
      .some(event => event.causationCommandId === 'session-controls-1'))
    expect((await events(client, activeKey.key, roomId, projectId)).find(event =>
      event.causationCommandId === 'session-controls-1'
      && event.payload.type === 'session.updated'
    )?.payload).toMatchObject({
      projection: { controls: [{ id: 'verbosity', value: 'concise' }] },
    })
    await send({
      ...base,
      commandId: 'project-controls-clear-1',
      operation: 'project.update',
      payload: {
        operation: 'project.update',
        patch: { controls: {}, model: null, reasoningEffort: null },
      },
    }, '$project-controls-clear-1')
    await waitFor(async () => (await events(client, activeKey.key, roomId, projectId))
      .some(event => event.causationCommandId === 'project-controls-clear-1'))
    const clearedProjectControls = (await events(client, activeKey.key, roomId, projectId)).find(
      event => event.causationCommandId === 'project-controls-clear-1'
        && event.payload.type === 'project.snapshot',
    )?.payload
    expect(clearedProjectControls).toMatchObject({ type: 'project.snapshot' })
    if (clearedProjectControls?.type !== 'project.snapshot') {
      throw new Error('Project control defaults were not cleared')
    }
    expect(clearedProjectControls.controls).not.toHaveProperty('verbosity')
    expect(clearedProjectControls).not.toHaveProperty('model')
    expect(clearedProjectControls).not.toHaveProperty('reasoningEffort')
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
      .filter(event =>
        event.causationCommandId === 'prompt-a'
        && event.payload.type === 'turn.completed'
      ).length >= 2)
    await send(promptA, '$prompt-a-retry-same-terminal-state')
    await waitFor(async () => (await events(client, activeKey.key, roomId, projectId))
      .filter(event =>
        event.causationCommandId === 'prompt-a'
        && event.payload.type === 'turn.completed'
      ).length >= 3)
    const promptATerminalEvents = (await events(client, activeKey.key, roomId, projectId))
      .filter(event =>
        event.causationCommandId === 'prompt-a'
        && event.payload.type === 'turn.completed'
      )
    expect(new Set(promptATerminalEvents.map(event => event.eventId)).size)
      .toBe(promptATerminalEvents.length)
    expect(promptATerminalEvents.map(event => event.payload)).toEqual(
      promptATerminalEvents.map(() => promptATerminalEvents[0]?.payload),
    )
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
    )).toHaveLength(0)
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
    await waitFor(async () => (await events(client, activeKey.key, roomId, projectId)).filter(event =>
      event.causationCommandId === 'prompt-cancel-active'
      && event.payload.type === 'turn.completed'
      && event.payload.outcome === 'cancelled'
    ).length >= 2)

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

    const archiveCleanupGate = client.blockNextThreadDeletion()
    const archiveA = {
      ...base,
      commandId: 'archive-a',
      sessionId: 'session-a',
      operation: 'session.set_lifecycle',
      payload: { operation: 'session.set_lifecycle', state: 'archived' },
    } satisfies Mlp3Command
    await send(archiveA, '$archive-a')
    await waitFor(async () => (await events(client, activeKey.key, roomId, projectId))
      .some(event => event.causationCommandId === 'archive-a'))
    expect((await events(client, activeKey.key, roomId, projectId)).find(event =>
      event.causationCommandId === 'archive-a'
    )?.payload).toMatchObject({
      type: 'session.lifecycle',
      state: 'deleted',
    })
    await archiveCleanupGate.started.promise
    const archiveState = new FileMlp3RuntimeStateStore(
      `${config.replayLedgerPath}.v3-runtime-state.json`,
      config.gatewayId,
    )
    expect((await archiveState.project(roomId)).sessions.find(session =>
      session.id === 'session-a'
    )).toMatchObject({
      lifecycle: 'archived',
      archiveCleanup: {
        matrixThreadDeleted: false,
        providerHistoryDeleted: false,
        scratchDirectoryDeleted: true,
      },
    })
    archiveCleanupGate.release.resolve()
    await waitFor(async () => !(await archiveState.project(roomId)).sessions.some(session =>
      session.id === 'session-a'
    ))
    await send(archiveA, '$archive-a-recovery')
    await waitFor(async () => (await events(client, activeKey.key, roomId, projectId)).filter(event =>
      event.causationCommandId === 'archive-a'
      && event.payload.type === 'session.lifecycle'
      && event.payload.state === 'deleted'
    ).length >= 2)
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
      }],
    })
    expect((await events(client, activeKey.key, roomId, projectId)).find(event =>
      event.causationCommandId === 'provider-list-after-archive'
      && event.payload.type === 'provider.sessions.listed'
    )?.payload).not.toEqual(expect.objectContaining({
      sessions: [expect.objectContaining({ managedSessionId: 'session-a' })],
    }))

    const retiredRoomsBeforeFailedRecovery = client.retiredRooms.length
    await send({
      ...base,
      commandId: 'create-recovered-session-failure',
      sessionId: 'session-recovery-failure',
      operation: 'session.create',
      payload: {
        operation: 'session.create',
        providerSessionId: 'provider-session-1',
      },
    }, '$create-recovered-session-failure')
    await waitFor(async () => (await events(client, activeKey.key, roomId, projectId))
      .some(event =>
        event.causationCommandId === 'create-recovered-session-failure'
        && event.payload.type === 'command.rejected'
      ))
    expect(client.retiredRooms).toHaveLength(retiredRoomsBeforeFailedRecovery + 1)
    expect(client.retiredRooms.at(-1)).toMatch(/^!history-/u)

    await send({
      ...base,
      commandId: 'gateway-restart-status-1',
      operation: 'gateway.restart.status',
      payload: { operation: 'gateway.restart.status' },
    }, '$gateway-restart-status-1')
    await waitFor(async () => (await events(client, activeKey.key, roomId, projectId))
      .some(event =>
        event.causationCommandId === 'gateway-restart-status-1'
        && event.payload.type === 'gateway.restart.status'
      ))
    expect((await events(client, activeKey.key, roomId, projectId)).find(event =>
      event.causationCommandId === 'gateway-restart-status-1'
    )?.payload).toMatchObject({
      type: 'gateway.restart.status',
      status: { phase: 'idle' },
    })

    await send({
      ...base,
      commandId: 'gateway-restart-when-idle-1',
      operation: 'gateway.restart',
      payload: { operation: 'gateway.restart', mode: 'when_idle' },
    }, '$gateway-restart-when-idle-1')
    await waitFor(async () => (await events(client, activeKey.key, roomId, projectId))
      .some(event =>
        event.causationCommandId === 'gateway-restart-when-idle-1'
        && event.payload.type === 'gateway.restart.status'
        && event.payload.status.phase === 'scheduled'
      ))
    expect(gatewayUpdateCalls).toContain('restart:when_idle')

    gatewayRestartStatus = {
      ...gatewayRestartStatus,
      phase: 'failed',
      completedAt: 30,
      detail: 'The local service manager rejected the restart',
      updatedAt: 30,
    }
    await send({
      ...base,
      commandId: 'gateway-restart-status-after-failure',
      operation: 'gateway.restart.status',
      payload: { operation: 'gateway.restart.status' },
    }, '$gateway-restart-status-after-failure')
    await waitFor(async () => (await events(client, activeKey.key, roomId, projectId))
      .some(event =>
        event.causationCommandId === 'gateway-restart-status-after-failure'
        && event.payload.type === 'gateway.restart.status'
        && event.payload.status.phase === 'failed'
      ))

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
        allowForwardOnly: true,
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
    expect(gatewayUpdateCalls).toContain('apply-forward-only:true')
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
      onLog: message => gatewayLogs.push(message),
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
      'session-provider-defaults',
      'session-scratch',
    ].sort())
    expect(recovered.every(event =>
      event.payload.type === 'session.ready'
      && event.payload.projection.activity === 'idle'
    )).toBe(true)
    await send({
      ...base,
      commandId: 'project-delete-with-sessions',
      operation: 'project.delete',
      payload: { operation: 'project.delete' },
    }, '$project-delete-with-sessions')
    await waitFor(async () => (await events(client, activeKey.key, roomId, projectId))
      .some(event =>
        event.causationCommandId === 'project-delete-with-sessions'
        && event.payload.type === 'command.rejected'
      ))
    expect(deletedProjects).not.toContain(projectId)
    expect(client.retiredRooms).not.toContain(roomId)

    gatewayAgentStaged = false
    const remainingSessionIds = [
      'session-b',
      'session-long-initial-prompt',
      'session-provider-defaults',
      'session-scratch',
      gatewayMaintenanceSessionId('gateway-node-1', 'release-2'),
    ]
    for (const [index, sessionId] of remainingSessionIds.entries()) {
      const commandId = `archive-before-project-delete-${index}`
      await send({
        ...base,
        commandId,
        sessionId,
        operation: 'session.set_lifecycle',
        payload: { operation: 'session.set_lifecycle', state: 'archived' },
      }, `$${commandId}`)
      await waitFor(async () => (await events(client, activeKey.key, roomId, projectId))
        .some(event =>
          event.causationCommandId === commandId
          && ['session.lifecycle', 'command.rejected'].includes(event.payload.type)
        )).catch(error => {
        throw new Error(
          `No terminal event for ${commandId} (${sessionId}).\n${gatewayLogs.slice(-20).join('\n')}`,
          { cause: error },
        )
      })
      expect((await events(client, activeKey.key, roomId, projectId)).find(event =>
        event.causationCommandId === commandId
      )?.payload).toMatchObject({
        type: 'session.lifecycle',
        state: 'deleted',
      })
      await waitFor(async () => !(await archiveState.project(roomId)).sessions.some(session =>
        session.id === sessionId
      ))
    }
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
    expect(client.retiredRooms).toContain(roomId)
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

async function stateEvents(
  client: TestMatrixClient,
  key: string,
  roomId: string,
  projectId: string,
  eventType: string,
): Promise<Mlp3Event[]> {
  const result: Mlp3Event[] = []
  for (const delivery of client.state.values()) {
    if (delivery.roomId !== roomId || delivery.eventType !== eventType) continue
    const extension = delivery.content[MALINK_MATRIX_EXTENSION] as
      | Record<string, unknown>
      | undefined
    if (!extension?.envelope) continue
    const opened = await openMlp3Envelope(extension.envelope, {
      projectKey: base64UrlDecode(key),
      roomId,
      projectId,
      keyId: (extension.envelope as { keyId: string }).keyId,
    })
    if (opened.plaintext.kind === 'signed_event') {
      result.push(opened.plaintext.value.event)
    }
  }
  return result
}

async function projectKeyForRoom(
  client: TestMatrixClient,
  roomId: string,
  recipientPrivateKey: CryptoKey,
  senderPublicKey: CryptoKey,
): Promise<string> {
  const grantState = [...client.state.values()].find(state =>
    state.roomId === roomId
    && state.eventType === MLP3_MATRIX_PROJECT_KEY_GRANT_EVENT_TYPE
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
    recipientPrivateKey,
    senderPublicKey,
  })
  return keyGrant.keys.find(key => key.keyId === keyGrant.activeKeyId)!.key
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
