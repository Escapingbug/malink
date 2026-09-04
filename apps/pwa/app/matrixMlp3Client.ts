import {
  MALINK_MATRIX_EXTENSION,
  mlp3ProjectKeyGrantStateSchema,
  type Mlp3Command,
  type Mlp3Event,
  type Mlp3ProjectKeyGrantPlaintext,
  type CommandPayload,
  type SessionExtensionBinding,
  type WebPushSubscription as Mlp3WebPushSubscription,
} from "@malink/protocol";
import {
  base64UrlDecode,
  openMlp3Envelope,
  openMlp3ProjectKeyGrant,
  sealMlp3Envelope,
  signMlp3Command,
  verifyMlp3Command,
  verifyMlp3Event,
  verifyWorkspaceGatewayDirectory,
} from "@malink/security";
import type { DeviceIdentity } from "./matrix";
import type { TrustedGateway } from "./pairing";
import {
  MatrixMlp3Projection,
  type MatrixMlp3ProjectionState,
  type Mlp3CommandCompletion,
} from "./matrixMlp3Projection";

export type MatrixMlp3RawEvent = {
  roomId: string;
  eventId: string;
  sender: string;
  timestamp: number;
  content: Record<string, unknown>;
};

export type MatrixMlp3OutboxRecord = {
  command: Mlp3Command;
  content: Record<string, unknown>;
  transactionId: string;
  status: "pending" | "completed";
  matrixEventId?: string;
  completion?: Mlp3CommandCompletion;
};

export type MatrixMlp3InboxRecord = {
  raw: MatrixMlp3RawEvent;
  status: "pending" | "projected" | "quarantined";
  error?: string;
};

export interface MatrixMlp3ClientStore {
  putOutbox(record: MatrixMlp3OutboxRecord): Promise<void>;
  getOutbox(commandId: string): Promise<MatrixMlp3OutboxRecord | null>;
  deleteOutbox(commandId: string): Promise<void>;
  listPendingOutbox(): Promise<MatrixMlp3OutboxRecord[]>;
  putInbox(record: MatrixMlp3InboxRecord): Promise<boolean>;
  getInbox(eventId: string): Promise<MatrixMlp3InboxRecord | null>;
  listInbox(): Promise<MatrixMlp3InboxRecord[]>;
  listPendingInbox(): Promise<MatrixMlp3InboxRecord[]>;
  updateInbox(eventId: string, update: Pick<MatrixMlp3InboxRecord, "status" | "error">): Promise<void>;
  deleteInbox(eventId: string): Promise<void>;
  loadProjection(): Promise<unknown | null>;
  saveProjection(state: MatrixMlp3ProjectionState): Promise<void>;
  loadSyncCheckpoint(): Promise<string | null>;
  saveSyncCheckpoint(token: string): Promise<void>;
  clearProjection(): Promise<void>;
  /** Drops only Matrix-derived inbox/projection state; durable outbox survives. */
  resetRebuildableState(): Promise<void>;
}

export interface MatrixMlp3ClientTransport {
  sendMessage(input: {
    roomId: string;
    content: Record<string, unknown>;
    transactionId: string;
  }): Promise<{ eventId: string }>;
}

export type MatrixMlp3ClientConfig = {
  workspaceId: string;
  roomId: string;
  projectId: string;
};

export type MatrixMlp3SendResult = {
  commandId: string;
  sessionId?: string;
  eventId?: string;
  completion: Promise<Mlp3CommandCompletion>;
};

interface CompletionWaiter {
  resolve(value: Mlp3CommandCompletion): void;
  reject(error: Error): void;
}

const COMMAND_RECONCILIATION_MIN_INTERVAL_MS = 60_000;
const COMMAND_RECONCILIATION_FAILURE_INTERVAL_MS = 15_000;

/** Browser/native-web shared MLP/3 command, inbox and projection core. */
export class MatrixMlp3ProtocolClient {
  readonly projection = new MatrixMlp3Projection();
  private keyGrant: Mlp3ProjectKeyGrantPlaintext | null = null;
  private readonly waiters = new Map<string, Set<CompletionWaiter>>();
  private readonly reconciliationFlights = new Map<string, Promise<string>>();
  private readonly reconciliationNotBefore = new Map<string, number>();
  private drainChain: Promise<void> = Promise.resolve();
  private projectionSaveChain: Promise<void> = Promise.resolve();
  private initialization: Promise<void> | null = null;
  private projectionRestored = false;
  private readonly retriedQuarantinedEventIds = new Set<string>();

