export const NATIVE_BRIDGE_PROTOCOL_VERSION = 1 as const;

/** QR exports are intentionally much smaller than the bridge RPC envelope. */
export const NATIVE_IMAGE_SAVE_MAX_BYTES = 256 * 1024;

/** Authorization transfers share the protocol's bounded portable-file limit. */
export const NATIVE_AUTHORIZATION_EXPORT_MAX_BYTES = 128 * 1024;

export const NATIVE_BRIDGE_LIMITS = Object.freeze({
  maxRpcBytes: 512 * 1024,
  maxEventBatchBytes: 256 * 1024,
  maxEventBatchCount: 100,
  maxReplayEvents: 1_000,
  maxAttachmentBytes: 50 * 1024 * 1024,
  attachmentChunkBytes: 256 * 1024,
  maxJsonDepth: 32,
  maxRpcIdLength: 128,
});

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type RpcId = string;

export type RpcRequest<M extends string = string, P = JsonObject> = {
  jsonrpc: "2.0";
  id: RpcId;
  method: M;
  params: P;
};

export type RpcNotification<M extends string = string, P = JsonObject> = {
  jsonrpc: "2.0";
  method: M;
  params: P;
};

export type RpcSuccess<R = JsonValue> = {
  jsonrpc: "2.0";
  id: RpcId;
  result: R;
};

export type BridgeErrorCode =
  | "PARSE_ERROR"
  | "INVALID_REQUEST"
  | "METHOD_NOT_FOUND"
  | "INVALID_PARAMS"
  | "BRIDGE_NOT_READY"
  | "PROTOCOL_UNSUPPORTED"
  | "CAPABILITY_UNAVAILABLE"
  | "UNAUTHORIZED_ORIGIN"
  | "STALE_WEB_INSTANCE"
  | "INVALID_STATE"
  | "USER_CANCELLED"
  | "IDEMPOTENCY_CONFLICT"
  | "OPERATION_NOT_FOUND"
  | "OPERATION_NOT_RECOVERABLE"
  | "OFFLINE"
  | "TIMEOUT"
  | "RATE_LIMITED"
  | "TRUST_REQUIRED"
  | "TRUST_BLOCKED"
  | "PAIRING_EXPIRED"
  | "PAIRING_REJECTED"
  | "CURSOR_EXPIRED"
  | "HISTORY_CURSOR_INVALID"
  | "TRANSFER_NOT_FOUND"
  | "CHUNK_CONFLICT"
  | "ATTACHMENT_TOO_LARGE"
  | "HASH_MISMATCH"
  | "NATIVE_INTERNAL";

export type BridgeUserAction =
  | "retry"
  | "open_app"
  | "repair_trust"
  | "pair_again"
  | "update_native";

export type RpcErrorData = {
  errorCode: BridgeErrorCode;
  retryable: boolean;
  retryAfterMs?: number;
  operationId?: string;
  userAction?: BridgeUserAction;
  details?: JsonValue;
};

export type RpcError = {
  code: number;
  message: string;
  data: RpcErrorData;
};

export type RpcFailure = {
  jsonrpc: "2.0";
  id: RpcId | null;
  error: RpcError;
};

export type RpcResponse<R = JsonValue> = RpcSuccess<R> | RpcFailure;

export type CapabilityName =
  | "client.lifecycle"
  | "events.replay"
  | "state.snapshot"
  | "commands.durable"
  | "commands.journal-reconciliation"
  | "commands.orphan-retirement"
  | "history.page"
  | "attachments.chunked"
  | "pairing.native"
  | "trust.native"
  | "matrix.session-bootstrap"
  | "matrix.login-token"
  | "session.read-receipts"
  | "client.update"
  | "client.pwa-source"
  | "client.diagnostics"
  | "client.image-save"
  | "client.authorization-export"
  | "background.foreground-service";

export type CapabilityRequest = {
  name: CapabilityName | (string & {});
  versions: number[];
};

