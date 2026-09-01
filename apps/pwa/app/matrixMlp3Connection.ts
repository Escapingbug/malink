import {
  MLP3_MATRIX_PROJECT_KEY_GRANT_EVENT_TYPE,
  MLP3_MATRIX_PROJECT_POINTER_EVENT_TYPE,
  MLP3_MATRIX_WORKSPACE_POINTER_EVENT_TYPE,
  MLP3_MATRIX_WORKSPACE_DIRECTORY_EVENT_TYPE,
  MAX_MALINK_ATTACHMENT_BYTES,
  attachmentSchema,
  mlp3ProjectKeyGrantStateSchema,
  type MalinkAttachment,
} from "@malink/protocol";
import {
  decryptMedia,
  encryptMedia,
  sha256,
  toArrayBuffer,
  verifyMlp3Pointer,
} from "@malink/security";
import type { MatrixClient, MatrixEvent, Room } from "matrix-js-sdk";
import type { RoomMessageEventContent } from "matrix-js-sdk/lib/@types/events";
import { ClientPrefix } from "matrix-js-sdk/lib/http-api/prefix";
import type { MessageDeliveryMode } from "@malink/native-bridge";
import { IndexedDbMatrixMlp3ClientStore } from "./IndexedDbMatrixMlp3ClientStore";
import {
  MatrixMlp3ReadModelRepairError,
  MatrixMlp3ProtocolClient,
  type MatrixMlp3RawEvent,
} from "./matrixMlp3Client";
import { MatrixMlp3Readiness } from "./matrixMlp3Readiness";
import {
  acquireMatrixCryptoLock,
  flushAndReleaseMatrixSyncStore,
  flushMatrixSyncStore,
  matrixCryptoLockName,
  matrixSyncDatabaseName,
  waitForMatrixSyncStoreClose,
} from "./matrixSyncStore";
import {
  getOrCreateDeviceIdentity,
  normalizeMatrixConfig,
  createMatrixPairingTransport,
  verifyAndPinGatewayDevice,
  waitForInitialSync,
  waitForOwnMatrixDeviceKeys,
  withMatrixTimeout,
  type CollaborationState,
  type IncomingMalinkMessage,
  type MatrixConnection,
  type MatrixConnectionConfig,
  type MatrixConnectionStatus,
  type MatrixHistoryPage,
  type MatrixWorkspaceRoute,
} from "./matrix";
import {
  completePairing,
  applyWorkspaceGatewayDirectory,
  loadTrustedGateway,
  type PairingPreview,
  type TrustedGateway,
} from "./pairing";
import {
  parseToolGroupPresentation,
  type ToolGroupPresentation,
} from "./presentation";
import type { CommandCompletion } from "./commandLifecycle";
import {
  parseGatewayCapabilities,
  type GatewayStateSnapshot,
} from "./gatewayState";
import {
  MATRIX_PROJECT_AUTHORIZATION_REPAIR_REQUIRED,
  resolveAuthoritativeProjectKeyGrant,
} from "./projectKeyGrantRecovery";
import { workspaceRouteNeedsJoin } from "./matrixWorkspaceRoute";
import {
  MATRIX_CRYPTO_INITIALIZATION_TIMEOUT_DETAIL,
  MATRIX_CRYPTO_INITIALIZATION_TIMEOUT_MS,
  MATRIX_CRYPTO_LOADING_DETAIL,
} from "./matrixStartup";

const LOCAL_TIMEOUT_MS = 10_000;
const MATRIX_HISTORY_REQUEST_TIMEOUT_MS = 30_000;
const INITIAL_SYNC_LIMIT = 32;
const CATCHUP_PRESENTATION_LIMIT_PER_SESSION = 30;

type ProjectionDeliveryMode = MessageDeliveryMode | "hydrate";

type V3Handlers = {
  onMessage(message: IncomingMalinkMessage): void;
  onStatus(status: MatrixConnectionStatus, detail?: string): void;
  onTrustUpdated?(trust: TrustedGateway): void;
  onCollaborationState?(state: CollaborationState): void;
  onCommandResult?(result: CommandCompletion): void;
  onHistoryRecovered?(page: { sessionId: string; messages: IncomingMalinkMessage[]; hasMore: boolean }): void;
  onConvergenceRequired?(): void;
};