  constructor(
    private readonly config: MatrixMlp3ClientConfig,
    private readonly identity: DeviceIdentity,
    private readonly trust: TrustedGateway,
    private readonly transport: MatrixMlp3ClientTransport,
    private readonly store: MatrixMlp3ClientStore,
    private readonly onProjection?: () => void,
    private readonly onQuarantine?: (event: MatrixMlp3RawEvent, error: Error) => void,
  ) {}

  initialize(): Promise<void> {
    if (this.initialization) return this.initialization;
    this.initialization = (async () => {
      try {
        const state = await this.store.loadProjection();
        if (state === null) {
          // Inbox and projection form one rebuildable read model. Replaying an
          // unbounded retained inbox before contacting Matrix made startup grow
          // slower over time. If its materialized projection is absent, discard
          // the incomplete pair and recover from bounded authoritative state.
          await this.store.resetRebuildableState();
          this.projection.reset();
          return;
        }
        this.projection.restore(state);
        this.projectionRestored = true;
      } catch (error) {
        // The projection is rebuildable from the durable raw inbox and Matrix
        // history. Never let a stale/corrupt materialized view block startup.
        await this.repairRebuildableState(error);
      }
    })();
    return this.initialization;
  }

  async acceptKeyGrant(input: unknown): Promise<void> {
    await this.initialize();
    const grant = mlp3ProjectKeyGrantStateSchema.parse(input);
    const certificate = this.trust.certificate.certificate;
    if (
      grant.workspaceId !== this.config.workspaceId ||
      grant.projectId !== this.config.projectId ||
      grant.roomId !== this.config.roomId ||
      grant.deviceId !== certificate.deviceId ||
      grant.certificateId !== certificate.certificateId
    ) {
      throw new Error("The MLP/3 project key grant is not addressed to this device.");
    }
    this.keyGrant = await openMlp3ProjectKeyGrant(grant.sealedGrant, {
      expected: {
        grantId: grant.grantId,
        workspaceId: grant.workspaceId,
        projectId: grant.projectId,
        roomId: grant.roomId,
        deviceId: grant.deviceId,
        certificateId: grant.certificateId,
        senderKeyId: this.trust.gatewayKey.keyId,
        recipientKeyId: this.identity.keyId,
      },
      recipientPrivateKey: this.identity.privateKey,
      senderPublicKey: this.trust.gatewayKey.publicKey,
    });
  }

  async send(payload: CommandPayload): Promise<MatrixMlp3SendResult> {
    await this.initialize();
    const command = toMlp3Command(
      payload,
      this.config,
      this.identity.keyId,
      this.trust.certificate.certificate.certificateId,
    );
    return await this.sendCommand(command);
  }

  async updateProjectExtensions(
    defaultExtensions: SessionExtensionBinding[],
  ): Promise<MatrixMlp3SendResult> {
    await this.initialize();
    return await this.sendCommand({
      kind: "malink.command",
      version: 3,
      commandId: crypto.randomUUID(),
      workspaceId: this.config.workspaceId,
      projectId: this.config.projectId,
      deviceId: this.identity.keyId,
      certificateId: this.trust.certificate.certificate.certificateId,
      createdAt: Date.now(),
      operation: "project.update",
      payload: {
        operation: "project.update",
        patch: { defaultExtensions },
      },
    });
  }

  async updateWebPushSubscription(
    subscription: Mlp3WebPushSubscription | null,
  ): Promise<MatrixMlp3SendResult> {
    await this.initialize();
    const common = {
      kind: "malink.command" as const,
      version: 3 as const,
      commandId: crypto.randomUUID(),
      workspaceId: this.config.workspaceId,
      projectId: this.config.projectId,
      deviceId: this.identity.keyId,
      certificateId: this.trust.certificate.certificate.certificateId,
      createdAt: Date.now(),
    };
    return await this.sendCommand(subscription
      ? {
          ...common,
          operation: "notification.subscribe",
          payload: { operation: "notification.subscribe", subscription },
        }
      : {
          ...common,
          operation: "notification.unsubscribe",
          payload: { operation: "notification.unsubscribe" },
        });
  }