export type NegotiatedCapability = {
  version: number;
  options?: JsonObject;
};

export type HelloParams = {
  application: "malink-web";
  webBuild: string;
  webInstanceId: string;
  supportedProtocolVersions: number[];
  requiredCapabilities: CapabilityRequest[];
  optionalCapabilities: CapabilityRequest[];
};

export type HelloResult = {
  protocolVersion: number;
  bridgeSessionId: string;
  native: {
    runtimeVersion: string;
    runtimeBuild: string;
    platform: "android" | "windows" | "macos";
  };
  capabilities: Record<string, NegotiatedCapability>;
  limits: typeof NATIVE_BRIDGE_LIMITS;
};

export type BridgeContext = {
  bridgeSessionId: string;
};

export type ContextParams = {
  context: BridgeContext;
};

export type IdempotentMutationParams = ContextParams & {
  idempotencyKey: string;
};

export type LifecyclePhase =
  | "stopped"
  | "starting"
  | "unpaired"
  | "connecting"
  | "securing"
  | "ready"
  | "reconnecting"
  | "offline"
  | "blocked";

export type PublicTrustState =
  | { state: "unpaired" }
  | { state: "pairing"; pairingId: string; expiresAt: number }
  | {
      state: "trusted";
      gatewayId: string;
      gatewayNodeId?: string;
      gatewayName: string;
      certificateId: string;
      pairedAt: number;
      activeDeviceCount?: number;
    }
  | { state: "blocked"; reasonCode: string };

export type PublicCommandError = {
  code: string;
  message: string;
  retryable: boolean;
};

export type CommandCompletion = {
  commandId: string;
  /** Bridge-v1 compatibility metadata; it has no MLP/3 authorization meaning. */
  sequence: number;
  /** Bridge-v1 compatibility metadata; MLP/3 has no global revision gate. */
  revision: number;
  outcome: "succeeded" | "failed" | "cancelled";
  sessionId?: string;
  result?: JsonValue;
  error?: PublicCommandError;
};

export type CommandState =
  | "queued"
  | "transmitting"
  | "accepted"
  | "running"
  | "needs_review"
  | "recovery_required"
  | "succeeded"
  | "failed"
  | "cancelled";

export type CommandView = {
  operationId: string;
  commandId?: string;
  idempotencyKey: string;
  state: CommandState;
  submittedAt: number;
  updatedAt: number;
  sessionId?: string;
  /** Bridge-v1 compatibility metadata; it has no MLP/3 authorization meaning. */
  sequence?: number;
  /** Bridge-v1 compatibility metadata; MLP/3 has no global revision gate. */
  revision?: number;
  cancelRequested?: boolean;
  completion?: CommandCompletion;
};

export type CommandReceipt = Pick<
  CommandView,
  | "operationId"
  | "commandId"
  | "idempotencyKey"
  | "state"
  | "submittedAt"
  | "updatedAt"
  | "sessionId"
  | "sequence"
  | "revision"
>;

export type ClientSnapshot = {
  schemaVersion: 1;
  deviceId: string;
  cursor: string;
  generatedAt: number;
  lifecycle: {
    phase: LifecyclePhase;
    since: number;
    detailCode?: string;
  };
  foregroundService: {
    required: true;
    active: boolean;
    notificationVisible: boolean;
  };
  trust: PublicTrustState;
  gatewayState?: JsonObject;
  /** Latest verified session projection acknowledged by this Matrix account. */
  sessionReadState?: Record<string, number>;
  commands: CommandView[];
  pairing?: JsonObject;
};

export type ClientStartResult = {
  deviceId: string;
  snapshot: ClientSnapshot;
};

export type MatrixRoomBinding = {
  roomId: string;
  gatewayId: string;
  conversationId: string;
  gatewayUserId: string;
  gatewayDeviceId: string;
  gatewayDeviceEd25519: string;
};