/** Matrix SDK transport host for the MLP/3 core. */
export async function connectMatrixMlp3(
  configInput: MatrixConnectionConfig,
  handlers: V3Handlers,
): Promise<MatrixConnection> {
  const config = normalizeMatrixConfig(configInput);
  handlers.onStatus("connecting", "Opening the durable MLP/3 client…");
  const identity = await getOrCreateDeviceIdentity();
  let trust = await loadTrustedGateway(identity, config.gatewayId || undefined);
  const sdk = await import("matrix-js-sdk");
  const syncDatabase = await matrixSyncDatabaseName(config);
  await waitForMatrixSyncStoreClose(syncDatabase);
  const syncStore = new sdk.IndexedDBStore({ indexedDB, dbName: syncDatabase });
  const cryptoScope = await matrixCryptoLockName(config);
  const cryptoLock = await acquireMatrixCryptoLock(cryptoScope);
  const client = sdk.createClient({
    baseUrl: config.homeserver,
    userId: config.userId,
    accessToken: config.accessToken,
    deviceId: config.matrixDeviceId,
    timelineSupport: true,
    store: syncStore,
  });
  let stopped = false;
  let room: Room | null = null;
  let protocol: MatrixMlp3ProtocolClient | null = null;
  let projectId: string | null = null;
  let savedMatrixSyncToken: string | null = null;
  let matrixSyncCatchingUp = false;
  let matrixSyncCatchupGeneration = 0;
  const secondaryProtocols = new Map<string, {
    route: MatrixWorkspaceRoute;
    room: Room;
    protocol: MatrixMlp3ProtocolClient;
  }>();
  const commandProjects = new Map<string, MatrixMlp3ProtocolClient>();
  const pendingSecondaryProjects = new Set<string>();
  const activeSecondaryRecoveries = new Set<Promise<void>>();
  const activeSecondaryRecoveryCounts = new Map<string, number>();
  let matrixDeviceKeys: { ed25519: string; curve25519: string } | null = null;
  const readiness = new MatrixMlp3Readiness(Boolean(trust));
  let authoritativeProjectionPrepared = false;
  let cachedProjectionPublished = false;
  let reconcileWorkspaceRoutes = () => undefined;
  const deliveredMessages = new Map<string, { version: number; physicalEventId: string }>();
  const emittedCompletions = new Set<string>();
  const deliveredHistory = new Map<string, Set<string>>();
  const historyTokens = new Map<string, string | null>();
  const historyInitialized = new Set<string>();
  let readySettled = false;
  let resolveReady!: () => void;
  let rejectReady!: (error: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const completeReady = () => {
    if (readySettled) return;
    readySettled = true;
    resolveReady();
  };
  const failReady = (error: unknown) => {
    if (readySettled) return;
    readySettled = true;
    rejectReady(error);
  };

  const activeWorkspaceProtocols = (): MatrixMlp3ProtocolClient[] => {
    const routes = trust ? workspaceRoutesFromTrust(trust) : [];
    const routeDirectoryAvailable = routes.length > 0;
    const active: MatrixMlp3ProtocolClient[] = [];
    if (
      protocol
      && (!routeDirectoryAvailable || routes.some(route =>
        route.projectId === projectId && route.roomId === config.roomId))
    ) active.push(protocol);
    for (const context of secondaryProtocols.values()) {
      if (!routeDirectoryAvailable || routes.some(route =>
        route.projectId === context.route.projectId && route.roomId === context.route.roomId)) {
        active.push(context.protocol);
      }
    }
    return active;
  };

  const protocolForProject = (
    targetProjectId?: string,
  ): MatrixMlp3ProtocolClient | null => {
    const active = activeWorkspaceProtocols();
    if (!targetProjectId) return active.length === 1 ? active[0]! : null;
    if (targetProjectId === projectId && protocol && active.includes(protocol)) return protocol;
    const secondary = secondaryProtocols.get(targetProjectId)?.protocol;
    return secondary && active.includes(secondary) ? secondary : null;
  };

  const projectForProtocol = (
    target: MatrixMlp3ProtocolClient,
  ): string | undefined => {
    if (target === protocol) return projectId ?? undefined;
    return [...secondaryProtocols.values()].find(
      value => value.protocol === target,
    )?.route.projectId;
  };

  const publishProjection = (
    deliveryMode: ProjectionDeliveryMode = "live",
    targetProtocols?: readonly MatrixMlp3ProtocolClient[],
  ) => {
    // Recovery may fetch authoritative pointers after the SDK has announced a
    // reconnect but before its sync boundary has settled. Let the boundary
    // publish one bounded catch-up window instead of leaking those snapshots
    // through the ordinary live callback.
    if (deliveryMode === "live" && matrixSyncCatchingUp) return;
    const activeProtocols = activeWorkspaceProtocols();
    if (activeProtocols.length === 0) return;
    const projectionProtocols = targetProtocols
      ? targetProtocols.filter(target => activeProtocols.includes(target))
      : activeProtocols;
    const catchupBySession = new Map<
      string,
      { sessionId: string; messages: IncomingMalinkMessage[] }
    >();
    const unscopedCatchup: IncomingMalinkMessage[] = [];
    for (const target of projectionProtocols) {
      const messageProjectId = projectForProtocol(target);
      for (const message of target.projection.messages.values()) {
        const deliveryKey = messageProjectId
          ? `${messageProjectId}\0${message.logicalId}`
          : message.logicalId;
        const previous = deliveredMessages.get(deliveryKey);
        if (
          previous
          && previous.version === message.version
          && previous.physicalEventId === message.physicalEventId
        ) continue;
        deliveredMessages.set(deliveryKey, {
          version: message.version,
          physicalEventId: message.physicalEventId,
        });
        if (deliveryMode === "hydrate") continue;
        const incoming = toIncomingMessage(
          message,
          previous?.physicalEventId,
          deliveryMode,
          messageProjectId,
        );
        if (deliveryMode !== "catchup") {
          handlers.onMessage(incoming);
        } else if (incoming.sessionId) {
          const routeKey = incoming.projectId
            ? `${incoming.projectId}\0${incoming.sessionId}`
            : incoming.sessionId;
          const recovered = catchupBySession.get(routeKey) ?? {
            sessionId: incoming.sessionId,
            messages: [],
          };
          recovered.messages.push(incoming);
          catchupBySession.set(routeKey, recovered);
        } else {
          unscopedCatchup.push(incoming);
        }
      }
    }
    for (const recovered of catchupBySession.values()) {
      const bounded = recovered.messages
        .sort(
          (left, right) =>
            left.timestamp - right.timestamp ||
            left.eventId.localeCompare(right.eventId),
        )
        .slice(-CATCHUP_PRESENTATION_LIMIT_PER_SESSION);
      if (handlers.onHistoryRecovered) {
        handlers.onHistoryRecovered({
          sessionId: recovered.sessionId,
          messages: bounded,
          // Catch-up is intentionally a bounded presentation window. Older
          // transcript content remains available through explicit pagination.
          hasMore: true,
        });
      } else {
        bounded.forEach(handlers.onMessage);
      }
    }
    unscopedCatchup
      .sort(
        (left, right) =>
          left.timestamp - right.timestamp ||
          left.eventId.localeCompare(right.eventId),
      )
      .slice(-CATCHUP_PRESENTATION_LIMIT_PER_SESSION)
      .forEach(handlers.onMessage);
    for (const completion of projectionProtocols.flatMap(value => [...value.projection.completions.values()])) {
      if (emittedCompletions.has(completion.commandId)) continue;
      emittedCompletions.add(completion.commandId);
      handlers.onCommandResult?.(toLegacyCompletion(completion));
    }
    handlers.onCollaborationState?.({
      activeDeviceCount: trust?.activeDeviceCount,
      revision: 0,
      gatewayState: aggregateGatewayState(activeProtocols, config, trust),
    });
    reconcileWorkspaceRoutes();
  };

  const publishProjectionIfAuthoritative = () => {
    if (
      readiness.canPublishAuthoritativeProjection
      && !matrixSyncCatchingUp
      && protocol
    ) {
      publishProjection("live", [protocol]);
    }
  };

  const publishCachedProjectionIfAvailable = () => {
    const active = protocol;
    if (
      cachedProjectionPublished
      || readiness.canPublishAuthoritativeProjection
      || !active
      || (
        !active.projection.workspace
        && !active.projection.project
        && active.projection.sessions.size === 0
        && active.projection.messages.size === 0
        && active.projection.inboxFiles.size === 0
      )
    ) return;
    cachedProjectionPublished = true;
    // The selected session hydrates its bounded local window through
    // loadLocalHistory. Seeding delivery identities here prevents a restored
    // projection from being replayed message-by-message as live traffic.
    publishProjection("hydrate");
  };

  const createProtocol = async (grantInput: unknown): Promise<boolean> => {
    if (!trust) return false;
    const grant = mlp3ProjectKeyGrantStateSchema.parse(grantInput);
    if (
      grant.workspaceId !== config.gatewayId
      || grant.roomId !== config.roomId
      || grant.deviceId !== identity.keyId
      || grant.certificateId !== trust.certificate.certificate.certificateId
    ) return false;
    projectId = grant.projectId;
    if (!protocol) {
      const store = new IndexedDbMatrixMlp3ClientStore([
        config.gatewayId,
        config.roomId,
        grant.projectId,
        identity.keyId,
        grant.certificateId,
      ].join("\u0000"));
      protocol = new MatrixMlp3ProtocolClient(
        {
          workspaceId: config.gatewayId,
          roomId: config.roomId,
          projectId: grant.projectId,
        },
        identity,
        trust,
        {
          async sendMessage(request) {
            return {
              eventId: await sendMatrixMlp3ApplicationEvent(
                client,
                request.roomId,
                request.content as unknown as RoomMessageEventContent,
                request.transactionId,
              ),
            };
          },
        },
        store,
        publishProjectionIfAuthoritative,
        (_event, error) => {
          // Per-event quarantine is intentionally non-fatal. Diagnostics keep
          // the exact error while the following event continues projecting.
          console.error("[mlp3/matrix] quarantined timeline event", error);
        },
      );
    }
    await protocol.initialize();
    await protocol.acceptKeyGrant(grant);
    await protocol.drainInbox();
    if (readiness.canPublishAuthoritativeProjection) {
      await protocol.retryPending();
      publishProjection();
    } else {
      // A non-empty durable projection remains useful for offline reading, but
      // an absent/rebuilt projection cannot be presented as an authoritative
      // empty Gateway while current snapshots are still being fetched.
      publishCachedProjectionIfAvailable();
    }
    return true;
  };

  const createSecondaryProtocol = async (route: MatrixWorkspaceRoute): Promise<void> => {
    if (!trust || route.roomId === config.roomId || secondaryProtocols.has(route.projectId) ||
        pendingSecondaryProjects.has(route.projectId)) return;
    pendingSecondaryProjects.add(route.projectId);
    try {
      let routeRoom = client.getRoom(route.roomId);
      if (workspaceRouteNeedsJoin(routeRoom)) {
        routeRoom = await client.joinRoom(route.roomId);
      }
      if (!routeRoom) throw new Error(`Workspace project room ${route.roomId} is unavailable.`);
      if (!client.isRoomEncrypted(route.roomId)) {
        throw new Error(`Workspace project room ${route.roomId} is not encrypted.`);
      }
      const content = await client.getStateEvent(
        route.roomId,
        MLP3_MATRIX_PROJECT_KEY_GRANT_EVENT_TYPE,
        `${route.projectId}.${identity.keyId}`,
      );
      const resolution = resolveAuthoritativeProjectKeyGrant(content, {
        workspaceId: config.gatewayId,
        projectId: route.projectId,
        roomId: route.roomId,
        deviceId: identity.keyId,
        certificateId: trust.certificate.certificate.certificateId,
      });
      if (resolution.kind === "reauthorization-required") {
        throw new Error(`Project ${route.projectId} has not granted this Workspace device access.`);
      }
      const routeProtocol = new MatrixMlp3ProtocolClient(
      { workspaceId: config.gatewayId, roomId: route.roomId, projectId: route.projectId },
      identity,
      trust,
      {
        async sendMessage(request) {
          return { eventId: await sendMatrixMlp3ApplicationEvent(
            client, request.roomId,
            request.content as unknown as RoomMessageEventContent,
            request.transactionId,
          ) };
        },
      },
      new IndexedDbMatrixMlp3ClientStore([
        config.gatewayId, route.roomId, route.projectId, identity.keyId,
        trust.certificate.certificate.certificateId,
      ].join("\u0000")),
      () => {
        if ((activeSecondaryRecoveryCounts.get(route.projectId) ?? 0) > 0) return;
        const active = secondaryProtocols.get(route.projectId)?.protocol;
        if (active) publishProjection("live", [active]);
      },
      (_event, error) => console.error("[mlp3/matrix] quarantined project event", error),
    );
      await routeProtocol.initialize();
      await routeProtocol.acceptKeyGrant(resolution.grant);
      const context = { route, room: routeRoom, protocol: routeProtocol };
      secondaryProtocols.set(route.projectId, context);
      routeRoom.on(sdk.RoomStateEvent.Events, onRoomState);
      await recoverSecondaryProject(route.projectId, "hydrate");
      if (await routeProtocol.requiresThreadDirectoryRecovery(savedMatrixSyncToken)) {
        await replayThreadDirectory(
          route.roomId,
          event => ingestSecondaryEvent(context, event),
        );
      }
      await checkpointMatrixSync([routeProtocol]);
    } finally {
      pendingSecondaryProjects.delete(route.projectId);
    }
  };

  const recoverSecondaryProject = (
    targetProjectId: string,
    deliveryMode: ProjectionDeliveryMode = "live",
  ): Promise<void> => {
    activeSecondaryRecoveryCounts.set(
      targetProjectId,
      (activeSecondaryRecoveryCounts.get(targetProjectId) ?? 0) + 1,
    );
    const operation = (async () => {
      const context = secondaryProtocols.get(targetProjectId);
      if (!context || !trust) return;
      for (const [eventType, stateKey] of [
        [MLP3_MATRIX_WORKSPACE_POINTER_EVENT_TYPE, config.gatewayId],
        [MLP3_MATRIX_PROJECT_POINTER_EVENT_TYPE, targetProjectId],
      ] as const) {
        const content = await client.getStateEvent(context.route.roomId, eventType, stateKey);
        const pointer = await verifyMlp3Pointer(content, trust.gatewayKey.publicKey);
        if (pointer.workspaceId !== config.gatewayId || pointer.projectId !== targetProjectId ||
            pointer.roomId !== context.route.roomId || pointer.gatewayKeyId !== trust.gatewayKey.keyId) {
          throw new Error("The MLP/3 pointer is bound to another Workspace project.");
        }
        const raw = await client.fetchRoomEvent(context.route.roomId, pointer.eventId);
        await ingestSecondaryEvent(context, new sdk.MatrixEvent(raw));
      }
      for (const event of context.room.getLiveTimeline().getEvents()) {
        await ingestSecondaryEvent(context, event);
      }
      await context.protocol.retryPending();
      publishProjection(deliveryMode, [context.protocol]);
    })();
    activeSecondaryRecoveries.add(operation);
    const finish = () => {
      activeSecondaryRecoveries.delete(operation);
      const remaining = (activeSecondaryRecoveryCounts.get(targetProjectId) ?? 1) - 1;
      if (remaining > 0) {
        activeSecondaryRecoveryCounts.set(targetProjectId, remaining);
      } else {
        activeSecondaryRecoveryCounts.delete(targetProjectId);
      }
    };
    void operation.then(
      finish,
      finish,
    );
    return operation;
  };

  const ingestSecondaryEvent = async (
    context: { route: MatrixWorkspaceRoute; protocol: MatrixMlp3ProtocolClient },
    event: MatrixEvent,
  ): Promise<void> => {
    if (event.isEncrypted() || event.getType() === "m.room.encrypted") {
      await client.decryptEventIfNeeded(event);
    }
    if (event.isDecryptionFailure() || event.getType() !== "m.room.message") return;
    const eventId = event.getId();
    const sender = event.getSender();
    if (!eventId || !sender) return;
    await context.protocol.ingest({
      roomId: context.route.roomId,
      eventId,
      sender,
      timestamp: event.getTs(),
      content: event.getContent() as Record<string, unknown>,
    });
  };

  const acceptWorkspaceDirectory = async (input: unknown): Promise<void> => {
    if (!trust) return;
    trust = await applyWorkspaceGatewayDirectory(trust, input);
    config.workspaceRoutes = workspaceRoutesFromTrust(trust);
    handlers.onTrustUpdated?.(trust);
    publishProjection("live");
    reconcileWorkspaceRoutes();
  };

  const recoverWorkspaceDirectoryState = async (): Promise<void> => {
    if (!trust) return;
    try {
      await acceptWorkspaceDirectory(await client.getStateEvent(
        config.roomId,
        MLP3_MATRIX_WORKSPACE_DIRECTORY_EVENT_TYPE,
        config.gatewayId,
      ));
    } catch (error) {
      if (!isMatrixNotFound(error)) throw error;
    }
  };

  let routeReconciliationChain = Promise.resolve();
  reconcileWorkspaceRoutes = () => {
    if (!trust || stopped) return;
    const activeProtocols = activeWorkspaceProtocols();
    const trustedRoutes = workspaceRoutesFromTrust(trust);
    const discovered = workspaceRoutesFromProtocols(activeProtocols);
    const routes = trustedRoutes.length > 0
      ? trustedRoutes
      : discovered.length > 0 ? discovered : config.workspaceRoutes ?? [];
    routeReconciliationChain = routeReconciliationChain.then(async () => {
      const desired = new Map(routes
        .filter(route => route.roomId !== config.roomId)
        .map(route => [route.projectId, route]));
      for (const [secondaryProjectId, context] of secondaryProtocols) {
        const next = desired.get(secondaryProjectId);
        if (next?.roomId === context.route.roomId) continue;
        context.room.off(sdk.RoomStateEvent.Events, onRoomState);
        secondaryProtocols.delete(secondaryProjectId);
        for (const [commandId, owner] of commandProjects) {
          if (owner === context.protocol) commandProjects.delete(commandId);
        }
      }
      for (const route of desired.values()) await createSecondaryProtocol(route);
    }).catch(error => {
      // One unavailable project route must not downgrade every other Gateway
      // and project after the primary command path is authoritative.
      console.error("[mlp3/matrix] a Workspace project route could not be reconciled", error);
    });
  };

  const scanGrantState = async (): Promise<boolean> => {
    const currentRoom = room ?? client.getRoom(config.roomId);
    if (!currentRoom || !trust) return false;
    const states = currentRoom.currentState.getStateEvents(
      MLP3_MATRIX_PROJECT_KEY_GRANT_EVENT_TYPE,
    );
    const candidates = Array.isArray(states) ? states : states ? [states] : [];
    for (const event of candidates) {
      const parsed = mlp3ProjectKeyGrantStateSchema.safeParse(event.getContent());
      if (
        parsed.success
        && parsed.data.workspaceId === config.gatewayId
        && parsed.data.deviceId === identity.keyId
        && parsed.data.certificateId === trust.certificate.certificate.certificateId
      ) {
        await createProtocol(parsed.data);
        return true;
      }
    }
    return false;
  };

  const authoritativeProjectId = async (): Promise<string> => {
    if (!trust) throw new Error("This device has not approved a Gateway.");
    const content = await client.getStateEvent(
      config.roomId,
      MLP3_MATRIX_WORKSPACE_POINTER_EVENT_TYPE,
      config.gatewayId,
    );
    const pointer = await verifyMlp3Pointer(
      content,
      trust.gatewayKey.publicKey,
    );
    if (
      pointer.kind !== "workspace.current"
      || pointer.workspaceId !== config.gatewayId
      || !pointer.projectId
      || pointer.roomId !== config.roomId
      || pointer.gatewayKeyId !== trust.gatewayKey.keyId
    ) {
      throw new Error(
        "The authoritative workspace pointer is bound to another Gateway or room.",
      );
    }
    return pointer.projectId;
  };

  const openAuthoritativeProjectGrant = async (): Promise<boolean> => {
    if (!trust) return false;
    const currentProjectId = await authoritativeProjectId();
    let content: unknown | null;
    try {
      content = await client.getStateEvent(
        config.roomId,
        MLP3_MATRIX_PROJECT_KEY_GRANT_EVENT_TYPE,
        `${currentProjectId}.${identity.keyId}`,
      );
    } catch (error) {
      if (!isMatrixNotFound(error)) throw error;
      content = null;
    }
    const resolution = resolveAuthoritativeProjectKeyGrant(content, {
      workspaceId: config.gatewayId,
      projectId: currentProjectId,
      roomId: config.roomId,
      deviceId: identity.keyId,
      certificateId: trust.certificate.certificate.certificateId,
    });
    if (resolution.kind === "reauthorization-required") return false;
    return createProtocol(resolution.grant);
  };

  const ingestEvent = async (event: MatrixEvent): Promise<void> => {
    if (event.isEncrypted() || event.getType() === "m.room.encrypted") {
      await client.decryptEventIfNeeded(event);
    }
    if (event.isDecryptionFailure() || event.getType() !== "m.room.message") return;
    const eventId = event.getId();
    const sender = event.getSender();
    if (!eventId || !sender) return;
    const raw: MatrixMlp3RawEvent = {
      roomId: config.roomId,
      eventId,
      sender,
      timestamp: event.getTs(),
      content: event.getContent() as Record<string, unknown>,
    };
    const active = protocol;
    if (!active) {
      return;
    }
    await active.ingest(raw);
  };

  const recoverCurrentProjectSnapshot = async (): Promise<boolean> => {
    if (!trust || !protocol || !projectId) return false;
    const content = await client.getStateEvent(
      config.roomId,
      MLP3_MATRIX_PROJECT_POINTER_EVENT_TYPE,
      projectId,
    );
    const pointer = await verifyMlp3Pointer(
      content,
      trust.gatewayKey.publicKey,
    );
    if (
      pointer.kind !== "project.current"
      || pointer.workspaceId !== config.gatewayId
      || pointer.projectId !== projectId
      || pointer.roomId !== config.roomId
      || pointer.gatewayKeyId !== trust.gatewayKey.keyId
    ) throw new Error("The MLP/3 project pointer is bound to another Gateway or room.");
    const raw = await client.fetchRoomEvent(config.roomId, pointer.eventId);
    await ingestEvent(new sdk.MatrixEvent(raw));
    return true;
  };

  const recoverCurrentWorkspaceSnapshot = async (): Promise<boolean> => {
    if (!trust || !protocol || !projectId) return false;
    const content = await client.getStateEvent(
      config.roomId,
      MLP3_MATRIX_WORKSPACE_POINTER_EVENT_TYPE,
      config.gatewayId,
    );
    const pointer = await verifyMlp3Pointer(
      content,
      trust.gatewayKey.publicKey,
    );
    if (
      pointer.kind !== "workspace.current"
      || pointer.workspaceId !== config.gatewayId
      || pointer.projectId !== projectId
      || pointer.roomId !== config.roomId
      || pointer.gatewayKeyId !== trust.gatewayKey.keyId
    ) throw new Error("The MLP/3 workspace pointer is bound to another Gateway or room.");
    const raw = await client.fetchRoomEvent(config.roomId, pointer.eventId);
    await ingestEvent(new sdk.MatrixEvent(raw));
    return true;
  };

  let inboundChain = Promise.resolve();
  let recoveryChain = Promise.resolve();
  let checkpointChain = Promise.resolve();
  const enqueue = (event: MatrixEvent): void => {
    inboundChain = inboundChain.then(() => ingestEvent(event)).catch(error => {
      console.error("[mlp3/matrix] an application event could not be ingested", error);
      handlers.onStatus("error", "matrix_event_ingest_failed");
    });
  };
  const onMatrixEvent = (event: MatrixEvent) => {
    // Room.timeline is not an exhaustive sync feed: matrix-js-sdk routes
    // m.thread replies into per-thread timelines, and may omit them from the
    // room listener when the root is outside its active window. ClientEvent
    // delivers every event seen by /sync; the durable inbox then deduplicates
    // main-timeline, thread, and explicit-history copies by physical event ID.
    if (stopped) return;
    const secondary = [...secondaryProtocols.values()].find(
      value => value.route.roomId === event.getRoomId(),
    );
    if (secondary) {
      inboundChain = inboundChain.then(() => ingestSecondaryEvent(secondary, event)).catch(error => {
        console.error("[mlp3/matrix] a secondary project event could not be ingested", error);
      });
      return;
    }
    if (event.getRoomId() !== config.roomId) return;
    enqueue(event);
  };
  const onRoomState = (event: MatrixEvent) => {
    if (event.getType() === MLP3_MATRIX_WORKSPACE_DIRECTORY_EVENT_TYPE) {
      void acceptWorkspaceDirectory(event.getContent()).catch(error =>
        reportRecoveryFailure("A Workspace Gateway directory update was rejected", error));
      return;
    }
    const secondary = [...secondaryProtocols.values()].find(
      value => value.route.roomId === event.getRoomId(),
    );
    if (secondary) {
      if (event.getType() === MLP3_MATRIX_PROJECT_KEY_GRANT_EVENT_TYPE) {
        void secondary.protocol.acceptKeyGrant(event.getContent())
          .then(() => recoverSecondaryProject(secondary.route.projectId))
          .catch(error => console.error(
            `[mlp3/matrix] project ${secondary.route.projectId} key grant could not be opened`,
            error,
          ));
      } else if (
        event.getType() === MLP3_MATRIX_PROJECT_POINTER_EVENT_TYPE ||
        event.getType() === MLP3_MATRIX_WORKSPACE_POINTER_EVENT_TYPE
      ) {
        void recoverSecondaryProject(secondary.route.projectId)
          .catch(error => console.error(
            `[mlp3/matrix] project ${secondary.route.projectId} snapshot could not be recovered`,
            error,
          ));
      }
      return;
    }
    if (event.getType() === MLP3_MATRIX_PROJECT_KEY_GRANT_EVENT_TYPE) {
      void createProtocol(event.getContent())
        .then(opened => opened ? recoverAuthoritativeState() : undefined)
        .catch(error => {
          reportRecoveryFailure("The project key grant could not be opened", error);
        });
      return;
    }
    if (
      event.getType() === MLP3_MATRIX_PROJECT_POINTER_EVENT_TYPE
      || event.getType() === MLP3_MATRIX_WORKSPACE_POINTER_EVENT_TYPE
    ) {
      void recoverAuthoritativeState().catch(error => {
        reportRecoveryFailure("The current MLP/3 snapshots could not be recovered", error);
      });
    }
  };
  const onSync = (state: string) => {
    if (stopped) return;
    if (
      state === "RECONNECTING"
      || state === "CATCHUP"
      || state === "ERROR"
      || state === "STOPPED"
    ) {
      matrixSyncCatchingUp = true;
      matrixSyncCatchupGeneration += 1;
    }
    if (state === "SYNCING" || state === "PREPARED") {
      const persisted = flushMatrixSyncStore(syncDatabase, syncStore);
      if (readiness.canPublishAuthoritativeProjection) {
        void protocol?.retryPending();
        void checkpointMatrixSync(activeWorkspaceProtocols(), persisted);
      }
      if (matrixSyncCatchingUp) {
        const generation = matrixSyncCatchupGeneration;
        const catchupBoundary = (async () => {
          await inboundChain;
          await recoveryChain;
          while (activeSecondaryRecoveries.size > 0) {
            await Promise.all([...activeSecondaryRecoveries]);
          }
        })();
        void catchupBoundary.then(() => {
          if (
            stopped
            || generation !== matrixSyncCatchupGeneration
            || !matrixSyncCatchingUp
          ) return;
          if (readiness.canPublishAuthoritativeProjection) {
            publishProjection("catchup");
          }
          matrixSyncCatchingUp = false;
        }).catch(error => {
          if (generation === matrixSyncCatchupGeneration) {
            matrixSyncCatchingUp = false;
          }
          console.error("[mlp3/matrix] catch-up presentation could not converge", error);
        });
      }
    }
    const update = readiness.statusForMatrixSync(state);
    if (update) handlers.onStatus(update.status, update.detail);
  };

  const replayKnownTimeline = async (): Promise<void> => {
    const currentRoom = room;
    if (!currentRoom || !protocol) return;
    for (const event of currentRoom.getLiveTimeline().getEvents()) enqueue(event);
    if (await protocol.requiresThreadDirectoryRecovery(savedMatrixSyncToken)) {
      await replayThreadDirectory(config.roomId, ingestEvent);
    }
    await inboundChain;
  };

  const replayThreadDirectory = async (
    roomId: string,
    ingest: (event: MatrixEvent) => Promise<void>,
  ): Promise<void> => {
    let from: string | null = null;
    const seenTokens = new Set<string>();
    for (let pageIndex = 0; pageIndex < 1_000; pageIndex += 1) {
      const page = await client.createThreadListMessagesRequest(
        roomId,
        from,
        100,
        sdk.Direction.Backward,
        sdk.ThreadFilterType.All,
      );
      for (const rawEvent of page.chunk) {
        const raw = { ...rawEvent, room_id: rawEvent.room_id ?? roomId };
        await ingest(new sdk.MatrixEvent(raw));
        const latest = latestThreadEvent(rawEvent);
        if (latest) {
          await ingest(new sdk.MatrixEvent({
            ...latest,
            room_id: typeof latest.room_id === "string"
              ? latest.room_id
              : roomId,
          }));
        }
      }
      const next = typeof page.end === "string" && page.end ? page.end : null;
      if (!next) return;
      if (seenTokens.has(next)) {
        throw new Error("The Matrix thread directory repeated a pagination token.");
      }
      seenTokens.add(next);
      from = next;
    }
    throw new Error("The Matrix thread directory exceeded the 100,000-session safety limit.");
  };

  const checkpointMatrixSync = (
    targets: MatrixMlp3ProtocolClient[],
    persistedStore: Promise<void> = flushMatrixSyncStore(syncDatabase, syncStore),
  ): Promise<void> => {
    const token = syncStore.getSyncToken();
    if (!token || targets.length === 0) return Promise.resolve();
    const operation = checkpointChain.catch(() => undefined).then(async () => {
      await inboundChain;
      await persistedStore;
      await Promise.all(targets.map(target => target.checkpointMatrixSync(token)));
    });
    checkpointChain = operation;
    return operation;
  };

  const recoverAuthoritativeState = async (
    deliveryMode: ProjectionDeliveryMode = "live",
  ): Promise<void> => {
    const operation = recoveryChain.catch(() => undefined).then(async () => {
      readiness.beginRecovery();
      handlers.onStatus("connecting", "matrix_gateway_state_syncing");
      if (!authoritativeProjectionPrepared) {
        const active = protocol;
        if (!active) throw new Error("The MLP/3 project is not initialized.");
        await active.prepareAuthoritativeRecovery();
        authoritativeProjectionPrepared = true;
      }
      const [workspaceRecovered, projectRecovered] = await Promise.all([
        recoverCurrentWorkspaceSnapshot(),
        recoverCurrentProjectSnapshot(),
      ]);
      if (!workspaceRecovered || !projectRecovered) {
        const missing = [
          !workspaceRecovered ? "workspace" : null,
          !projectRecovered ? "project" : null,
        ].filter((value): value is string => value !== null).join(" and ");
        throw new Error(`The Gateway has not published the current ${missing} snapshot pointer.`);
      }
      await replayKnownTimeline();
      await protocol?.retryPending();
      await checkpointMatrixSync(activeWorkspaceProtocols());
      readiness.completeRecovery();
      publishProjection(deliveryMode);
      handlers.onStatus("connected");
    });
    recoveryChain = operation;
    await operation;
  };

  const reportRecoveryFailure = (context: string, error: unknown): void => {
    console.error(`[mlp3/matrix] ${context}`, error);
    if (error instanceof MatrixMlp3ReadModelRepairError) {
      readiness.failRecovery(error.code);
      handlers.onStatus("error", error.code);
      return;
    }
    const detail = "matrix_gateway_state_recovery_failed";
    readiness.failRecovery(detail);
    handlers.onStatus("error", detail);
  };

  const transportReady = (async () => {
    await withMatrixTimeout(syncStore.startup(), LOCAL_TIMEOUT_MS, "The Matrix sync store did not open in time.");
    savedMatrixSyncToken = await syncStore.getSavedSyncToken();
    handlers.onStatus("connecting", MATRIX_CRYPTO_LOADING_DETAIL);
    await withMatrixTimeout(
      client.initRustCrypto({ useIndexedDB: true, cryptoDatabasePrefix: cryptoScope }),
      MATRIX_CRYPTO_INITIALIZATION_TIMEOUT_MS,
      MATRIX_CRYPTO_INITIALIZATION_TIMEOUT_DETAIL,
    );
    const cryptoApi = client.getCrypto();
    if (!cryptoApi) throw new Error("Matrix encryption did not initialize.");
    const { AllDevicesIsolationMode } = await import("matrix-js-sdk/lib/crypto-api");
    cryptoApi.globalBlacklistUnverifiedDevices = true;
    cryptoApi.setDeviceIsolationMode(new AllDevicesIsolationMode(false));
    matrixDeviceKeys = await cryptoApi.getOwnDeviceKeys();
    if (!matrixDeviceKeys) throw new Error("Matrix device keys are unavailable.");
    client.on(sdk.ClientEvent.Sync, onSync);
    client.on(sdk.ClientEvent.Event, onMatrixEvent);
    await client.startClient({ initialSyncLimit: INITIAL_SYNC_LIMIT });
    await waitForInitialSync(client, sdk.ClientEvent.Sync);
    room = client.getRoom(config.roomId);
    if (!room) throw new Error("The bound Matrix project room is unavailable.");
    if (!client.isRoomEncrypted(config.roomId)) throw new Error("The Matrix project room is not encrypted.");
    room.on(sdk.RoomStateEvent.Events, onRoomState);
    if (trust) await verifyAndPinGatewayDevice(client, trust.gatewayTransport);
  })();

  const initialRecovery = transportReady.then(async () => {
    if (!trust) {
      handlers.onStatus("connected");
      completeReady();
      return;
    }
    if (!(await openAuthoritativeProjectGrant())) {
      readiness.failRecovery(MATRIX_PROJECT_AUTHORIZATION_REPAIR_REQUIRED);
      handlers.onStatus("error", MATRIX_PROJECT_AUTHORIZATION_REPAIR_REQUIRED);
      return;
    }
    await recoverAuthoritativeState("hydrate");
    await recoverWorkspaceDirectoryState();
    completeReady();
    reconcileWorkspaceRoutes();
  });
  void initialRecovery.catch(error => {
    reportRecoveryFailure("The current MLP/3 state could not be recovered", error);
    failReady(error);
  });

  const waitForGrant = async (signal?: AbortSignal): Promise<void> => {
    const deadline = Date.now() + 30_000;
    let nextAuthoritativeCheckAt = 0;
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new DOMException("Pairing was cancelled.", "AbortError");
      if (await scanGrantState()) return;
      if (Date.now() >= nextAuthoritativeCheckAt) {
        if (await openAuthoritativeProjectGrant()) return;
        nextAuthoritativeCheckAt = Date.now() + 1_000;
      }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw new Error(
      "The computer approved this device, but its conversation authorization did not arrive. Create a new one-time invitation on the computer and add this device again.",
    );
  };

  const pair = async (
    preview: PairingPreview,
    deviceName: string,
    signal?: AbortSignal,
  ): Promise<TrustedGateway> => {
    // Finish the bounded startup authorization check before rotating trust.
    // This prevents a late stale-grant result from overwriting a successful
    // reauthorization performed by this same connection.
    await initialRecovery;
    if (!matrixDeviceKeys) throw new Error("Matrix device keys are unavailable.");
    handlers.onStatus("securing", "Publishing this device’s encryption keys…");
    await waitForOwnMatrixDeviceKeys(config, matrixDeviceKeys, 30_000);
    handlers.onStatus("securing", "Verifying the Gateway encryption identity…");
    await verifyAndPinGatewayDevice(client, preview.transport);
    const paired = await completePairing(
      preview,
      identity,
      {
        homeserver: config.homeserver,
        roomId: config.roomId,
        userId: config.userId,
        deviceId: config.matrixDeviceId,
        ed25519: matrixDeviceKeys.ed25519,
      },
      deviceName,
      createMatrixPairingTransport(
        client,
        sdk.RoomEvent.Timeline,
        sdk.MatrixEventEvent.Decrypted,
        sdk.MsgType.Notice,
        config.roomId,
        detail => handlers.onStatus("securing", detail),
      ),
      signal,
    );
    trust = paired;
    handlers.onTrustUpdated?.(paired);
    readiness.beginRecovery();
    handlers.onStatus("connecting", "matrix_gateway_state_syncing");
    try {
      await waitForGrant(signal);
      await recoverAuthoritativeState("hydrate");
      await recoverWorkspaceDirectoryState();
      completeReady();
      reconcileWorkspaceRoutes();
    } catch (error) {
      reportRecoveryFailure("The paired Gateway state could not be recovered", error);
      throw error;
    }
    return paired;
  };

  const protocolForSession = (sessionId: string, targetProjectId?: string): {
    protocol: MatrixMlp3ProtocolClient;
    roomId: string;
  } | null => {
    const exact = protocolForProject(targetProjectId);
    if (exact?.projection.sessions.has(sessionId)) {
      return {
        protocol: exact,
        roomId: exact === protocol
          ? config.roomId
          : [...secondaryProtocols.values()].find(
              value => value.protocol === exact,
            )?.route.roomId ?? config.roomId,
      };
    }
    if (targetProjectId) return null;
    const active = activeWorkspaceProtocols();
    if (protocol && active.includes(protocol) && protocol.projection.sessions.has(sessionId)) {
      return { protocol, roomId: config.roomId };
    }
    for (const value of secondaryProtocols.values()) {
      if (active.includes(value.protocol) && value.protocol.projection.sessions.has(sessionId)) {
        return { protocol: value.protocol, roomId: value.route.roomId };
      }
    }
    return null;
  };

  const loadHistory = async (
    sessionId: string,
    limit = 30,
    targetProjectId?: string,
  ): Promise<MatrixHistoryPage> => {
    await ready;
    const context = protocolForSession(sessionId, targetProjectId);
    if (!context) throw new Error("The MLP/3 project is not initialized.");
    const active = context.protocol;
    const session = active.projection.sessions.get(sessionId);
    if (!session?.threadRootEventId) return { messages: [], hasMore: false };
    const pageLimit = Math.max(1, Math.min(limit, 100));
    const historyKey = targetProjectId ? `${targetProjectId}\0${sessionId}` : sessionId;
    const from = historyInitialized.has(historyKey)
      ? historyTokens.get(historyKey) ?? undefined
      : undefined;
    const path = [
      "/rooms/",
      encodeURIComponent(context.roomId),
      "/relations/",
      encodeURIComponent(session.threadRootEventId),
      "/",
      encodeURIComponent(sdk.RelationType.Thread),
    ].join("");
    type RawMatrixEvent = Parameters<
      ReturnType<MatrixClient["getEventMapper"]>
    >[0];
    const page = await client.http.authedRequest<{
      chunk: RawMatrixEvent[];
      next_batch?: string | null;
    }>(
      "GET" as Parameters<MatrixClient["http"]["authedRequest"]>[0],
      path,
      {
        dir: sdk.Direction.Backward,
        limit: Math.min(32, pageLimit),
        recurse: true,
        ...(from ? { from } : {}),
      },
      undefined,
      {
        prefix: ClientPrefix.V1,
        localTimeoutMs: MATRIX_HISTORY_REQUEST_TIMEOUT_MS,
      },
    );
    historyInitialized.add(historyKey);
    historyTokens.set(historyKey, page.next_batch ?? null);
    const mapEvent = client.getEventMapper();
    for (const event of page.chunk.map(raw => mapEvent(raw))) {
      if (active === protocol) {
        await ingestEvent(event);
      } else {
        const secondary = [...secondaryProtocols.values()].find(
          value => value.protocol === active,
        );
        if (secondary) await ingestSecondaryEvent(secondary, event);
      }
    }
    const delivered = deliveredHistory.get(historyKey) ?? new Set<string>();
    deliveredHistory.set(historyKey, delivered);
    const messages = active.projection.sessionMessages(sessionId)
      .filter(message =>
        !delivered.has(message.logicalId) && !delivered.has(message.physicalEventId)
      )
      .slice(-pageLimit)
      .map(message => {
        delivered.add(message.logicalId);
        delivered.add(message.physicalEventId);
        return toIncomingMessage(message, undefined, "history", targetProjectId);
      });
    return { messages, hasMore: Boolean(page.next_batch) };
  };

  const loadLocalHistory = async (
    sessionId: string,
    targetProjectId?: string,
  ): Promise<MatrixHistoryPage> => {
    await ready;
    const active = protocolForSession(sessionId, targetProjectId)?.protocol;
    if (!active) throw new Error("The MLP/3 project is not initialized.");
    const historyKey = targetProjectId ? `${targetProjectId}\0${sessionId}` : sessionId;
    const delivered = deliveredHistory.get(historyKey) ?? new Set<string>();
    deliveredHistory.set(historyKey, delivered);
    const available = active.projection.sessionMessages(sessionId)
      .filter(message =>
        !delivered.has(message.logicalId) && !delivered.has(message.physicalEventId)
      );
    const messages = available.slice(-CATCHUP_PRESENTATION_LIMIT_PER_SESSION)
      .map(message => {
        delivered.add(message.logicalId);
        delivered.add(message.physicalEventId);
        return toIncomingMessage(message, undefined, "history", targetProjectId);
      });
    return {
      messages,
      hasMore: available.length > messages.length,
    };
  };

  const uploadAttachment = async (file: File): Promise<MalinkAttachment> => {
    await ready;
    if (file.size > MAX_MALINK_ATTACHMENT_BYTES) throw new Error("Attachment is too large.");
    const plaintext = new Uint8Array(await file.arrayBuffer());
    const encrypted = await encryptMedia(plaintext);
    const uploaded = await client.uploadContent(
      new Blob([toArrayBuffer(encrypted.ciphertext)], { type: "application/octet-stream" }),
      { type: "application/octet-stream", includeFilename: false },
    );
    return attachmentSchema.parse({
      id: crypto.randomUUID(),
      name: file.name,
      mimeType: file.type || "application/octet-stream",
      size: plaintext.byteLength,
      sha256: await sha256(plaintext),
      media: { url: uploaded.content_uri, ...encrypted.descriptor },
    });
  };

  const downloadAttachment = async (input: MalinkAttachment): Promise<Blob> => {
    await ready;
    const attachment = attachmentSchema.parse(input);
    const url = client.mxcUrlToHttp(attachment.media.url, undefined, undefined, undefined, false, false, true);
    if (!url) throw new Error("Matrix media URL is invalid.");
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${client.getAccessToken()}` },
      redirect: "error",
    });
    if (!response.ok) throw new Error(`Matrix media download failed with HTTP ${response.status}.`);
    const ciphertext = new Uint8Array(await response.arrayBuffer());
    if (ciphertext.byteLength > attachment.media.size) throw new Error("Encrypted attachment exceeds its signed size.");
    const plaintext = await decryptMedia(ciphertext, attachment.media);
    if (plaintext.byteLength !== attachment.size || await sha256(plaintext) !== attachment.sha256) {
      throw new Error("Attachment integrity verification failed.");
    }
    return new Blob([toArrayBuffer(plaintext)], { type: attachment.mimeType });
  };

  return {
    ready,
    identity,
    get matrixDeviceKeys() {
      if (!matrixDeviceKeys) throw new Error("Matrix device keys are not ready.");
      return matrixDeviceKeys;
    },
    get deviceTransport() {
      if (!matrixDeviceKeys) throw new Error("Matrix device keys are not ready.");
      return {
        homeserver: config.homeserver,
        roomId: config.roomId,
        userId: config.userId,
        deviceId: config.matrixDeviceId,
        ed25519: matrixDeviceKeys.ed25519,
      };
    },
    pair,
    async send(payload, targetProjectId) {
      await ready;
      const target = protocolForProject(targetProjectId);
      if (!target) throw new Error("The target Workspace project is not initialized.");
      const sent = await target.send(payload);
      commandProjects.set(sent.commandId, target);
      return {
        eventId: sent.eventId ?? `$malink.queued.${sent.commandId}`,
        commandId: sent.commandId,
        ...(sent.sessionId ? { sessionId: sent.sessionId } : {}),
        sequence: 1,
        revision: 0,
        completion: sent.completion.then(toLegacyCompletion),
      };
    },
    async updateProjectExtensions(extensions, targetProjectId) {
      await ready;
      const target = protocolForProject(targetProjectId);
      if (!target) throw new Error("The target Workspace project is not initialized.");
      const sent = await target.updateProjectExtensions(extensions);
      commandProjects.set(sent.commandId, target);
      return {
        eventId: sent.eventId ?? `$malink.queued.${sent.commandId}`,
        commandId: sent.commandId,
        sequence: 1,
        revision: 0,
        completion: sent.completion.then(toLegacyCompletion),
      };
    },
    async updateWebPushSubscription(subscription) {
      await ready;
      const targets = activeWorkspaceProtocols();
      if (targets.length === 0) throw new Error("The Malink v3 projects are not initialized.");
      const sentCommands = await Promise.all(
        targets.map(target => target.updateWebPushSubscription(subscription)),
      );
      sentCommands.forEach((sent, index) => commandProjects.set(sent.commandId, targets[index]!));
      const sent = sentCommands[0]!;
      return {
        eventId: sent.eventId ?? `$malink.queued.${sent.commandId}`,
        commandId: sent.commandId,
        sequence: 1,
        revision: 0,
        completion: Promise.all(sentCommands.map(value => value.completion)).then(completions => {
          const failed = completions.find(value => value.outcome !== "succeeded");
          return toLegacyCompletion(failed ?? completions[0]!);
        }),
      };
    },
    async recoverCommand(commandId) {
      await ready;
      const candidates = commandProjects.has(commandId)
        ? [commandProjects.get(commandId)!]
        : activeWorkspaceProtocols();
      let sent: Awaited<ReturnType<MatrixMlp3ProtocolClient["recover"]>> | undefined;
      for (const candidate of candidates) {
        try { sent = await candidate.recover(commandId); commandProjects.set(commandId, candidate); break; }
        catch (error) { if (!String(error).includes("unavailable")) throw error; }
      }
      if (!sent) throw new Error(`The durable command ${commandId} is unavailable.`);
      return {
        eventId: sent.eventId ?? `$malink.queued.${sent.commandId}`,
        commandId: sent.commandId,
        sequence: 1,
        revision: 0,
        completion: sent.completion.then(toLegacyCompletion),
      };
    },
    uploadAttachment,
    downloadAttachment,
    confirmRevisionRetry() {
      throw new Error("MLP/3 has no global revision conflict to retry.");
    },
    discardRevisionConflict: async () => undefined,
    markHistoryLoaded(sessionId, eventIds, targetProjectId) {
      const historyKey = targetProjectId ? `${targetProjectId}\0${sessionId}` : sessionId;
      const delivered = deliveredHistory.get(historyKey) ?? new Set<string>();
      deliveredHistory.set(historyKey, delivered);
      for (const eventId of eventIds) delivered.add(eventId);
    },
    loadLocalHistory,
    loadHistoryPage: loadHistory,
    async observeCommandCompletion(commandId, timeoutMs) {
      const target = commandProjects.get(commandId) ?? activeWorkspaceProtocols()[0];
      if (!target) throw new Error("The MLP/3 project is not initialized.");
      return toLegacyCompletion(await target.observeCompletion(commandId, timeoutMs));
    },
    async releaseCommand(commandId) {
      await ready;
      const target = commandProjects.get(commandId);
      if (!target) return;
      await target.release(commandId);
      commandProjects.delete(commandId);
    },
    stop() {
      if (stopped) return;
      stopped = true;
      client.off(sdk.ClientEvent.Event, onMatrixEvent);
      room?.off(sdk.RoomStateEvent.Events, onRoomState);
      for (const value of secondaryProtocols.values()) {
        value.room.off(sdk.RoomStateEvent.Events, onRoomState);
      }
      client.off(sdk.ClientEvent.Sync, onSync);
      client.stopClient();
      handlers.onStatus("offline");
      void flushAndReleaseMatrixSyncStore(syncDatabase, syncStore, cryptoLock);
    },
  };
}

async function sendMatrixMlp3ApplicationEvent(
  client: MatrixClient,
  roomId: string,
  content: RoomMessageEventContent,
  transactionId: string,
): Promise<string> {
  const path = [
    "/rooms/",
    encodeURIComponent(roomId),
    "/send/m.room.message/",
    encodeURIComponent(transactionId),
  ].join("");
  const response = await client.http.authedRequest<{ event_id: string }>(
    "PUT" as Parameters<MatrixClient["http"]["authedRequest"]>[0],
    path,
    undefined,
    content,
  );
  return response.event_id;
}

export function toIncomingMessage(
  message: import("./matrixMlp3Projection").V3ProjectedMessage,
  replacesEventId?: string,
  deliveryMode: MessageDeliveryMode = "live",
  projectId?: string,
): IncomingMalinkMessage {
  const payload = message.payload;
  const toolGroup = toolGroupFromMlp3Payload(payload, message.timestamp);
  return {
    // Logical MLP identity is the cross-client/UI identity. Matrix event IDs
    // change whenever a streamed message version is emitted and are transport
    // metadata only. The replacement alias migrates caches written by older
    // browser builds that incorrectly keyed bubbles by physical event ID.
    eventId: message.logicalId,
    sender: message.sender === "user" ? "device" : "gateway",
    timestamp: message.timestamp,
    encrypted: true,
    kind: payload?.type === "decision.requested" || payload?.type === "extension.interaction.requested"
      ? "permission"
      : payload?.type === "turn.failed" || payload?.type === "command.rejected"
        ? "error"
        : message.sender === "user"
          ? "user"
          : toolGroup
            ? "tool"
            : "agent",
    text: message.body,
    sessionId: message.sessionId,
    ...(projectId ? { projectId } : {}),
    deliveryMode,
    ...(deliveryMode === "history" ? { historical: true } : {}),
    ...(message.commandId ? { commandId: message.commandId } : {}),
    ...(message.originDeviceId ? { originDeviceId: message.originDeviceId } : {}),
    ...(payload?.type === "decision.requested" || payload?.type === "extension.interaction.requested"
      ? { requestId: payload.requestId }
      : {}),
    ...(replacesEventId || message.physicalEventId
      ? { replacesEventId: replacesEventId || message.physicalEventId }
      : {}),
    format: message.format,
    ...(payload?.type === "assistant.message" && payload.attachments
      ? { attachments: payload.attachments }
      : {}),
    ...(toolGroup ? { toolGroup } : {}),
    raw: payload
      ? {
          ...structuredClone(payload) as Record<string, unknown>,
          ...(message.resolvedActionId
            ? { resolvedActionId: message.resolvedActionId }
            : {}),
        }
      : {},
  };
}

function toolGroupFromMlp3Payload(
  payload: import("@malink/protocol").Mlp3Event["payload"] | undefined,
  timestamp: number,
): ToolGroupPresentation | undefined {
  if (payload?.type === "assistant.message") {
    return parseToolGroupPresentation(payload.ui);
  }
  if (payload?.type !== "tool.activity") return undefined;
  return {
    kind: "tool_group",
    version: 1,
    groupId: payload.toolCallId,
    tools: [{
      id: payload.toolCallId,
      name: payload.name,
      title: payload.name,
      category: "unknown",
      phase: payload.phase,
      isError: payload.phase === "failed",
      startedAt: timestamp,
      updatedAt: timestamp,
    }],
  };
}

export function toLegacyCompletion(
  completion: import("./matrixMlp3Projection").Mlp3CommandCompletion,
): CommandCompletion {
  const payload = completion.event.payload;
  const artifactResult = payload.type === "assistant.message"
    ? artifactMaterializationResult(payload.ui)
    : null;
  return {
    commandId: completion.commandId,
    sequence: 1,
    revision: 0,
    outcome: completion.outcome === "succeeded" || completion.outcome === "cancelled"
      ? completion.outcome
      : "failed",
    ...(completion.sessionId ? { sessionId: completion.sessionId } : {}),
    ...(payload.type === "device.invitation.created"
      ? { result: { pairingLink: payload.pairingLink, expiresAt: payload.expiresAt } }
      : payload.type === "gateway.enrollment.invitation.created"
        ? { result: { enrollmentLink: payload.enrollmentLink, expiresAt: payload.expiresAt } }
      : payload.type === "gateway.enrollment.approved"
        ? {
            result: {
              gatewayNodeId: payload.gatewayNodeId,
              gatewayName: payload.gatewayName,
            },
          }
      : payload.type === "gateway.profile.updated"
        ? {
            result: {
              gatewayNodeId: payload.gatewayNodeId,
              gatewayName: payload.gatewayName,
              computerName: payload.computerName,
            },
          }
      : payload.type === "project.created"
        ? { result: payload }
      : payload.type === "gateway.update.status"
        ? { result: payload.status }
      : payload.type === "provider.sessions.listed" || payload.type === "provider.session.inspected"
        ? { result: payload }
      : payload.type === "command.reconciled" && payload.result !== undefined
        ? { result: payload.result }
      : artifactResult
        ? { result: artifactResult }
      : {}),
    ...(payload.type === "turn.failed"
      ? { error: { code: payload.code, message: payload.message, retryable: false } }
      : payload.type === "command.rejected"
        ? { error: { code: payload.code, message: payload.message, retryable: payload.retryable } }
      : payload.type === "command.reconciled" && payload.error
        ? { error: payload.error }
        : {}),
  };
}

function artifactMaterializationResult(
  value: unknown,
): { status: "materialized" | "changed"; referenceId: string } | null {
  const marker = asRecord(value);
  const status = marker?.status;
  const referenceId = marker?.referenceId;
  return marker?.kind === "artifact_materialization"
    && marker.version === 1
    && (status === "materialized" || status === "changed")
    && typeof referenceId === "string"
    && referenceId.length > 0
    ? { status, referenceId }
    : null;
}

function gatewayState(
  protocol: MatrixMlp3ProtocolClient,
  config: MatrixConnectionConfig,
  trust: TrustedGateway | null,
): GatewayStateSnapshot {
  const project = protocol.projection.project;
  const sessions = protocol.projection.visibleSessions();
  const inboxFiles = protocol.projection.visibleInboxFiles();
  const gatewayDirectory = trust?.gatewayDirectory
    ?? protocol.projection.workspace?.gatewayDirectory;
  const gatewayNodeId = gatewayDirectory?.directory.gateways.find(gateway =>
    (gateway.projects ?? []).some(route => route.projectId === project?.projectId)
  )?.gatewayNodeId;
  const updateObservation = protocol.projection.gatewayUpdateObservation;
  const gatewayNodeStatuses = gatewayNodeId && updateObservation
    ? {
        [gatewayNodeId]: {
          version: 1 as const,
          gatewayNodeId,
          observedAt: updateObservation.observedAt,
          update: structuredClone(updateObservation.status),
        },
      }
    : {};
  const capabilities = protocol.projection.workspace
    ? parseGatewayCapabilities(protocol.projection.workspace.capabilities)
    : {
        models: [],
        providers: [],
        permissionModes: [{ id: "default", name: "Default" }],
        canCreateSession: true,
        canSelectSession: false,
        canArchiveSession: true,
        canDeleteSession: false,
        sessionExtensions: project?.installedExtensions ?? [],
      };
  return {
    stateVersion: Math.max(1, ...sessions.map(session => session.stateVersion)),
    revision: 0,
    revisionEpoch: "matrix-native-v3",
    revisionEpochGeneration: 1,
    activeDeviceCount: trust?.activeDeviceCount ?? 1,
    updatedAt: Math.max(
      0,
      ...sessions.map(session => session.updatedAt),
      ...inboxFiles.map(file => file.receivedAt),
      ...Object.values(gatewayNodeStatuses).map(status => status.observedAt),
    ),
    currentSessionId: null,
    sessions: sessions.map(session => ({
      id: session.sessionId,
      title: session.title,
      updatedAt: session.updatedAt,
      stateVersion: session.stateVersion,
      status: session.lifecycle === "archived"
        ? "archived"
        : session.activity === "working" || session.activity === "queued"
          ? "running"
          : session.activity === "failed"
            ? "failed"
            : "idle",
      activityPhase: session.activity === "working"
        ? "working"
        : session.activity === "queued"
          ? "starting"
          : session.activity === "failed"
            ? "failed"
            : "idle",
      scope: session.scope ?? "project",
      projectId: session.projectId,
      projectName: session.scope === "scratch" ? "Temporary" : project?.name ?? "Project",
      cwd: session.cwd ?? project?.cwd ?? "",
      provider: session.provider ?? project?.provider ?? "unknown",
      ...(session.model ? { model: session.model } : {}),
      ...(session.reasoningEffort ? { reasoningEffort: session.reasoningEffort } : {}),
      ...(session.activeTurnId ? { activeTurnId: session.activeTurnId } : {}),
      extensions: session.extensions ?? [],
      availableCommands: session.availableCommands ?? [],
    })),
    inboxFiles: inboxFiles.map(file => ({
      id: file.fileId,
      receivedAt: file.receivedAt,
      ...(file.caption ? { caption: file.caption } : {}),
      ...(file.sourceLabel ? { sourceLabel: file.sourceLabel } : {}),
      attachment: file.attachment,
    })),
    workspace: {
      projectId: project?.projectId ?? "unknown",
      projectName: project?.name ?? "Project",
      cwd: project?.cwd ?? "",
      provider: project?.provider ?? "unknown",
      ...(project?.model ? { model: project.model } : {}),
      ...(project?.reasoningEffort ? { reasoningEffort: project.reasoningEffort } : {}),
      permissionMode: project?.permissionMode ?? "default",
      defaultExtensions: project?.defaultExtensions ?? [],
      extensionDefaultsRevision: project?.extensionDefaultsRevision ?? 1,
      capabilities,
    },
    capabilities,
    nativeClientReleases: protocol.projection.workspace?.clientReleases ?? [],
    ...(gatewayDirectory
      ? { gatewayDirectory }
      : {}),
    pendingGatewayEnrollments:
      protocol.projection.workspace?.pendingGatewayEnrollments ?? [],
    ...(Object.keys(gatewayNodeStatuses).length > 0
      ? { gatewayNodeStatuses }
      : {}),
    ...(protocol.projection.workspace?.gatewayUpdate
      ? { gatewayUpdate: protocol.projection.workspace.gatewayUpdate }
      : {}),
  };
}

function aggregateGatewayState(
  protocols: readonly MatrixMlp3ProtocolClient[],
  config: MatrixConnectionConfig,
  trust: TrustedGateway | null,
): GatewayStateSnapshot {
  const states = protocols.map(value => gatewayState(value, config, trust));
  const first = states[0]!;
  const directory = states
    .map(value => value.gatewayDirectory)
    .filter((value): value is NonNullable<typeof value> => Boolean(value))
    .sort((left, right) => right.directory.revision - left.directory.revision)[0];
  const pendingGatewayEnrollments = states
    .flatMap(value => value.pendingGatewayEnrollments ?? [])
    .filter((value, index, all) =>
      all.findIndex(candidate => candidate.enrollmentId === value.enrollmentId) === index
    )
    .sort((left, right) => left.requestedAt - right.requestedAt);
  const gatewayUpdate = states
    .map(value => value.gatewayUpdate)
    .filter((value): value is NonNullable<typeof value> => Boolean(value))
    .sort((left, right) => right.updatedAt - left.updatedAt)[0];
  const gatewayNodeStatuses = states.reduce<NonNullable<GatewayStateSnapshot["gatewayNodeStatuses"]>>(
    (result, state) => {
      for (const [gatewayNodeId, status] of Object.entries(state.gatewayNodeStatuses ?? {})) {
        if (!result[gatewayNodeId] || result[gatewayNodeId]!.observedAt < status.observedAt) {
          result[gatewayNodeId] = status;
        }
      }
      return result;
    },
    {},
  );
  return {
    ...first,
    stateVersion: Math.max(...states.map(value => value.stateVersion)),
    updatedAt: Math.max(...states.map(value => value.updatedAt ?? 0)),
    activeDeviceCount: Math.max(...states.map(value => value.activeDeviceCount)),
    sessions: states.flatMap(value => value.sessions),
    projects: states.map(value => value.workspace)
      .filter((value, index, all) =>
        all.findIndex(candidate => candidate.projectId === value.projectId) === index
      ),
    inboxFiles: states.flatMap(value => value.inboxFiles ?? []),
    nativeClientReleases: states.flatMap(value => value.nativeClientReleases ?? [])
      .filter((value, index, all) => all.findIndex(candidate => candidate.buildId === value.buildId) === index),
    ...(directory ? { gatewayDirectory: directory } : {}),
    pendingGatewayEnrollments,
    ...(Object.keys(gatewayNodeStatuses).length > 0
      ? { gatewayNodeStatuses }
      : {}),
    ...(gatewayUpdate ? { gatewayUpdate } : {}),
  };
}

function workspaceRoutesFromTrust(trust: TrustedGateway): MatrixWorkspaceRoute[] {
  return (trust.gatewayDirectory?.directory.gateways ?? []).flatMap(gateway =>
    (gateway.projects ?? []).map(project => ({
      projectId: project.projectId,
      gatewayNodeId: gateway.gatewayNodeId,
      roomId: project.roomId,
      conversationId: project.conversationId,
      gatewayMatrixUserId: gateway.transport.userId,
      gatewayMatrixDeviceId: gateway.transport.deviceId,
      gatewayMatrixEd25519: gateway.transport.ed25519,
    })),
  );
}

function workspaceRoutesFromProtocols(
  protocols: readonly MatrixMlp3ProtocolClient[],
): MatrixWorkspaceRoute[] {
  const directory = protocols
    .map(value => value.projection.workspace?.gatewayDirectory)
    .filter((value): value is NonNullable<typeof value> => Boolean(value))
    .sort((left, right) => right.directory.revision - left.directory.revision)[0];
  if (!directory) return [];
  return directory.directory.gateways.flatMap(gateway =>
    (gateway.projects ?? []).map(project => ({
      projectId: project.projectId,
      gatewayNodeId: gateway.gatewayNodeId,
      roomId: project.roomId,
      conversationId: project.conversationId,
      gatewayMatrixUserId: gateway.transport.userId,
      gatewayMatrixDeviceId: gateway.transport.deviceId,
      gatewayMatrixEd25519: gateway.transport.ed25519,
    })),
  );
}

function isMatrixNotFound(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as {
    errcode?: unknown;
    httpStatus?: unknown;
    status?: unknown;
  };
  return (
    candidate.errcode === "M_NOT_FOUND"
    || candidate.httpStatus === 404
    || candidate.status === 404
  );
}

function latestThreadEvent(input: unknown): Record<string, unknown> | null {
  const unsigned = asRecord(asRecord(input)?.unsigned);
  const relations = asRecord(unsigned?.["m.relations"]);
  const thread = asRecord(relations?.["m.thread"]);
  return asRecord(thread?.latest_event);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