  private async sendCommand(command: Mlp3Command): Promise<MatrixMlp3SendResult> {
    const key = this.activeProjectKey();
    const signed = await signMlp3Command(
      command,
      this.identity.privateKey,
      this.identity.keyId,
    );
    const envelope = await sealMlp3Envelope({
      plaintext: { kind: "signed_command", value: signed },
      projectKey: base64UrlDecode(key.key),
      roomId: this.config.roomId,
      projectId: this.config.projectId,
      keyId: key.keyId,
      logicalEventId: command.commandId,
    });
    const rootEventId = command.operation === "session.create" || !command.sessionId
      ? undefined
      : this.projection.sessions.get(command.sessionId)?.threadRootEventId || undefined;
    const content = {
      msgtype: "m.notice",
      body: "Encrypted Malink command",
      ...(rootEventId ? { "m.relates_to": threadRelation(rootEventId) } : {}),
      [MALINK_MATRIX_EXTENSION]: { version: 3, envelope },
    };
    const record: MatrixMlp3OutboxRecord = {
      command,
      content,
      transactionId: transactionId(command.commandId),
      status: "pending",
    };
    await this.store.putOutbox(record);
    const completion = this.observeCompletion(command.commandId);
    const eventId = await this.transmit(record).catch(() => undefined);
    return {
      commandId: command.commandId,
      ...(command.sessionId ? { sessionId: command.sessionId } : {}),
      ...(eventId ? { eventId } : {}),
      completion,
    };
  }

  async recover(commandId: string): Promise<MatrixMlp3SendResult> {
    await this.initialize();
    const record = await this.store.getOutbox(commandId);
    if (!record) throw new Error(`The durable command ${commandId} is unavailable.`);
    if (record.completion) {
      return {
        commandId,
        ...(record.command.sessionId ? { sessionId: record.command.sessionId } : {}),
        ...(record.matrixEventId ? { eventId: record.matrixEventId } : {}),
        completion: Promise.resolve(record.completion),
      };
    }
    const completion = this.observeCompletion(commandId);
    const eventId = record.matrixEventId
      ? record.matrixEventId
      : await this.transmit(record).catch(() => undefined);
    if (record.matrixEventId) {
      await this.reconcile(record).catch(() => undefined);
    }
    return {
      commandId,
      ...(record.command.sessionId ? { sessionId: record.command.sessionId } : {}),
      ...(eventId ? { eventId } : {}),
      completion,
    };
  }

  async retryPending(): Promise<void> {
    await this.initialize();
    await Promise.all((await this.store.listPendingOutbox()).map(record =>
      this.transmit(record).catch(() => undefined),
    ));
  }

  async release(commandId: string): Promise<void> {
    await this.initialize();
    const record = await this.store.getOutbox(commandId);
    if (!record) return;
    if (record.status !== "completed") {
      throw new Error(`The durable command ${commandId} has not completed.`);
    }
    this.reconciliationFlights.delete(commandId);
    this.reconciliationNotBefore.delete(commandId);
    this.waiters.delete(commandId);
    await this.store.deleteOutbox(commandId);
  }

  async prepareAuthoritativeRecovery(): Promise<void> {
    await this.initialize();
    if (!this.keyGrant) {
      throw new Error("The MLP/3 project key grant has not been loaded.");
    }
    // A structurally valid current-schema projection is the local-first view.
    // Schema changes are handled by the startup migration, while Matrix
    // pointers and incremental events reconcile it. Do not replay the entire
    // retained inbox on every reconnect.
  }

  async requiresThreadDirectoryRecovery(
    savedMatrixSyncToken: string | null,
  ): Promise<boolean> {
    await this.initialize();
    if (!this.projectionRestored || !savedMatrixSyncToken) return true;
    return await this.store.loadSyncCheckpoint() !== savedMatrixSyncToken;
  }

  checkpointMatrixSync(token: string): Promise<void> {
    if (!token) throw new Error("The Matrix sync checkpoint is empty.");
    const operation = this.projectionSaveChain.then(async () => {
      await this.initialize();
      await this.store.saveSyncCheckpoint(token);
    });
    this.projectionSaveChain = operation.catch(() => undefined);
    return operation;
  }