export type PublicMatrixSession = {
  homeserver: string;
  userId: string;
  matrixDeviceId: string;
  roomBinding: MatrixRoomBinding;
  /** v2 exposes every native-owned project binding to a newly loaded PWA origin. */
  roomBindings?: MatrixRoomBinding[];
};

export type ClientBootstrapResult = {
  deviceId: string;
  session: PublicMatrixSession;
  snapshot: ClientSnapshot;
};

export type ClientSessionResult = {
  /** Null means Android has not established a native Matrix session yet. */
  session: PublicMatrixSession | null;
};

export type ClientDisconnectResult = {
  mode: "stop" | "revoke";
  snapshot: ClientSnapshot;
};

export type ClientEventType =
  | "client.status.changed"
  | "trust.changed"
  | "gateway.state.changed"
  | "session.read.changed"
  | "message.upserted"
  | "message.removed"
  | "command.changed"
  | "attachment.changed"
  | "pairing.changed";

export type ClientEvent = {
  schemaVersion: 1;
  eventId: string;
  cursor: string;
  occurredAt: number;
  type: ClientEventType;
  payload: JsonValue;
};

export type SessionReadUpdate = {
  sessionId: string;
  projectId?: string;
  readUpdatedAt: number;
};

export type EventsSubscribeParams = {
  context: BridgeContext;
  afterCursor?: string;
  maxReplayEvents?: number;
};

export type EventsSubscribeResult = {
  subscriptionId: string;
  barrierCursor: string;
} & (
  | { mode: "replay"; events: ClientEvent[] }
  | { mode: "snapshot"; snapshot: ClientSnapshot }
);

export type EventsActivateParams = {
  context: BridgeContext;
  subscriptionId: string;
  throughCursor: string;
};

export type EventsAckParams = EventsActivateParams;

export type EventsCursorResult = {
  subscriptionId: string;
  throughCursor: string;
};

export type EventsUnsubscribeResult = {
  subscriptionId: string;
  unsubscribed: true;
};

export type EventsDeliverNotification = RpcNotification<
  "malink.events.deliver",
  { subscriptionId: string; events: ClientEvent[] }
>;

export type EncryptedMedia = {
  url: string;
  key: string;
  iv: string;
  sha256: string;
  size: number;
};

export type MalinkAttachment = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  sha256: string;
  media: EncryptedMedia;
};

export type ToolCategory =
  | "read"
  | "edit"
  | "write"
  | "execute"
  | "search"
  | "agent"
  | "unknown";

export type ToolPhase = "started" | "updated" | "completed" | "failed";

export type ToolPresentationItem = {
  id: string;
  name: string;
  title: string;
  detail?: string;
  result?: string;
  category: ToolCategory;
  phase: ToolPhase;
  isError: boolean;
  startedAt: number;
  updatedAt: number;
};

export type ToolGroupPresentation = {
  kind: "tool_group";
  version: 1;
  groupId: string;
  tools: ToolPresentationItem[];
};

/**
 * Presentation context for an already authenticated message. This is not part
 * of the message's durable identity and must never create another Matrix or
 * ClientEvent copy.
 */
export type MessageDeliveryMode = "live" | "catchup" | "history";

export type ClientMessage = {
  eventId: string;
  sender: string;
  timestamp: number;
  /** True only after the native runtime authenticated and decrypted it. */
  encrypted: boolean;
  kind: "notice" | "user" | "agent" | "tool" | "permission" | "error";
  text?: string;
  sessionId?: string;
  deliveryMode?: MessageDeliveryMode;
  /** Legacy history marker retained for older native/web clients. */
  historical?: boolean;
  operationId?: string;
  requestId?: string;
  replacesEventId?: string;
  commandId?: string;
  revision?: number;
  originDeviceId?: string;
  originDeviceName?: string;
  activeDeviceCount?: number;
  format: "plain" | "markdown" | "html";
  attachments?: MalinkAttachment[];
  toolGroup?: ToolGroupPresentation;
  /** Normalized Malink semantic payload; never a raw Matrix event. */
  semantic?: JsonObject;
};

