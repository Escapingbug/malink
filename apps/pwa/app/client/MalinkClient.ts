import type {
  ClientMessage,
  CommandView,
  HelloResult,
  PairingPreview,
  PublicTrustState,
  NativeUpdateStatus,
} from "@malink/native-bridge";
import type {
  MalinkAttachment,
  CommandPayload,
  SessionExtensionBinding,
  WebPushSubscription as Mlp3WebPushSubscription,
} from "@malink/protocol";
import type { CommandCompletion } from "../commandLifecycle";
import type { MatrixLoginTokenResult } from "../matrixAuth";
import type {
  CollaborationState,
  MatrixConnectionStatus,
} from "../matrix";

export type MalinkClientRuntime = "web" | "native";
export type MalinkPwaSourceInfo = {
  currentBaseUrl: string;
  officialBaseUrl: string;
  source: "official" | "custom";
};
export type MalinkNativeRuntimeInfo = HelloResult["native"] & {
  pwaSource?: MalinkPwaSourceInfo;
  /** Additive capability; absent on APKs that only scan Matrix history. */
  commandJournalReconciliation?: boolean;
  /** Additive capability for permanently retiring an unverified local command. */
  orphanCommandRetirement?: boolean;
};
export type MalinkMessage = ClientMessage & {
  /** Browser-only verified route context; absent on legacy/native hosts. */
  projectId?: string;
};
export type MalinkPairingPreview = PairingPreview;
export type MalinkPublicTrust = Extract<
  PublicTrustState,
  { state: "trusted" }
>;

export type MalinkCommandSendResult = {
  operationId: string;
  commandId: string;
  sessionId?: string;
  sequence: number;
  revision: number;
  completion: Promise<CommandCompletion>;
};

export type MalinkHistoryPage = {
  messages: MalinkMessage[];
  hasMore: boolean;
};

export type MalinkHistoryRecovery = MalinkHistoryPage & {
  sessionId: string;
};

export type MalinkCommandReview = {
  commandId: string;
  operation?: CommandPayload["operation"];
  expectedRevision?: number;
};

export type MalinkRecoveredSessionCreate = {
  commandId: string;
  submittedAt: number;
  completion: CommandCompletion & { sessionId: string };
};

export type MalinkRecoveredDurableCommand = Pick<
  CommandView,
  "commandId" | "state" | "sessionId" | "submittedAt" | "updatedAt"
> & { commandId: string };

export class CommandReviewRequiredError extends Error {
  constructor(readonly review: MalinkCommandReview) {
    super(
      "A previous action conflicts with newer Gateway state. Review or discard it before starting another action.",
    );
    this.name = "CommandReviewRequiredError";
  }
}

export type MalinkClientHandlers = {
  onMessage(message: MalinkMessage): void;
  onStatus(status: MatrixConnectionStatus, detail?: string): void;
  onNativeRuntime?(runtime: MalinkNativeRuntimeInfo | null): void;
  onTrustUpdated?(trust: MalinkPublicTrust | null): void;
  onCollaborationState?(state: CollaborationState): void;
  onCommandResult?(result: CommandCompletion): void;
  onSessionCreateRecovered?(recovery: MalinkRecoveredSessionCreate): void;
  onDurableCommandRecovered?(command: MalinkRecoveredDurableCommand): void;
  onCommandReviewRequired?(review: MalinkCommandReview | null): void;
  onHistoryRecovered?(page: MalinkHistoryRecovery): void;
  onConvergenceRequired?(): void;
};

/**
 * Native-safe UI boundary. No Matrix access token, CryptoKey, raw Matrix event,
 * signed trust certificate, or provider SDK object may cross this interface.
 *
 * `dispose()` follows the UI host lifecycle: a web client closes the transport
 * owned by the current tab, while a native client only detaches the WebView and
 * leaves its foreground service connected. `disconnect()` is the explicit user
 * action that stops the active transport on every runtime.
 */
export interface MalinkClient {
  readonly runtime: MalinkClientRuntime;
  readonly ready: Promise<void>;
  readonly deviceId: string;
  readonly deviceName: string;

  pair(
    pairingLink: string,
    deviceName: string,
    signal?: AbortSignal,
  ): Promise<MalinkPublicTrust>;
  requestMatrixLoginToken(
    invitationId: string,
    password?: string,
  ): Promise<MatrixLoginTokenResult>;
  send(payload: CommandPayload, projectId?: string): Promise<MalinkCommandSendResult>;
  updateProjectExtensions?(
    extensions: SessionExtensionBinding[],
    projectId?: string,
  ): Promise<MalinkCommandSendResult>;
  updateWebPushSubscription?(
    subscription: Mlp3WebPushSubscription | null,
  ): Promise<MalinkCommandSendResult>;
  recoverCommand(commandId: string): Promise<MalinkCommandSendResult>;
  uploadAttachment(file: File): Promise<MalinkAttachment>;
  downloadAttachment(attachment: MalinkAttachment): Promise<Blob>;
  confirmRevisionRetry(commandId: string): Promise<MalinkCommandSendResult>;
  discardRevisionConflict(commandId: string): Promise<void>;
  markHistoryLoaded(
    sessionId: string,
    eventIds: readonly string[],
    projectId?: string,
  ): void;
  /** Reads the runtime's durable local projection without Matrix I/O. */
  loadLocalHistory(sessionId: string, projectId?: string): Promise<MalinkHistoryPage>;
  loadHistoryPage(
    sessionId: string,
    limit?: number,
    projectId?: string,
  ): Promise<MalinkHistoryPage>;
  observeCommandCompletion(
    commandId: string,
    timeoutMs: number,
  ): Promise<CommandCompletion>;
  releaseCommand(commandId: string): Promise<void>;
  retireUnverifiedCommand?(commandId: string): Promise<void>;
  nativeUpdateStatus?(): Promise<NativeUpdateStatus>;
  checkNativeUpdate?(): Promise<NativeUpdateStatus>;
  installNativeUpdate?(): Promise<NativeUpdateStatus>;
  exportDiagnostics?(): Promise<boolean>;

  disconnect(): Promise<void>;
  dispose(): void;
}