  async ingest(raw: MatrixMlp3RawEvent): Promise<void> {
    await this.initialize();
    if (raw.roomId !== this.config.roomId) return;
    if (await this.store.putInbox({ raw, status: "pending" })) {
      await this.drainInbox();
      return;
    }
    if (this.retriedQuarantinedEventIds.has(raw.eventId)) return;
    const existing = await this.store.getInbox(raw.eventId);
    if (existing?.status !== "quarantined") return;
    if (this.retriedQuarantinedEventIds.has(raw.eventId)) return;
    this.retriedQuarantinedEventIds.add(raw.eventId);
    await this.store.updateInbox(raw.eventId, {
      status: "pending",
      error: undefined,
    });
    await this.drainInbox();
  }

  drainInbox(): Promise<void> {
    const operation = this.drainChain.then(async () => {
      await this.initialize();
      for (const record of await this.store.listPendingInbox()) {
        try {
          await this.projectRaw(record.raw);
          await this.store.deleteInbox(record.raw.eventId);
        } catch (error) {
          const normalized = error instanceof Error ? error : new Error(String(error));
          await this.store.updateInbox(record.raw.eventId, {
            status: "quarantined",
            error: normalized.message,
          });
          this.onQuarantine?.(record.raw, normalized);
        }
      }
    });
    this.drainChain = operation.then(() => undefined, () => undefined);
    return operation;
  }

  observeCompletion(commandId: string, timeoutMs?: number): Promise<Mlp3CommandCompletion> {
    return this.initialize().then(() => this.store.getOutbox(commandId)).then(record => {
      if (record?.completion) return record.completion;
      return new Promise<Mlp3CommandCompletion>((resolve, reject) => {
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const waiter: CompletionWaiter = {
          resolve(value) {
            if (timeout !== undefined) clearTimeout(timeout);
            resolve(value);
          },
          reject(error) {
            if (timeout !== undefined) clearTimeout(timeout);
            reject(error);
          },
        };
        const waiters = this.waiters.get(commandId) ?? new Set<CompletionWaiter>();
        waiters.add(waiter);
        this.waiters.set(commandId, waiters);
        if (timeoutMs !== undefined) {
          timeout = setTimeout(() => {
            waiters.delete(waiter);
            if (waiters.size === 0) this.waiters.delete(commandId);
            reject(new Error(`Command ${commandId} did not reach a terminal event in time.`));
          }, timeoutMs);
        }
      });
    });
  }

  private async transmit(record: MatrixMlp3OutboxRecord): Promise<string> {
    // A Matrix event ID is the durable server acknowledgement. The command
    // remains semantically pending until its terminal Gateway event arrives,
    // but repeatedly PUTting the same transaction on every /sync cycle only
    // creates a rate-limit feedback loop and cannot improve delivery.
    if (record.matrixEventId) {
      if (this.projection.applyCommand(record.command, record.matrixEventId)) {
        await this.persistProjection();
      }
      return record.matrixEventId;
    }
    const result = await this.transport.sendMessage({
      roomId: this.config.roomId,
      content: record.content,
      transactionId: record.transactionId,
    });
    const updated = { ...record, matrixEventId: result.eventId };
    await this.store.putOutbox(updated);
    if (this.projection.applyCommand(record.command, result.eventId)) {
      await this.persistProjection();
    }
    this.onProjection?.();
    return result.eventId;
  }

  private async reconcile(record: MatrixMlp3OutboxRecord): Promise<string> {
    // This is not a second business command. The exact signed/encrypted MLP/3
    // content is delivered under a fresh Matrix transaction so the Gateway
    // can consult its execution-once journal and publish current durable state.
    const commandId = record.command.commandId;
    const current = this.reconciliationFlights.get(commandId);
    if (current) return current;
    const now = Date.now();
    if (now < (this.reconciliationNotBefore.get(commandId) ?? 0)) {
      return record.matrixEventId ?? record.transactionId;
    }
    this.reconciliationNotBefore.set(
      commandId,
      now + COMMAND_RECONCILIATION_MIN_INTERVAL_MS,
    );
    const operation = this.transport.sendMessage({
      roomId: this.config.roomId,
      content: record.content,
      transactionId: reconciliationTransactionId(commandId),
    }).then(result => result.eventId).catch(error => {
      this.reconciliationNotBefore.set(
        commandId,
        Date.now() + COMMAND_RECONCILIATION_FAILURE_INTERVAL_MS,
      );
      throw error;
    }).finally(() => {
      if (this.reconciliationFlights.get(commandId) === operation) {
        this.reconciliationFlights.delete(commandId);
      }
    });
    this.reconciliationFlights.set(commandId, operation);
    return operation;
  }