export type HistoryPageResult = {
  sessionId: string;
  messages: ClientMessage[];
  nextBefore?: string;
  hasMore: boolean;
  asOfCursor: string;
};

export type PairingPreview = {
  pairingId: string;
  gatewayId: string;
  gatewayName: string;
  verificationCode: string;
  expiresAt: number;
  requiresNativeConfirmation: true;
};

export type PairingCompleteResult = {
  trust: Extract<PublicTrustState, { state: "trusted" }>;
  snapshot: ClientSnapshot;
};

export type PairingCancelResult = {
  pairingId: string;
  cancelled: true;
};

export type AttachmentUploadOpenResult = {
  transferId: string;
  chunkBytes: number;
  nextIndex: number;
  expiresAt: number;
};

export type AttachmentUploadChunkResult = {
  transferId: string;
  index: number;
  receivedBytes: number;
  nextIndex: number;
};

export type AttachmentUploadFinishResult = {
  attachment: MalinkAttachment;
};

export type AttachmentUploadAbortResult = {
  transferId: string;
  aborted: true;
};

export type AttachmentDownloadOpenResult = {
  transferId: string;
  size: number;
  sha256: string;
  chunkBytes: number;
  chunkCount: number;
};

export type AttachmentDownloadReadResult = {
  transferId: string;
  index: number;
  dataBase64Url: string;
  chunkSha256: string;
  eof: boolean;
};

export type AttachmentDownloadCloseResult = {
  transferId: string;
  closed: true;
};

export type CommandReleaseResult = {
  commandId: string;
  released: true;
};

export type CommandRetireResult = {
  commandId: string;
  retired: true;
};

export type NativeUpdateStatus = {
  phase:
    | "current"
    | "checking"
    | "available"
    | "downloading"
    | "ready"
    | "installing"
    | "permission_required"
    | "failed";
  currentVersionCode: number;
  currentVersionName: string;
  latestVersionCode?: number;
  latestVersionName?: string;
  buildId?: string;
  downloadedBytes?: number;
  totalBytes?: number;
  detailCode?: string;
  checkedAt?: number;
};

export type DiagnosticsExportResult = {
  status: "share_opened";
  filename: string;
};

export type ImageSaveResult = {
  status: "saved";
  filename: string;
};

export type AuthorizationExportResult = {
  status: "saved";
  filename: string;
};

export const REQUEST_METHODS = [
  "malink.bridge.hello",
  "malink.client.start",
  "malink.client.session",
  "malink.client.bootstrap",
  "malink.client.rejoin",
  "malink.matrix.loginToken",
  "malink.client.snapshot",
  "malink.client.disconnect",
  "malink.update.status",
  "malink.update.check",
  "malink.update.install",
  "malink.diagnostics.export",
  "malink.image.save",
  "malink.authorization.export",
  "malink.events.subscribe",
  "malink.events.activate",
  "malink.events.ack",
  "malink.events.unsubscribe",
  "malink.command.send",
  "malink.command.cancel",
  "malink.command.recover",
  "malink.command.get",
  "malink.command.release",
  "malink.command.retire",
  "malink.command.resolveConflict",
  "malink.history.page",
  "malink.session.markRead",
  "malink.attachment.upload.open",
  "malink.attachment.upload.chunk",
  "malink.attachment.upload.finish",
  "malink.attachment.upload.abort",
  "malink.attachment.download.open",
  "malink.attachment.download.read",
  "malink.attachment.download.close",
  "malink.pairing.inspect",
  "malink.pairing.complete",
  "malink.pairing.cancel",
  "malink.trust.get",
] as const;

export type RequestMethod = (typeof REQUEST_METHODS)[number];