  private async projectRaw(
    raw: MatrixMlp3RawEvent,
    persistAndPublish = true,
  ): Promise<void> {
    const extension = asRecord(raw.content[MALINK_MATRIX_EXTENSION]);
    if (extension?.version !== 3 || !extension.envelope) return;
    const key = this.keyForEnvelope(extension.envelope);
    const opened = await openMlp3Envelope(extension.envelope, {
      projectKey: base64UrlDecode(key.key),
      roomId: this.config.roomId,
      projectId: this.config.projectId,
      keyId: key.keyId,
    });
    if (opened.plaintext.kind === "signed_command") {
      const candidate = opened.plaintext.value.command;
      // Only our own command can be verified with the local public key. Remote
      // user text is projected from the Gateway-signed canonical event.
      if (candidate.deviceId === this.identity.keyId) {
        const command = await verifyMlp3Command(
          opened.plaintext.value,
          this.identity.publicKey,
          {
            workspaceId: this.config.workspaceId,
            projectId: this.config.projectId,
            deviceId: this.identity.keyId,
            certificateId: this.trust.certificate.certificate.certificateId,
          },
        );
        if (opened.envelope.logicalEventId !== command.commandId) {
          throw new Error("The MLP/3 command envelope logical ID is invalid.");
        }
        const changed = this.projection.applyCommand(command, raw.eventId, raw.timestamp);
        if (changed && persistAndPublish) {
          await this.persistProjection();
        }
      }
      if (persistAndPublish) this.onProjection?.();
      return;
    }
    const event = await verifyMlp3Event(
      opened.plaintext.value,
      this.trust.gatewayKey.publicKey,
      {
        workspaceId: this.config.workspaceId,
        projectId: this.config.projectId,
      },
    );
    if (
      event.payload.type === "workspace.snapshot"
      && event.payload.gatewayKeyId !== this.trust.gatewayKey.keyId
    ) {
      throw new Error("The MLP/3 workspace capability snapshot names another Gateway key.");
    }
    if (
      event.payload.type === "workspace.snapshot" &&
      event.payload.gatewayDirectory
    ) {
      await verifyWorkspaceGatewayDirectory(
        event.payload.gatewayDirectory,
        this.trust.gatewayKey.publicKey,
        { workspaceId: this.config.workspaceId },
      );
    }
    if (opened.envelope.logicalEventId !== event.eventId) {
      throw new Error("The MLP/3 event envelope logical ID is invalid.");
    }
    const relation = asRecord(raw.content["m.relates_to"]);
    const threadRootHint = relation?.rel_type === "m.thread" && typeof relation.event_id === "string"
      ? relation.event_id
      : undefined;
    const changed = this.projection.applyEvent(event, raw.eventId, threadRootHint);
    await this.recordCompletion(event);
    if (changed && persistAndPublish) {
      await this.persistProjection();
    }
    if (persistAndPublish) this.onProjection?.();
  }

  private async repairRebuildableState(cause: unknown): Promise<void> {
    try {
      await this.store.resetRebuildableState();
    } catch (error) {
      throw new MatrixMlp3ReadModelRepairError(
        "The local MLP/3 conversation cache could not be repaired.",
        { cause: new AggregateError([cause, error], "MLP/3 read-model repair failed.") },
      );
    }
    this.projection.reset();
    this.projectionRestored = false;
    this.retriedQuarantinedEventIds.clear();
    this.onProjection?.();
    console.warn(
      "[mlp3/matrix] discarded an incompatible local conversation cache; durable commands were preserved",
      cause,
    );
  }

  private async recordCompletion(event: Mlp3Event): Promise<void> {
    if (!event.causationCommandId) return;
    const completion = this.projection.completions.get(event.causationCommandId);
    if (!completion) return;
    this.reconciliationFlights.delete(event.causationCommandId);
    this.reconciliationNotBefore.delete(event.causationCommandId);
    const record = await this.store.getOutbox(event.causationCommandId);
    if (record) {
      await this.store.putOutbox({ ...record, status: "completed", completion });
    }
    const waiters = this.waiters.get(event.causationCommandId);
    this.waiters.delete(event.causationCommandId);
    for (const waiter of waiters ?? []) waiter.resolve(completion);
  }

  private persistProjection(): Promise<void> {
    const operation = this.projectionSaveChain.then(() =>
      this.store.saveProjection(this.projection.durableState())
    );
    this.projectionSaveChain = operation.catch(() => undefined);
    return operation;
  }

  private activeProjectKey() {
    const grant = this.keyGrant;
    if (!grant) throw new Error("The MLP/3 project key grant has not been loaded.");
    const key = grant.keys.find(candidate => candidate.keyId === grant.activeKeyId);
    if (!key) throw new Error("The active MLP/3 project key is unavailable.");
    return key;
  }

  private keyForEnvelope(input: unknown) {
    const envelope = asRecord(input);
    const keyId = typeof envelope?.keyId === "string" ? envelope.keyId : "";
    const key = this.keyGrant?.keys.find(candidate => candidate.keyId === keyId);
    if (!key) throw new Error(`MLP/3 project key ${keyId || "<missing>"} is unavailable.`);
    return key;
  }
}

/** Deterministic in-memory store used by protocol tests and ephemeral hosts. */
export class MemoryMatrixMlp3ClientStore implements MatrixMlp3ClientStore {
  readonly outbox = new Map<string, MatrixMlp3OutboxRecord>();
  readonly inbox = new Map<string, MatrixMlp3InboxRecord>();
  projectionState: MatrixMlp3ProjectionState | null = null;
  syncCheckpoint: string | null = null;
  async putOutbox(record: MatrixMlp3OutboxRecord): Promise<void> {
    this.outbox.set(record.command.commandId, structuredClone(record));
  }
  async getOutbox(commandId: string): Promise<MatrixMlp3OutboxRecord | null> {
    const record = this.outbox.get(commandId);
    return record ? structuredClone(record) : null;
  }
  async deleteOutbox(commandId: string): Promise<void> {
    this.outbox.delete(commandId);
  }
  async listPendingOutbox(): Promise<MatrixMlp3OutboxRecord[]> {
    return [...this.outbox.values()].filter(record => record.status === "pending").map(record => structuredClone(record));
  }
  async putInbox(record: MatrixMlp3InboxRecord): Promise<boolean> {
    if (this.inbox.has(record.raw.eventId)) return false;
    this.inbox.set(record.raw.eventId, structuredClone(record));
    return true;
  }
  async getInbox(eventId: string): Promise<MatrixMlp3InboxRecord | null> {
    const record = this.inbox.get(eventId);
    return record ? structuredClone(record) : null;
  }
  async listPendingInbox(): Promise<MatrixMlp3InboxRecord[]> {
    return [...this.inbox.values()].filter(record => record.status === "pending").map(record => structuredClone(record));
  }
  async listInbox(): Promise<MatrixMlp3InboxRecord[]> {
    return [...this.inbox.values()].map(record => structuredClone(record));
  }
  async updateInbox(
    eventId: string,
    update: Pick<MatrixMlp3InboxRecord, "status" | "error">,
  ): Promise<void> {
    const record = this.inbox.get(eventId);
    if (!record) throw new Error(`Unknown raw Matrix event ${eventId}`);
    this.inbox.set(eventId, {
      ...record,
      status: update.status,
      ...(update.error ? { error: update.error } : { error: undefined }),
    });
  }
  async deleteInbox(eventId: string): Promise<void> {
    this.inbox.delete(eventId);
  }
  async loadProjection(): Promise<unknown | null> {
    return this.projectionState ? structuredClone(this.projectionState) : null;
  }
  async saveProjection(state: MatrixMlp3ProjectionState): Promise<void> {
    this.projectionState = structuredClone(state);
  }
  async loadSyncCheckpoint(): Promise<string | null> {
    return this.syncCheckpoint;
  }
  async saveSyncCheckpoint(token: string): Promise<void> {
    if (this.projectionState) this.syncCheckpoint = token;
  }
  async clearProjection(): Promise<void> {
    this.projectionState = null;
    this.syncCheckpoint = null;
  }
  async resetRebuildableState(): Promise<void> {
    this.inbox.clear();
    this.projectionState = null;
    this.syncCheckpoint = null;
  }
}

export class MatrixMlp3ReadModelRepairError extends Error {
  readonly code = "matrix_projection_repair_required";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "MatrixMlp3ReadModelRepairError";
  }
}