export const MUTATION_METHODS = [
  "malink.client.start",
  "malink.client.bootstrap",
  "malink.client.rejoin",
  "malink.matrix.loginToken",
  "malink.client.disconnect",
  "malink.update.check",
  "malink.update.install",
  "malink.image.save",
  "malink.authorization.export",
  "malink.command.send",
  "malink.command.cancel",
  "malink.command.recover",
  "malink.command.release",
  "malink.command.retire",
  "malink.command.resolveConflict",
  "malink.session.markRead",
  "malink.attachment.upload.open",
  "malink.attachment.upload.finish",
  "malink.attachment.upload.abort",
  "malink.pairing.complete",
  "malink.pairing.cancel",
] as const satisfies readonly RequestMethod[];

export type MutationMethod = (typeof MUTATION_METHODS)[number];

export type MatrixLoginTokenResult =
  | {
      status: "ready";
      /** Single-use secret. Callers must never log or persist this value. */
      loginToken: string;
      expiresAt: number;
    }
  | {
      status: "reauth-required";
      passwordSupported: boolean;
    }
  | {
      status: "unsupported";
    };

export type BridgeMethodParams = {
  "malink.bridge.hello": HelloParams;
  "malink.client.start": IdempotentMutationParams;
  "malink.client.session": ContextParams;
  "malink.client.bootstrap": IdempotentMutationParams & {
    homeserver: string;
    /** Single-use secret: never log it or persist it in an idempotency record. */
    oneTimeLoginToken: string;
    expectedUserId: string;
    deviceName: string;
    roomBinding: MatrixRoomBinding;
  };
  "malink.client.rejoin": IdempotentMutationParams & {
    /** Signed pairing offer approved by the already pinned Gateway. */
    pairingLink: string;
    homeserver: string;
    /** Single-use secret issued by an existing device on the Workspace account. */
    oneTimeLoginToken: string;
    expectedUserId: string;
    deviceName: string;
    roomBinding: MatrixRoomBinding;
  };
  "malink.matrix.loginToken": IdempotentMutationParams & {
    /** Successful device.invite command whose lifetime bounds this token. */
    invitationId: string;
    /** Reauthentication secret: memory-only and never included in diagnostics. */
    password?: string;
  };
  "malink.client.snapshot": ContextParams;
  "malink.client.disconnect": IdempotentMutationParams & {
    mode: "stop" | "revoke";
  };
  "malink.update.status": ContextParams;
  "malink.update.check": IdempotentMutationParams;
  "malink.update.install": IdempotentMutationParams;
  "malink.diagnostics.export": ContextParams;
  "malink.image.save": IdempotentMutationParams & {
    filename: string;
    mimeType: "image/png";
    dataBase64: string;
  };
  "malink.authorization.export": IdempotentMutationParams & {
    filename: string;
    mimeType: "application/vnd.malink.authorization+json";
    contents: string;
  };
  "malink.events.subscribe": EventsSubscribeParams;
  "malink.events.activate": EventsActivateParams;
  "malink.events.ack": EventsAckParams;
  "malink.events.unsubscribe": ContextParams & { subscriptionId: string };
  "malink.command.send": IdempotentMutationParams & {
    projectId?: string;
    payload: JsonObject & { operation: string };
  };
  "malink.command.cancel": IdempotentMutationParams & {
    sessionId: string;
    targetCommandId?: string;
  };
  "malink.command.recover": IdempotentMutationParams & { commandId: string };
  "malink.command.get": ContextParams & { commandId: string };
  "malink.command.release": IdempotentMutationParams & { commandId: string };
  "malink.command.retire": IdempotentMutationParams & { commandId: string };
  "malink.command.resolveConflict": IdempotentMutationParams & {
    commandId: string;
    action: "retry" | "discard";
  };
  "malink.history.page": ContextParams & {
    sessionId: string;
    before?: string;
    limit: number;
    /** v2: local projection reads can never perform Matrix network I/O. */
    source: "local" | "matrix";
  };
  "malink.session.markRead": IdempotentMutationParams & {
    sessionId: string;
    projectId?: string;
  };
  "malink.attachment.upload.open": IdempotentMutationParams & {
    name: string;
    mimeType: string;
    size: number;
    sha256: string;
  };
  "malink.attachment.upload.chunk": ContextParams & {
    transferId: string;
    index: number;
    dataBase64Url: string;
    chunkSha256: string;
  };
  "malink.attachment.upload.finish": IdempotentMutationParams & {
    transferId: string;
  };
  "malink.attachment.upload.abort": IdempotentMutationParams & {
    transferId: string;
  };
  "malink.attachment.download.open": ContextParams & {
    attachment: MalinkAttachment;
  };
  "malink.attachment.download.read": ContextParams & {
    transferId: string;
    index: number;
  };
  "malink.attachment.download.close": ContextParams & { transferId: string };
  "malink.pairing.inspect": ContextParams & { link: string };
  "malink.pairing.complete": IdempotentMutationParams & {
    pairingId: string;
    deviceName: string;
  };
  "malink.pairing.cancel": IdempotentMutationParams & { pairingId: string };
  "malink.trust.get": ContextParams;
};