function toMlp3Command(
  payload: CommandPayload,
  config: MatrixMlp3ClientConfig,
  deviceId: string,
  certificateId: string,
): Mlp3Command {
  const common = {
    kind: "malink.command" as const,
    version: 3 as const,
    commandId: crypto.randomUUID(),
    workspaceId: config.workspaceId,
    projectId: config.projectId,
    deviceId,
    certificateId,
    createdAt: Date.now(),
  };
  switch (payload.operation) {
    case "session.create":
      if (payload.cwd || payload.projectName) {
        throw new Error("A MLP/3 project is a Matrix room; create or select a project room instead of changing cwd per session.");
      }
      return {
        ...common,
        sessionId: crypto.randomUUID(),
        operation: "session.create",
        payload: {
          operation: "session.create",
          ...(payload.scope ? { scope: payload.scope } : {}),
          ...(payload.provider ? { provider: payload.provider } : {}),
          ...(payload.providerSessionId ? { providerSessionId: payload.providerSessionId } : {}),
          ...(payload.title ? { title: payload.title } : {}),
          ...(payload.model ? { model: payload.model } : {}),
          ...(payload.reasoningEffort ? { reasoningEffort: payload.reasoningEffort } : {}),
          ...(payload.permissionMode ? { permissionMode: payload.permissionMode } : {}),
          ...(payload.controls ? { controls: payload.controls } : {}),
          ...(payload.extensions ? { extensions: payload.extensions } : {}),
          ...(payload.initialPrompt
            ? { initialPrompt: { text: payload.initialPrompt } }
            : {}),
        },
      };
    case "prompt":
      return {
        ...common,
        sessionId: payload.sessionId,
        operation: "prompt.submit",
        payload: {
          operation: "prompt.submit",
          text: payload.text,
          ...(payload.attachments ? { attachments: payload.attachments } : {}),
        },
      };
    case "cancel":
      if (!payload.targetCommandId) throw new Error("The active turn ID is required to cancel a MLP/3 turn.");
      return {
        ...common,
        sessionId: payload.sessionId,
        operation: "turn.cancel",
        payload: { operation: "turn.cancel", turnId: payload.targetCommandId },
      };
    case "decision":
      return {
        ...common,
        sessionId: payload.sessionId,
        operation: "decision.answer",
        payload: {
          operation: "decision.answer",
          requestId: payload.requestId,
          decision: payload.decision,
          ...(payload.totp ? { totp: payload.totp } : {}),
        },
      };
    case "artifact.materialize":
      return {
        ...common,
        sessionId: payload.sessionId,
        operation: "artifact.materialize",
        payload: {
          operation: "artifact.materialize",
          referenceId: payload.referenceId,
          expectedStatRevision: payload.expectedStatRevision,
        },
      };
    case "session.settings": {
      if (payload.cwd || payload.projectName) {
        throw new Error("Project directory changes belong to a project room in MLP/3.");
      }
      return {
        ...common,
        sessionId: payload.sessionId,
        operation: "session.update",
        payload: {
          operation: "session.update",
          patch: {
            ...(payload.model ? { model: payload.model } : {}),
            ...(payload.reasoningEffort ? { reasoningEffort: payload.reasoningEffort } : {}),
            ...(payload.permissionMode ? { permissionMode: payload.permissionMode } : {}),
            ...(payload.controls ? { controls: payload.controls } : {}),
          },
        },
      };
    }
    case "project.settings":
      return {
        ...common,
        operation: "project.update",
        payload: {
          operation: "project.update",
          patch: {
            ...(payload.name === undefined ? {} : { name: payload.name }),
            ...(payload.model === undefined ? {} : { model: payload.model }),
            ...(payload.reasoningEffort === undefined
              ? {}
              : { reasoningEffort: payload.reasoningEffort }),
            ...(payload.controls === undefined ? {} : { controls: payload.controls }),
            ...(payload.defaultExtensions === undefined
              ? {}
              : { defaultExtensions: payload.defaultExtensions }),
          },
        },
      };
    case "project.delete":
      return {
        ...common,
        operation: "project.delete",
        payload: { operation: "project.delete" },
      };
    case "project.create":
      return {
        ...common,
        operation: "project.create",
        payload: {
          operation: "project.create",
          name: payload.name,
          cwd: payload.cwd,
          ...(payload.provider ? { provider: payload.provider } : {}),
          ...(payload.createDirectory === undefined
            ? {}
            : { createDirectory: payload.createDirectory }),
        },
      };
    case "provider.sessions.list":
      return {
        ...common,
        operation: "provider.sessions.list",
        payload: {
          operation: "provider.sessions.list",
          provider: payload.provider,
          ...(payload.cursor ? { cursor: payload.cursor } : {}),
        },
      };
    case "provider.session.inspect":
      return {
        ...common,
        operation: "provider.session.inspect",
        payload: {
          operation: "provider.session.inspect",
          provider: payload.provider,
          providerSessionId: payload.providerSessionId,
        },
      };
    case "provider.history.materialize":
      return {
        ...common,
        sessionId: payload.sessionId,
        operation: "provider.history.materialize",
        payload: {
          operation: "provider.history.materialize",
          expectedFrontier: payload.expectedFrontier,
          ...(payload.limit === undefined ? {} : { limit: payload.limit }),
        },
      };
    case "session.archive":
    case "session.restore":
    case "session.delete":
      return {
        ...common,
        sessionId: payload.sessionId,
        operation: "session.set_lifecycle",
        payload: {
          operation: "session.set_lifecycle",
          state: payload.operation === "session.archive" || payload.operation === "session.delete"
            ? "archived"
            : "active",
        },
      };
    case "device.invite":
      return {
        ...common,
        operation: "device.invitation.create",
        payload: {
          operation: "device.invitation.create",
          ...(payload.lifetimeMs ? { lifetimeMs: payload.lifetimeMs } : {}),
        },
      };
    case "gateway.enrollment.invite":
      return {
        ...common,
        operation: "gateway.enrollment.invitation.create",
        payload: {
          operation: "gateway.enrollment.invitation.create",
          ...(payload.lifetimeMs ? { lifetimeMs: payload.lifetimeMs } : {}),
        },
      };
    case "gateway.enrollment.approve":
      return {
        ...common,
        operation: "gateway.enrollment.approve",
        payload: {
          operation: "gateway.enrollment.approve",
          enrollmentId: payload.enrollmentId,
        },
      };
    case "gateway.enrollment.cancel":
      return {
        ...common,
        operation: "gateway.enrollment.cancel",
        payload: {
          operation: "gateway.enrollment.cancel",
          enrollmentId: payload.enrollmentId,
        },
      };
    case "gateway.profile.update":
      return {
        ...common,
        operation: "gateway.profile.update",
        payload: {
          operation: "gateway.profile.update",
          gatewayNodeId: payload.gatewayNodeId,
          gatewayName: payload.gatewayName,
        },
      };
    case "gateway.retire":
      return {
        ...common,
        operation: "gateway.retire",
        payload: {
          operation: "gateway.retire",
          gatewayNodeId: payload.gatewayNodeId,
          expectedDirectoryRevision: payload.expectedDirectoryRevision,
          expectedGatewayKeyId: payload.expectedGatewayKeyId,
        },
      };
    case "gateway.update.stage":
      return {
        ...common,
        operation: "gateway.update.stage",
        payload: {
          operation: "gateway.update.stage",
          releaseId: payload.releaseId,
        },
      };
    case "gateway.update.apply":
      return {
        ...common,
        operation: "gateway.update.apply",
        payload: {
          operation: "gateway.update.apply",
          releaseId: payload.releaseId,
          mode: payload.mode ?? "when_idle",
        },
      };
    case "gateway.update.status":
      return {
        ...common,
        operation: "gateway.update.status",
        payload: { operation: "gateway.update.status" },
      };
    case "gateway.restart":
      return {
        ...common,
        operation: "gateway.restart",
        payload: {
          operation: "gateway.restart",
          mode: payload.mode ?? "when_idle",
        },
      };
    case "gateway.restart.status":
      return {
        ...common,
        operation: "gateway.restart.status",
        payload: { operation: "gateway.restart.status" },
      };
  }
}

function threadRelation(rootEventId: string) {
  return {
    rel_type: "m.thread",
    event_id: rootEventId,
    is_falling_back: true,
    "m.in_reply_to": { event_id: rootEventId },
  };
}

function transactionId(commandId: string): string {
  return `malink.v3.command.${commandId}`;
}

function reconciliationTransactionId(commandId: string): string {
  return `malink.v3.reconcile.${commandId}.${crypto.randomUUID()}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