export type BridgeMethodResults = {
  "malink.bridge.hello": HelloResult;
  "malink.client.start": ClientStartResult;
  "malink.client.session": ClientSessionResult;
  "malink.client.bootstrap": ClientBootstrapResult;
  "malink.client.rejoin": ClientBootstrapResult;
  "malink.matrix.loginToken": MatrixLoginTokenResult;
  "malink.client.snapshot": ClientSnapshot;
  "malink.client.disconnect": ClientDisconnectResult;
  "malink.update.status": NativeUpdateStatus;
  "malink.update.check": NativeUpdateStatus;
  "malink.update.install": NativeUpdateStatus;
  "malink.diagnostics.export": DiagnosticsExportResult;
  "malink.image.save": ImageSaveResult;
  "malink.authorization.export": AuthorizationExportResult;
  "malink.events.subscribe": EventsSubscribeResult;
  "malink.events.activate": EventsCursorResult;
  "malink.events.ack": EventsCursorResult;
  "malink.events.unsubscribe": EventsUnsubscribeResult;
  "malink.command.send": CommandReceipt;
  "malink.command.cancel": CommandReceipt;
  "malink.command.recover": CommandReceipt;
  "malink.command.get": CommandView;
  "malink.command.release": CommandReleaseResult;
  "malink.command.retire": CommandRetireResult;
  "malink.command.resolveConflict": CommandReceipt;
  "malink.history.page": HistoryPageResult;
  "malink.session.markRead": SessionReadUpdate;
  "malink.attachment.upload.open": AttachmentUploadOpenResult;
  "malink.attachment.upload.chunk": AttachmentUploadChunkResult;
  "malink.attachment.upload.finish": AttachmentUploadFinishResult;
  "malink.attachment.upload.abort": AttachmentUploadAbortResult;
  "malink.attachment.download.open": AttachmentDownloadOpenResult;
  "malink.attachment.download.read": AttachmentDownloadReadResult;
  "malink.attachment.download.close": AttachmentDownloadCloseResult;
  "malink.pairing.inspect": PairingPreview;
  "malink.pairing.complete": PairingCompleteResult;
  "malink.pairing.cancel": PairingCancelResult;
  "malink.trust.get": PublicTrustState;
};

export type BridgeRequest<M extends RequestMethod = RequestMethod> =
  M extends RequestMethod ? RpcRequest<M, BridgeMethodParams[M]> : never;

export type ParsedBridgeRequest = BridgeRequest;

export type MethodRpcResponse<M extends RequestMethod> =
  | RpcSuccess<BridgeMethodResults[M]>
  | RpcFailure;
