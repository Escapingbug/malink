"use client";

import {
  ChangeEvent,
  FormEvent,
  KeyboardEvent,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import {
  MAX_MALINK_ATTACHMENTS,
  MAX_MALINK_ATTACHMENT_BYTES,
  MAX_MALINK_PROMPT_ATTACHMENT_BYTES,
  encodePairingLink,
  providerHistoryMessageSchema,
  providerSessionEntrySchema,
  gatewayUpdateStatusSchema,
  type MalinkAttachment,
  type CommandPayload,
  type GatewayUpdateStatus,
  type ProviderHistoryMessage,
  type ProviderSessionEntry,
} from "@malink/protocol";
import type { NativeUpdateStatus } from "@malink/native-bridge";
import {
  CommandAcknowledgementTimeoutError,
  CommandCompletionTimeoutError,
  waitForCommandCompletion,
  type CommandCompletion,
} from "./commandLifecycle";
import {
  DeviceInvitationLifecycle,
  InvitationRequestCancelledError,
} from "./deviceInvitationLifecycle";
import {
  MatrixLoginTokenLifecycle,
  MatrixLoginTokenRequestCancelledError,
} from "./matrixLoginTokenLifecycle";
import {
  SENDING_AGENT_ACTIVITY,
  STARTING_AGENT_ACTIVITY,
  STOPPING_AGENT_ACTIVITY,
  WAITING_AGENT_ACTIVITY,
  WORKING_AGENT_ACTIVITY,
  agentExecutionSignal,
  reduceAgentActivity,
  type AgentActivity,
} from "./agentActivity";
import { MatrixSettings } from "./MatrixSettings";
import type { GatewayEnrollmentBusyState } from "./GatewayEnrollmentPanel";
import { waitForUiCommit } from "./uiScheduling";
import { hasPairingRoute, pairingRouteFromUrl } from "./pairingRoute";
import {
  NewSessionDialog,
  type NewSessionInput,
} from "./NewSessionDialog";
import {
  NewProjectDialog,
  type NewProjectInput,
  type ProjectCreationGateway,
} from "./NewProjectDialog";
import { ProviderHistoryDialog } from "./ProviderHistoryDialog";
import { findRecentlyArchivedProviderSession } from "./providerHistorySessions";
import {
  buildProviderHistorySources,
  findProviderHistorySource,
  findProviderHistorySourceByKey,
  firstMatchingProviderHistorySource,
  providerHistoryRequestKey,
  providerHistoryRequestMatches,
  type ProviderHistoryRouteIdentity,
  type ProviderHistorySource,
} from "./providerHistoryRouting";
import { GatewayForgetDialog } from "./GatewayForgetDialog";
import { PrivilegeTotpDialog } from "./PrivilegeTotpDialog";
import {
  enrollPrivilegeTotp,
  forgetPrivilegeTotp,
  hasPrivilegeTotp,
  unlockPrivilegeTotp,
} from "./privilegeTotp";
import {
  gatewayProjectKey,
  type GatewaySessionSummary,
} from "./gatewayState";
import {
  clearGatewayUiCache,
  readGatewayUiCache,
  writeGatewayUiCache,
} from "./gatewayUiCache";
import { MarkdownContent } from "./MarkdownContent";
import { ToolActivityCard } from "./ToolActivityCard";
import {
  focusedToolPresentation,
  ToolFocusPanel,
} from "./ToolFocusPanel";
import {
  ExtensionViewCard,
  type ExtensionViewDecisionState,
} from "./ExtensionViewCard";
import { parseExtensionViewPresentation } from "./presentation";
import {
  MALINK_BUILD_VERSION,
  MALINK_GATEWAY_RELEASE,
} from "./buildInfo";
import { discoverLatestGatewayAgentUpdate } from "./gatewayAgentUpdateDiscovery";
import {
  automaticGatewayUpdateTargets as selectAutomaticGatewayUpdateTargets,
  hasAttemptedAutomaticGatewayUpdate,
  recordAutomaticGatewayUpdateAttempt,
  triggerAutomaticGatewayUpdate,
} from "./gatewayUpdateTrigger";
import {
  registerPwaUpdates,
  type PwaUpdateHandle,
  type PwaUpdateState,
} from "./pwaUpdate";
import {
  disableWebPushNotifications,
  enableWebPushNotifications,
  inspectWebPushNotifications,
  synchronizeWebPushNotifications,
  type WebPushNotificationState,
} from "./webPushNotifications";
import {
  PwaStateUpgradeBlockedError,
  resetBlockedPwaConnection,
  runPwaStateUpgrade,
} from "./stateUpgrade";
import {
  PwaIndexedDbUpgradeBlockedError,
  resetBlockedPwaIndexedDb,
  runPwaIndexedDbUpgrade,
} from "./indexedDbUpgrade";
import {
  clearPendingSessionCreateRecovery,
  completedSessionCreateTarget,
  isMissingSessionCreateRecoveryCommand,
  isSessionCreateRecoveryUncertain,
  readPendingSessionCreateRecovery,
  rebindPendingSessionCreateRecovery,
  sessionCreateRecoveryMatches,
  writePendingSessionCreateRecovery,
  type PendingSessionCreateRecovery,
} from "./sessionCreateRecovery";
import {
  bindOptimisticSession,
  clearOptimisticSession,
  createOptimisticSessionRecord,
  failOptimisticSession,
  markOptimisticSessionUncertain,
  readOptimisticSession,
  retryOptimisticSession,
  writeOptimisticSession,
  type OptimisticSessionRecord,
} from "./optimisticSession";
import {
  pendingSessionLifecycleIds,
  sessionsAvailableForAutomaticSelection,
} from "./pendingSessionDeletion";
import {
  hasShortDeviceInvitation,
  resolveShortDeviceInvitation,
  shortenDeviceInvitation,
  shortenEncryptedInvitation,
} from "./invitationRelay";
import {
  compareChatMessages,
  findOptimisticMessageId,
  isAgentWorkMessage,
  isTransientAgentLifecycleEvent,
  mergeChatMessage,
  mergeChatMessages,
  resolvedDecisionActionId,
  withoutReconciledOptimisticCopies,
  type ChatMessage,
  type OptimisticMessageReference,
} from "./chatMessages";
import {
  createCancelCommandPayload,
  createPromptCommandPayload,
} from "./commandPayloads";
import { retryMatchingCommandRevisionConflict } from "./commandRevisionRetry";
import { deriveComposerState } from "./composerState";
import {
  connectionRepairReasonForDetail,
  connectionStatusForBrowserNetwork,
  deriveConnectionPresentation,
  deriveMobileConnectionSignal,
  type ConnectionRepairReason,
  type MobileConnectionSignal,
} from "./connectionPresentation";
import { connectionFailureCode } from "./connectionFailure";
import {
  automaticConnectionRetryDelay,
  connectionRecoveryDisposition,
} from "./connectionRecovery";
import { deriveGatewayLiveness } from "./gatewayLiveness";
import { createConnectionDiagnostics } from "./connectionDiagnostics";
import {
  formatUserFacingError,
  isCommandRecoveryPendingError,
} from "./userFacingError";
import {
  isProjectExpanded,
  readProjectDisclosureState,
  setProjectCollapsed,
  toggleProjectCollapsed,
  writeProjectDisclosureState,
} from "./projectDisclosureState";
import {
  EMPTY_SESSION_READ_STATE,
  initializeSessionReadState,
  markSessionRead,
  pruneSessionReadState,
  readSessionReadState,
  reconcileSelectedSessionReadState,
  sessionIndicator,
  writeSessionReadState,
  type SessionReadState,
} from "./sessionIndicators";
import {
  compareProjectSessionsForAction,
  compareSessionsForAction,
  projectSessionSummaryLabel,
  sessionListSignal,
  sessionSignalLabel,
  summarizeProjectSessions,
  type SessionListSignal,
} from "./sessionListOrder";
import {
  canonicalGatewayProjects,
  gatewayProjectOwner,
  gatewayProjectOwners,
} from "./projectCatalog";
import {
  EMPTY_UI_NOTICE_STATE,
  noticesForScope,
  reduceUiNotices,
  type UiNotice,
  type UiNoticeScope,
  type UiNoticeSeverity,
} from "./uiNotices";
import {
  NATIVE_BACK_PRIORITY,
  resolveMalinkBackAction,
  useNativeBackHandler,
} from "./nativeBackNavigation";
import type {
  MalinkClient,
  MalinkCommandReview,
  MalinkCommandSendResult,
  MalinkHistoryRecovery,
  MalinkMessage,
  MalinkNativeRuntimeInfo,
  MalinkPublicTrust,
} from "./client/MalinkClient";
import { CommandReviewRequiredError } from "./client/MalinkClient";
import {
  NATIVE_MANAGED_ACCESS_TOKEN,
  advanceNativeAppUpdate,
  bootstrapNativeMatrixSessionIfAvailable,
  createMalinkClient,
  isNativeManagedMatrixConfig,
} from "./client/createMalinkClient";
import { publicTrustFromWeb } from "./client/web/WebMalinkClient";
import {
  clearMessageHistoryScope,
  clearSessionMessageHistory,
  deleteMessageHistory,
  loadMessageHistoryPage,
  loadQueuedSessionMessages,
  loadTurnPromptHistory,
  matrixHistoryScope,
  moveSessionMessageHistory,
  reconcileMessageHistory,
  saveMessageHistory,
  type MessageHistoryCursor,
} from "./messageHistory";
import {
  latestCompletedTurnContext,
  nextTurnPromptLookup,
  trimHistoryPageToTurn,
  turnPrompt,
  type ObservedCommandCompletion,
} from "./turnContext";
import {
  activeTurnToolFocus,
  turnTimelineMessages,
} from "./turnTimeline";
import {
  readSelectedSession,
  writeSelectedSession,
} from "./selectedSessionState";
import {
  CommandRevisionConflictError,
  clearMatrixConfig,
  getOrCreateDeviceIdentity,
  loadMatrixConfig,
  normalizeMatrixConfig,
  resolveMatrixSession,
  saveMatrixConfig,
  type IncomingMalinkMessage,
  type GatewayStateSnapshot,
  type MatrixConnectionConfig,
  type MatrixConnectionStatus,
} from "./matrix";
import {
  clearPendingPairing,
  clearTrustedGateway,
  createDeviceInvitationLink,
  decodeDeviceInvitationLink,
  inspectPairingLink,
  loadPendingPairingRecovery,
  loadTrustedGateway,
  loadTrustedGateways,
  pairingLinkFromDeviceInvitation,
  trustedGatewayConfig,
  type GeneratedDeviceInvitation,
  type PairingPreview,
} from "./pairing";
import {
  loginWithMatrixPassword,
  loginWithMatrixToken,
} from "./matrixAuth";
import {
  MATRIX_STARTUP_RECOVERY_SESSION_KEY,
  shouldDeferStoredMatrixStartupForPairing,
  shouldReloadInterruptedMatrixStartup,
} from "./matrixStartup";

type RevisionConflictNotice = {
  commandId: string;
  expectedRevision: number;
  payload: CommandPayload;
  optimisticMessageId?: string;
  busy: boolean;
};

type NativeCommandReviewNotice = MalinkCommandReview & {
  busy: boolean;
};

type SessionSettingsField = "model" | "reasoningEffort" | "permissionMode";

type SessionSettingsUpdate = {
  sessionId: string;
  field: SessionSettingsField;
  value: string;
};

function sessionSettingsFieldLabel(field: SessionSettingsField): string {
  switch (field) {
    case "model":
      return "Model";
    case "reasoningEffort":
      return "Reasoning effort";
    case "permissionMode":
      return "Permission mode";
  }
}

type SendRealCommandOptions = {
  autoRetryRevisionConflict?: boolean;
  propagateFailure?: boolean;
};

type TurnHistoryLoadState = {
  commandId: string;
  phase: "loading" | "ready" | "error";
};

type ProviderHistoryLoadState = ProviderHistoryRouteIdentity & {
  id: number;
  provider: string;
  kind: "sessions" | "session";
  providerSessionId?: string;
};

type ProviderHistoryPendingCommand = ProviderHistoryRouteIdentity & {
  commandId: string;
  provider: string;
  kind: "sessions" | "session";
  providerSessionId?: string;
};

type ProviderHistoryFocus = ProviderHistoryRouteIdentity & {
  provider: string;
  archivedSessionId: string;
};

type OpenProviderHistoryRequest = {
  sourceKey?: string;
  provider?: string;
};

type FeedReturnAnchor = {
  sessionId: string;
  messageId: string;
  viewportOffset: number;
  fallbackScrollTop: number;
};

type PendingSessionLifecycleRecovery = {
  commandId: string;
  action: "archive";
  sessionId: string;
  onSucceeded?: () => void | Promise<void>;
  onFailed?: () => void | Promise<void>;
  timer: number | null;
  inFlight: boolean;
};

type SessionLifecycleAction = PendingSessionLifecycleRecovery["action"];

const emptyMatrixConfig: MatrixConnectionConfig = {
  homeserver: "",
  userId: "",
  accessToken: "",
  matrixDeviceId: "",
  roomId: "",
  gatewayId: "",
  conversationId: "",
  gatewayMatrixUserId: "",
  gatewayMatrixDeviceId: "",
  gatewayMatrixEd25519: "",
};

type InitialGatewayUiState = {
  config: MatrixConnectionConfig;
  gatewayState: GatewayStateSnapshot | null;
  selectedSessionId: string | null;
  historyScope: string;
};

function loadInitialGatewayUiState(): InitialGatewayUiState {
  if (typeof window === "undefined") {
    return {
      config: emptyMatrixConfig,
      gatewayState: null,
      selectedSessionId: null,
      historyScope: "",
    };
  }
  const config = loadMatrixConfig() ?? emptyMatrixConfig;
  const gatewayState = readGatewayUiCache(window.localStorage, config);
  if (!gatewayState) {
    return { config, gatewayState: null, selectedSessionId: null, historyScope: "" };
  }
  const historyScope = matrixHistoryScope({
    gatewayId: config.gatewayId,
    conversationId: config.conversationId,
    roomId: config.roomId,
  });
  const selectableIds = new Set(gatewayState.sessions.map((session) => session.id));
  const rememberedSessionId = readSelectedSession(window.localStorage, historyScope);
  const selectedSessionId = rememberedSessionId && selectableIds.has(rememberedSessionId)
    ? rememberedSessionId
    : gatewayState.currentSessionId && selectableIds.has(gatewayState.currentSessionId)
      ? gatewayState.currentSessionId
      : gatewayState.sessions.find((session) => session.status !== "archived")?.id ??
        gatewayState.sessions[0]?.id ??
        null;
  return { config, gatewayState, selectedSessionId, historyScope };
}

function sessionIdsWithStatus(
  state: GatewayStateSnapshot | null,
  ...statuses: GatewayStateSnapshot["sessions"][number]["status"][]
): Set<string> {
  const accepted = new Set(statuses);
  return new Set(
    state?.sessions
      .filter((session) => accepted.has(session.status))
      .map((session) => session.id) ?? [],
  );
}

function sameGatewayUiScope(
  left: MatrixConnectionConfig,
  right: MatrixConnectionConfig,
): boolean {
  return Boolean(
    left.gatewayId.trim() &&
      left.gatewayId.trim() === right.gatewayId.trim() &&
      left.conversationId.trim() === right.conversationId.trim() &&
      left.roomId.trim() === right.roomId.trim(),
  );
}

const DEVICE_INVITATION_RESULT_TIMEOUT_MS = 95_000;
const SESSION_CREATE_RESULT_RECOVERY_MS = 15_000;
const PROJECT_CREATE_RESULT_TIMEOUT_MS = 60_000;
const PROVIDER_HISTORY_RESULT_TIMEOUT_MS = 60_000;
const GATEWAY_UPDATE_DISCOVERY_INTERVAL_MS = 15 * 60_000;

class InvitationReauthenticationRequiredError extends Error {
  constructor() {
    super("Matrix reauthentication is required for this invitation.");
    this.name = "InvitationReauthenticationRequiredError";
  }
}

function bindCredentialsToHomeserver(
  config: MatrixConnectionConfig,
  homeserver: string,
): MatrixConnectionConfig {
  let sameOrigin = false;
  try {
    sameOrigin =
      Boolean(config.homeserver) &&
      new URL(config.homeserver).origin === new URL(homeserver).origin;
  } catch {
    sameOrigin = false;
  }
  return {
    ...config,
    homeserver,
    userId: sameOrigin ? config.userId : "",
    accessToken: sameOrigin ? config.accessToken : "",
    matrixDeviceId: sameOrigin ? config.matrixDeviceId : "",
  };
}

function Icon({ children }: { children: React.ReactNode }) {
  return (
    <span className="icon" aria-hidden="true">
      {children}
    </span>
  );
}

function CheckCircleIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <circle cx="12" cy="12" r="8.5" />
      <path d="m8.3 12.1 2.3 2.3 5.1-5.2" />
    </svg>
  );
}

function QuoteIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d="M5.5 8.2h5v5.1H7.6c0 1.7.8 2.7 2.4 3.1v2c-3-.5-4.5-2.4-4.5-5.7V8.2Zm8 0h5v5.1h-2.9c0 1.7.8 2.7 2.4 3.1v2c-3-.5-4.5-2.4-4.5-5.7V8.2Z" />
    </svg>
  );
}

function LocateIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 3v3M12 18v3M3 12h3M18 12h3" />
    </svg>
  );
}

function ArrowDownIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d="M12 5v12M7.5 12.5 12 17l4.5-4.5" />
    </svg>
  );
}

function ProjectDisclosureIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d="m9 6 6 6-6 6" />
    </svg>
  );
}

function ProjectFolderIcon({ temporary }: { temporary: boolean }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path
        className="project-folder-shell"
        d="M3.25 7V6.35c0-.75.6-1.35 1.35-1.35h4.1l1.9 2.15h8.8c.75 0 1.35.6 1.35 1.35v9.1c0 .75-.6 1.35-1.35 1.35H4.6c-.75 0-1.35-.6-1.35-1.35V7Z"
      />
      <path className="project-folder-seam" d="M3.6 8.4h16.8" />
      {temporary && (
        <g className="project-folder-clock">
          <circle cx="17.25" cy="17" r="4.15" />
          <path d="M17.25 14.75v2.45l1.55.9" />
        </g>
      )}
    </svg>
  );
}

function NewProjectIcon() {
  return (
    <svg aria-hidden="true" className="toolbar-icon" viewBox="0 0 24 24">
      <path d="M3.75 7.75V6.6c0-.83.67-1.5 1.5-1.5h4.1l2 2.25h7.4c.83 0 1.5.67 1.5 1.5v9.05c0 .83-.67 1.5-1.5 1.5H5.25c-.83 0-1.5-.67-1.5-1.5V7.75Z" />
      <path d="M16.75 11.75v5M14.25 14.25h5" />
    </svg>
  );
}

function HistoryIcon() {
  return (
    <svg aria-hidden="true" className="toolbar-icon" viewBox="0 0 24 24">
      <path d="M4.25 8.25V4.8M4.25 8.25H7.7" />
      <path d="M5.15 7.1a8 8 0 1 1-1 7.15" />
      <path d="M12 7.75v4.6l3 1.75" />
    </svg>
  );
}

function FileInboxIcon() {
  return (
    <svg aria-hidden="true" className="toolbar-icon" viewBox="0 0 24 24">
      <path d="M4.25 5.25h15.5v13.5H4.25z" />
      <path d="M8 14.75h1.5l1 1.5h3l1-1.5H16" />
      <path d="M12 7.75v5M9.75 10.5 12 12.75l2.25-2.25" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg aria-hidden="true" className="toolbar-icon" viewBox="0 0 24 24">
      <circle cx="10.75" cy="10.75" r="5.75" />
      <path d="m15 15 4 4" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg aria-hidden="true" className="toolbar-icon" viewBox="0 0 24 24">
      <path d="m7 7 10 10M17 7 7 17" />
    </svg>
  );
}

function NewConversationIcon() {
  return (
    <svg aria-hidden="true" className="toolbar-icon" viewBox="0 0 24 24">
      <path d="M5.25 4.75h13.5c.83 0 1.5.67 1.5 1.5v9.5c0 .83-.67 1.5-1.5 1.5h-7.5l-4.7 3v-3h-1.3c-.83 0-1.5-.67-1.5-1.5v-9.5c0-.83.67-1.5 1.5-1.5Z" />
      <path d="M12 8v6M9 11h6" />
    </svg>
  );
}

function SessionSignalIcon({
  signal,
}: {
  signal: Exclude<SessionListSignal, "idle">;
}) {
  if (signal === "working") {
    return <i className="session-signal-spinner" />;
  }
  if (signal === "ready") {
    return (
      <svg aria-hidden="true" viewBox="0 0 24 24">
        <path d="M11.7 3.8c.7 4.1 2.4 5.8 6.5 6.5-4.1.7-5.8 2.4-6.5 6.5-.7-4.1-2.4-5.8-6.5-6.5 4.1-.7 5.8-2.4 6.5-6.5Z" />
        <path d="M18.2 3.6v3.6M20 5.4h-3.6" />
      </svg>
    );
  }
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d="m8.1 8.1 7.8 7.8M15.9 8.1l-7.8 7.8" />
    </svg>
  );
}

function MobileConnectionIcon({
  state,
}: {
  state: MobileConnectionSignal["state"];
}) {
  if (state === "ready") {
    return (
      <svg aria-hidden="true" viewBox="0 0 24 24">
        <circle cx="12" cy="12" r="8.5" />
        <path d="m8.3 12.1 2.3 2.3 5.1-5.2" />
      </svg>
    );
  }
  if (state === "progress") {
    return (
      <svg aria-hidden="true" className="mobile-connection-spinner" viewBox="0 0 24 24">
        <circle className="mobile-connection-track" cx="12" cy="12" r="8.5" />
        <path d="M12 3.5a8.5 8.5 0 0 1 7.9 5.4" />
      </svg>
    );
  }
  if (state === "offline") {
    return (
      <svg aria-hidden="true" viewBox="0 0 24 24">
        <circle cx="12" cy="12" r="8.5" />
        <path d="m7 7 10 10" />
      </svg>
    );
  }
  if (state === "attention") {
    return (
      <svg aria-hidden="true" viewBox="0 0 24 24">
        <circle cx="12" cy="12" r="8.5" />
        <path d="M12 7.5v5.8M12 16.5h.01" />
      </svg>
    );
  }
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 8v8M8 12h8" />
    </svg>
  );
}

function AttachmentList({
  attachments,
  connection,
}: {
  attachments?: MalinkAttachment[];
  connection: MalinkClient | null;
}) {
  if (!attachments?.length) return null;
  return (
    <div className="message-attachments">
      {attachments.map((attachment) => (
        <AttachmentCard
          attachment={attachment}
          connection={connection}
          key={attachment.id}
        />
      ))}
    </div>
  );
}

function TurnResultContext({
  prompt,
  connection,
  expanded,
  locationPhase,
  failed,
  onTogglePrompt,
  onLocatePrompt,
}: {
  prompt: ChatMessage;
  connection: MalinkClient | null;
  expanded: boolean;
  locationPhase: TurnHistoryLoadState["phase"];
  failed: boolean;
  onTogglePrompt(): void;
  onLocatePrompt(): void;
}) {
  const locating = locationPhase === "loading";
  const completionLabel = failed ? "Task ended with an error" : "Task completed";
  const locateLabel = locating
    ? "Loading the original message"
    : locationPhase === "error"
      ? "Retry loading the original message"
      : "Jump to the original message";
  return (
    <div className={`turn-result-context ${expanded ? "is-expanded" : ""}`}>
      <div className="turn-result-toolbar" aria-label="Completed task context">
        <span
          className={`turn-completion-mark ${failed ? "is-failed" : ""}`}
          aria-label={completionLabel}
          title={completionLabel}
          role="img"
        >
          {failed ? "!" : <CheckCircleIcon />}
        </span>
        <button
          type="button"
          className="turn-context-button"
          aria-label={expanded ? "Hide the original message" : "Show the original message"}
          aria-expanded={expanded}
          title={expanded ? "Hide original message" : "Show original message"}
          onClick={onTogglePrompt}
        >
          <QuoteIcon />
        </button>
        <button
          type="button"
          className={`turn-context-button turn-locate-button is-${locationPhase}`}
          aria-label={locateLabel}
          aria-busy={locating}
          disabled={locating}
          title={locateLabel}
          onClick={onLocatePrompt}
        >
          <LocateIcon />
          {locating && <span className="turn-location-spinner" aria-hidden="true" />}
          {locationPhase === "error" && (
            <span className="turn-location-error" aria-hidden="true" />
          )}
        </button>
      </div>
      {expanded && (
        <div className="turn-origin-preview">
          <QuoteIcon />
          <div>
            {prompt.text ? <p>{prompt.text}</p> : null}
            <AttachmentList
              attachments={prompt.attachments}
              connection={connection}
            />
          </div>
        </div>
      )}
    </div>
  );
}

function AttachmentCard({
  attachment,
  connection,
}: {
  attachment: MalinkAttachment;
  connection: MalinkClient | null;
}) {
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState<"preview" | "download" | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(
    () => () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    },
    [previewUrl],
  );

  async function load(mode: "preview" | "download") {
    if (!connection || busy) return;
    setBusy(mode);
    setError(null);
    try {
      const blob = await connection.downloadAttachment(attachment);
      const url = URL.createObjectURL(blob);
      if (mode === "preview") {
        setPreviewUrl((current) => {
          if (current) URL.revokeObjectURL(current);
          return url;
        });
      } else {
        const link = document.createElement("a");
        link.href = url;
        link.download = attachment.name;
        document.body.append(link);
        link.click();
        link.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
      }
    } catch (loadError) {
      setError(formatUiError(loadError));
    } finally {
      setBusy(null);
    }
  }

  const isImage = attachment.mimeType.startsWith("image/");
  return (
    <section className="attachment-card">
      {previewUrl && isImage && (
        // Decrypted attachments use short-lived local blob: URLs, which are
        // intentionally outside the Next image optimization pipeline.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={previewUrl} alt={attachment.name} />
      )}
      <div className="attachment-card-copy">
        <span aria-hidden="true">{isImage ? "▧" : "▤"}</span>
        <span>
          <b title={attachment.name}>{attachment.name}</b>
          <small>
            {attachment.mimeType} · {formatFileSize(attachment.size)}
          </small>
        </span>
      </div>
      <div className="attachment-card-actions">
        {isImage && !previewUrl && (
          <button
            type="button"
            disabled={!connection || busy !== null}
            onClick={() => void load("preview")}
          >
            {busy === "preview" ? "Decrypting…" : "Preview"}
          </button>
        )}
        <button
          type="button"
          disabled={!connection || busy !== null}
          onClick={() => void load("download")}
        >
          {busy === "download" ? "Decrypting…" : "Download"}
        </button>
      </div>
      {error && <small className="attachment-error">{error}</small>}
    </section>
  );
}

function UiNoticeList({
  notices,
  className,
  onDismiss,
}: {
  notices: UiNotice[];
  className?: string;
  onDismiss(key: string): void;
}) {
  if (notices.length === 0) return null;
  return (
    <div className={`ui-notice-list ${className ?? ""}`}>
      {notices.map((notice) => (
        <div
          key={notice.key}
          className={`ui-notice ui-notice-${notice.severity}`}
          role={notice.severity === "error" ? "alert" : "status"}
        >
          <span aria-hidden="true">
            {notice.severity === "error"
              ? "!"
              : notice.severity === "success"
                ? "✓"
                : "i"}
          </span>
          <p>{notice.message}</p>
          <button
            type="button"
            aria-label="Dismiss message"
            onClick={() => onDismiss(notice.key)}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

type PwaUpgradeGateState =
  | { phase: "preparing" }
  | { phase: "ready" }
  | {
      phase: "blocked";
      scope: "local-storage" | "indexed-db";
      error: PwaStateUpgradeBlockedError | PwaIndexedDbUpgradeBlockedError;
    };

/**
 * Mounting the business UI is the upgrade commit boundary. No trust, command,
 * Matrix, native bridge, or cached UI reader runs before this gate succeeds.
 */
export function MalinkApp() {
  const [upgrade, setUpgrade] = useState<PwaUpgradeGateState>({
    phase: "preparing",
  });

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        runPwaStateUpgrade(window.localStorage);
      } catch (error) {
        if (!active) return;
        setUpgrade({
          phase: "blocked",
          scope: "local-storage",
          error: error instanceof PwaStateUpgradeBlockedError
            ? error
            : new PwaStateUpgradeBlockedError(
                "Malink could not prepare this browser's saved state.",
                [],
                { cause: error },
              ),
        });
        return;
      }
      try {
        await runPwaIndexedDbUpgrade(window.localStorage, window.indexedDB);
        if (active) setUpgrade({ phase: "ready" });
      } catch (error) {
        if (!active) return;
        setUpgrade({
          phase: "blocked",
          scope: "indexed-db",
          error: error instanceof PwaIndexedDbUpgradeBlockedError
            ? error
            : new PwaIndexedDbUpgradeBlockedError(
                "Malink could not prepare this browser's databases.",
                [],
                { cause: error },
              ),
        });
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  if (upgrade.phase === "preparing") {
    return (
      <main className="upgrade-gate" aria-busy="true">
        <section className="upgrade-gate-card" role="status">
          <span className="session-status-dot is-running" aria-hidden="true" />
          <div>
            <h1>Preparing this version…</h1>
            <p>Checking saved connection and recovery state before Malink starts.</p>
          </div>
        </section>
      </main>
    );
  }
  if (upgrade.phase === "blocked") {
    const canReset = upgrade.error.blockedKeys.length > 0;
    return (
      <main className="upgrade-gate">
        <section className="upgrade-gate-card" role="alert">
          <div>
            <p className="eyebrow">Local state needs repair</p>
            <h1>This version did not start</h1>
            <p>{upgrade.error.message}</p>
            <p>
              Malink preserved identity and trust data instead of deleting it during
              an uncertain upgrade.
            </p>
            <div className="upgrade-gate-actions">
              <button type="button" onClick={() => window.location.reload()}>
                Try again
              </button>
              {canReset ? (
                <button
                  type="button"
                  className="danger-button"
                  onClick={() => {
                    if (!window.confirm(
                      "Reset this browser connection? Other devices and Gateway history are not deleted, but this browser must be invited again.",
                    )) return;
                    void (async () => {
                      if (upgrade.scope === "indexed-db") {
                        await resetBlockedPwaIndexedDb(
                          window.localStorage,
                          window.indexedDB,
                          upgrade.error.blockedKeys,
                        );
                      } else {
                        resetBlockedPwaConnection(
                          window.localStorage,
                          upgrade.error.blockedKeys,
                        );
                      }
                      window.location.reload();
                    })();
                  }}
                >
                  Reset this browser connection
                </button>
              ) : null}
            </div>
          </div>
        </section>
      </main>
    );
  }
  return <MalinkAppRuntime />;
}

function MalinkAppRuntime() {
  const initialGatewayUiRef = useRef<InitialGatewayUiState | null>(null);
  if (initialGatewayUiRef.current === null) {
    initialGatewayUiRef.current = loadInitialGatewayUiState();
  }
  const initialGatewayUi = initialGatewayUiRef.current;
  const [mobileChatOpen, setMobileChatOpen] = useState(false);
  const [primaryView, setPrimaryView] = useState<"chats" | "files">("chats");
  const [search, setSearch] = useState("");
  const [sessionSearchOpen, setSessionSearchOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [attachmentBusy, setAttachmentBusy] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [feedAwayFromLatest, setFeedAwayFromLatest] = useState(false);
  const [feedHasUnseenMessages, setFeedHasUnseenMessages] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyHasMore, setHistoryHasMore] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyRetryMode, setHistoryRetryMode] = useState<
    "restore" | "older" | null
  >(null);
  const [observedCommandCompletions, setObservedCommandCompletions] = useState<
    ObservedCommandCompletion[]
  >([]);
  const [turnPromptCache, setTurnPromptCache] = useState<
    Map<string, ChatMessage | null>
  >(() => new Map());
  const [expandedTurnId, setExpandedTurnId] = useState<string | null>(null);
  const [toolFocusHistoryKey, setToolFocusHistoryKey] = useState<string | null>(
    null,
  );
  const [turnHistoryLoad, setTurnHistoryLoad] =
    useState<TurnHistoryLoadState | null>(null);
  const [feedReturnAnchor, setFeedReturnAnchor] =
    useState<FeedReturnAnchor | null>(null);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(
    initialGatewayUi.selectedSessionId,
  );
  const [runningSessionIds, setRunningSessionIds] = useState<Set<string>>(
    () => sessionIdsWithStatus(initialGatewayUi.gatewayState, "running", "stopping"),
  );
  const [stoppingSessionIds, setStoppingSessionIds] = useState<Set<string>>(
    () => sessionIdsWithStatus(initialGatewayUi.gatewayState, "stopping"),
  );
  const [submittingPromptSessionIds, setSubmittingPromptSessionIds] = useState<
    Set<string>
  >(() => new Set());
  const [agentActivitiesBySession, setAgentActivitiesBySession] = useState<
    Map<string, AgentActivity>
  >(() => new Map());
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [composerOptionsOpen, setComposerOptionsOpen] = useState(false);
  const [providerCommandsOpen, setProviderCommandsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [matrixConfig, setMatrixConfig] = useState<MatrixConnectionConfig>(
    initialGatewayUi.config,
  );
  const [connectionStatus, setConnectionStatus] =
    useState<MatrixConnectionStatus>("offline");
  const [connectionDetail, setConnectionDetail] = useState<string | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  // Pairing is an operation layered on top of an already-connected Matrix
  // sync. A routine "connected" status must not erase its timeout/error.
  const [pairingError, setPairingError] = useState<string | null>(null);
  const [nativeRuntime, setNativeRuntime] =
    useState<MalinkNativeRuntimeInfo | null>(null);
  const [nativeUpdateState, setNativeUpdateState] =
    useState<NativeUpdateStatus | null>(null);
  const [nativeUpdateBusy, setNativeUpdateBusy] = useState(false);
  const nativeUpdateBusyRef = useRef(false);
  const [pageLinkCopyBusy, setPageLinkCopyBusy] = useState(false);
  const [pwaUpdateState, setPwaUpdateState] = useState<PwaUpdateState>({
    phase: "current",
    currentVersion: MALINK_BUILD_VERSION,
  });
  const [webPushState, setWebPushState] = useState<WebPushNotificationState>({
    status: "unavailable",
  });
  const [webPushBusy, setWebPushBusy] = useState(false);
  const [deviceKeyId, setDeviceKeyId] = useState<string | null>(null);
  const [activeDeviceCount, setActiveDeviceCount] = useState<number | null>(
    initialGatewayUi.gatewayState?.activeDeviceCount ?? null,
  );
  const [gatewayState, setGatewayState] =
    useState<GatewayStateSnapshot | null>(initialGatewayUi.gatewayState);
  const [, setGatewayRevision] = useState<number | null>(null);
  const [revisionConflict, setRevisionConflict] =
    useState<RevisionConflictNotice | null>(null);
  const [nativeCommandReview, setNativeCommandReview] =
    useState<NativeCommandReviewNotice | null>(null);
  const [pairingPreview, setPairingPreview] =
    useState<PairingPreview | null>(null);
  const [trustedGateway, setTrustedGateway] =
    useState<MalinkPublicTrust | null>(null);
  const [savedGateways, setSavedGateways] = useState<MalinkPublicTrust[]>([]);
  const [pairingBusy, setPairingBusy] = useState(false);
  const [deviceInvitation, setDeviceInvitation] =
    useState<GeneratedDeviceInvitation | null>(null);
  const [invitationBusy, setInvitationBusy] = useState(false);
  const [invitationError, setInvitationError] = useState<string | null>(null);
  const [invitationReauthRequired, setInvitationReauthRequired] =
    useState(false);
  const [gatewayEnrollmentInvitation, setGatewayEnrollmentInvitation] = useState<{
    link: string;
    expiresAt: number;
  } | null>(null);
  const [gatewayEnrollmentBusy, setGatewayEnrollmentBusy] =
    useState<GatewayEnrollmentBusyState>(null);
  const [gatewayEnrollmentError, setGatewayEnrollmentError] = useState<string | null>(null);
  const [gatewayProfileBusy, setGatewayProfileBusy] = useState<string | null>(null);
  const [gatewayProfileError, setGatewayProfileError] = useState<string | null>(null);
  const [gatewayUpdateBusy, setGatewayUpdateBusy] = useState(false);
  const [gatewayUpdateError, setGatewayUpdateError] = useState<string | null>(null);
  const [gatewayUpdateDiscoveryError, setGatewayUpdateDiscoveryError] =
    useState<string | null>(null);
  const [gatewayRelease, setGatewayRelease] = useState(MALINK_GATEWAY_RELEASE);
  const [approvedGatewayEnrollmentIds, setApprovedGatewayEnrollmentIds] =
    useState<Set<string>>(() => new Set());
  const pendingGatewayEnrollments = useMemo(() => {
    const joinedGatewayNodeIds = new Set(
      gatewayState?.gatewayDirectory?.directory.gateways.map(
        (gateway) => gateway.gatewayNodeId,
      ) ?? [],
    );
    return (gatewayState?.pendingGatewayEnrollments ?? []).filter(
      (enrollment) => !joinedGatewayNodeIds.has(enrollment.gatewayNodeId),
    );
  }, [gatewayState?.gatewayDirectory, gatewayState?.pendingGatewayEnrollments]);
  const visibleApprovedGatewayEnrollmentIds = useMemo(() => {
    const visibleEnrollmentIds = new Set(
      pendingGatewayEnrollments.map((enrollment) => enrollment.enrollmentId),
    );
    return new Set(
      [...approvedGatewayEnrollmentIds].filter(
        (enrollmentId) => visibleEnrollmentIds.has(enrollmentId),
      ),
    );
  }, [approvedGatewayEnrollmentIds, pendingGatewayEnrollments]);
  const [newSessionOpen, setNewSessionOpen] = useState(false);
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [providerHistoryOpen, setProviderHistoryOpen] = useState(false);
  const [providerHistoryGatewayNodeId, setProviderHistoryGatewayNodeId] = useState("");
  const [providerHistoryProjectId, setProviderHistoryProjectId] = useState("");
  const [providerHistoryProvider, setProviderHistoryProvider] = useState("");
  const [providerHistorySessions, setProviderHistorySessions] = useState<ProviderSessionEntry[]>([]);
  const [providerHistorySelected, setProviderHistorySelected] = useState<ProviderSessionEntry | null>(null);
  const [providerHistoryMessages, setProviderHistoryMessages] = useState<ProviderHistoryMessage[]>([]);
  const [providerHistoryLoad, setProviderHistoryLoad] =
    useState<ProviderHistoryLoadState | null>(null);
  const [providerHistoryError, setProviderHistoryError] = useState<string | null>(null);
  const [forgetDialogOpen, setForgetDialogOpen] = useState(false);
  const [newSessionBusy, setNewSessionBusy] = useState(false);
  const [newProjectBusy, setNewProjectBusy] = useState(false);
  const [sessionSettingsUpdate, setSessionSettingsUpdate] =
    useState<SessionSettingsUpdate | null>(null);
  const [pendingSessionCreate, setPendingSessionCreate] =
    useState<NewSessionInput | null>(null);
  const [optimisticSession, setOptimisticSession] =
    useState<OptimisticSessionRecord | null>(null);
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(() =>
    readProjectDisclosureState(
      typeof window === "undefined" ? null : window.localStorage,
    ),
  );
  const [sessionReadState, setSessionReadState] = useState<SessionReadState>(() =>
    typeof window === "undefined"
      ? EMPTY_SESSION_READ_STATE
      : readSessionReadState(window.localStorage),
  );
  const [uiNotices, dispatchUiNotice] = useReducer(
    reduceUiNotices,
    EMPTY_UI_NOTICE_STATE,
  );
  const [sessionLifecycleBusy, setSessionLifecycleBusy] = useState<
    Map<string, SessionLifecycleAction>
  >(() => new Map());
  const [decisionStates, setDecisionStates] = useState<
    Record<string, ExtensionViewDecisionState>
  >({});
  const [privilegeTotpEnrollment, setPrivilegeTotpEnrollment] = useState<{
    message: ChatMessage;
    decision: string;
  } | null>(null);
  const [privilegeTotpBusy, setPrivilegeTotpBusy] = useState(false);
  const [privilegeTotpError, setPrivilegeTotpError] = useState<string | null>(
    null,
  );
  const feedRef = useRef<HTMLDivElement>(null);
  const composerTextareaRef = useRef<HTMLTextAreaElement>(null);
  const sessionSearchRef = useRef<HTMLInputElement>(null);
  const detailsButtonRef = useRef<HTMLButtonElement>(null);
  const detailsPopoverRef = useRef<HTMLDivElement>(null);
  const attachmentInputRef = useRef<HTMLInputElement>(null);
  const malinkClientRef = useRef<MalinkClient | null>(null);
  const matrixStartupGenerationRef = useRef(0);
  const connectionRecoveryTimerRef = useRef<number | null>(null);
  const connectionRecoveryAttemptRef = useRef(0);
  const connectionRecoveryAllowedRef = useRef(true);
  const matrixStartupRef = useRef<{
    phase: "connecting" | "securing";
    startedAt: number;
    hiddenAt: number | null;
  } | null>(null);
  const pwaUpdateRef = useRef<PwaUpdateHandle | null>(null);
  const pwaReloadBlockedRef = useRef(false);
  const componentMountedRef = useRef(true);
  const automaticGatewayUpdateAttemptsRef = useRef(new Set<string>());
  const executeGatewayUpdateRef = useRef<(
    payload: Extract<CommandPayload, { operation: `gateway.update.${string}` }>,
    targetProjectId: string,
  ) => Promise<GatewayUpdateStatus>>(async () => {
    throw new Error("Gateway update runtime is not ready.");
  });
  executeGatewayUpdateRef.current = executeGatewayUpdate;
  const connectionStatusRef = useRef<MatrixConnectionStatus>("offline");
  const matrixSessionRepairRequiredRef = useRef(false);
  const pendingSessionCreateRecoveryRef =
    useRef<PendingSessionCreateRecovery | null>(null);
  const sessionCreateRecoveryInFlightRef = useRef<{
    commandId: string;
    connection: MalinkClient;
  } | null>(null);
  const sessionCreateRecoveryTimerRef = useRef<number | null>(null);
  const sessionLifecycleRecoveriesRef = useRef(
    new Map<string, PendingSessionLifecycleRecovery>(),
  );
  const sessionLifecycleBusyRef = useRef(
    new Map<string, SessionLifecycleAction>(),
  );
  const pairingAbortRef = useRef<AbortController | null>(null);
  const pairingRecoveryRef = useRef<
    (
      preview: PairingPreview,
      config: MatrixConnectionConfig,
    ) => Promise<void>
  >(async () => {});
  const revisionConflictRef = useRef<RevisionConflictNotice | null>(null);
  const nativeCommandReviewRef = useRef<NativeCommandReviewNotice | null>(null);
  const activePromptCommandsRef = useRef(new Map<string, string>());
  const completedCommandResultsRef = useRef(new Set<string>());
  const completionObservationOrderRef = useRef(0);
  const turnPromptLookupRef = useRef(new Set<string>());
  const turnHistoryHydrationRef = useRef<string | null>(null);
  const messageElementsRef = useRef(new Map<string, HTMLDivElement>());
  const optimisticMessagesRef = useRef(
    new Map<string, OptimisticMessageReference>(),
  );
  const reconciledOptimisticMessageIdsRef = useRef(new Set<string>());
  const pendingPromptSessionIdsRef = useRef(new Set<string>());
  const queuedSessionFlushIdsRef = useRef(new Set<string>());
  const queuedSessionFlushInFlightRef = useRef(new Set<string>());
  const optimisticPromotionInFlightRef = useRef<string | null>(null);
  const selectedSessionIdRef = useRef<string | null>(
    initialGatewayUi.selectedSessionId,
  );
  const pendingCreatedSessionIdRef = useRef<string | null>(null);
  const optimisticSessionRef = useRef<OptimisticSessionRecord | null>(null);
  const pendingOpenedSessionIdRef = useRef<string | null>(null);
  const activateLocalSessionRef = useRef<(sessionId: string) => void>(() => {});
  const knownGatewaySessionIdsRef = useRef(
    new Set(initialGatewayUi.gatewayState?.sessions.map((session) => session.id)),
  );
  const liveMessagesBySessionRef = useRef(new Map<string, ChatMessage[]>());
  const historyScopeRef = useRef(initialGatewayUi.historyScope);
  const historySessionIdRef = useRef<string | null>(null);
  const historyCursorRef = useRef<MessageHistoryCursor | null>(null);
  const historyGenerationRef = useRef(0);
  const historyLoadingRef = useRef(false);
  const providerHistoryProviderRef = useRef("");
  const providerHistoryGatewayNodeIdRef = useRef("");
  const providerHistoryProjectIdRef = useRef("");
  const providerHistoryLoadRef = useRef<ProviderHistoryLoadState | null>(null);
  const providerHistoryLoadIdRef = useRef(0);
  const providerHistoryLoadedProviderRef = useRef<string | null>(null);
  const providerHistoryFocusRef = useRef<ProviderHistoryFocus | null>(null);
  const providerHistoryPendingCommandRef =
    useRef<ProviderHistoryPendingCommand | null>(null);
  const deviceInvitationLifecycleRef = useRef(
    new DeviceInvitationLifecycle<GeneratedDeviceInvitation>(),
  );
  const matrixLoginTokenLifecycleRef = useRef(
    new MatrixLoginTokenLifecycle(),
  );
  const invitationExpiryTimeoutRef = useRef<number | null>(null);
  const pendingGatewayInvitationRef = useRef<{
    commandId: string;
    pairingLink: string;
    expiresAt: number;
  } | null>(null);
  const followLatestRef = useRef(true);
  const prependScrollRef = useRef<{
    scrollHeight: number;
    scrollTop: number;
  } | null>(null);

  const gatewaySelected =
    gatewayState?.sessions.find(
      (session) => session.id === selectedSessionId,
    ) ?? null;
  const optimisticSelected = Boolean(
    optimisticSession &&
      optimisticSession.localSessionId === selectedSessionId,
  );
  const optimisticSelectedSummary = optimisticSelected && optimisticSession
    ? optimisticSessionSummary(optimisticSession, gatewayState)
    : null;
  const selected = gatewaySelected ?? optimisticSelectedSummary;
  const selectedLifecycleAction = gatewaySelected
    ? sessionLifecycleBusy.get(gatewaySelected.id) ?? null
    : null;
  const selectedLifecycleBusy = selectedLifecycleAction !== null;
  const latestCompletedTurn = useMemo(
    () =>
      latestCompletedTurnContext(
        messages,
        observedCommandCompletions,
        turnPromptCache,
        selectedSessionId,
      ),
    [
      messages,
      observedCommandCompletions,
      selectedSessionId,
      turnPromptCache,
    ],
  );
  const inferredCompletedTurnResultIds = useMemo(() => {
    const resultIds = new Set<string>();
    let latestAgentResultId: string | null = null;
    for (const message of messages) {
      if (message.kind === "user") {
        if (latestAgentResultId) resultIds.add(latestAgentResultId);
        latestAgentResultId = null;
        continue;
      }
      if (message.kind === "agent" || message.kind === "error") {
        latestAgentResultId = message.id;
      }
    }
    if (latestCompletedTurn) resultIds.add(latestCompletedTurn.result.id);
    return resultIds;
  }, [latestCompletedTurn, messages]);
  const nativeBackAction = resolveMalinkBackAction({
    deleteDialogOpen: false,
    deleteDialogBusy: false,
    providerHistoryOpen,
    newProjectOpen,
    newProjectBusy,
    newSessionOpen,
    newSessionBusy,
    settingsOpen,
    detailsOpen,
    composerOptionsOpen: composerOptionsOpen || providerCommandsOpen,
    sessionSearchOpen,
    mobileChatOpen,
  });
  useNativeBackHandler(
    nativeBackAction !== null,
    () => {
      switch (nativeBackAction) {
        case "close-delete-dialog":
          break;
        case "close-provider-history":
          setProviderHistoryOpen(false);
          break;
        case "close-new-project":
          setNewProjectOpen(false);
          break;
        case "block-new-project":
          break;
        case "close-new-session":
          setNewSessionOpen(false);
          break;
        case "close-settings":
          setSettingsOpen(false);
          break;
        case "close-details":
          setDetailsOpen(false);
          break;
        case "close-composer-options":
          setComposerOptionsOpen(false);
          setProviderCommandsOpen(false);
          break;
        case "close-session-search":
          setSearch("");
          setSessionSearchOpen(false);
          break;
        case "show-conversations":
          setMobileChatOpen(false);
          break;
        case "block-delete-dialog":
        case "block-new-session":
          break;
        case null:
          return false;
      }
      return true;
    },
    NATIVE_BACK_PRIORITY.app,
  );
  const visibleGatewaySessions = useMemo(
    () => gatewayState?.sessions ?? [],
    [gatewayState],
  );
  const fallbackProjectGateway = useMemo(() => {
    const expectedGatewayNodeId = matrixConfig.gatewayNodeId
      ?? trustedGateway?.gatewayNodeId
      ?? matrixConfig.gatewayId;
    const directoryGateway = gatewayState?.gatewayDirectory?.directory.gateways.find(
      gateway => gateway.gatewayNodeId === expectedGatewayNodeId,
    );
    return gatewayProjectOwner(
      directoryGateway?.gatewayNodeId ?? expectedGatewayNodeId,
      directoryGateway?.gatewayName ?? trustedGateway?.gatewayName ?? "Gateway",
      directoryGateway?.computerName,
    );
  }, [
    gatewayState?.gatewayDirectory,
    matrixConfig.gatewayId,
    matrixConfig.gatewayNodeId,
    trustedGateway?.gatewayName,
    trustedGateway?.gatewayNodeId,
  ]);
  const projectGatewaysById = useMemo(
    () => gatewayProjectOwners(
      gatewayState?.gatewayDirectory?.directory.gateways ?? [],
    ),
    [gatewayState?.gatewayDirectory],
  );
  const filteredSessions = useMemo(
    () =>
      visibleGatewaySessions.filter((session) => {
        const owner = projectGatewaysById.get(session.projectId) ?? fallbackProjectGateway;
        return `${session.title} ${session.projectName} ${session.cwd} ${session.provider} ${session.model ?? ""} ${owner.gatewayName} ${owner.computerName} ${owner.gatewayNodeId}`
          .toLowerCase()
          .includes(search.toLowerCase());
      }),
    [fallbackProjectGateway, projectGatewaysById, search, visibleGatewaySessions],
  );
  const activeFilteredSessions = filteredSessions;
  const activeSessionCount = visibleGatewaySessions.length;
  const canonicalProjectsById = useMemo(
    () =>
      new Map(
        canonicalGatewayProjects(
          gatewayState?.workspace,
          visibleGatewaySessions,
          gatewayState?.projects ?? [],
        ).map((project) => [project.projectId, project]),
      ),
    [gatewayState?.workspace, gatewayState?.projects, visibleGatewaySessions],
  );
  const projectGroups = useMemo(() => {
    const groups = new Map<
      string,
      {
        key: string;
        projectId: string;
        projectName: string;
        cwd: string;
        gatewayLabel: string;
        sessions: NonNullable<typeof gatewayState>["sessions"];
      }
    >();
    for (const session of activeFilteredSessions) {
      if (session.scope === "scratch") continue;
      const key = gatewayProjectKey(matrixConfig.gatewayId, session.projectId);
      const project = canonicalProjectsById.get(session.projectId) ?? session;
      const owner = projectGatewaysById.get(session.projectId) ?? fallbackProjectGateway;
      const group = groups.get(key) ?? {
        key,
        projectId: session.projectId,
        projectName: project.projectName,
        cwd: project.cwd,
        gatewayLabel: owner.label,
        sessions: [],
      };
      group.sessions.push(session);
      groups.set(key, group);
    }
    if (!search.trim()) {
      for (const project of canonicalProjectsById.values()) {
        const key = gatewayProjectKey(matrixConfig.gatewayId, project.projectId);
        if (!groups.has(key)) {
          groups.set(key, {
            key,
            projectId: project.projectId,
            projectName: project.projectName,
            cwd: project.cwd,
            gatewayLabel: (
              projectGatewaysById.get(project.projectId) ?? fallbackProjectGateway
            ).label,
            sessions: [],
          });
        }
      }
    }
    const projects = [...groups.values()];
    for (const project of projects) {
      project.sessions.sort((left, right) =>
        compareSessionsForAction(left, right, sessionReadState),
      );
    }
    projects.sort((left, right) =>
      compareProjectSessionsForAction(
        left.sessions,
        right.sessions,
        sessionReadState,
      ) || left.projectName.localeCompare(right.projectName),
    );
    return projects;
  }, [
    activeFilteredSessions,
    canonicalProjectsById,
    fallbackProjectGateway,
    matrixConfig.gatewayId,
    projectGatewaysById,
    search,
    sessionReadState,
  ]);
  const scratchSessions = useMemo(
    () => activeFilteredSessions
      .filter((session) => session.scope === "scratch")
      .sort((left, right) => compareSessionsForAction(left, right, sessionReadState)),
    [activeFilteredSessions, sessionReadState],
  );
  const conversationGroups = useMemo(() => [
    ...(scratchSessions.length > 0
      ? [{
          key: `${matrixConfig.gatewayId}\u0000scratch`,
          projectId: "scratch",
          projectName: "Temporary",
          cwd: "Isolated workspace · not linked to a project",
          gatewayLabel: null,
          sessions: scratchSessions,
          temporary: true,
        }]
      : []),
    ...projectGroups.map((project) => ({ ...project, temporary: false })),
  ], [matrixConfig.gatewayId, projectGroups, scratchSessions]);
  const inboxFiles = gatewayState?.inboxFiles ?? [];
  const matrixConnectionPresentation = useMemo(
    () => deriveConnectionPresentation(connectionStatus, connectionDetail),
    [connectionDetail, connectionStatus],
  );
  const gatewayLiveness = deriveGatewayLiveness({
    matrixStatus: connectionStatus,
    trusted: trustedGateway !== null,
    gatewayUpdatedAt: gatewayState?.updatedAt,
  });
  const gatewayAvailable = gatewayLiveness.available;
  const displayedConnectionStatus = gatewayLiveness.state === "offline"
    ? "offline"
    : connectionStatus;
  const connectionPresentation = gatewayLiveness.state === "offline"
    ? deriveConnectionPresentation("offline", "matrix_gateway_offline")
    : matrixConnectionPresentation;
  const mobileConnectionSignal = deriveMobileConnectionSignal({
    trusted: trustedGateway !== null,
    status: displayedConnectionStatus,
    gatewayAvailable,
  });

  const connectionRepairReason = connectionRepairReasonForDetail(
    connectionDetail,
  );

  useEffect(() => {
    if (!connectionRepairReason) return;
    const timer = window.setTimeout(() => setSettingsOpen(true), 0);
    return () => window.clearTimeout(timer);
  }, [connectionRepairReason]);
  const composerNotices = [
    ...noticesForScope(uiNotices, "composer"),
    ...noticesForScope(uiNotices, "attachment"),
  ];
  const sessionNotices = noticesForScope(uiNotices, "session");
  const historyNotices = noticesForScope(uiNotices, "history");
  const gatewayConnected = gatewayAvailable;
  const isStreaming = Boolean(
    selectedSessionId && runningSessionIds.has(selectedSessionId),
  );
  const toolFocus = useMemo(
    () => activeTurnToolFocus(messages, isStreaming),
    [isStreaming, messages],
  );
  const liveToolMessage = toolFocus?.toolMessage ?? null;
  const toolFocusCurrentTool = toolFocus?.toolMessage.toolGroup
    ? focusedToolPresentation(toolFocus.toolMessage.toolGroup.tools)
    : undefined;
  const toolFocusKey = toolFocus && toolFocusCurrentTool
    ? `${selectedSessionId ?? "session"}:${toolFocus.toolMessage.id}:${toolFocusCurrentTool.id}`
    : null;
  const toolFocusHistoryOpen = Boolean(
    toolFocusKey && toolFocusHistoryKey === toolFocusKey,
  );
  const timelineMessages = useMemo(
    () => turnTimelineMessages(messages),
    [messages],
  );
  const isStopping = Boolean(
    selectedSessionId && stoppingSessionIds.has(selectedSessionId),
  );
  const agentActivity = selectedSessionId
    ? agentActivitiesBySession.get(selectedSessionId) ?? null
    : null;

  const isPromptSubmitting = Boolean(
    selectedSessionId && submittingPromptSessionIds.has(selectedSessionId),
  );
  const sessionReady = Boolean(
    gatewayAvailable &&
      gatewayState &&
      gatewaySelected,
  );
  const derivedComposerState = deriveComposerState({
    connectionStatus,
    gatewayAvailable,
    hasGatewayState: Boolean(gatewayState),
    hasSelectedSession: Boolean(selected),
    selectedArchived: false,
    attachmentBusy,
    promptSubmitting: isPromptSubmitting,
    isStreaming,
    isStopping,
    hasContent: Boolean(draft.trim() || pendingFiles.length > 0),
  });
  const composerState = optimisticSelected && optimisticSession
    ? optimisticSession.phase === "failed"
      ? {
          canType: true,
          canSend: false,
          mode: "blocked" as const,
          reason: "Session creation failed · Retry creation to send queued messages",
        }
      : optimisticSession.phase === "uncertain"
        ? {
            canType: true,
            canSend: false,
            mode: "blocked" as const,
            reason: "Creation result not confirmed · Check the result or stop waiting",
          }
        : derivedComposerState.canSend
          ? {
              ...derivedComposerState,
              mode: "queue" as const,
              reason: "Creating conversation · Send queues this message safely",
            }
          : derivedComposerState
    : derivedComposerState;
  const conversationTitle =
    selected?.title ??
    (trustedGateway
      ? gatewayState
        ? "No active session"
        : "Syncing conversations…"
      : "Connect a computer");
  const activeProvider =
    selected?.provider ?? gatewayState?.workspace.provider ?? "Agent";
  const selectedProjectWorkspace = selected
    ? gatewayState?.projects?.find(project => project.projectId === selected.projectId)
    : undefined;
  const activeWorkspace = selected
    ? {
        ...selectedProjectWorkspace,
        projectId: selected.projectId,
        projectName: selected.projectName,
        cwd: selected.cwd,
        provider: selected.provider,
        model: selected.model,
        reasoningEffort: selected.reasoningEffort,
        permissionMode: selectedProjectWorkspace?.permissionMode ?? "default",
      }
    : gatewayState?.workspace;
  const activeProjectGateway = activeWorkspace
    ? projectGatewaysById.get(activeWorkspace.projectId) ?? fallbackProjectGateway
    : fallbackProjectGateway;
  const workspaceGatewayCount = gatewayState?.gatewayDirectory?.directory.gateways.length
    ?? (trustedGateway ? 1 : 0);
  const onlyWorkspaceGateway = gatewayState?.gatewayDirectory?.directory.gateways[0];
  const workspaceGatewayTitle = workspaceGatewayCount > 1
    ? `${workspaceGatewayCount} Gateways`
    : onlyWorkspaceGateway
      ? gatewayProjectOwner(
          onlyWorkspaceGateway.gatewayNodeId,
          onlyWorkspaceGateway.gatewayName,
          onlyWorkspaceGateway.computerName,
        ).label
      : trustedGateway
        ? fallbackProjectGateway.label
      : "Connect a computer";
  const activeCapabilities = activeWorkspace?.capabilities ?? gatewayState?.capabilities;
  const canCreateAnySession = (gatewayState?.projects ?? (gatewayState ? [gatewayState.workspace] : []))
    .some(project => (project.capabilities ?? gatewayState?.capabilities)?.canCreateSession);
  const projectCreationGateways = useMemo<ProjectCreationGateway[]>(() => {
    if (!gatewayState) return [];
    const workspaces = gatewayState.projects ?? [gatewayState.workspace];
    const directory = gatewayState.gatewayDirectory?.directory;
    if (directory) {
      return directory.gateways.flatMap(gateway => {
        const route = (gateway.projects ?? []).find(candidate =>
          workspaces.some(project => project.projectId === candidate.projectId),
        );
        const workspace = route
          ? workspaces.find(project => project.projectId === route.projectId)
          : undefined;
        if (!route || !workspace) return [];
        const capabilities = workspace.capabilities ?? gatewayState.capabilities;
        return [{
          gatewayNodeId: gateway.gatewayNodeId,
          gatewayName: gateway.gatewayName,
          computerName: gateway.computerName,
          targetProjectId: route.projectId,
          providers: capabilities.providers.map(provider => ({
            id: provider.id,
            name: provider.name,
          })),
          defaultProvider: workspace.provider,
        }];
      });
    }
    const gatewayNodeId = matrixConfig.gatewayNodeId
      ?? trustedGateway?.gatewayNodeId
      ?? matrixConfig.gatewayId;
    if (!gatewayNodeId) return [];
    const capabilities = gatewayState.workspace.capabilities ?? gatewayState.capabilities;
    return [{
      gatewayNodeId,
      gatewayName: fallbackProjectGateway.gatewayName,
      computerName: fallbackProjectGateway.computerName,
      targetProjectId: gatewayState.workspace.projectId,
      providers: capabilities.providers.map(provider => ({
        id: provider.id,
        name: provider.name,
      })),
      defaultProvider: gatewayState.workspace.provider,
    }];
  }, [
    fallbackProjectGateway.gatewayName,
    fallbackProjectGateway.computerName,
    gatewayState,
    matrixConfig.gatewayId,
    matrixConfig.gatewayNodeId,
    trustedGateway,
  ]);
  const automaticGatewayUpdateTargets = useMemo(() =>
    selectAutomaticGatewayUpdateTargets({
      directory: gatewayState?.gatewayDirectory,
      knownProjectIds: new Set(
        (gatewayState?.projects ?? (gatewayState ? [gatewayState.workspace] : []))
          .map((project) => project.projectId),
      ),
      release: gatewayRelease,
    }), [gatewayRelease, gatewayState]);
  const providerHistorySources = useMemo<ProviderHistorySource[]>(() => {
    if (!gatewayState) return [];
    return buildProviderHistorySources({
      workspaces: gatewayState.projects ?? [gatewayState.workspace],
      projectOwners: projectGatewaysById,
      fallbackOwner: fallbackProjectGateway,
      fallbackCapabilities: gatewayState.capabilities,
      directoryAvailable: Boolean(gatewayState.gatewayDirectory),
    });
  }, [fallbackProjectGateway, gatewayState, projectGatewaysById]);
  const providerHistorySource = findProviderHistorySource(
    providerHistorySources,
    providerHistoryGatewayNodeId && providerHistoryProjectId
      ? {
          gatewayNodeId: providerHistoryGatewayNodeId,
          projectId: providerHistoryProjectId,
        }
      : null,
  );
  const providerHistoryWorkspace = providerHistorySource
    ? gatewayState?.projects?.find(
        project => project.projectId === providerHistorySource.projectId,
      ) ?? (gatewayState?.workspace.projectId === providerHistorySource.projectId
        ? gatewayState.workspace
        : undefined)
    : undefined;
  const providerHistoryCapabilities = providerHistoryWorkspace?.capabilities
    ?? (providerHistoryWorkspace ? gatewayState?.capabilities : undefined);
  const activeProviderModels = activeCapabilities?.providers.find(
    (provider) => provider.id === activeProvider,
  )?.models ?? activeCapabilities?.models ?? [];
  const activeModelCapability = activeProviderModels.find(
    (model) => model.id === activeWorkspace?.model,
  );

  function showUiNotice(
    key: string,
    scope: UiNoticeScope,
    severity: UiNoticeSeverity,
    message: string,
    autoDismissMs?: number | null,
  ) {
    dispatchUiNotice({
      type: "show",
      key,
      scope,
      severity,
      message,
      now: Date.now(),
      ...(autoDismissMs === undefined ? {} : { autoDismissMs }),
    });
  }

  function updateSessionLifecycleBusy(
    update:
      | Map<string, SessionLifecycleAction>
      | ((current: ReadonlyMap<string, SessionLifecycleAction>) => Map<string, SessionLifecycleAction>),
  ): void {
    const next = typeof update === "function"
      ? update(sessionLifecycleBusyRef.current)
      : update;
    sessionLifecycleBusyRef.current = next;
    setSessionLifecycleBusy(next);
  }

  function dismissUiNotice(key: string) {
    dispatchUiNotice({ type: "dismiss", key });
  }

  function recoverUiNotice(key: string) {
    dispatchUiNotice({ type: "operation-recovered", key });
  }

  function setSessionRunning(sessionId: string, running: boolean) {
    setRunningSessionIds((current) => {
      const next = new Set(current);
      if (running) next.add(sessionId);
      else next.delete(sessionId);
      return next;
    });
  }

  function setSessionStopping(sessionId: string, stopping: boolean) {
    setStoppingSessionIds((current) => {
      const next = new Set(current);
      if (stopping) next.add(sessionId);
      else next.delete(sessionId);
      return next;
    });
  }

  function setSessionPromptSubmitting(sessionId: string, submitting: boolean) {
    if (submitting) pendingPromptSessionIdsRef.current.add(sessionId);
    else pendingPromptSessionIdsRef.current.delete(sessionId);
    setSubmittingPromptSessionIds((current) => {
      const next = new Set(current);
      if (submitting) next.add(sessionId);
      else next.delete(sessionId);
      return next;
    });
  }

  function hasActivePromptCommand(sessionId: string): boolean {
    return [...activePromptCommandsRef.current.values()].some(
      (candidate) => candidate === sessionId,
    );
  }

  function finishLocalPromptCommand(sessionId: string): void {
    if (
      hasActivePromptCommand(sessionId) ||
      pendingPromptSessionIdsRef.current.has(sessionId)
    ) {
      setSessionRunning(sessionId, true);
      return;
    }
    setSessionRunning(sessionId, false);
    setSessionStopping(sessionId, false);
    setSessionAgentActivity(sessionId, null);
  }

  function setSessionAgentActivity(
    sessionId: string,
    update:
      | AgentActivity
      | null
      | ((current: AgentActivity | null) => AgentActivity | null),
  ) {
    setAgentActivitiesBySession((current) => {
      const next = new Map(current);
      const activity =
        typeof update === "function"
          ? update(next.get(sessionId) ?? null)
          : update;
      if (activity) next.set(sessionId, activity);
      else next.delete(sessionId);
      return next;
    });
  }

  function rememberLiveMessage(
    sessionId: string,
    message: ChatMessage,
    options: { reconcileMessageId?: string } = {},
  ) {
    const current = liveMessagesBySessionRef.current.get(sessionId) ?? [];
    const exactIndex = current.findIndex((entry) => entry.id === message.id);
    const next =
      options.reconcileMessageId
        ? mergeChatMessage(current, message, options)
        : exactIndex >= 0
        ? current.map((entry, index) =>
            index === exactIndex ? { ...entry, ...message } : entry,
          )
        : mergeChatMessage(current, message);
    liveMessagesBySessionRef.current.set(sessionId, next.slice(-1_000));
  }

  function removeLiveMessage(sessionId: string, messageId: string) {
    const current = liveMessagesBySessionRef.current.get(sessionId);
    if (!current) return;
    liveMessagesBySessionRef.current.set(
      sessionId,
      current.filter((message) => message.id !== messageId),
    );
  }

  function observeCommandCompletion(result: CommandCompletion): void {
    if (!result.sessionId) return;
    const observed: ObservedCommandCompletion = {
      ...result,
      observedOrder: ++completionObservationOrderRef.current,
    };
    setObservedCommandCompletions((current) =>
      current.some((completion) => completion.commandId === result.commandId)
        ? current
        : [...current, observed],
    );
    const prompt = turnPrompt(
      liveMessagesBySessionRef.current.get(result.sessionId) ?? [],
      result.commandId,
    );
    if (prompt) {
      setTurnPromptCache((current) => {
        const next = new Map(current);
        next.set(result.commandId, prompt);
        return next;
      });
    }
  }

  useEffect(() => {
    writeProjectDisclosureState(window.localStorage, collapsedProjects);
  }, [collapsedProjects]);

  useEffect(() => {
    writeSessionReadState(window.localStorage, sessionReadState);
  }, [sessionReadState]);

  useEffect(() => {
    const sessionId = selectedSessionId;
    const scope = historyScopeRef.current;
    if (!sessionId || !scope) return;
    const unresolved = nextTurnPromptLookup(
      [
        ...messages,
        ...(liveMessagesBySessionRef.current.get(sessionId) ?? []),
      ],
      observedCommandCompletions,
      turnPromptCache,
      sessionId,
    );
    if (!unresolved) return;
    const lookupKey = `${sessionId}:${unresolved.commandId}`;
    if (turnPromptLookupRef.current.has(lookupKey)) return;
    turnPromptLookupRef.current.add(lookupKey);
    void loadTurnPromptHistory(scope, sessionId, unresolved.commandId)
      .then((prompt) => {
        if (historyScopeRef.current !== scope) return;
        setTurnPromptCache((current) => {
          const next = new Map(current);
          next.set(
            unresolved.commandId,
            prompt ? { ...prompt, sessionId, historical: true } : null,
          );
          return next;
        });
      })
      .catch((error) => {
        showUiNotice(
          "history:turn-prompt",
          "history",
          "warning",
          `The task's original message could not be read: ${formatUiError(error)}`,
        );
      })
      .finally(() => turnPromptLookupRef.current.delete(lookupKey));
  }, [
    messages,
    observedCommandCompletions,
    selectedSessionId,
    turnPromptCache,
  ]);

  useEffect(() => {
    const turn = latestCompletedTurn;
    if (!turn) return;
    if (turn.promptInTranscript) return;
    if (
      historyLoading ||
      turnHistoryHydrationRef.current === turn.commandId ||
      (turnHistoryLoad?.commandId === turn.commandId &&
        (turnHistoryLoad.phase === "loading" ||
          turnHistoryLoad.phase === "error"))
    ) {
      return;
    }
    void hydrateTurnHistory(turn.completion.sessionId!, turn.commandId);
  }, [historyLoading, latestCompletedTurn, turnHistoryLoad]);

  useEffect(() => {
    if (!Object.values(uiNotices).some((notice) => notice.expiresAt !== null)) {
      return;
    }
    const timer = window.setInterval(() => {
      dispatchUiNotice({ type: "tick", now: Date.now() });
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [uiNotices]);

  useEffect(() => {
    const recovery = readPendingSessionCreateRecovery(window.localStorage);
    let optimistic = readOptimisticSession(window.localStorage, {
      gatewayId: matrixConfig.gatewayId,
      conversationId: matrixConfig.conversationId,
    });
    if (!optimistic && recovery) {
      optimistic = {
        ...createOptimisticSessionRecord(
          recovery.input,
          {
            gatewayId: recovery.gatewayId,
            conversationId: recovery.conversationId,
          },
          `local-session:${recovery.commandId}`,
          recovery.createdAt,
        ),
        commandId: recovery.commandId,
      };
      try {
        writeOptimisticSession(window.localStorage, optimistic);
      } catch {
        // The durable command recovery below remains authoritative.
      }
    }
    if (
      optimistic?.phase === "creating" &&
      !recovery &&
      !optimistic.commandId
    ) {
      optimistic = failOptimisticSession(
        optimistic,
        "Session creation stopped before its secure command was saved. Retry creation to continue.",
      );
      try {
        writeOptimisticSession(window.localStorage, optimistic);
      } catch {
        // The in-memory failed draft remains usable for this page lifetime.
      }
    }
    if (
      optimistic?.phase === "creating" &&
      recovery &&
      isSessionCreateRecoveryUncertain(recovery)
    ) {
      optimistic = markOptimisticSessionUncertain(
        optimistic,
        "Your computer accepted the secure command, but Malink could not confirm its final result. Check again, or stop waiting to create a different conversation.",
      );
      try {
        writeOptimisticSession(window.localStorage, optimistic);
      } catch {
        // The in-memory uncertain draft remains actionable for this page lifetime.
      }
    }
    if (optimistic?.phase === "uncertain" && !recovery) {
      optimistic = failOptimisticSession(
        optimistic,
        "The saved creation command is no longer available. Stop waiting and create the session again.",
      );
      try {
        writeOptimisticSession(window.localStorage, optimistic);
      } catch {
        // The in-memory failed draft remains usable for this page lifetime.
      }
    }
    if (recovery) pendingSessionCreateRecoveryRef.current = recovery;
    if (optimistic) optimisticSessionRef.current = optimistic;
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      if (optimistic) {
        setOptimisticSession(optimistic);
        void restoreOptimisticSessionMessages(optimistic);
        if (
          !selectedSessionIdRef.current ||
          selectedSessionIdRef.current === optimistic.localSessionId
        ) {
          activateLocalSession(
            optimistic.localSessionId,
            null,
            true,
            true,
          );
        }
      }
      if (recovery && optimistic?.phase !== "uncertain") {
        setPendingSessionCreate(recovery.input);
        setNewSessionBusy(true);
      }
    });
    return () => {
      active = false;
    };
    // This restores one durable record for the initial Matrix binding. The
    // callbacks intentionally read current refs and must not restart whenever
    // the render-local helper identities change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const updater = registerPwaUpdates(setPwaUpdateState, {
      canReload: () => !pwaReloadBlockedRef.current,
    });
    pwaUpdateRef.current = updater;
    return () => {
      pwaUpdateRef.current = null;
      updater.dispose();
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const refresh = () => {
      void discoverLatestGatewayAgentUpdate(fetch, controller.signal)
        .then((release) => {
          if (controller.signal.aborted) return;
          setGatewayUpdateDiscoveryError(null);
          if (!release) return;
          setGatewayRelease((current) =>
            current?.releaseId === release.releaseId && current.buildId === release.buildId
              ? current
              : release,
          );
        })
        .catch((error) => {
          if (controller.signal.aborted) return;
          const detail = formatUiError(error);
          console.warn(`[gateway-update/discovery] ${detail}`, error);
          setGatewayUpdateDiscoveryError(detail);
        });
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") refresh();
    };
    refresh();
    const timer = window.setInterval(refresh, GATEWAY_UPDATE_DISCOVERY_INTERVAL_MS);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      controller.abort();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);

  useEffect(() => {
    componentMountedRef.current = true;
    return () => {
      componentMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (connectionStatus !== "connected" || !gatewayRelease) return;
    const release = gatewayRelease;
    const targets = automaticGatewayUpdateTargets.filter((target) =>
      !automaticGatewayUpdateAttemptsRef.current.has(
        `${target.gatewayNodeId}\0${release.releaseId}\0${release.buildId}`,
      ) &&
      !hasAttemptedAutomaticGatewayUpdate(
        window.localStorage,
        target.gatewayNodeId,
        release,
      ),
    );
    if (targets.length === 0) return;
    for (const target of targets) {
      // This tab must also remain one-shot when localStorage is unavailable.
      automaticGatewayUpdateAttemptsRef.current.add(
        `${target.gatewayNodeId}\0${release.releaseId}\0${release.buildId}`,
      );
    }
    void (async () => {
      setGatewayUpdateBusy(true);
      setGatewayUpdateError(null);
      try {
        await Promise.all(targets.map(async (target) => {
          recordAutomaticGatewayUpdateAttempt(
            window.localStorage,
            target.gatewayNodeId,
            release,
          );
          try {
            const status = await triggerAutomaticGatewayUpdate({
              release,
              target,
              send: (command, targetProjectId) =>
                executeGatewayUpdateRef.current(command, targetProjectId),
            });
            if (componentMountedRef.current) {
              showUiNotice(
                `gateway-update:${target.gatewayNodeId}`,
                "connection",
                "success",
                status.phase === "committed"
                  ? `${target.gatewayName} already runs the Gateway release paired with this PWA.`
                  : `${target.gatewayName} stopped starting new tasks and will switch after its current Agent work finishes.`,
                8_000,
              );
            }
          } catch (error) {
            if (componentMountedRef.current) {
              const detail = formatUiError(error);
              setGatewayUpdateError(detail);
              showUiNotice(
                `gateway-update:${target.gatewayNodeId}`,
                "connection",
                "warning",
                `${target.gatewayName} could not start its paired Gateway update: ${detail}`,
              );
            }
          }
        }));
      } finally {
        if (componentMountedRef.current) setGatewayUpdateBusy(false);
      }
    })();
  }, [automaticGatewayUpdateTargets, connectionStatus, gatewayRelease]);

  useEffect(() => {
    let active = true;
    const vapidPublicKey = gatewayState?.capabilities.webPush?.vapidPublicKey;
    if (nativeRuntime || !vapidPublicKey) {
      void Promise.resolve<WebPushNotificationState>({ status: "unavailable" })
        .then(state => {
          if (active) setWebPushState(state);
        });
      return () => {
        active = false;
      };
    }
    const client = malinkClientRef.current;
    const inspect = client?.runtime === "web" && connectionStatus === "connected"
      ? synchronizeWebPushNotifications({
          client,
          gatewayId: matrixConfig.gatewayId,
          vapidPublicKey,
        })
      : inspectWebPushNotifications(vapidPublicKey);
    void inspect.then(state => {
      if (active) setWebPushState(state);
    }).catch(error => {
      if (active) setWebPushState({ status: "error", detail: formatUiError(error) });
    });
    return () => {
      active = false;
    };
  }, [
    connectionStatus,
    deviceKeyId,
    gatewayState?.capabilities.webPush?.vapidPublicKey,
    matrixConfig.gatewayId,
    nativeRuntime,
  ]);

  async function enableAgentNotifications(): Promise<void> {
    const client = malinkClientRef.current;
    const vapidPublicKey = gatewayState?.capabilities.webPush?.vapidPublicKey;
    if (!client || client.runtime !== "web" || !vapidPublicKey) {
      setWebPushState({ status: "unavailable" });
      return;
    }
    setWebPushBusy(true);
    try {
      setWebPushState(await enableWebPushNotifications({
        client,
        gatewayId: matrixConfig.gatewayId,
        vapidPublicKey,
      }));
    } catch (error) {
      setWebPushState({ status: "error", detail: formatUiError(error) });
    } finally {
      setWebPushBusy(false);
    }
  }

  async function disableAgentNotifications(): Promise<void> {
    const client = malinkClientRef.current;
    if (!client || client.runtime !== "web") {
      setWebPushState({ status: "unavailable" });
      return;
    }
    setWebPushBusy(true);
    try {
      setWebPushState(await disableWebPushNotifications({
        client,
        gatewayId: matrixConfig.gatewayId,
      }));
    } catch (error) {
      setWebPushState({ status: "error", detail: formatUiError(error) });
    } finally {
      setWebPushBusy(false);
    }
  }

  useEffect(() => {
    connectionStatusRef.current = connectionStatus;
  }, [connectionStatus]);

  useEffect(() => {
    if (isNativeManagedMatrixConfig(matrixConfig)) return;
    const reportBrowserOffline = () => {
      connectionStatusRef.current = "offline";
      setConnectionStatus("offline");
      setConnectionDetail(null);
      setConnectionError(null);
    };
    window.addEventListener("offline", reportBrowserOffline);
    if (!navigator.onLine) reportBrowserOffline();
    return () => window.removeEventListener("offline", reportBrowserOffline);
  }, [matrixConfig]);

  useEffect(
    () => () => {
      if (sessionCreateRecoveryTimerRef.current !== null) {
        window.clearTimeout(sessionCreateRecoveryTimerRef.current);
      }
      if (connectionRecoveryTimerRef.current !== null) {
        window.clearTimeout(connectionRecoveryTimerRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    const focusSessionSearch = (event: globalThis.KeyboardEvent) => {
      if (event.key.toLowerCase() !== "k" || (!event.metaKey && !event.ctrlKey)) {
        return;
      }
      event.preventDefault();
      setMobileChatOpen(false);
      setSessionSearchOpen(true);
      window.requestAnimationFrame(() => sessionSearchRef.current?.focus());
    };
    window.addEventListener("keydown", focusSessionSearch);
    return () => window.removeEventListener("keydown", focusSessionSearch);
  }, []);

  useEffect(() => {
    if (!detailsOpen) return;
    const closeDetails = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setDetailsOpen(false);
      detailsButtonRef.current?.focus();
    };
    const closeDetailsFromOutside = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (
        detailsPopoverRef.current?.contains(target) ||
        detailsButtonRef.current?.contains(target)
      ) {
        return;
      }
      setDetailsOpen(false);
    };
    window.addEventListener("keydown", closeDetails);
    window.addEventListener("pointerdown", closeDetailsFromOutside);
    return () => {
      window.removeEventListener("keydown", closeDetails);
      window.removeEventListener("pointerdown", closeDetailsFromOutside);
    };
  }, [detailsOpen]);

  useEffect(() => {
    const recoverInterruptedStartup = () => {
      const startup = matrixStartupRef.current;
      if (!startup) return;
      const visible = document.visibilityState === "visible";
      if (
        !shouldReloadInterruptedMatrixStartup({
          phase: startup.phase,
          startedAt: startup.startedAt,
          hiddenAt: startup.hiddenAt,
          now: Date.now(),
          visible,
        })
      ) {
        return;
      }
      if (sessionStorage.getItem(MATRIX_STARTUP_RECOVERY_SESSION_KEY)) {
        setConnectionDetail(
          "Android interrupted secure startup again. Keep Malink visible; if it does not continue, tap Disconnect and reconnect.",
        );
        return;
      }
      sessionStorage.setItem(
        MATRIX_STARTUP_RECOVERY_SESSION_KEY,
        String(Date.now()),
      );
      window.location.reload();
    };
    const onVisibilityChange = () => {
      const startup = matrixStartupRef.current;
      if (!startup) return;
      if (document.visibilityState === "hidden") {
        startup.hiddenAt = Date.now();
        setConnectionDetail(
          "Secure startup paused in the background. Return to Malink to resume it.",
        );
        return;
      }
      recoverInterruptedStartup();
      if (!sessionStorage.getItem(MATRIX_STARTUP_RECOVERY_SESSION_KEY)) {
        startup.hiddenAt = null;
        setConnectionDetail("Resuming secure startup…");
      }
    };
    const interval = window.setInterval(recoverInterruptedStartup, 1_000);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);

  useEffect(() => {
    const openRequestedSession = () => {
      const url = new URL(window.location.href);
      const hash = new URLSearchParams(url.hash.replace(/^#/, ""));
      const requested = hash.get("session");
      if (!requested) return;
      hash.delete("session");
      const nextHash = hash.toString();
      window.history.replaceState(
        window.history.state,
        "",
        `${url.pathname}${url.search}${nextHash ? `#${nextHash}` : ""}`,
      );
      if (
        requested.length > 512 ||
        [...requested].some((character) => /\p{Cc}/u.test(character))
      ) {
        return;
      }
      pendingOpenedSessionIdRef.current = requested;
      if (!knownGatewaySessionIdsRef.current.has(requested)) return;
      pendingOpenedSessionIdRef.current = null;
      activateLocalSessionRef.current(requested);
      setMobileChatOpen(true);
    };
    openRequestedSession();
    window.addEventListener("hashchange", openRequestedSession);
    return () => window.removeEventListener("hashchange", openRequestedSession);
  }, []);

  useEffect(() => {
    const route = pairingRouteFromUrl(window.location.href);
    const link = route.pairingLink;
    const invitation = route.deviceInvitation;
    const shortInvitation = route.shortInvitation;
    const deferStoredStartupForPairing =
      shouldDeferStoredMatrixStartupForPairing({
        pairingLink: link,
        deviceInvitation: invitation,
        shortInvitation,
      });
    const rejectedQueryPairing = route.rejectedQueryPairing;
    if (hasPairingRoute(route)) {
      window.history.replaceState(
        window.history.state,
        "",
        route.sanitizedPath,
      );
    }
    if (invitation) void openDeviceInvitation(invitation);
    else if (link) void openPairingLink(link);
    else if (shortInvitation) void openPairingLink(shortInvitation);
    void (async () => {
      if (rejectedQueryPairing) {
        await Promise.resolve();
        setConnectionError(
          "Pairing links in the URL query are not accepted. Scan the QR code or use a fragment invitation.",
        );
        setSettingsOpen(true);
        return;
      }
      // The invitation flow owns native bridge startup for this boot. Restoring
      // a stored native session at the same time would attach a second Web
      // client before the one-time Matrix bootstrap can acquire the port.
      if (deferStoredStartupForPairing) return;
      const identity = await getOrCreateDeviceIdentity();
      const trust = await loadTrustedGateway(identity);
      const savedTrusts = await loadTrustedGateways(identity);
      setSavedGateways(savedTrusts.map(publicTrustFromWeb));
      const stored = loadMatrixConfig(trust?.gatewayId) ?? loadMatrixConfig() ?? emptyMatrixConfig;
      if (trust) {
        clearPendingPairing();
        setTrustedGateway(publicTrustFromWeb(trust));
        setActiveDeviceCount(trust.activeDeviceCount ?? null);
        setDeviceKeyId(identity.keyId);
        const trustedConfig: MatrixConnectionConfig = {
          ...bindCredentialsToHomeserver(
            stored,
            trust.gatewayTransport.homeserver,
          ),
          ...trustedGatewayConfig(trust),
          conversationId:
            stored.conversationId || trust.gatewayTransport.roomId,
        };
        setMatrixConfig(trustedConfig);
        const recoveryRequestedAt = Number(
          sessionStorage.getItem(MATRIX_STARTUP_RECOVERY_SESSION_KEY),
        );
        const resumeInterruptedStartup =
          Number.isFinite(recoveryRequestedAt) &&
          recoveryRequestedAt > 0 &&
          Date.now() - recoveryRequestedAt < 5 * 60_000;
        setSettingsOpen(false);
        await connectMalinkClient(
          trustedConfig,
          true,
          resumeInterruptedStartup,
        );
        return;
      }
      if (isNativeManagedMatrixConfig(stored)) {
        clearPendingPairing();
        setMatrixConfig(stored);
        setSettingsOpen(false);
        await connectMalinkClient(stored, true, true);
        return;
      }
      const pending = await loadPendingPairingRecovery(identity);
      if (!pending) {
        setSettingsOpen(true);
        return;
      }
      if (pending.status === "expired") {
        setConnectionError(
          "The previous invitation expired. Scan a new QR code from your computer.",
        );
        setSettingsOpen(true);
        return;
      }
      const preview = pending.preview;
      const transport = preview.transport;
      const recoveryConfig: MatrixConnectionConfig = {
        ...bindCredentialsToHomeserver(stored, transport.homeserver),
        roomId: transport.roomId,
        gatewayId: preview.gatewayId,
        gatewayNodeId: preview.gatewayNodeId,
        conversationId: transport.roomId,
        gatewayMatrixUserId: transport.userId,
        gatewayMatrixDeviceId: transport.deviceId,
        gatewayMatrixEd25519: transport.ed25519,
      };
      setPairingPreview(preview);
      setMatrixConfig(recoveryConfig);
      setSettingsOpen(true);
      await pairingRecoveryRef.current(preview, recoveryConfig);
    })().catch((error) => {
      setConnectionError(`Saved trust could not be verified: ${formatUiError(error)}`);
    });
    // URL fragments and persisted pairing recovery are consumed once at boot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const openRuntimePairingRoute = () => {
      const route = pairingRouteFromUrl(window.location.href);
      if (!route.pairingLink && !route.deviceInvitation && !route.shortInvitation) return;
      window.history.replaceState(
        window.history.state,
        "",
        route.sanitizedPath,
      );
      if (route.deviceInvitation) void openDeviceInvitation(route.deviceInvitation);
      else if (route.pairingLink) void openPairingLink(route.pairingLink);
      else if (route.shortInvitation) void openPairingLink(route.shortInvitation);
    };
    window.addEventListener("hashchange", openRuntimePairingRoute);
    return () => window.removeEventListener("hashchange", openRuntimePairingRoute);
    // Runtime invitation delivery is intentionally registered once. The
    // handlers read current refs/state and own their async serialization.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useLayoutEffect(() => {
    const feed = feedRef.current;
    if (!feed) return;
    const prepend = prependScrollRef.current;
    if (prepend) {
      prependScrollRef.current = null;
      feed.scrollTop =
        prepend.scrollTop + (feed.scrollHeight - prepend.scrollHeight);
      setFeedAwayFromLatest(!isNearFeedBottom(feed));
      return;
    }
    if (followLatestRef.current) {
      feed.scrollTo({
        top: feed.scrollHeight,
        behavior: "auto",
      });
      setFeedAwayFromLatest(false);
      setFeedHasUnseenMessages(false);
    } else {
      setFeedAwayFromLatest(!isNearFeedBottom(feed));
    }
  }, [messages, isStreaming]);

  useEffect(
    () => () => {
      matrixStartupGenerationRef.current += 1;
      connectionRecoveryAllowedRef.current = false;
      if (connectionRecoveryTimerRef.current !== null) {
        window.clearTimeout(connectionRecoveryTimerRef.current);
        connectionRecoveryTimerRef.current = null;
      }
      pairingAbortRef.current?.abort();
      clearSessionLifecycleRecoveries();
      malinkClientRef.current?.dispose();
    },
    [],
  );

  function receiveMatrixMessage(incoming: IncomingMalinkMessage) {
    if (incoming.revision !== undefined) {
      setGatewayRevision((current) =>
        current === null ? incoming.revision! : Math.max(current, incoming.revision!),
      );
    }
    const sessionId =
      incoming.sessionId ?? selectedSessionIdRef.current ?? undefined;
    if (sessionId && !incoming.historical) {
      setSessionAgentActivity(sessionId, (current) => {
        if (incoming.kind === "user") {
          return current?.phase === "starting" ||
            current?.phase === "working" ||
            current?.phase === "stopping"
            ? current
            : WAITING_AGENT_ACTIVITY;
        }
        return reduceAgentActivity(current, incoming.raw);
      });
      const executionSignal = agentExecutionSignal(incoming.raw);
      if (executionSignal === "running") {
        setSessionRunning(sessionId, true);
      } else if (executionSignal === "stopping") {
        setSessionRunning(sessionId, true);
        setSessionStopping(sessionId, true);
      } else if (executionSignal === "stopped") {
        setSessionRunning(sessionId, false);
        setSessionStopping(sessionId, false);
      }
    }
    const lifecycleFailure = agentLifecycleFailureText(incoming.raw);
    if (
      isTransientAgentLifecycleEvent(incoming.raw) &&
      lifecycleFailure === null
    ) {
      if (sessionId && incoming.replacesEventId) {
        const replacementTarget = incoming.replacesEventId;
        removeLiveMessage(sessionId, replacementTarget);
        if (selectedSessionIdRef.current === sessionId) {
          setMessages((current) =>
            current.filter(
              (message) =>
                message.id !== replacementTarget &&
                message.eventId !== replacementTarget &&
                !message.eventAliases?.includes(replacementTarget),
            ),
          );
        }
        if (historyScopeRef.current) {
          void deleteMessageHistory(
            historyScopeRef.current,
            replacementTarget,
          ).catch((error) => {
            showUiNotice(
              "history:lifecycle-cleanup",
              "history",
              "warning",
              `Transient lifecycle history could not be removed: ${formatUiError(error)}`,
            );
          });
        }
      }
      return;
    }
    const displayIncoming: IncomingMalinkMessage =
      lifecycleFailure === null
        ? incoming
        : { ...incoming, kind: "error", text: lifecycleFailure };
    const ownUserMessage = Boolean(
      incoming.kind === "user" &&
        incoming.originDeviceId &&
        incoming.originDeviceId === malinkClientRef.current?.deviceId,
    );
    const message: ChatMessage = {
      ...chatMessageFromIncoming(displayIncoming, sessionId),
      ...(ownUserMessage ? { deliveryState: "sent" } : {}),
    };
    const optimisticMessageId = ownUserMessage
      ? findOptimisticMessageId(optimisticMessagesRef.current.values(), message)
      : undefined;
    if (optimisticMessageId) {
      reconciledOptimisticMessageIdsRef.current.add(optimisticMessageId);
      optimisticMessagesRef.current.delete(optimisticMessageId);
      recoverUiNotice("composer:send");
    }
    if (sessionId && !incoming.historical) {
      rememberLiveMessage(sessionId, message, {
        reconcileMessageId: optimisticMessageId,
      });
    }
    if (sessionId && historyScopeRef.current) {
      const persist =
        message.kind === "user" && message.eventId
          ? reconcileMessageHistory(
              historyScopeRef.current,
              sessionId,
              message,
              optimisticMessageId,
            )
          : saveMessageHistory(historyScopeRef.current, sessionId, [message]);
      void persist.catch((error) => {
        showUiNotice(
          "history:save",
          "history",
          "warning",
          `Conversation history could not be saved: ${formatUiError(error)}`,
        );
      });
    }
    if (
      sessionId &&
      sessionId !== selectedSessionIdRef.current
    ) {
      return;
    }
    if (incoming.requestId && !incoming.historical) {
      const resolvedActionId = resolvedDecisionActionId(incoming.raw);
      setDecisionStates((current) => ({
        ...current,
        [message.id]: resolvedActionId
          ? { actionId: resolvedActionId }
          : "pending",
      }));
    }
    const feed = feedRef.current;
    followLatestRef.current = !feed || isNearFeedBottom(feed);
    if (!followLatestRef.current && !incoming.historical) {
      setFeedHasUnseenMessages(true);
    }
    setMessages((current) =>
      mergeChatMessage(current, message, {
        reconcileMessageId: optimisticMessageId,
      }),
    );
  }

  function recoverLateHistory(page: MalinkHistoryRecovery): void {
    const scope = historyScopeRef.current;
    if (!scope) return;
    const recovered = page.messages.map((message) =>
      chatMessageFromIncoming(
        { ...incomingMessageFromClient(message), historical: true },
        message.sessionId ?? page.sessionId,
      ),
    );
    // Persist before checking the selected-session generation. A response may
    // arrive after the user switched conversations and must still be visible
    // when they return.
    void persistMessageHistoryPage(scope, page.sessionId, recovered)
      .then(() => {
        if (historySessionIdRef.current !== page.sessionId) return;
        historyCursorRef.current = olderHistoryCursor(
          historyCursorRef.current,
          recovered,
        );
        setMessages((current) => mergeChatMessages(current, recovered));
        setHistoryHasMore(page.hasMore);
        setHistoryError(null);
        setHistoryRetryMode(null);
      })
      .catch((error) => {
        if (historySessionIdRef.current === page.sessionId) {
          setHistoryError(
            `Recovered history could not be saved: ${formatUiError(error)}`,
          );
        }
      });
  }

  async function restoreSessionHistory(
    sessionId: string,
    connection: MalinkClient | null = malinkClientRef.current,
  ): Promise<void> {
    const scope = historyScopeRef.current;
    if (!scope) return;
    const generation = ++historyGenerationRef.current;
    historySessionIdRef.current = sessionId;
    historyCursorRef.current = null;
    followLatestRef.current = true;
    historyLoadingRef.current = true;
    setHistoryLoading(true);
    setHistoryError(null);
    setHistoryRetryMode(null);
    setHistoryHasMore(false);
    setMessages([]);
    setDecisionStates({});
    try {
      const cached = await loadMessageHistoryPage(scope, sessionId);
      if (
        generation !== historyGenerationRef.current ||
        historySessionIdRef.current !== sessionId
      ) {
        return;
      }
      const cachedMessages = cached.messages.map((message) => ({
        ...message,
        sessionId,
        historical: true,
        ...(message.deliveryState === "sending"
          ? { deliveryState: "failed" as const }
          : {}),
      }));
      const interruptedSends = cached.messages
        .filter((message) => message.deliveryState === "sending")
        .map((message) => ({
          ...message,
          deliveryState: "failed" as const,
        }));
      if (interruptedSends.length > 0) {
        await saveMessageHistory(
          scope,
          sessionId,
          interruptedSends,
        );
        if (
          generation !== historyGenerationRef.current ||
          historySessionIdRef.current !== sessionId
        ) {
          return;
        }
      }
      const liveMessages =
        liveMessagesBySessionRef.current.get(sessionId) ?? [];
      historyCursorRef.current = cached.cursor;
      setMessages((current) =>
        mergeChatMessages(
          current,
          withoutReconciledOptimisticCopies(
            [...liveMessages, ...cachedMessages],
            reconciledOptimisticMessageIdsRef.current,
          ),
        ),
      );
      if (cached.messages.some((message) => message.deliveryState === "queued")) {
        queuedSessionFlushIdsRef.current.add(sessionId);
        if (connection && connectionStatusRef.current === "connected") {
          void flushQueuedSessionMessages(sessionId, connection);
        }
      }
      setHistoryHasMore(cached.hasMore || Boolean(connection));

      if (!connection) return;
      connection.markHistoryLoaded(
        sessionId,
        cachedMessages.flatMap((message) =>
          message.eventId ? [message.eventId] : [],
        ),
      );
      // The live Matrix subscription is the only source of recent updates.
      // A populated local cache must render immediately and must never turn
      // focus, reload, or a Gateway-state timestamp into a remote history RPC.
      // A cache-cold device performs one explicit initial thread-page load;
      // older pages remain driven solely by user pagination below.
      const remote = cachedMessages.length > 0
        ? await connection.loadLocalHistory(sessionId)
        : await connection.loadHistoryPage(sessionId);
      const remoteMessages = remote.messages.map((message) =>
        chatMessageFromIncoming(
          { ...incomingMessageFromClient(message), historical: true },
          message.sessionId ?? sessionId,
        ),
      );
      if (remoteMessages.length > 0) {
        await persistMessageHistoryPage(scope, sessionId, remoteMessages);
      }
      if (
        generation !== historyGenerationRef.current ||
        historySessionIdRef.current !== sessionId
      ) {
        return;
      }
      if (remoteMessages.length > 0) {
        historyCursorRef.current = olderHistoryCursor(
          historyCursorRef.current,
          remoteMessages,
        );
        setMessages((current) =>
          mergeChatMessages(current, remoteMessages),
        );
      }
      setHistoryHasMore(cached.hasMore || remote.hasMore);
    } catch (error) {
      if (
        generation === historyGenerationRef.current &&
        historySessionIdRef.current === sessionId
      ) {
        setHistoryError(
          `Conversation history could not be restored: ${formatUiError(error)}`,
        );
        setHistoryRetryMode("restore");
      }
    } finally {
      if (generation === historyGenerationRef.current) {
        historyLoadingRef.current = false;
        setHistoryLoading(false);
      }
    }
  }

  async function loadOlderHistory(): Promise<void> {
    const sessionId = historySessionIdRef.current;
    const scope = historyScopeRef.current;
    if (
      !sessionId ||
      !scope ||
      historyLoadingRef.current ||
      !historyHasMore
    ) {
      return;
    }
    const generation = historyGenerationRef.current;
    historyLoadingRef.current = true;
    setHistoryLoading(true);
    setHistoryError(null);
    setHistoryRetryMode(null);
    try {
      const cached = await loadMessageHistoryPage(scope, sessionId, {
        before: historyCursorRef.current,
      });
      if (
        generation !== historyGenerationRef.current ||
        historySessionIdRef.current !== sessionId
      ) {
        return;
      }
      if (cached.messages.length > 0) {
        const olderMessages = cached.messages.map((message) => ({
          ...message,
          sessionId,
          historical: true,
        }));
        prepareHistoryPrepend(feedRef.current, prependScrollRef);
        historyCursorRef.current = cached.cursor;
        setMessages((current) =>
          mergeChatMessages(
            current,
            withoutReconciledOptimisticCopies(
              olderMessages,
              reconciledOptimisticMessageIdsRef.current,
            ),
          ),
        );
        // Consume at most one local page per pull. Once the local cache ends,
        // advance Matrix by one page in parallel so a later pull does not need
        // to replay every already-cached server page after a refresh.
        const connection = malinkClientRef.current;
        if (!connection) {
          setHistoryHasMore(cached.hasMore);
          return;
        }
        connection.markHistoryLoaded(
          sessionId,
          olderMessages.flatMap((message) =>
            message.eventId ? [message.eventId] : [],
          ),
        );
        const prefetched = await connection.loadHistoryPage(sessionId);
        const prefetchedMessages = prefetched.messages.map((message) =>
          chatMessageFromIncoming(
            { ...incomingMessageFromClient(message), historical: true },
            message.sessionId ?? sessionId,
          ),
        );
        if (prefetchedMessages.length > 0) {
          await persistMessageHistoryPage(
            scope,
            sessionId,
            prefetchedMessages,
          );
        }
        if (
          generation !== historyGenerationRef.current ||
          historySessionIdRef.current !== sessionId
        ) {
          return;
        }
        setHistoryHasMore(cached.hasMore || prefetched.hasMore);
        return;
      }

      const connection = malinkClientRef.current;
      if (!connection) {
        setHistoryHasMore(false);
        return;
      }
      const remote = await connection.loadHistoryPage(sessionId);
      const olderMessages = remote.messages.map((message) =>
        chatMessageFromIncoming(
          { ...incomingMessageFromClient(message), historical: true },
          message.sessionId ?? sessionId,
        ),
      );
      if (olderMessages.length > 0) {
        await persistMessageHistoryPage(scope, sessionId, olderMessages);
      }
      if (
        generation !== historyGenerationRef.current ||
        historySessionIdRef.current !== sessionId
      ) {
        return;
      }
      if (olderMessages.length > 0) {
        prepareHistoryPrepend(feedRef.current, prependScrollRef);
        historyCursorRef.current = olderHistoryCursor(
          historyCursorRef.current,
          olderMessages,
        );
        setMessages((current) =>
          mergeChatMessages(current, olderMessages),
        );
      }
      setHistoryHasMore(remote.hasMore);
    } catch (error) {
      if (
        generation === historyGenerationRef.current &&
        historySessionIdRef.current === sessionId
      ) {
        setHistoryError(
          `Older history could not be loaded: ${formatUiError(error)}`,
        );
        setHistoryRetryMode("older");
      }
    } finally {
      if (generation === historyGenerationRef.current) {
        historyLoadingRef.current = false;
        setHistoryLoading(false);
      }
    }
  }

  async function hydrateTurnHistory(
    sessionId: string,
    commandId: string,
  ): Promise<void> {
    const scope = historyScopeRef.current;
    if (
      !scope ||
      historySessionIdRef.current !== sessionId ||
      historyLoadingRef.current ||
      turnHistoryHydrationRef.current === commandId
    ) {
      return;
    }
    const generation = historyGenerationRef.current;
    turnHistoryHydrationRef.current = commandId;
    historyLoadingRef.current = true;
    setTurnHistoryLoad({ commandId, phase: "loading" });
    setHistoryError(null);
    setHistoryRetryMode(null);
    try {
      while (
        generation === historyGenerationRef.current &&
        historySessionIdRef.current === sessionId
      ) {
        const cached = await loadMessageHistoryPage(scope, sessionId, {
          before: historyCursorRef.current,
          limit: 100,
        });
        if (
          generation !== historyGenerationRef.current ||
          historySessionIdRef.current !== sessionId
        ) {
          return;
        }
        if (cached.messages.length > 0) {
          const cachedMessages = cached.messages.map((message) => ({
            ...message,
            sessionId,
            historical: true,
          }));
          const turnPage = trimHistoryPageToTurn(cachedMessages, commandId);
          prepareHistoryPrepend(feedRef.current, prependScrollRef);
          historyCursorRef.current = turnPage.prompt
            ? olderHistoryCursor(
                historyCursorRef.current,
                [turnPage.prompt],
              )
            : cached.cursor;
          setMessages((current) =>
            mergeChatMessages(
              current,
              withoutReconciledOptimisticCopies(
                turnPage.messages,
                reconciledOptimisticMessageIdsRef.current,
              ),
            ),
          );
          const connection = malinkClientRef.current;
          connection?.markHistoryLoaded(
            sessionId,
            cachedMessages.flatMap((message) =>
              message.eventId ? [message.eventId] : [],
            ),
          );
          if (turnPage.prompt) {
            setHistoryHasMore(
              turnPage.hasEarlierMessages ||
                cached.hasMore ||
                Boolean(connection),
            );
            setTurnHistoryLoad({ commandId, phase: "ready" });
            return;
          }
          if (cached.hasMore) {
            setHistoryHasMore(true);
            continue;
          }
        }

        const connection = malinkClientRef.current;
        if (!connection) {
          setHistoryHasMore(false);
          setTurnHistoryLoad({ commandId, phase: "error" });
          return;
        }
        const remote = await connection.loadHistoryPage(sessionId, 100);
        const remoteMessages = remote.messages.map((message) =>
          chatMessageFromIncoming(
            { ...incomingMessageFromClient(message), historical: true },
            message.sessionId ?? sessionId,
          ),
        );
        if (remoteMessages.length > 0) {
          await persistMessageHistoryPage(scope, sessionId, remoteMessages);
        }
        if (
          generation !== historyGenerationRef.current ||
          historySessionIdRef.current !== sessionId
        ) {
          return;
        }
        if (remoteMessages.length > 0) {
          const turnPage = trimHistoryPageToTurn(remoteMessages, commandId);
          prepareHistoryPrepend(feedRef.current, prependScrollRef);
          historyCursorRef.current = olderHistoryCursor(
            historyCursorRef.current,
            turnPage.prompt ? [turnPage.prompt] : remoteMessages,
          );
          setMessages((current) =>
            mergeChatMessages(current, turnPage.messages),
          );
          if (turnPage.prompt) {
            setHistoryHasMore(turnPage.hasEarlierMessages || remote.hasMore);
            setTurnHistoryLoad({ commandId, phase: "ready" });
            return;
          }
        }
        setHistoryHasMore(remote.hasMore);
        if (!remote.hasMore) {
          setTurnHistoryLoad({ commandId, phase: "error" });
          return;
        }
      }
    } catch (error) {
      if (
        generation === historyGenerationRef.current &&
        historySessionIdRef.current === sessionId
      ) {
        setTurnHistoryLoad({ commandId, phase: "error" });
        setHistoryError(
          `The task's original position could not be loaded: ${formatUiError(error)}`,
        );
        setHistoryRetryMode("older");
      }
    } finally {
      if (turnHistoryHydrationRef.current === commandId) {
        turnHistoryHydrationRef.current = null;
      }
      if (generation === historyGenerationRef.current) {
        historyLoadingRef.current = false;
      }
    }
  }

  function handleFeedScroll() {
    const feed = feedRef.current;
    if (!feed) return;
    followLatestRef.current = isNearFeedBottom(feed);
    setFeedAwayFromLatest(!followLatestRef.current);
    if (followLatestRef.current) setFeedHasUnseenMessages(false);
    if (
      feed.scrollTop <= 80 &&
      historyHasMore &&
      !historyLoadingRef.current
    ) {
      void loadOlderHistory();
    }
  }

  function scrollFeedToLatest() {
    const feed = feedRef.current;
    if (!feed) return;
    followLatestRef.current = true;
    feed.scrollTo({ top: feed.scrollHeight, behavior: "auto" });
    setFeedAwayFromLatest(false);
    setFeedHasUnseenMessages(false);
  }

  function bindMessageElement(
    messageId: string,
    element: HTMLDivElement | null,
  ): void {
    if (element) messageElementsRef.current.set(messageId, element);
    else messageElementsRef.current.delete(messageId);
  }

  function feedScrollBehavior(): ScrollBehavior {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches
      ? "auto"
      : "smooth";
  }

  function jumpToTurnOrigin(): void {
    const turn = latestCompletedTurn;
    const feed = feedRef.current;
    const promptId = turn?.promptInTranscript?.id;
    if (!turn || !feed || !promptId) {
      if (turn && turnHistoryLoad?.phase === "error") {
        void hydrateTurnHistory(turn.completion.sessionId!, turn.commandId);
      }
      return;
    }
    const promptElement = messageElementsRef.current.get(promptId);
    const resultElement = messageElementsRef.current.get(turn.result.id);
    if (!promptElement || !resultElement) return;
    const feedRect = feed.getBoundingClientRect();
    setFeedReturnAnchor({
      sessionId: turn.completion.sessionId!,
      messageId: turn.result.id,
      viewportOffset: resultElement.getBoundingClientRect().top - feedRect.top,
      fallbackScrollTop: feed.scrollTop,
    });
    const promptRect = promptElement.getBoundingClientRect();
    const centeredTop =
      feed.scrollTop +
      promptRect.top -
      feedRect.top -
      Math.max(18, (feed.clientHeight - promptRect.height) / 2);
    followLatestRef.current = false;
    feed.scrollTo({
      top: Math.max(0, centeredTop),
      behavior: feedScrollBehavior(),
    });
    setFeedAwayFromLatest(true);
  }

  function returnToTurnResult(): void {
    const feed = feedRef.current;
    const anchor = feedReturnAnchor;
    if (!feed || !anchor) return;
    const target = messageElementsRef.current.get(anchor.messageId);
    const top = target
      ? feed.scrollTop +
        target.getBoundingClientRect().top -
        feed.getBoundingClientRect().top -
        anchor.viewportOffset
      : anchor.fallbackScrollTop;
    followLatestRef.current = false;
    feed.scrollTo({ top: Math.max(0, top), behavior: feedScrollBehavior() });
    setFeedReturnAnchor(null);
    window.requestAnimationFrame(() => {
      const currentFeed = feedRef.current;
      if (currentFeed) {
        setFeedAwayFromLatest(!isNearFeedBottom(currentFeed));
      }
    });
  }

  function activateLocalSession(
    sessionId: string | null,
    connection: MalinkClient | null = malinkClientRef.current,
    revealProject = true,
    skipHistoryRestore = false,
  ) {
    const sessionChanged = selectedSessionIdRef.current !== sessionId;
    selectedSessionIdRef.current = sessionId;
    setSelectedSessionId(sessionId);
    if (historyScopeRef.current) {
      writeSelectedSession(
        window.localStorage,
        historyScopeRef.current,
        sessionId,
      );
    }
    const openedSession = gatewayState?.sessions.find(
      (session) => session.id === sessionId,
    );
    if (openedSession) {
      setSessionReadState((current) => markSessionRead(current, openedSession));
      if (sessionChanged && revealProject) {
        const projectKey = gatewayProjectKey(
          matrixConfig.gatewayId,
          openedSession.projectId,
        );
        setCollapsedProjects((current) =>
          setProjectCollapsed(current, projectKey, false),
        );
      }
    }
    if (!sessionChanged) return;
    setExpandedTurnId(null);
    setFeedReturnAnchor(null);
    setTurnHistoryLoad(null);
    followLatestRef.current = true;
    setFeedAwayFromLatest(false);
    setFeedHasUnseenMessages(false);
    setComposerOptionsOpen(false);
    historyGenerationRef.current += 1;
    historySessionIdRef.current = sessionId;
    historyCursorRef.current = null;
    setMessages([]);
    setDecisionStates({});
    setHistoryHasMore(Boolean(sessionId) && !skipHistoryRestore);
    setHistoryError(null);
    setHistoryRetryMode(null);
    if (!sessionId || skipHistoryRestore) {
      historyLoadingRef.current = false;
      setHistoryLoading(false);
    } else if (connection) {
      void restoreSessionHistory(sessionId, connection);
    }
  }
  activateLocalSessionRef.current = (sessionId) => activateLocalSession(sessionId);

  function setSessionCreateReloadBlocked(blocked: boolean): void {
    pwaReloadBlockedRef.current = blocked;
    if (!blocked) pwaUpdateRef.current?.resumeDeferredUpdate();
  }

  function clearPendingSessionCreateUi(): void {
    setPendingSessionCreate(null);
    setNewSessionBusy(false);
    setSessionCreateReloadBlocked(false);
  }

  function commitOptimisticSession(record: OptimisticSessionRecord): void {
    optimisticSessionRef.current = record;
    setOptimisticSession(record);
    try {
      writeOptimisticSession(window.localStorage, record);
    } catch (error) {
      showUiNotice(
        "session:create-draft-storage",
        "session",
        "warning",
        `This draft session remains usable while the page stays open, but could not be saved for reload: ${formatUiError(error)}`,
      );
    }
  }

  function removeOptimisticSession(localSessionId: string): void {
    if (optimisticSessionRef.current?.localSessionId !== localSessionId) return;
    optimisticSessionRef.current = null;
    setOptimisticSession(null);
    try {
      clearOptimisticSession(window.localStorage, localSessionId);
    } catch (error) {
      showUiNotice(
        "session:create-draft-storage",
        "session",
        "warning",
        `The completed draft marker could not be cleared: ${formatUiError(error)}`,
      );
    }
  }

  async function restoreOptimisticSessionMessages(
    record: OptimisticSessionRecord,
  ): Promise<void> {
    const scope = historyScopeRef.current;
    if (!scope) return;
    try {
      const queued = (await loadQueuedSessionMessages(
        scope,
        record.localSessionId,
      )).map<ChatMessage>((message) => ({
        ...message,
        sessionId: record.localSessionId,
        optimistic: true,
      }));
      const restored = mergeChatMessages(
        liveMessagesBySessionRef.current.get(record.localSessionId) ?? [],
        queued,
      );
      liveMessagesBySessionRef.current.set(record.localSessionId, restored);
      if (selectedSessionIdRef.current === record.localSessionId) {
        setMessages((current) => mergeChatMessages(current, restored));
      }
    } catch (error) {
      showUiNotice(
        "session:create-queue-storage",
        "composer",
        "warning",
        `Messages waiting for session creation could not be restored: ${formatUiError(error)}`,
      );
    }
  }

  function rememberPendingSessionCreate(
    input: NewSessionInput,
    commandId: string,
  ): PendingSessionCreateRecovery {
    const recovery: PendingSessionCreateRecovery = {
      version: 1,
      commandId,
      gatewayId: matrixConfig.gatewayId,
      conversationId: matrixConfig.conversationId,
      createdAt: Date.now(),
      input,
    };
    pendingSessionCreateRecoveryRef.current = recovery;
    setPendingSessionCreate(input);
    setNewSessionBusy(true);
    try {
      writePendingSessionCreateRecovery(window.localStorage, recovery);
    } catch (error) {
      showUiNotice(
        "session:create-recovery-storage",
        "session",
        "warning",
        `This session will keep retrying while this page remains open, but its recovery state could not be saved: ${formatUiError(error)}`,
      );
    } finally {
      // The native/Web command and its stable command ID are durable now.
      // Reloading can safely hand reconciliation to a newer application build;
      // retaining the pre-durability guard here would let an old marker block
      // the very upgrade which knows how to repair it.
      setSessionCreateReloadBlocked(false);
    }
    return recovery;
  }

  function forgetPendingSessionCreate(commandId?: string): void {
    const recovery = pendingSessionCreateRecoveryRef.current;
    if (commandId && recovery?.commandId !== commandId) return;
    pendingSessionCreateRecoveryRef.current = null;
    if (sessionCreateRecoveryTimerRef.current !== null) {
      window.clearTimeout(sessionCreateRecoveryTimerRef.current);
      sessionCreateRecoveryTimerRef.current = null;
    }
    try {
      clearPendingSessionCreateRecovery(window.localStorage, commandId);
    } catch (error) {
      showUiNotice(
        "session:create-recovery-storage",
        "session",
        "warning",
        `The completed session recovery marker could not be cleared: ${formatUiError(error)}`,
      );
    }
  }

  function schedulePendingSessionCreateRecovery(
    connection: MalinkClient,
  ): void {
    if (sessionCreateRecoveryTimerRef.current !== null) {
      window.clearTimeout(sessionCreateRecoveryTimerRef.current);
    }
    sessionCreateRecoveryTimerRef.current = window.setTimeout(() => {
      sessionCreateRecoveryTimerRef.current = null;
      if (
        malinkClientRef.current === connection &&
        connectionStatusRef.current === "connected"
      ) {
        continuePendingSessionCreate(connection);
      }
    }, 5_000);
  }

  function continuePendingSessionCreate(
    connection: MalinkClient,
    acknowledgedCommand?: MalinkCommandSendResult,
  ): void {
    const recovery = pendingSessionCreateRecoveryRef.current;
    if (!recovery) return;
    if (
      acknowledgedCommand &&
      acknowledgedCommand.commandId !== recovery.commandId
    ) {
      return;
    }
    if (
      sessionCreateRecoveryInFlightRef.current?.commandId ===
      recovery.commandId
    ) {
      return;
    }
    sessionCreateRecoveryInFlightRef.current = {
      commandId: recovery.commandId,
      connection,
    };
    void (async () => {
      let activeCommandId = recovery.commandId;
      try {
        const sent =
          acknowledgedCommand ??
          (await connection.recoverCommand(recovery.commandId));
        if (sent.commandId !== activeCommandId) {
          const rebound = rebindPendingSessionCreateRecovery(
            window.localStorage,
            activeCommandId,
            sent.commandId,
          );
          if (!rebound) {
            if (
              pendingSessionCreateRecoveryRef.current?.commandId ===
              activeCommandId
            ) {
              pendingSessionCreateRecoveryRef.current = null;
              clearPendingSessionCreateUi();
            }
            return;
          }
          activeCommandId = rebound.commandId;
          pendingSessionCreateRecoveryRef.current = rebound;
          sessionCreateRecoveryInFlightRef.current = {
            commandId: activeCommandId,
            connection,
          };
        }
        recoverUiNotice("session:create");
        await settleSessionCreate(connection, sent);
      } catch (error) {
        if (
          pendingSessionCreateRecoveryRef.current?.commandId !==
          activeCommandId
        ) {
          return;
        }
        if (isMissingSessionCreateRecoveryCommand(error)) {
          forgetPendingSessionCreate(activeCommandId);
          const draft = optimisticSessionRef.current;
          if (draft) {
            markOptimisticSessionFailed(
              draft.localSessionId,
              "The saved creation command is no longer available. Retry creation to continue.",
            );
          } else {
            clearPendingSessionCreateUi();
          }
          showUiNotice(
            "session:create",
            "session",
            "warning",
            "The unfinished local session creation was cleared because this device no longer has its command. You can create the session again.",
          );
          return;
        }
        const draft = optimisticSessionRef.current;
        const resultIsUncertain = Boolean(
          draft && isSessionCreateRecoveryUncertain(recovery),
        );
        if (draft && resultIsUncertain) {
          commitOptimisticSession(
            markOptimisticSessionUncertain(
              draft,
              "Your computer accepted the secure command, but Malink could not confirm its final result. Check again, or stop waiting to create a different conversation.",
            ),
          );
          clearPendingSessionCreateUi();
          showUiNotice(
            "session:create",
            "session",
            "warning",
            "Session creation did not reach a confirmed result. The original command remains safe to check again and will not be submitted twice.",
          );
        } else {
          showUiNotice(
            "session:create",
            "session",
            "warning",
            "Session creation is still queued securely. Malink will resume the same command when your computer reconnects.",
          );
        }
        if (
          !resultIsUncertain &&
          malinkClientRef.current === connection &&
          connectionStatusRef.current === "connected"
        ) {
          schedulePendingSessionCreateRecovery(connection);
        }
      } finally {
        if (
          sessionCreateRecoveryInFlightRef.current?.commandId ===
          activeCommandId
        ) {
          sessionCreateRecoveryInFlightRef.current = null;
        }
        const currentConnection = malinkClientRef.current;
        if (
          pendingSessionCreateRecoveryRef.current?.commandId ===
            activeCommandId &&
          currentConnection &&
          currentConnection !== connection &&
          connectionStatusRef.current === "connected"
        ) {
          continuePendingSessionCreate(currentConnection);
        }
      }
    })();
  }

  function cancelAutomaticConnectionRecovery(resetAttempts = true) {
    if (connectionRecoveryTimerRef.current !== null) {
      window.clearTimeout(connectionRecoveryTimerRef.current);
      connectionRecoveryTimerRef.current = null;
    }
    if (resetAttempts) connectionRecoveryAttemptRef.current = 0;
  }

  function scheduleAutomaticConnectionRecovery(
    config: MatrixConnectionConfig,
    detail: string,
  ) {
    if (
      !connectionRecoveryAllowedRef.current ||
      connectionRecoveryTimerRef.current !== null
    ) {
      return;
    }
    const attempt = connectionRecoveryAttemptRef.current;
    connectionRecoveryAttemptRef.current = attempt + 1;
    const delay = automaticConnectionRetryDelay(attempt);
    console.warn(
      `[connection/recovery] ${detail}; retry ${attempt + 1} in ${delay}ms`,
    );
    matrixStartupRef.current = null;
    connectionStatusRef.current = "reconnecting";
    setConnectionStatus("reconnecting");
    setConnectionDetail(detail);
    setConnectionError(null);
    connectionRecoveryTimerRef.current = window.setTimeout(() => {
      connectionRecoveryTimerRef.current = null;
      if (!connectionRecoveryAllowedRef.current) return;
      void connectMalinkClient(config, false, true, true);
    }, delay);
  }

  async function connectMalinkClient(
    configInput = matrixConfig,
    closeSettings = true,
    recoveringInterruptedStartup = false,
    automaticRecovery = false,
  ): Promise<MalinkClient | null> {
    // Native status callbacks may run before createMalinkClient() returns.
    // Remember a repair result synchronously so the routine post-connect close
    // cannot immediately undo the recovery dialog opened by that callback.
    let keepSettingsOpenForRepair = false;
    const preserveGatewayProjection =
      gatewayState !== null &&
      sameGatewayUiScope(matrixConfig, configInput);
    if (!automaticRecovery) {
      connectionRecoveryAllowedRef.current = true;
      cancelAutomaticConnectionRecovery();
    }
    matrixSessionRepairRequiredRef.current = false;
    const storedSessionCreateRecovery = pendingSessionCreateRecoveryRef.current;
    const sessionCreateRecovery =
      storedSessionCreateRecovery &&
      sessionCreateRecoveryMatches(storedSessionCreateRecovery, configInput)
        ? storedSessionCreateRecovery
        : null;
    if (storedSessionCreateRecovery && !sessionCreateRecovery) {
      forgetPendingSessionCreate(storedSessionCreateRecovery.commandId);
    }
    const startupGeneration = matrixStartupGenerationRef.current + 1;
    matrixStartupGenerationRef.current = startupGeneration;
    const isCurrentStartup = () =>
      matrixStartupGenerationRef.current === startupGeneration;
    malinkClientRef.current?.dispose();
    malinkClientRef.current = null;
    if (!recoveringInterruptedStartup) {
      sessionStorage.removeItem(MATRIX_STARTUP_RECOVERY_SESSION_KEY);
    }
    matrixStartupRef.current = {
      phase: "connecting",
      startedAt: Date.now(),
      hiddenAt: null,
    };
    if (!automaticRecovery) {
      optimisticMessagesRef.current.clear();
      reconciledOptimisticMessageIdsRef.current.clear();
      pendingPromptSessionIdsRef.current.clear();
      setSubmittingPromptSessionIds(new Set());
      revisionConflictRef.current = null;
      nativeCommandReviewRef.current = null;
      activePromptCommandsRef.current.clear();
      completedCommandResultsRef.current.clear();
      completionObservationOrderRef.current = 0;
      turnPromptLookupRef.current.clear();
      turnHistoryHydrationRef.current = null;
      messageElementsRef.current.clear();
      setObservedCommandCompletions([]);
      setTurnPromptCache(new Map());
      setExpandedTurnId(null);
      setTurnHistoryLoad(null);
      setFeedReturnAnchor(null);
      setRevisionConflict(null);
      setNativeCommandReview(null);
    }
    setConnectionError(null);
    setConnectionDetail(
      automaticRecovery ? "matrix_sync_retry_wait" : "Preparing your connection…",
    );
    connectionStatusRef.current = automaticRecovery ? "reconnecting" : "connecting";
    setConnectionStatus(automaticRecovery ? "reconnecting" : "connecting");
    if (!automaticRecovery && !preserveGatewayProjection) {
      setMessages([]);
      setSelectedSessionId(null);
      setRunningSessionIds(new Set());
      setStoppingSessionIds(new Set());
      setAgentActivitiesBySession(new Map());
      pendingCreatedSessionIdRef.current = null;
      updateSessionLifecycleBusy(new Map());
      setPendingSessionCreate(sessionCreateRecovery?.input ?? null);
      setNewSessionBusy(Boolean(sessionCreateRecovery));
    }
    // A persisted recovery is safe across reloads. Only the short interval
    // before rememberPendingSessionCreate() records a command may defer an
    // application update.
    setSessionCreateReloadBlocked(false);
    if (!automaticRecovery && !preserveGatewayProjection) {
      knownGatewaySessionIdsRef.current.clear();
      liveMessagesBySessionRef.current.clear();
      setGatewayState(null);
      setGatewayRevision(null);
      selectedSessionIdRef.current = null;
      historySessionIdRef.current = null;
      historyCursorRef.current = null;
      historyGenerationRef.current += 1;
      historyLoadingRef.current = false;
      setHistoryLoading(false);
      setHistoryHasMore(false);
      setFeedHasUnseenMessages(false);
      setHistoryError(null);
      setHistoryRetryMode(null);
    }
    try {
      const normalized = normalizeMatrixConfig(configInput);
      historyScopeRef.current = matrixHistoryScope({
        gatewayId: normalized.gatewayId,
        conversationId: normalized.conversationId,
        roomId: normalized.roomId,
      });
      const rememberedSessionId = readSelectedSession(
        window.localStorage,
        historyScopeRef.current,
      );
      if (!automaticRecovery && !preserveGatewayProjection) {
        selectedSessionIdRef.current = rememberedSessionId;
        setSelectedSessionId(rememberedSessionId);
      }
      setMatrixConfig(normalized);
      saveMatrixConfig(normalized);
      const connection = await createMalinkClient(normalized, {
        onMessage(message) {
          if (isCurrentStartup()) {
            receiveMatrixMessage(incomingMessageFromClient(message));
          }
        },
        onStatus(status, detail) {
          if (!isCurrentStartup()) return;
          const presentedStatus = isNativeManagedMatrixConfig(normalized)
            ? status
            : connectionStatusForBrowserNetwork(status, navigator.onLine);
          if (
            matrixStartupRef.current &&
            (presentedStatus === "connecting" || presentedStatus === "securing")
          ) {
            matrixStartupRef.current.phase = presentedStatus;
          }
          const repairReason: ConnectionRepairReason | null =
            presentedStatus === "error"
              ? connectionRepairReasonForDetail(detail)
              : null;
          matrixSessionRepairRequiredRef.current =
            repairReason === "matrix-session";
          if (
            presentedStatus === "error" &&
            connectionRecoveryDisposition(detail) === "automatic"
          ) {
            scheduleAutomaticConnectionRecovery(
              normalized,
              detail?.trim() || "matrix_connection_bootstrap_failed",
            );
            return;
          }
          if (presentedStatus === "error") {
            connectionRecoveryAllowedRef.current = false;
            cancelAutomaticConnectionRecovery();
          }
          connectionStatusRef.current = presentedStatus;
          setConnectionStatus(presentedStatus);
          setConnectionDetail(presentedStatus === "offline" ? null : detail ?? null);
          if (presentedStatus === "error") {
            const presentation = deriveConnectionPresentation(presentedStatus, detail);
            setConnectionError(presentation.detail);
            if (repairReason) {
              keepSettingsOpenForRepair = true;
              setSettingsOpen(true);
            }
          } else if (
            presentedStatus === "reconnecting" ||
            presentedStatus === "offline"
          ) {
            setConnectionError(null);
          }
          if (
            presentedStatus === "connected" ||
            presentedStatus === "offline" ||
            presentedStatus === "error"
          ) {
            matrixStartupRef.current = null;
          }
          if (presentedStatus === "connected") {
            cancelAutomaticConnectionRecovery();
            sessionStorage.removeItem(MATRIX_STARTUP_RECOVERY_SESSION_KEY);
            setConnectionError(null);
            dispatchUiNotice({ type: "scope-recovered", scope: "connection" });
            window.setTimeout(() => {
              const activeConnection = malinkClientRef.current;
              if (activeConnection) {
                continuePendingSessionCreate(activeConnection);
                for (const sessionId of queuedSessionFlushIdsRef.current) {
                  void flushQueuedSessionMessages(sessionId, activeConnection);
                }
              }
            }, 0);
          }
        },
        onNativeRuntime(runtime) {
          if (isCurrentStartup()) {
            setNativeRuntime(runtime);
            if (!runtime) setNativeUpdateState(null);
          }
        },
        onTrustUpdated(trust) {
          if (!isCurrentStartup()) return;
          setTrustedGateway(trust);
          if (trust) {
            setSavedGateways((current) => [
              trust,
              ...current.filter((gateway) =>
                (gateway.gatewayNodeId ?? gateway.gatewayId) !==
                (trust.gatewayNodeId ?? trust.gatewayId)
              ),
            ]);
          }
          setActiveDeviceCount(trust?.activeDeviceCount ?? null);
          if (trust) {
            setPairingPreview(null);
            setPairingBusy(false);
            setPairingError(null);
            setConnectionError(null);
          }
        },
        onCollaborationState(state) {
          if (!isCurrentStartup()) return;
          if (state.gatewayState?.gatewayDirectory) {
            void getOrCreateDeviceIdentity()
              .then(identity => loadTrustedGateways(identity))
              .then(gateways => {
                if (isCurrentStartup()) setSavedGateways(gateways.map(publicTrustFromWeb));
              })
              .catch(error => {
                if (isCurrentStartup()) {
                  setConnectionError(
                    `Workspace Gateway directory could not be loaded: ${formatUiError(error)}`,
                  );
                }
              });
          }
          if (state.gatewayState) {
            setActiveDeviceCount(state.gatewayState.activeDeviceCount);
            setGatewayRevision(state.gatewayState.revision);
          } else if (state.revision !== undefined) {
            setGatewayRevision((current) =>
              current === null
                ? state.revision!
                : Math.max(current, state.revision!),
            );
          }
          if (state.gatewayState) {
            writeGatewayUiCache(
              window.localStorage,
              normalized,
              state.gatewayState,
            );
            const nextSessionIds = new Set(
              state.gatewayState.sessions.map((session) => session.id),
            );
            for (const previousSessionId of knownGatewaySessionIdsRef.current) {
              if (nextSessionIds.has(previousSessionId)) continue;
              liveMessagesBySessionRef.current.delete(previousSessionId);
              if (historyScopeRef.current) {
                void clearSessionMessageHistory(
                  historyScopeRef.current,
                  previousSessionId,
                ).catch((error) => {
                  showUiNotice(
                    "history:archived-session-cleanup",
                    "history",
                    "warning",
                    `Archived session history could not be cleared locally: ${formatUiError(error)}`,
                  );
                });
              }
            }
            knownGatewaySessionIdsRef.current = nextSessionIds;
            const pendingDraft = optimisticSessionRef.current;
            if (
              pendingDraft?.remoteSessionId &&
              nextSessionIds.has(pendingDraft.remoteSessionId)
            ) {
              promoteOptimisticSession(
                pendingDraft.remoteSessionId,
                malinkClientRef.current,
              );
            }
            setGatewayState(state.gatewayState);
            const runningIds = new Set(
              state.gatewayState.sessions
                .filter(
                  (session) =>
                    session.status === "running" ||
                    session.status === "stopping",
                )
                .map((session) => session.id),
            );
            const stoppingIds = new Set(
              state.gatewayState.sessions
                .filter((session) => session.status === "stopping")
                .map((session) => session.id),
            );
            setRunningSessionIds(runningIds);
            setStoppingSessionIds(stoppingIds);
            setAgentActivitiesBySession((current) => {
              const next = new Map<string, AgentActivity>();
              for (const session of state.gatewayState!.sessions) {
                if (session.activityPhase === "starting") {
                  next.set(session.id, STARTING_AGENT_ACTIVITY);
                } else if (
                  session.activityPhase === "stopping" ||
                  session.status === "stopping"
                ) {
                  next.set(session.id, STOPPING_AGENT_ACTIVITY);
                } else if (
                  session.activityPhase === "working" ||
                  session.status === "running"
                ) {
                  next.set(
                    session.id,
                    current.get(session.id) ?? WORKING_AGENT_ACTIVITY,
                  );
                } else {
                  const localActivity = current.get(session.id);
                  if (
                    (localActivity?.phase === "sending" ||
                      localActivity?.phase === "waiting") &&
                    (hasActivePromptCommand(session.id) ||
                      pendingPromptSessionIdsRef.current.has(session.id))
                  ) {
                    next.set(session.id, localActivity);
                  }
                }
              }
              return next;
            });
            const selectableSessions = sessionsAvailableForAutomaticSelection(
              state.gatewayState.sessions,
              pendingSessionLifecycleIds(sessionLifecycleBusyRef.current),
            );
            const availableIds = new Set(
              selectableSessions.map((session) => session.id),
            );
            const openedSession = pendingOpenedSessionIdRef.current;
            const activeSessions = selectableSessions.filter(
              (session) => session.status !== "archived",
            );
            const activeIds = new Set(
              activeSessions.map((session) => session.id),
            );
            const pendingCreated = pendingCreatedSessionIdRef.current;
            const localDraftId = optimisticSessionRef.current?.localSessionId;
            const localDraftSelected = Boolean(
              localDraftId && selectedSessionIdRef.current === localDraftId,
            );
            const nextSessionId =
              openedSession && availableIds.has(openedSession)
                ? openedSession
                : localDraftSelected
                  ? localDraftId!
                : !localDraftId &&
                    pendingCreated &&
                    availableIds.has(pendingCreated)
                  ? pendingCreated
                : selectedSessionIdRef.current &&
                    availableIds.has(selectedSessionIdRef.current)
                  ? selectedSessionIdRef.current
                : state.gatewayState.currentSessionId &&
                      activeIds.has(state.gatewayState.currentSessionId)
                    ? state.gatewayState.currentSessionId
                    : activeSessions[0]?.id ??
                      selectableSessions[0]?.id ??
                      null;
            if (openedSession) {
              pendingOpenedSessionIdRef.current = null;
              if (openedSession === nextSessionId) setMobileChatOpen(true);
            }
            if (pendingCreated === nextSessionId) {
              pendingCreatedSessionIdRef.current = null;
              clearPendingSessionCreateUi();
              setMobileChatOpen(true);
            }
            setSessionReadState((current) => {
              const initialized = initializeSessionReadState(
                current,
                state.gatewayState!.sessions,
              );
              const pruned = pruneSessionReadState(initialized, availableIds);
              return reconcileSelectedSessionReadState(
                pruned,
                state.gatewayState!.sessions,
                nextSessionId,
              );
            });
            const shouldRevealNextSession =
              (openedSession === nextSessionId ||
                pendingCreated === nextSessionId) &&
              nextSessionId !== selectedSessionIdRef.current;
            activateLocalSession(
              nextSessionId,
              malinkClientRef.current,
              shouldRevealNextSession,
              pendingCreated === nextSessionId,
            );
          }
        },
        onCommandReviewRequired(review) {
          if (!isCurrentStartup()) return;
          if (!review) {
            if (nativeCommandReviewRef.current?.busy) return;
            nativeCommandReviewRef.current = null;
            setNativeCommandReview(null);
            return;
          }
          if (
            nativeCommandReviewRef.current?.busy &&
            nativeCommandReviewRef.current.commandId === review.commandId
          ) return;
          const notice: NativeCommandReviewNotice = {
            ...review,
            busy: false,
          };
          nativeCommandReviewRef.current = notice;
          setNativeCommandReview(notice);
        },
        onCommandResult(result) {
          if (!isCurrentStartup()) return;
          observeCommandCompletion(result);
          const promptSessionId =
            activePromptCommandsRef.current.get(result.commandId);
          if (promptSessionId) {
            activePromptCommandsRef.current.delete(result.commandId);
            completedCommandResultsRef.current.delete(result.commandId);
            finishLocalPromptCommand(promptSessionId);
            recoverUiNotice("composer:send");
            void flushQueuedSessionMessages(promptSessionId);
          } else {
            completedCommandResultsRef.current.add(result.commandId);
          }
        },
        onHistoryRecovered(page) {
          if (isCurrentStartup()) recoverLateHistory(page);
        },
      });
      if (!isCurrentStartup()) {
        connection.dispose();
        return null;
      }
      malinkClientRef.current = connection;
      setDeviceKeyId(connection.deviceId);
      if (connection.nativeUpdateStatus) {
        void connection.nativeUpdateStatus()
          .then((value) => {
            if (malinkClientRef.current === connection) setNativeUpdateState(value);
          })
          .catch(() => undefined);
      }
      if (closeSettings && !keepSettingsOpenForRepair) setSettingsOpen(false);
      void connection.ready
        .then(() => {
          if (malinkClientRef.current !== connection) return;
          continuePendingSessionCreate(connection);
          const sessionId = selectedSessionIdRef.current;
          if (
            sessionId &&
            optimisticSessionRef.current?.localSessionId === sessionId
          ) {
            void restoreOptimisticSessionMessages(optimisticSessionRef.current);
          } else if (sessionId) {
            void restoreSessionHistory(sessionId, connection);
          }
        })
        .catch(() => undefined);
      return connection;
    } catch (error) {
      if (!isCurrentStartup()) return null;
      matrixStartupRef.current = null;
      const detail = connectionFailureCode(error);
      console.error(`[connection/startup] ${detail}`, error);
      if (connectionRecoveryDisposition(detail) === "automatic") {
        scheduleAutomaticConnectionRecovery(configInput, detail);
        return null;
      }
      connectionRecoveryAllowedRef.current = false;
      cancelAutomaticConnectionRecovery();
      connectionStatusRef.current = "error";
      setConnectionStatus("error");
      setConnectionDetail(detail);
      setConnectionError(deriveConnectionPresentation("error", detail).detail);
      return null;
    }
  }

  function disconnectClient() {
    connectionRecoveryAllowedRef.current = false;
    cancelAutomaticConnectionRecovery();
    const queuedSessionCreate = pendingSessionCreateRecoveryRef.current;
    matrixStartupGenerationRef.current += 1;
    const disconnectingClient = malinkClientRef.current;
    malinkClientRef.current = null;
    void disconnectingClient?.disconnect().catch((error) => {
      connectionStatusRef.current = "error";
      setConnectionStatus("error");
      setConnectionError(
        `The client could not disconnect cleanly: ${formatUiError(error)}`,
      );
    });
    optimisticMessagesRef.current.clear();
    reconciledOptimisticMessageIdsRef.current.clear();
    pendingPromptSessionIdsRef.current.clear();
    setSubmittingPromptSessionIds(new Set());
    revisionConflictRef.current = null;
    nativeCommandReviewRef.current = null;
    activePromptCommandsRef.current.clear();
    completedCommandResultsRef.current.clear();
    completionObservationOrderRef.current = 0;
    turnPromptLookupRef.current.clear();
    turnHistoryHydrationRef.current = null;
    messageElementsRef.current.clear();
    setObservedCommandCompletions([]);
    setTurnPromptCache(new Map());
    setExpandedTurnId(null);
    setTurnHistoryLoad(null);
    setFeedReturnAnchor(null);
    setFeedHasUnseenMessages(false);
    pendingCreatedSessionIdRef.current = null;
    updateSessionLifecycleBusy(new Map());
    setPendingSessionCreate(queuedSessionCreate?.input ?? null);
    setNewSessionBusy(Boolean(queuedSessionCreate));
    setSessionCreateReloadBlocked(false);
    if (sessionCreateRecoveryTimerRef.current !== null) {
      window.clearTimeout(sessionCreateRecoveryTimerRef.current);
      sessionCreateRecoveryTimerRef.current = null;
    }
    knownGatewaySessionIdsRef.current.clear();
    liveMessagesBySessionRef.current.clear();
    setRevisionConflict(null);
    setNativeCommandReview(null);
    matrixStartupRef.current = null;
    sessionStorage.removeItem(MATRIX_STARTUP_RECOVERY_SESSION_KEY);
    connectionStatusRef.current = "offline";
    setConnectionStatus("offline");
    setConnectionDetail(null);
    setConnectionError(null);
    setPairingError(null);
    setRunningSessionIds(new Set());
    setStoppingSessionIds(new Set());
    setAgentActivitiesBySession(new Map());
    setSelectedSessionId(null);
    setGatewayState(null);
    setGatewayRevision(null);
    selectedSessionIdRef.current = null;
    historyGenerationRef.current += 1;
    historySessionIdRef.current = null;
    historyCursorRef.current = null;
    historyLoadingRef.current = false;
    setHistoryLoading(false);
    setHistoryHasMore(false);
    setHistoryError(null);
    setHistoryRetryMode(null);
    deviceInvitationLifecycleRef.current.clear();
    matrixLoginTokenLifecycleRef.current.clear();
    pendingGatewayInvitationRef.current = null;
    if (invitationExpiryTimeoutRef.current !== null) {
      window.clearTimeout(invitationExpiryTimeoutRef.current);
      invitationExpiryTimeoutRef.current = null;
    }
    setDeviceInvitation(null);
    setInvitationBusy(false);
    setInvitationError(null);
    setGatewayEnrollmentInvitation(null);
    setGatewayEnrollmentBusy(null);
    setGatewayEnrollmentError(null);
    setPairingBusy(false);
    setSessionSettingsUpdate(null);
  }

  function detachClientForNativeBootstrap() {
    // Supersede any startup that has acquired the native port but has not yet
    // published its MalinkClient. A stale startup disposes itself once its
    // current bridge operation settles, releasing the lease to bootstrap.
    matrixStartupGenerationRef.current += 1;
    connectionRecoveryAllowedRef.current = false;
    cancelAutomaticConnectionRecovery();
    const attachedClient = malinkClientRef.current;
    malinkClientRef.current = null;
    attachedClient?.dispose();
    matrixStartupRef.current = null;
    sessionStorage.removeItem(MATRIX_STARTUP_RECOVERY_SESSION_KEY);
    connectionStatusRef.current = "connecting";
    setConnectionStatus("connecting");
    setConnectionDetail("Transferring the native connection to this invitation…");
  }

  function settleNativeBootstrapTransfer(status: "offline" | "error") {
    connectionStatusRef.current = status;
    setConnectionStatus(status);
    setConnectionDetail(null);
  }

  function forgetMatrixConfig() {
    const historyScope = historyScopeRef.current;
    pairingAbortRef.current?.abort();
    disconnectClient();
    const queuedSessionCreate = pendingSessionCreateRecoveryRef.current;
    if (queuedSessionCreate) {
      forgetPendingSessionCreate(queuedSessionCreate.commandId);
      clearPendingSessionCreateUi();
    }
    const removedGatewayId = matrixConfig.gatewayNodeId || matrixConfig.gatewayId || undefined;
    clearMatrixConfig(removedGatewayId);
    clearGatewayUiCache(window.localStorage);
    clearPendingPairing();
    clearTrustedGateway(removedGatewayId);
    setMatrixConfig(emptyMatrixConfig);
    setTrustedGateway(null);
    setSavedGateways((current) =>
      removedGatewayId
        ? current.filter((gateway) =>
            (gateway.gatewayNodeId ?? gateway.gatewayId) !== removedGatewayId
          )
        : current,
    );
    setActiveDeviceCount(null);
    setGatewayRevision(null);
    setGatewayState(null);
    selectedSessionIdRef.current = null;
    setPairingPreview(null);
    setDeviceInvitation(null);
    setInvitationReauthRequired(false);
    setConnectionError(null);
    setPairingError(null);
    setMessages([]);
    if (historyScope) {
      writeSelectedSession(window.localStorage, historyScope, null);
    }
    historyScopeRef.current = "";
    if (historyScope) {
      void clearMessageHistoryScope(historyScope).catch((error) => {
        showUiNotice(
          "history:clear-all",
          "history",
          "warning",
          `Conversation history could not be cleared: ${formatUiError(error)}`,
        );
      });
    }
    setSettingsOpen(true);
  }

  async function openPairingLink(link: string) {
    if (pairingBusy) return;
    setPairingBusy(true);
    setConnectionError(null);
    setPairingError(null);
    try {
      if (
        hasShortDeviceInvitation(
          link,
          typeof window === "undefined"
            ? "https://malink.invalid/"
            : window.location.href,
        )
      ) {
        const invitationLink = await resolveShortDeviceInvitation(
          link,
          window.location.href,
        );
        await openDeviceInvitation(invitationLink);
        return;
      }
      if (deviceInvitationFromLink(link)) {
        await openDeviceInvitation(link);
        return;
      }
      const preview = await inspectPairingLink(link);
      const transport = preview.transport;
      setPairingPreview(preview);
      setMatrixConfig((current) => ({
        ...bindCredentialsToHomeserver(current, transport.homeserver),
        roomId: transport.roomId,
        gatewayId: preview.gatewayId,
        gatewayNodeId: preview.gatewayNodeId,
        conversationId: transport.roomId,
        gatewayMatrixUserId: transport.userId,
        gatewayMatrixDeviceId: transport.deviceId,
        gatewayMatrixEd25519: transport.ed25519,
      }));
      setSettingsOpen(true);
    } catch (error) {
      setConnectionError(formatUiError(error));
    } finally {
      setPairingBusy(false);
    }
  }

  async function openDeviceInvitation(link: string) {
    setConnectionError(null);
    setPairingError(null);
    try {
      const invitation = decodeDeviceInvitationLink(link);
      const preview = await inspectPairingLink(
        pairingLinkFromDeviceInvitation(invitation),
      );
      const transport = preview.transport;
      let nextConfig: MatrixConnectionConfig = {
        ...bindCredentialsToHomeserver(matrixConfig, transport.homeserver),
        roomId: transport.roomId,
        gatewayId: preview.gatewayId,
        gatewayNodeId: preview.gatewayNodeId,
        conversationId: transport.roomId,
        gatewayMatrixUserId: transport.userId,
        gatewayMatrixDeviceId: transport.deviceId,
        gatewayMatrixEd25519: transport.ed25519,
        ...(invitation.matrixLogin
          ? { userId: invitation.matrixLogin.userId }
          : matrixSessionRepairRequiredRef.current
            ? { accessToken: "", matrixDeviceId: "" }
          : {}),
      };
      setPairingPreview(preview);
      setMatrixConfig(nextConfig);
      setSettingsOpen(true);

      const matrixLogin = invitation.matrixLogin;
      if (!matrixLogin) return;
      if (matrixLogin.expiresAt <= Date.now()) {
        setConnectionError(
          "The one-time sign-in expired. Sign in below; the invitation may still be valid.",
        );
        return;
      }
      try {
        detachClientForNativeBootstrap();
        const nativeBootstrap = await bootstrapNativeMatrixSessionIfAvailable({
          homeserver: matrixLogin.homeserver,
          oneTimeLoginToken: matrixLogin.loginToken,
          expectedUserId: matrixLogin.userId,
          deviceName: browserDeviceName(),
          roomBinding: {
            roomId: transport.roomId,
            gatewayId: preview.gatewayId,
            gatewayNodeId: preview.gatewayNodeId,
            conversationId: transport.roomId,
            gatewayUserId: transport.userId,
            gatewayDeviceId: transport.deviceId,
            gatewayDeviceEd25519: transport.ed25519,
          },
        });
        if (nativeBootstrap) {
          nextConfig = {
            ...nextConfig,
            homeserver: nativeBootstrap.session.homeserver,
            userId: nativeBootstrap.session.userId,
            matrixDeviceId: nativeBootstrap.session.matrixDeviceId,
            accessToken: NATIVE_MANAGED_ACCESS_TOKEN,
          };
        } else {
          const credentials = await loginWithMatrixToken(
            matrixLogin.homeserver,
            matrixLogin.loginToken,
            matrixLogin.userId,
            browserDeviceName(),
          );
          nextConfig = { ...nextConfig, ...credentials };
        }
        setMatrixConfig(nextConfig);
        saveMatrixConfig(nextConfig);
        settleNativeBootstrapTransfer("offline");
      } catch (error) {
        settleNativeBootstrapTransfer("error");
        setConnectionError(
          `The one-time sign-in could not be used: ${formatUiError(error)} Sign in below to continue.`,
        );
      }
    } catch (error) {
      setConnectionError(formatUiError(error));
      setSettingsOpen(true);
    }
  }

  async function signInForPairing(userId: string, password: string) {
    if (pairingBusy) return;
    setPairingBusy(true);
    setPairingError(null);
    try {
      detachClientForNativeBootstrap();
      const preview = pairingPreview;
      const nativeBootstrap = preview
        ? await bootstrapNativeMatrixSessionIfAvailable({
            homeserver: matrixConfig.homeserver,
            password,
            expectedUserId: userId,
            deviceName: browserDeviceName(),
            roomBinding: {
              roomId: preview.transport.roomId,
              gatewayId: preview.gatewayId,
              gatewayNodeId: preview.gatewayNodeId,
              conversationId: preview.transport.roomId,
              gatewayUserId: preview.transport.userId,
              gatewayDeviceId: preview.transport.deviceId,
              gatewayDeviceEd25519: preview.transport.ed25519,
            },
          })
        : null;
      const credentials = nativeBootstrap
        ? {
            homeserver: nativeBootstrap.session.homeserver,
            userId: nativeBootstrap.session.userId,
            matrixDeviceId: nativeBootstrap.session.matrixDeviceId,
            accessToken: NATIVE_MANAGED_ACCESS_TOKEN,
          }
        : await loginWithMatrixPassword(
            matrixConfig.homeserver,
            userId,
            password,
            browserDeviceName(),
          );
      const next = { ...matrixConfig, ...credentials };
      setMatrixConfig(next);
      saveMatrixConfig(next);
      // Native bootstrap is opportunistic. A regular browser deliberately
      // falls back to the Web Matrix client, so the temporary transfer state
      // must be settled for both outcomes before pairing can be confirmed.
      settleNativeBootstrapTransfer("offline");
    } catch (error) {
      settleNativeBootstrapTransfer("error");
      setConnectionError(formatUiError(error));
    } finally {
      setPairingBusy(false);
    }
  }

  async function createDeviceInvitation(password?: string) {
    if (!trustedGateway || !malinkClientRef.current) {
      setConnectionError(
        "Connect to your approved computer before adding another device.",
      );
      return;
    }
    const reusable = deviceInvitationLifecycleRef.current.current();
    if (reusable) {
      showDeviceInvitation(reusable);
      return;
    }
    setInvitationBusy(true);
    setInvitationError(null);
    try {
      const generated = await deviceInvitationLifecycleRef.current.request(
        async () => {
          const connection = malinkClientRef.current;
          if (!connection) throw new Error("The connection was closed.");
          let gatewayInvitation = pendingGatewayInvitationRef.current;
          if (
            !gatewayInvitation ||
            gatewayInvitation.expiresAt <= Date.now() + 15_000
          ) {
            matrixLoginTokenLifecycleRef.current.clear();
            pendingGatewayInvitationRef.current = null;
            let completion: CommandCompletion;
            let commandId: string | null = null;
            try {
              try {
                const sent = await sendRealCommand({
                  operation: "device.invite",
                  lifetimeMs: 5 * 60_000,
                });
                if (!sent) {
                  throw new Error(
                    "The invitation request is waiting for revision conflict review.",
                  );
                }
                commandId = sent.commandId;
                completion = await waitForCommandCompletion(
                  sent.completion,
                  DEVICE_INVITATION_RESULT_TIMEOUT_MS,
                );
              } catch (error) {
                if (!(error instanceof CommandAcknowledgementTimeoutError)) {
                  throw error;
                }
                commandId = error.commandId;
                setInvitationError(
                  "Your computer is still preparing this invitation. Malink will keep waiting instead of creating another one.",
                );
                completion = await connection.observeCommandCompletion(
                  error.commandId,
                  DEVICE_INVITATION_RESULT_TIMEOUT_MS,
                );
              }
            } finally {
              if (commandId) {
                completedCommandResultsRef.current.delete(commandId);
              }
            }
            if (completion.outcome !== "succeeded") {
              if (commandId) await connection.releaseCommand(commandId);
              throw new Error(
                "Your computer could not create the device invitation.",
              );
            }
            if (!commandId) {
              throw new Error("The invitation command identity was lost.");
            }
            try {
              gatewayInvitation = {
                commandId,
                ...parseGatewayInvitationResult(completion.result),
              };
            } catch (error) {
              await connection.releaseCommand(commandId);
              throw error;
            }
            pendingGatewayInvitationRef.current = gatewayInvitation;
          }

          // Request the one-time Matrix credential only after the potentially
          // slow Gateway command completes, so queue delay cannot consume most
          // of the credential's useful lifetime.
          const tokenResult =
            await matrixLoginTokenLifecycleRef.current.request({
              invitationId: gatewayInvitation.commandId,
              invitationExpiresAt: gatewayInvitation.expiresAt,
              issue: () =>
                connection.requestMatrixLoginToken(
                  gatewayInvitation.commandId,
                  password,
                ),
              onRateLimit: (remainingMs) => {
                if (remainingMs === 0) {
                  setInvitationError(
                    "The account provider is accepting another sign-in attempt. Finishing this invitation…",
                  );
                  return;
                }
                setInvitationError(
                  `The account provider temporarily limited new-device sign-ins. Malink will keep this invitation and retry in ${Math.ceil(remainingMs / 1_000)} seconds.`,
                );
              },
            });
          if (
            tokenResult.status === "reauth-required" &&
            tokenResult.passwordSupported
          ) {
            setInvitationReauthRequired(true);
            throw new InvitationReauthenticationRequiredError();
          }
          const fullInvitation = createDeviceInvitationLink({
            pairingLink: gatewayInvitation.pairingLink,
            appUrl: window.location.href,
            ...(tokenResult.status === "ready"
              ? {
                  matrixLogin: {
                    homeserver: matrixConfig.homeserver,
                    userId: matrixConfig.userId,
                    loginToken: tokenResult.loginToken,
                    expiresAt: tokenResult.expiresAt,
                  },
                }
              : {}),
          });
          const shortened = await shortenDeviceInvitation(
            fullInvitation,
            window.location.href,
          );
          if (shortened.expiresAt <= Date.now() + 15_000) {
            await connection.releaseCommand(gatewayInvitation.commandId);
            pendingGatewayInvitationRef.current = null;
            matrixLoginTokenLifecycleRef.current.clear();
            throw new Error(
              "The recovered device invitation expired before it could be displayed. Create a new one.",
            );
          }
          await connection.releaseCommand(gatewayInvitation.commandId);
          pendingGatewayInvitationRef.current = null;
          matrixLoginTokenLifecycleRef.current.clear();
          return shortened;
        },
      );
      showDeviceInvitation(generated);
      setInvitationReauthRequired(false);
      setInvitationError(null);
    } catch (error) {
      if (
        !(error instanceof InvitationReauthenticationRequiredError) &&
        !(error instanceof InvitationRequestCancelledError) &&
        !(error instanceof MatrixLoginTokenRequestCancelledError)
      ) {
        setInvitationError(formatUiError(error));
      }
    } finally {
      setInvitationBusy(false);
    }
  }

  function showDeviceInvitation(invitation: GeneratedDeviceInvitation): void {
    if (invitationExpiryTimeoutRef.current !== null) {
      window.clearTimeout(invitationExpiryTimeoutRef.current);
    }
    setDeviceInvitation(invitation);
    invitationExpiryTimeoutRef.current = window.setTimeout(() => {
      invitationExpiryTimeoutRef.current = null;
      deviceInvitationLifecycleRef.current.clear();
      matrixLoginTokenLifecycleRef.current.clear();
      pendingGatewayInvitationRef.current = null;
      setDeviceInvitation(null);
      setInvitationError("This device invitation expired. Create a new one.");
    }, Math.max(0, invitation.expiresAt - Date.now()));
  }

  async function createGatewayEnrollment(): Promise<void> {
    if (!trustedGateway || !malinkClientRef.current) {
      setGatewayEnrollmentError(
        "Connect to the Workspace before adding a Gateway.",
      );
      return;
    }
    if (gatewayEnrollmentBusy) return;
    setGatewayEnrollmentBusy({ kind: "create" });
    setGatewayEnrollmentError(null);
    let commandId: string | null = null;
    try {
      const sent = await sendRealCommand({
        operation: "gateway.enrollment.invite",
        lifetimeMs: 10 * 60_000,
      }, undefined, {
        autoRetryRevisionConflict: true,
        propagateFailure: true,
      });
      if (!sent) {
        throw new Error(
          "The connected client could not send the Gateway setup request.",
        );
      }
      commandId = sent.commandId;
      const completion = await waitForCommandCompletion(
        sent.completion,
        DEVICE_INVITATION_RESULT_TIMEOUT_MS,
      );
      if (completion.outcome !== "succeeded") {
        throw new Error(
          completion.error?.message
            ?? "The connected Gateway could not create a setup link.",
        );
      }
      const enrollment = parseGatewayEnrollmentInvitationResult(completion.result);
      const link = await shortenEncryptedInvitation(
        enrollment.enrollmentLink,
        enrollment.expiresAt,
        window.location.href,
      );
      setGatewayEnrollmentInvitation({ link, expiresAt: enrollment.expiresAt });
    } catch (error) {
      setGatewayEnrollmentError(formatUiError(error));
    } finally {
      if (commandId) {
        completedCommandResultsRef.current.delete(commandId);
        await malinkClientRef.current?.releaseCommand(commandId).catch(() => undefined);
      }
      setGatewayEnrollmentBusy(null);
    }
  }

  async function approveGatewayEnrollment(
    enrollmentId: string,
    approverProjectId?: string,
  ): Promise<void> {
    if (gatewayEnrollmentBusy) return;
    setGatewayEnrollmentBusy({ kind: "approve", enrollmentId });
    setGatewayEnrollmentError(null);
    let commandId: string | null = null;
    try {
      if (!await waitForConnectedCommandWindow()) {
        throw new Error("The connection is not ready to approve this Gateway.");
      }
      const sent = await sendRealCommand({
        operation: "gateway.enrollment.approve",
        enrollmentId,
      }, approverProjectId, {
        autoRetryRevisionConflict: true,
        propagateFailure: true,
      });
      if (!sent) {
        throw new Error(
          "The connected client could not send the Gateway approval.",
        );
      }
      commandId = sent.commandId;
      const completion = await waitForCommandCompletion(
        sent.completion,
        DEVICE_INVITATION_RESULT_TIMEOUT_MS,
      );
      if (completion.outcome !== "succeeded") {
        throw new Error(
          completion.error?.message
            ?? "The connected Gateway could not approve this request.",
        );
      }
      setGatewayEnrollmentInvitation(null);
      setApprovedGatewayEnrollmentIds((current) => {
        const next = new Set(current);
        next.add(enrollmentId);
        return next;
      });
      showUiNotice(
        `gateway-enrollment:${enrollmentId}`,
        "connection",
        "success",
        "Gateway approved. It will appear here automatically after its first sync.",
        6_000,
      );
    } catch (error) {
      setGatewayEnrollmentError(formatUiError(error));
    } finally {
      if (commandId) {
        completedCommandResultsRef.current.delete(commandId);
        await malinkClientRef.current?.releaseCommand(commandId).catch(() => undefined);
      }
      setGatewayEnrollmentBusy(null);
    }
  }

  async function renameGateway(
    gatewayNodeId: string,
    gatewayName: string,
    targetProjectId: string,
  ): Promise<void> {
    if (gatewayProfileBusy) return;
    setGatewayProfileBusy(gatewayNodeId);
    setGatewayProfileError(null);
    let commandId: string | null = null;
    try {
      const sent = await sendRealCommand({
        operation: "gateway.profile.update",
        gatewayNodeId,
        gatewayName,
      }, targetProjectId, {
        autoRetryRevisionConflict: true,
        propagateFailure: true,
      });
      if (!sent) {
        throw new Error("The connected client could not update this Gateway name.");
      }
      commandId = sent.commandId;
      const completion = await waitForCommandCompletion(sent.completion, 60_000);
      if (completion.outcome !== "succeeded") {
        throw new Error(
          completion.error?.message ?? "The Gateway name update did not complete.",
        );
      }
      showUiNotice(
        `gateway-profile:${gatewayNodeId}`,
        "connection",
        "success",
        `Gateway renamed to ${gatewayName}.`,
        4_000,
      );
    } catch (error) {
      setGatewayProfileError(formatUiError(error));
      throw error;
    } finally {
      if (commandId) {
        completedCommandResultsRef.current.delete(commandId);
        await malinkClientRef.current?.releaseCommand(commandId).catch(() => undefined);
      }
      setGatewayProfileBusy(null);
    }
  }

  async function runGatewayUpdate(
    payload: Extract<CommandPayload, { operation: `gateway.update.${string}` }>,
    targetProjectId: string | undefined = activeWorkspace?.projectId,
  ): Promise<void> {
    setGatewayUpdateBusy(true);
    setGatewayUpdateError(null);
    try {
      await executeGatewayUpdate(payload, targetProjectId);
    } catch (error) {
      setGatewayUpdateError(formatUiError(error));
    } finally {
      setGatewayUpdateBusy(false);
    }
  }

  async function runPublishedGatewayUpdate(): Promise<void> {
    if (!gatewayRelease) {
      setGatewayUpdateError("No signed Gateway update Prompt is currently published.");
      return;
    }
    setGatewayUpdateBusy(true);
    setGatewayUpdateError(null);
    try {
      const targetProjectId = activeWorkspace?.projectId;
      const staged = await executeGatewayUpdate({
        operation: "gateway.update.stage",
        releaseId: gatewayRelease.releaseId,
      }, targetProjectId);
      if (["scheduled", "activating", "probation", "committed"].includes(staged.phase)) {
        return;
      }
      if (
        staged.phase !== "staged" ||
        staged.releaseId !== gatewayRelease.releaseId ||
        staged.targetBuildId !== gatewayRelease.buildId
      ) {
        throw new Error(
          `The Gateway did not prepare published release ${gatewayRelease.releaseId}.`,
        );
      }
      await executeGatewayUpdate({
        operation: "gateway.update.apply",
        releaseId: gatewayRelease.releaseId,
        mode: "when_idle",
      }, targetProjectId);
    } catch (error) {
      setGatewayUpdateError(formatUiError(error));
    } finally {
      setGatewayUpdateBusy(false);
    }
  }

  async function executeGatewayUpdate(
    payload: Extract<CommandPayload, { operation: `gateway.update.${string}` }>,
    targetProjectId: string | undefined,
  ) {
    let commandId: string | null = null;
    try {
      const sent = await sendRealCommand(payload, targetProjectId, {
        autoRetryRevisionConflict: true,
        propagateFailure: true,
      });
      if (!sent) throw new Error("The connected client could not send the Gateway update request.");
      commandId = sent.commandId;
      const completion = await waitForCommandCompletion(
        sent.completion,
        payload.operation === "gateway.update.status" ? 60_000 : 30 * 60_000,
      );
      if (completion.outcome !== "succeeded") {
        throw new Error(
          completion.error?.message ?? "The Gateway update request did not complete.",
        );
      }
      const status = gatewayUpdateStatusSchema.parse(completion.result);
      setGatewayState((current) => current ? { ...current, gatewayUpdate: status } : current);
      return status;
    } finally {
      if (commandId) {
        completedCommandResultsRef.current.delete(commandId);
        await malinkClientRef.current?.releaseCommand(commandId).catch(() => undefined);
      }
    }
  }

  async function waitForConnectedCommandWindow(timeoutMs = 10_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (connectionStatusRef.current !== "connected") {
      if (
        connectionStatusRef.current !== "connecting" &&
        connectionStatusRef.current !== "securing" &&
        connectionStatusRef.current !== "reconnecting"
      ) return false;
      if (Date.now() >= deadline) return false;
      await new Promise<void>((resolve) => window.setTimeout(resolve, 100));
    }
    return true;
  }

  async function confirmPairing(
    previewOverride: PairingPreview | null = pairingPreview,
    configOverride: MatrixConnectionConfig = matrixConfig,
  ) {
    if (!previewOverride || pairingBusy) return;
    pairingAbortRef.current?.abort();
    const abort = new AbortController();
    pairingAbortRef.current = abort;
    setPairingBusy(true);
    setPairingError(null);
    setConnectionError(null);
    try {
      const transport = previewOverride.transport;
      const unresolvedConfig: MatrixConnectionConfig = {
        ...configOverride,
        homeserver: transport.homeserver,
        roomId: transport.roomId,
        gatewayId: previewOverride.gatewayId,
        gatewayNodeId: previewOverride.gatewayNodeId,
        conversationId: transport.roomId,
        gatewayMatrixUserId: transport.userId,
        gatewayMatrixDeviceId: transport.deviceId,
        gatewayMatrixEd25519: transport.ed25519,
      };
      const configForPairing = isNativeManagedMatrixConfig(unresolvedConfig)
        ? normalizeMatrixConfig(unresolvedConfig)
        : await resolveMatrixSession(unresolvedConfig);
      setMatrixConfig(configForPairing);
      const connection = await connectMalinkClient(configForPairing, false);
      if (!connection) return;
      const trust = await connection.pair(
        encodePairingLink(previewOverride.signedOffer),
        browserDeviceName(),
        abort.signal,
      );
      saveMatrixConfig(configForPairing);
      setTrustedGateway(trust);
      setSavedGateways((current) => [
        trust,
        ...current.filter((gateway) =>
          (gateway.gatewayNodeId ?? gateway.gatewayId) !==
          (trust.gatewayNodeId ?? trust.gatewayId)
        ),
      ]);
      setActiveDeviceCount(trust.activeDeviceCount ?? null);
      setMatrixConfig(configForPairing);
      setPairingPreview(null);
      setPairingError(null);
      setSettingsOpen(false);
      showUiNotice(
        "connection:paired",
        "session",
        "success",
        `${trust.gatewayName} connected.`,
        5_000,
      );
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        setPairingError(formatUiError(error));
      }
    } finally {
      if (pairingAbortRef.current === abort) pairingAbortRef.current = null;
      setPairingBusy(false);
    }
  }
  pairingRecoveryRef.current = confirmPairing;

  async function recoverNativeAppUpdate(installReady: boolean): Promise<void> {
    if (nativeUpdateBusyRef.current) return;
    nativeUpdateBusyRef.current = true;
    setNativeUpdateBusy(true);
    try {
      const connection = malinkClientRef.current;
      let status: NativeUpdateStatus;
      if (connection?.nativeUpdateStatus) {
        status = await connection.nativeUpdateStatus();
        if (
          installReady &&
          connection.installNativeUpdate &&
          (status.phase === "ready" || status.phase === "permission_required")
        ) {
          status = await connection.installNativeUpdate();
        }
      } else {
        status = await advanceNativeAppUpdate({ installReady });
      }
      setNativeUpdateState(status);
      if (
        status.phase === "current" &&
        connectionDetail === "matrix_native_runtime_outdated"
      ) {
        setConnectionError(
          "No compatible APK update has reached this device yet. Restart Malink; if the update requirement remains, export diagnostics.",
        );
      } else if (status.phase === "failed") {
        setConnectionError(
          "The APK update did not complete. Restart Malink and try again; if it still fails, export diagnostics.",
        );
      }
    } catch {
      setNativeUpdateState((current) => current ? {
        ...current,
        phase: "failed",
        detailCode: "bridge_request_failed",
      } : current);
      setConnectionError(
        "The native updater did not respond. Restart Malink and try again; if it still fails, export diagnostics.",
      );
    } finally {
      nativeUpdateBusyRef.current = false;
      setNativeUpdateBusy(false);
    }
  }

  async function copyPageLinkForAnotherBrowser(): Promise<void> {
    if (pageLinkCopyBusy) return;
    setPageLinkCopyBusy(true);
    const pageLink = window.location.href;
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(pageLink);
      showUiNotice(
        "connection:browser-link-copied",
        "connection",
        "success",
        "Malink link copied. Open it in a current Chrome, Edge, or Safari browser.",
        5_000,
      );
    } catch {
      window.prompt(
        "Copy this Malink link and open it in a current Chrome, Edge, or Safari browser:",
        pageLink,
      );
    } finally {
      setPageLinkCopyBusy(false);
    }
  }

  function exportConnectionDiagnostics(): void {
    const report = createConnectionDiagnostics({
      buildVersion: MALINK_BUILD_VERSION,
      status: connectionStatus,
      detail: connectionDetail,
      deviceKeyId,
      nativeRuntime,
      gateways: gatewayDirectory?.directory.gateways,
      online: navigator.onLine,
      visibility: document.visibilityState,
      userAgent: navigator.userAgent,
    });
    const url = URL.createObjectURL(
      new Blob([report], { type: "application/json" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = `malink-connection-diagnostics-${Date.now()}.json`;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }

  async function sendRealCommand(
    payload: CommandPayload,
    targetProjectId: string | undefined = activeWorkspace?.projectId,
    options: SendRealCommandOptions = {},
  ): Promise<MalinkCommandSendResult | null> {
    const notice = commandNoticeFor(payload);
    const connection = malinkClientRef.current;
    const currentConnectionStatus = connectionStatusRef.current;
    if (!connection || currentConnectionStatus !== "connected") {
      const message = currentConnectionStatus === "reconnecting" ||
          currentConnectionStatus === "connecting" ||
          currentConnectionStatus === "securing"
        ? "The connection is still resuming. Try again when your computer is connected."
        : "Your computer is not connected. Open connection settings.";
      if (options.propagateFailure) throw new Error(message);
      showUiNotice(
        notice.key,
        notice.scope,
        "warning",
        message,
      );
      return null;
    }
    try {
      const result = await connection.send(payload, targetProjectId);
      revisionConflictRef.current = null;
      recoverUiNotice(notice.key);
      return result;
    } catch (caughtError) {
      let error = caughtError;
      if (options.autoRetryRevisionConflict) {
        try {
          const result = await retryMatchingCommandRevisionConflict(
            error,
            payload.operation,
            async (commandId) => {
              if (nativeCommandReviewRef.current?.commandId === commandId) {
                nativeCommandReviewRef.current = null;
                setNativeCommandReview(null);
              }
              if (revisionConflictRef.current?.commandId === commandId) {
                revisionConflictRef.current = null;
                setRevisionConflict(null);
              }
              return connection.confirmRevisionRetry(commandId);
            },
          );
          revisionConflictRef.current = null;
          setRevisionConflict(null);
          recoverUiNotice(notice.key);
          return result;
        } catch (retryError) {
          error = retryError;
        }
      }
      if (error instanceof CommandAcknowledgementTimeoutError) throw error;
      if (error instanceof CommandReviewRequiredError) {
        const review: NativeCommandReviewNotice = {
          ...error.review,
          busy: false,
        };
        nativeCommandReviewRef.current = review;
        setNativeCommandReview(review);
        recoverUiNotice(notice.key);
        if (options.propagateFailure) throw error;
        return null;
      }
      if (isCommandRecoveryPendingError(error)) {
        if (options.propagateFailure) throw error;
        showUiNotice(
          notice.key,
          notice.scope,
          "warning",
          formatUiError(error),
        );
        return null;
      }
      if (error instanceof CommandRevisionConflictError) {
        const notice: RevisionConflictNotice = {
          commandId: error.commandId,
          expectedRevision: error.expectedRevision,
          payload: error.payload,
          busy: false,
        };
        revisionConflictRef.current = notice;
        setRevisionConflict(notice);
        recoverUiNotice(commandNoticeFor(payload).key);
        if (options.propagateFailure) throw error;
        return null;
      }
      if (options.propagateFailure) throw error;
      showUiNotice(
        notice.key,
        notice.scope,
        "error",
        formatUiError(error),
      );
      return null;
    }
  }

  async function consumeSessionCreateCompletion(
    connection: MalinkClient,
    commandId: string,
    completion: CommandCompletion,
  ): Promise<void> {
    let sessionToReveal: string | null = null;
    let skipHistoryRestore = false;
    try {
      completedCommandResultsRef.current.delete(commandId);
      if (completion.outcome !== "succeeded") return;
      if (completion.sessionId) {
        const draft = optimisticSessionRef.current;
        if (draft) {
          commitOptimisticSession(
            bindOptimisticSession(
              draft,
              commandId,
              completion.sessionId,
            ),
          );
        }
        const target = completedSessionCreateTarget(
          completion.sessionId,
          knownGatewaySessionIdsRef.current,
        );
        pendingCreatedSessionIdRef.current = target.pendingSessionId;
        sessionToReveal = target.sessionToReveal;
        skipHistoryRestore = target.skipHistoryRestore;
      }
      setNewSessionOpen(false);
    } finally {
      // Receiving an acknowledgement is not enough for session.create: the
      // terminal sessionId must survive reloads until this UI has consumed it.
      forgetPendingSessionCreate(commandId);
      try {
        await connection.releaseCommand(commandId);
      } catch (error) {
        // The command is already terminal and its sessionId has been consumed.
        // A best-effort outbox cleanup must not resurrect the user-facing
        // "Creating session" state. Both transports can discard an old
        // terminal entry during their next command reconciliation.
        showUiNotice(
          "session:create-release",
          "session",
          "warning",
          `Session creation finished, but its completed local command could not be cleaned up yet: ${formatUiError(error)}`,
        );
      }
    }
    if (sessionToReveal) {
      if (optimisticSessionRef.current) {
        promoteOptimisticSession(sessionToReveal, connection);
      } else {
        clearPendingSessionCreateUi();
        activateLocalSession(
          sessionToReveal,
          connection,
          true,
          skipHistoryRestore,
        );
        setMobileChatOpen(true);
      }
    }
  }

  function promoteOptimisticSession(
    remoteSessionId: string,
    connection: MalinkClient | null,
  ): void {
    const record = optimisticSessionRef.current;
    if (!record) return;
    const localSessionId = record.localSessionId;
    if (optimisticPromotionInFlightRef.current === localSessionId) return;
    optimisticPromotionInFlightRef.current = localSessionId;
    const scope = historyScopeRef.current;
    const migrateHistory = scope
      ? moveSessionMessageHistory(scope, localSessionId, remoteSessionId)
      : Promise.resolve();
    void migrateHistory
      .then(() => {
        const current = optimisticSessionRef.current;
        if (!current || current.localSessionId !== localSessionId) return;
        const selectedDraft = selectedSessionIdRef.current === localSessionId;
        const localMessages = (
          liveMessagesBySessionRef.current.get(localSessionId) ?? []
        ).map((message) => ({ ...message, sessionId: remoteSessionId }));
        liveMessagesBySessionRef.current.delete(localSessionId);
        liveMessagesBySessionRef.current.set(remoteSessionId, localMessages);
        pendingCreatedSessionIdRef.current = null;
        if (selectedDraft) {
          selectedSessionIdRef.current = remoteSessionId;
          historySessionIdRef.current = remoteSessionId;
          setSelectedSessionId(remoteSessionId);
          setMessages(localMessages);
          if (scope) {
            writeSelectedSession(
              window.localStorage,
              scope,
              remoteSessionId,
            );
          }
          setMobileChatOpen(true);
        }
        removeOptimisticSession(localSessionId);
        clearPendingSessionCreateUi();
        recoverUiNotice("session:create-queue-storage");
        void flushQueuedSessionMessages(
          remoteSessionId,
          malinkClientRef.current === connection
            ? connection
            : malinkClientRef.current,
        );
      })
      .catch((error) => {
        showUiNotice(
          "session:create-queue-storage",
          "composer",
          "error",
          `The session was created, but its queued messages are still being prepared locally: ${formatUiError(error)}`,
        );
        window.setTimeout(() => {
          const current = optimisticSessionRef.current;
          if (
            current?.localSessionId === localSessionId &&
            current.remoteSessionId === remoteSessionId
          ) {
            promoteOptimisticSession(remoteSessionId, malinkClientRef.current);
          }
        }, 1_500);
      })
      .finally(() => {
        if (optimisticPromotionInFlightRef.current === localSessionId) {
          optimisticPromotionInFlightRef.current = null;
        }
      });
  }

  async function waitForRecoverableSessionCreateCompletion(
    connection: MalinkClient,
    sent: MalinkCommandSendResult,
  ): Promise<CommandCompletion> {
    try {
      return await waitForCommandCompletion(
        sent.completion,
        SESSION_CREATE_RESULT_RECOVERY_MS,
      );
    } catch (error) {
      if (!(error instanceof CommandCompletionTimeoutError)) throw error;
      // Recovery is intentionally keyed by the persisted command ID. The
      // connection refuses to reserve a new command if that exact outbox entry
      // is unavailable, so this can never create a second session.
      const recovered = await connection.recoverCommand(sent.commandId);
      return waitForCommandCompletion(
        recovered.completion,
        SESSION_CREATE_RESULT_RECOVERY_MS,
      );
    }
  }

  async function confirmRevisionRetry() {
    const conflict = revisionConflictRef.current;
    const connection = malinkClientRef.current;
    if (!conflict || !connection || conflict.busy) return;
    const conflictSessionId =
      conflict.payload.operation === "session.create" ||
      conflict.payload.operation === "device.invite"
        ? undefined
        : conflict.payload.sessionId;
    const optimisticMessage = conflict.optimisticMessageId
      ? [
          ...messages,
          ...(conflictSessionId
            ? liveMessagesBySessionRef.current.get(conflictSessionId) ?? []
            : []),
        ].find((message) => message.id === conflict.optimisticMessageId)
      : undefined;
    const busyConflict = { ...conflict, busy: true };
    revisionConflictRef.current = busyConflict;
    setRevisionConflict(busyConflict);
    try {
      const result = await connection.confirmRevisionRetry(conflict.commandId);
      setGatewayRevision((current) =>
        current === null ? result.revision : Math.max(current, result.revision),
      );
      if (
        conflict.optimisticMessageId &&
        optimisticMessage &&
        conflictSessionId
      ) {
        const sentMessage: ChatMessage = {
          ...optimisticMessage,
          commandId: result.commandId,
          revision: result.revision,
          optimistic: true,
          deliveryState: "sent",
        };
        const optimisticReference = optimisticMessagesRef.current.get(
          conflict.optimisticMessageId,
        );
        if (optimisticReference) {
          optimisticReference.commandId = result.commandId;
        }
        if (selectedSessionIdRef.current === conflictSessionId) {
          setMessages((current) =>
            current.map((message) =>
              message.id === conflict.optimisticMessageId
                ? sentMessage
                : message,
            ),
          );
        }
        rememberLiveMessage(conflictSessionId, sentMessage);
        if (historyScopeRef.current) {
          void saveMessageHistory(
            historyScopeRef.current,
            conflictSessionId,
            [sentMessage],
          ).catch((error) => {
            showUiNotice(
              "history:save",
              "history",
              "warning",
              `Conversation history could not be saved: ${formatUiError(error)}`,
            );
          });
        }
      }
      if (conflict.payload.operation === "prompt") {
        const sessionId = conflict.payload.sessionId;
        setPendingFiles([]);
        if (completedCommandResultsRef.current.delete(result.commandId)) {
          finishLocalPromptCommand(sessionId);
        } else {
          activePromptCommandsRef.current.set(result.commandId, sessionId);
          setSessionRunning(sessionId, true);
          setSessionAgentActivity(
            sessionId,
            runningSessionIds.has(sessionId)
              ? WORKING_AGENT_ACTIVITY
              : WAITING_AGENT_ACTIVITY,
          );
        }
      }
      const completion =
        conflict.payload.operation === "prompt"
          ? null
          : conflict.payload.operation === "session.create"
            ? await waitForRecoverableSessionCreateCompletion(
                connection,
                result,
              )
            : await result.completion;
      if (
        completion &&
        conflict.payload.operation === "session.create"
      ) {
        await consumeSessionCreateCompletion(
          connection,
          result.commandId,
          completion,
        );
      } else if (
        completion?.outcome === "succeeded" &&
        conflict.payload.operation === "cancel"
      ) {
        setSessionRunning(conflict.payload.sessionId, false);
        setSessionStopping(conflict.payload.sessionId, false);
        setSessionAgentActivity(conflict.payload.sessionId, null);
      } else if (
        completion?.outcome === "succeeded" &&
        conflict.payload.operation === "decision"
      ) {
        const requestId = conflict.payload.requestId;
        const decision = conflict.payload.decision;
        const request = messages.find(
          (message) => message.requestId === requestId,
        );
        if (request) {
          setDecisionStates((current) => ({
            ...current,
            [request.id]: { actionId: decision },
          }));
        }
      }
      if (revisionConflictRef.current?.commandId === conflict.commandId) {
        revisionConflictRef.current = null;
        setRevisionConflict(null);
      }
    } catch (error) {
      if (conflict.payload.operation === "prompt") {
        setSessionRunning(conflict.payload.sessionId, false);
        setSessionAgentActivity(conflict.payload.sessionId, null);
      }
      if (error instanceof CommandRevisionConflictError) {
        const next: RevisionConflictNotice = {
          commandId: error.commandId,
          expectedRevision: error.expectedRevision,
          payload: error.payload,
          optimisticMessageId: conflict.optimisticMessageId,
          busy: false,
        };
        revisionConflictRef.current = next;
        setRevisionConflict(next);
        return;
      }
      revisionConflictRef.current = { ...conflict, busy: false };
      setRevisionConflict({ ...conflict, busy: false });
      showUiNotice(
        "composer:revision-retry",
        "composer",
        "error",
        formatUiError(error),
      );
    }
  }

  async function discardRevisionConflict() {
    const conflict = revisionConflictRef.current;
    const connection = malinkClientRef.current;
    if (!conflict || !connection || conflict.busy) return;
    const busyConflict = { ...conflict, busy: true };
    revisionConflictRef.current = busyConflict;
    setRevisionConflict(busyConflict);
    try {
      await connection.discardRevisionConflict(conflict.commandId);
      if (conflict.optimisticMessageId) {
        optimisticMessagesRef.current.delete(conflict.optimisticMessageId);
        reconciledOptimisticMessageIdsRef.current.delete(
          conflict.optimisticMessageId,
        );
        if (
          conflict.payload.operation !== "session.create" &&
          conflict.payload.operation !== "device.invite"
        ) {
          removeLiveMessage(
            conflict.payload.sessionId,
            conflict.optimisticMessageId,
          );
        }
        setMessages((current) =>
          current.filter(
            (message) => message.id !== conflict.optimisticMessageId,
          ),
        );
        if (historyScopeRef.current) {
          await deleteMessageHistory(
            historyScopeRef.current,
            conflict.optimisticMessageId,
          );
        }
      }
      revisionConflictRef.current = null;
      setRevisionConflict(null);
    } catch (error) {
      revisionConflictRef.current = { ...conflict, busy: false };
      setRevisionConflict({ ...conflict, busy: false });
      showUiNotice(
        "composer:revision-discard",
        "composer",
        "error",
        formatUiError(error),
      );
    }
  }

  async function retryNativeCommandReview() {
    const review = nativeCommandReviewRef.current;
    const connection = malinkClientRef.current;
    if (!review || !connection || review.busy) return;
    const busyReview = { ...review, busy: true };
    nativeCommandReviewRef.current = busyReview;
    setNativeCommandReview(busyReview);
    let retriedCommandId: string | null = null;
    try {
      const sent = await connection.confirmRevisionRetry(review.commandId);
      retriedCommandId = sent.commandId;
      const completion = await sent.completion;
      if (completion.outcome !== "succeeded") {
        throw new Error(
          completion.error?.message ?? "The retried action did not complete.",
        );
      }
      if (nativeCommandReviewRef.current?.commandId === review.commandId) {
        nativeCommandReviewRef.current = null;
        setNativeCommandReview(null);
      }
    } catch (error) {
      if (error instanceof CommandReviewRequiredError) {
        const next: NativeCommandReviewNotice = {
          ...error.review,
          busy: false,
        };
        nativeCommandReviewRef.current = next;
        setNativeCommandReview(next);
        return;
      }
      const next = { ...review, busy: false };
      nativeCommandReviewRef.current = next;
      setNativeCommandReview(next);
      showUiNotice(
        "command:review-retry",
        "composer",
        "error",
        formatUiError(error),
      );
    } finally {
      if (retriedCommandId) {
        await connection.releaseCommand(retriedCommandId).catch((error) => {
          showUiNotice(
            "command:review-release",
            "composer",
            "warning",
            `The completed action could not be cleared from local recovery: ${formatUiError(error)}`,
          );
        });
      }
    }
  }

  async function discardNativeCommandReview() {
    const review = nativeCommandReviewRef.current;
    const connection = malinkClientRef.current;
    if (!review || !connection || review.busy) return;
    const busyReview = { ...review, busy: true };
    nativeCommandReviewRef.current = busyReview;
    setNativeCommandReview(busyReview);
    try {
      await connection.discardRevisionConflict(review.commandId);
      if (nativeCommandReviewRef.current?.commandId === review.commandId) {
        nativeCommandReviewRef.current = null;
        setNativeCommandReview(null);
      }
    } catch (error) {
      const next = { ...review, busy: false };
      nativeCommandReviewRef.current = next;
      setNativeCommandReview(next);
      showUiNotice(
        "command:review-discard",
        "composer",
        "error",
        formatUiError(error),
      );
    }
  }

  function chooseSession(id: string) {
    setPrimaryView("chats");
    setMobileChatOpen(true);
    activateLocalSession(id);
  }

  function providerHistoryPendingCommandMatches(
    pending: ProviderHistoryPendingCommand,
    load: ProviderHistoryLoadState,
  ): boolean {
    return providerHistoryRequestMatches(pending, load);
  }

  async function sendOrRecoverProviderHistoryCommand(
    load: ProviderHistoryLoadState,
    payload: Extract<
      CommandPayload,
      { operation: "provider.sessions.list" | "provider.session.inspect" }
    >,
  ): Promise<MalinkCommandSendResult> {
    const source = findProviderHistorySource(providerHistorySources, load);
    if (!source) {
      throw new Error(
        "The selected computer or project route changed. Choose the source again before loading Provider History.",
      );
    }
    const pending = providerHistoryPendingCommandRef.current;
    if (pending) {
      if (!providerHistoryPendingCommandMatches(pending, load)) {
        throw new Error(
          "Retry the previous provider history request before loading a different provider or session.",
        );
      }
      const connection = malinkClientRef.current;
      if (!connection || connectionStatus !== "connected") {
        throw new Error("Reconnect to your computer before retrying provider history.");
      }
      const recovered = await connection.recoverCommand(pending.commandId);
      providerHistoryPendingCommandRef.current = {
        ...pending,
        commandId: recovered.commandId,
      };
      return recovered;
    }
    const sent = await sendRealCommand(payload, load.projectId);
    if (!sent) {
      throw new Error(
        "Provider history could not be sent. Check the connection notice, then retry.",
      );
    }
    providerHistoryPendingCommandRef.current = {
      commandId: sent.commandId,
      gatewayNodeId: load.gatewayNodeId,
      projectId: load.projectId,
      provider: load.provider,
      kind: load.kind,
      ...(load.providerSessionId === undefined
        ? {}
        : { providerSessionId: load.providerSessionId }),
    };
    return sent;
  }

  async function finishProviderHistoryCommand(
    sent: MalinkCommandSendResult,
  ): Promise<CommandCompletion> {
    const completion = await waitForCommandCompletion(
      sent.completion,
      PROVIDER_HISTORY_RESULT_TIMEOUT_MS,
    );
    const pending = providerHistoryPendingCommandRef.current;
    if (pending?.commandId === sent.commandId) {
      providerHistoryPendingCommandRef.current = null;
    }
    try {
      await malinkClientRef.current?.releaseCommand(sent.commandId);
    } catch (error) {
      showUiNotice(
        "provider:history-release",
        "session",
        "warning",
        `Provider history finished, but its completed local command could not be cleaned up yet: ${formatUiError(error)}`,
      );
    }
    return completion;
  }

  async function openProviderHistory(request: OpenProviderHistoryRequest = {}) {
    setProviderHistoryOpen(true);
    const focus = providerHistoryFocusRef.current;
    const requestedSource = request.sourceKey === undefined
      ? null
      : findProviderHistorySourceByKey(providerHistorySources, request.sourceKey);
    if (request.sourceKey !== undefined && !requestedSource) {
      setProviderHistoryError(
        "That computer or project route is no longer available. Choose another source.",
      );
      return;
    }
    const focusedSource = !providerHistoryOpen && focus
      ? findProviderHistorySource(providerHistorySources, focus)
      : null;
    if (!providerHistoryOpen && focus && !focusedSource) {
      setProviderHistoryError(
        "The computer or project for the archived session is no longer available. Reconnect it before restoring Provider History.",
      );
      return;
    }
    const currentSource = providerHistoryOpen
      ? findProviderHistorySource(providerHistorySources, {
          gatewayNodeId: providerHistoryGatewayNodeIdRef.current,
          projectId: providerHistoryProjectIdRef.current,
        })
      : null;
    if (
      providerHistoryOpen
      && providerHistoryGatewayNodeIdRef.current
      && providerHistoryProjectIdRef.current
      && !currentSource
      && request.sourceKey === undefined
    ) {
      setProviderHistoryError(
        "The selected computer or project route changed. Choose the source again.",
      );
      return;
    }
    const activeOwner = activeWorkspace
      ? projectGatewaysById.get(activeWorkspace.projectId)
        ?? (gatewayState?.gatewayDirectory ? undefined : fallbackProjectGateway)
      : undefined;
    const activeSource = activeWorkspace && activeOwner
      ? findProviderHistorySource(providerHistorySources, {
          gatewayNodeId: activeOwner.gatewayNodeId,
          projectId: activeWorkspace.projectId,
        })
      : null;
    const source = requestedSource ?? firstMatchingProviderHistorySource(
      providerHistorySources,
      [currentSource, focusedSource, activeSource],
    );
    if (!source) {
      setProviderHistoryError(
        "No connected computer and project currently exposes Provider History.",
      );
      return;
    }
    const historyWorkspace = gatewayState?.projects?.find(
      project => project.projectId === source.projectId,
    ) ?? (gatewayState?.workspace.projectId === source.projectId
      ? gatewayState.workspace
      : undefined);
    if (!historyWorkspace) {
      setProviderHistoryError(
        "The selected project has not finished syncing. Try again after it appears in the project list.",
      );
      return;
    }
    const historyCapabilities = historyWorkspace.capabilities ?? gatewayState?.capabilities;
    const availableProviders = historyCapabilities?.providers.filter(candidate =>
      candidate.canListSessions && candidate.canInspectSessions
    ) ?? [];
    const focusMatchesSource = Boolean(
      focus
      && focus.gatewayNodeId === source.gatewayNodeId
      && focus.projectId === source.projectId,
    );
    const currentProvider = providerHistoryGatewayNodeIdRef.current === source.gatewayNodeId
      && providerHistoryProjectIdRef.current === source.projectId
      ? providerHistoryProviderRef.current
      : "";
    const provider = request.provider
      ?? availableProviders.find(candidate => candidate.id === currentProvider)?.id
      ?? (focusMatchesSource
        ? availableProviders.find(candidate => candidate.id === focus?.provider)?.id
        : undefined)
      ?? availableProviders.find(candidate => candidate.id === historyWorkspace.provider)?.id
      ?? availableProviders[0]?.id
      ?? "";
    if (!provider || (
      request.provider !== undefined
      && !availableProviders.some(candidate => candidate.id === request.provider)
    )) {
      setProviderHistoryError(
        "The selected Provider does not expose list and inspect history for this project.",
      );
      return;
    }
    if (
      focus
      && (
        (request.sourceKey !== undefined && !focusMatchesSource)
        || (request.provider !== undefined && request.provider !== focus.provider)
      )
    ) {
      providerHistoryFocusRef.current = null;
    }
    const providerKey = providerHistoryRequestKey(source, provider);
    if (
      providerHistoryGatewayNodeIdRef.current === source.gatewayNodeId
      && providerHistoryProjectIdRef.current === source.projectId
      && providerHistoryProviderRef.current === provider
      && (
        (providerHistoryLoadRef.current?.gatewayNodeId === source.gatewayNodeId
          && providerHistoryLoadRef.current.projectId === source.projectId
          && providerHistoryLoadRef.current.provider === provider)
        || providerHistoryLoadedProviderRef.current === providerKey
      )
    ) {
      return;
    }
    const providerChanged = providerHistoryGatewayNodeIdRef.current !== source.gatewayNodeId
      || providerHistoryProjectIdRef.current !== source.projectId
      || providerHistoryProviderRef.current !== provider;
    providerHistoryGatewayNodeIdRef.current = source.gatewayNodeId;
    setProviderHistoryGatewayNodeId(source.gatewayNodeId);
    providerHistoryProjectIdRef.current = source.projectId;
    setProviderHistoryProjectId(source.projectId);
    providerHistoryProviderRef.current = provider;
    setProviderHistoryProvider(provider);
    if (providerChanged) {
      providerHistoryLoadedProviderRef.current = null;
      setProviderHistorySessions([]);
      setProviderHistorySelected(null);
      setProviderHistoryMessages([]);
    }
    setProviderHistoryError(null);
    const load: ProviderHistoryLoadState = {
      id: ++providerHistoryLoadIdRef.current,
      gatewayNodeId: source.gatewayNodeId,
      projectId: source.projectId,
      provider,
      kind: "sessions",
    };
    providerHistoryLoadRef.current = load;
    setProviderHistoryLoad(load);
    let focusedSession: ProviderSessionEntry | null = null;
    try {
      const sent = await sendOrRecoverProviderHistoryCommand(
        load,
        { operation: "provider.sessions.list", provider },
      );
      const completion = await finishProviderHistoryCommand(sent);
      if (completion.outcome !== "succeeded") {
        throw new Error(completion.error?.message || "Provider history could not be loaded.");
      }
      const result = completion.result;
      if (!result || typeof result !== "object" || Array.isArray(result) || result.type !== "provider.sessions.listed") {
        throw new Error("The provider returned an invalid session list.");
      }
      const sessions = Array.isArray(result.sessions)
        ? result.sessions.map(entry => providerSessionEntrySchema.parse(entry))
        : [];
      if (providerHistoryLoadRef.current?.id === load.id) {
        providerHistoryLoadedProviderRef.current = providerKey;
        setProviderHistorySessions(sessions);
        const currentFocus = providerHistoryFocusRef.current;
        if (
          currentFocus?.gatewayNodeId === source.gatewayNodeId
          && currentFocus.projectId === source.projectId
          && currentFocus.provider === provider
        ) {
          focusedSession = findRecentlyArchivedProviderSession(
            sessions,
            currentFocus.archivedSessionId,
          );
          if (focusedSession) {
            providerHistoryFocusRef.current = null;
            setProviderHistorySelected(focusedSession);
            setProviderHistoryMessages([]);
          }
        }
      }
    } catch (error) {
      if (providerHistoryLoadRef.current?.id === load.id) {
        setProviderHistoryError(formatUiError(error));
      }
    } finally {
      if (providerHistoryLoadRef.current?.id === load.id) {
        providerHistoryLoadRef.current = null;
        setProviderHistoryLoad(null);
      }
    }
    if (focusedSession) {
      await inspectProviderHistorySession(focusedSession);
    }
  }

  async function inspectProviderHistorySession(session: ProviderSessionEntry) {
    const provider = providerHistoryProviderRef.current;
    if (!provider || providerHistoryLoadRef.current) return;
    setProviderHistorySelected(session);
    setProviderHistoryMessages([]);
    setProviderHistoryError(null);
    const load: ProviderHistoryLoadState = {
      id: ++providerHistoryLoadIdRef.current,
      gatewayNodeId: providerHistoryGatewayNodeIdRef.current,
      projectId: providerHistoryProjectIdRef.current,
      provider,
      kind: "session",
      providerSessionId: session.sessionId,
    };
    providerHistoryLoadRef.current = load;
    setProviderHistoryLoad(load);
    try {
      const sent = await sendOrRecoverProviderHistoryCommand(
        load,
        {
          operation: "provider.session.inspect",
          provider,
          providerSessionId: session.sessionId,
        },
      );
      const completion = await finishProviderHistoryCommand(sent);
      if (completion.outcome !== "succeeded") {
        throw new Error(completion.error?.message || "Provider session could not be inspected.");
      }
      const result = completion.result;
      if (!result || typeof result !== "object" || Array.isArray(result) || result.type !== "provider.session.inspected") {
        throw new Error("The provider returned invalid session history.");
      }
      if (providerHistoryLoadRef.current?.id === load.id) {
        setProviderHistoryMessages(
          Array.isArray(result.messages)
            ? result.messages.map(message => providerHistoryMessageSchema.parse(message))
            : [],
        );
      }
    } catch (error) {
      if (providerHistoryLoadRef.current?.id === load.id) {
        setProviderHistoryError(formatUiError(error));
      }
    } finally {
      if (providerHistoryLoadRef.current?.id === load.id) {
        providerHistoryLoadRef.current = null;
        setProviderHistoryLoad(null);
      }
    }
  }

  function openManagedProviderHistorySession(sessionId: string): void {
    const source = findProviderHistorySource(providerHistorySources, {
      gatewayNodeId: providerHistoryGatewayNodeIdRef.current,
      projectId: providerHistoryProjectIdRef.current,
    });
    const managed = gatewayState?.sessions.find(session => session.id === sessionId);
    const owner = managed
      ? projectGatewaysById.get(managed.projectId)
        ?? (gatewayState?.gatewayDirectory ? undefined : fallbackProjectGateway)
      : undefined;
    if (
      !source
      || !managed
      || managed.projectId !== source.projectId
      || owner?.gatewayNodeId !== source.gatewayNodeId
    ) {
      setProviderHistoryError(
        "The current Malink session is no longer on this computer and project. Refresh Provider History.",
      );
      return;
    }
    setProviderHistoryOpen(false);
    chooseSession(sessionId);
  }

  function continueProviderHistorySession(session: ProviderSessionEntry, text: string) {
    const source = findProviderHistorySource(providerHistorySources, {
      gatewayNodeId: providerHistoryGatewayNodeIdRef.current,
      projectId: providerHistoryProjectIdRef.current,
    });
    if (!source) {
      setProviderHistoryError(
        "The selected computer or project route changed. Choose the source again before continuing.",
      );
      return;
    }
    const historyWorkspace = gatewayState?.projects?.find(
      project => project.projectId === source.projectId,
    ) ?? (gatewayState?.workspace.projectId === source.projectId
      ? gatewayState.workspace
      : undefined);
    const historyCapabilities = historyWorkspace?.capabilities ?? gatewayState?.capabilities;
    const provider = providerHistoryProviderRef.current;
    const providerCapability = historyCapabilities?.providers.find(
      candidate => candidate.id === provider
        && candidate.canListSessions
        && candidate.canInspectSessions,
    );
    if (!historyWorkspace || !providerCapability) {
      setProviderHistoryError(
        "The selected Provider is no longer available for this computer and project.",
      );
      return;
    }
    setProviderHistoryOpen(false);
    void createSession({
      projectId: historyWorkspace.projectId,
      scope: "project",
      cwd: historyWorkspace.cwd,
      projectName: historyWorkspace.projectName,
      provider,
      providerSessionId: session.sessionId,
      title: session.title,
      initialPrompt: text,
      ...(provider === historyWorkspace.provider && historyWorkspace.model
        ? { model: historyWorkspace.model }
        : providerCapability.models[0]
          ? { model: providerCapability.models[0].id }
          : {}),
      ...(provider === historyWorkspace.provider && historyWorkspace.reasoningEffort
        ? { reasoningEffort: historyWorkspace.reasoningEffort }
        : {}),
      extensions: historyWorkspace.defaultExtensions ?? [],
    });
  }

  async function createProject(input: NewProjectInput): Promise<void> {
    if (newProjectBusy) return;
    setNewProjectBusy(true);
    recoverUiNotice("project:create");
    let completedCommandId: string | null = null;
    try {
      const target = projectCreationGateways.find(gateway =>
        gateway.gatewayNodeId === input.gatewayNodeId &&
        gateway.targetProjectId === input.targetProjectId,
      );
      if (!target) {
        throw new Error("The selected Gateway route changed. Reopen project creation and try again.");
      }
      const sent = await sendRealCommand({
        operation: "project.create",
        name: input.name,
        cwd: input.cwd,
        ...(input.provider ? { provider: input.provider } : {}),
        createDirectory: input.createDirectory,
      }, target.targetProjectId, { propagateFailure: true });
      if (!sent) return;
      const completion = await waitForCommandCompletion(
        sent.completion,
        PROJECT_CREATE_RESULT_TIMEOUT_MS,
      );
      completedCommandId = sent.commandId;
      if (completion.outcome !== "succeeded") {
        throw new Error(
          completion.error?.message ?? "The Gateway could not create this project.",
        );
      }
      setNewProjectOpen(false);
      showUiNotice(
        "project:create",
        "session",
        "success",
        `${input.name} was created on the selected Gateway. It will appear after the encrypted project room syncs.`,
        7_000,
      );
    } catch (error) {
      showUiNotice(
        "project:create",
        "session",
        "error",
        formatUiError(error),
      );
    } finally {
      if (completedCommandId) {
        completedCommandResultsRef.current.delete(completedCommandId);
        await malinkClientRef.current?.releaseCommand(completedCommandId)
          .catch(() => undefined);
      }
      setNewProjectBusy(false);
    }
  }

  async function createSession(
    input: NewSessionInput,
    retryRecord?: OptimisticSessionRecord,
  ) {
    const targetWorkspace = gatewayState?.projects?.find(
      project => project.projectId === input.projectId,
    ) ?? gatewayState?.workspace;
    const targetCapabilities = targetWorkspace?.capabilities ?? gatewayState?.capabilities;
    if (!targetCapabilities?.canCreateSession) {
      showUiNotice(
        "session:create",
        "session",
        "warning",
        gatewayState
          ? "This computer does not support creating sessions."
          : "Waiting for your conversations to sync.",
      );
      return;
    }
    if (optimisticSessionRef.current && !retryRecord) {
      showUiNotice(
        "session:create",
        "session",
        "info",
        "Finish or discard the current draft session before creating another one.",
      );
      return;
    }
    const localRecord = retryRecord
      ? retryOptimisticSession(retryRecord)
      : createOptimisticSessionRecord(
          input,
          {
            gatewayId: matrixConfig.gatewayId,
            conversationId: matrixConfig.conversationId,
          },
          `local-session:${crypto.randomUUID()}`,
        );
    commitOptimisticSession(localRecord);
    setSessionCreateReloadBlocked(true);
    setNewSessionBusy(true);
    setPendingSessionCreate(input);
    setNewSessionOpen(false);
    activateLocalSession(localRecord.localSessionId, null, true, true);
    setMobileChatOpen(true);
    recoverUiNotice("session:create");
    let durableCommandRecorded = false;
    let connection: MalinkClient | null = null;
    try {
      // Let React commit the pending row before Matrix encryption, IndexedDB,
      // acknowledgement, and command-result work begins.
      await waitForUiCommit();
      connection = malinkClientRef.current;
      if (input.setAsProjectDefault) {
        const settingsUpdate = await sendRealCommand({
          operation: "project.settings",
          model: input.model ?? null,
          reasoningEffort: input.reasoningEffort ?? null,
        }, input.projectId);
        if (!settingsUpdate || (await settingsUpdate.completion).outcome !== "succeeded") {
          throw new Error("The project model and reasoning defaults could not be updated.");
        }
        if (connection?.updateProjectExtensions) {
          const update = await connection.updateProjectExtensions(
            input.extensions ?? [],
            input.projectId,
          );
          const completion = await update.completion;
          if (completion.outcome !== "succeeded") {
            throw new Error("The project extension defaults could not be updated.");
          }
        }
      }
      const sent = await sendRealCommand({
        operation: "session.create",
        scope: input.scope ?? "project",
        provider: input.provider,
        ...(input.providerSessionId ? { providerSessionId: input.providerSessionId } : {}),
        ...(input.title ? { title: input.title } : {}),
        ...(input.initialPrompt ? { initialPrompt: input.initialPrompt } : {}),
        ...(input.model ? { model: input.model } : {}),
        ...(input.reasoningEffort
          ? { reasoningEffort: input.reasoningEffort }
          : {}),
        ...(input.extensions ? { extensions: input.extensions } : {}),
      }, input.projectId);
      if (!sent || !connection) {
        throw new Error("The secure session command was not accepted.");
      }
      rememberPendingSessionCreate(input, sent.commandId);
      const currentDraft = optimisticSessionRef.current;
      if (currentDraft?.localSessionId === localRecord.localSessionId) {
        commitOptimisticSession(
          bindOptimisticSession(
            currentDraft,
            sent.commandId,
            sent.sessionId ?? sent.commandId,
          ),
        );
      }
      durableCommandRecorded = true;
      continuePendingSessionCreate(connection, sent);
    } catch (error) {
      if (error instanceof CommandAcknowledgementTimeoutError && connection) {
        rememberPendingSessionCreate(input, error.commandId);
        const currentDraft = optimisticSessionRef.current;
        if (currentDraft?.localSessionId === localRecord.localSessionId) {
          commitOptimisticSession({
            ...currentDraft,
            commandId: error.commandId,
            updatedAt: Date.now(),
          });
        }
        durableCommandRecorded = true;
        showUiNotice(
          "session:create",
          "session",
          "warning",
          "Session creation is queued securely. Malink will resume this same command without creating a duplicate.",
        );
        continuePendingSessionCreate(connection);
      } else {
        markOptimisticSessionFailed(localRecord.localSessionId, error);
        showUiNotice(
          "session:create",
          "session",
          "error",
          formatUiError(error),
        );
      }
    } finally {
      if (!durableCommandRecorded) clearPendingSessionCreateUi();
    }
  }

  function retryFailedOptimisticSession(): void {
    const record = optimisticSessionRef.current;
    if (!record || record.phase !== "failed" || newSessionBusy) return;
    void createSession(record.input, record);
  }

  function recheckUncertainOptimisticSession(): void {
    const record = optimisticSessionRef.current;
    const recovery = pendingSessionCreateRecoveryRef.current;
    const connection = malinkClientRef.current;
    if (
      !record ||
      record.phase !== "uncertain" ||
      !recovery ||
      !connection ||
      connectionStatusRef.current !== "connected" ||
      sessionCreateRecoveryInFlightRef.current
    ) return;
    commitOptimisticSession({
      ...record,
      phase: "creating",
      error: undefined,
      updatedAt: Date.now(),
    });
    setPendingSessionCreate(recovery.input);
    setNewSessionBusy(true);
    continuePendingSessionCreate(connection);
  }

  async function stopWaitingForUncertainSession(): Promise<void> {
    const record = optimisticSessionRef.current;
    const recovery = pendingSessionCreateRecoveryRef.current;
    if (!record || record.phase !== "uncertain" || !recovery) return;
    const confirmed = window.confirm(
      "Stop waiting for this creation result? This removes the local draft and its queued messages. If the original command later succeeds, the conversation will still appear from your computer.",
    );
    if (!confirmed) return;
    forgetPendingSessionCreate(recovery.commandId);
    const localSessionId = record.localSessionId;
    const wasSelected = selectedSessionIdRef.current === localSessionId;
    removeOptimisticSession(localSessionId);
    clearPendingSessionCreateUi();
    liveMessagesBySessionRef.current.delete(localSessionId);
    if (wasSelected) {
      const fallback = gatewayState?.sessions.find(
        (session) => session.status !== "archived",
      ) ?? null;
      activateLocalSession(fallback?.id ?? null);
      if (!fallback) setMobileChatOpen(false);
    }
    const scope = historyScopeRef.current;
    if (scope) {
      await clearSessionMessageHistory(scope, localSessionId).catch((error) => {
        showUiNotice(
          "session:create-queue-storage",
          "composer",
          "warning",
          `The stopped draft's local messages could not be cleared: ${formatUiError(error)}`,
        );
      });
    }
    showUiNotice(
      "session:create",
      "session",
      "info",
      "The local creating placeholder was removed. You can create another conversation now.",
    );
  }

  async function discardFailedOptimisticSession(): Promise<void> {
    const record = optimisticSessionRef.current;
    if (!record || record.phase !== "failed" || newSessionBusy) return;
    const localSessionId = record.localSessionId;
    const wasSelected = selectedSessionIdRef.current === localSessionId;
    removeOptimisticSession(localSessionId);
    clearPendingSessionCreateUi();
    liveMessagesBySessionRef.current.delete(localSessionId);
    if (wasSelected) {
      const fallback = gatewayState?.sessions.find(
        (session) => session.status !== "archived",
      ) ?? null;
      activateLocalSession(fallback?.id ?? null);
      if (!fallback) setMobileChatOpen(false);
    }
    const scope = historyScopeRef.current;
    if (!scope) return;
    try {
      await clearSessionMessageHistory(scope, localSessionId);
      recoverUiNotice("session:create-queue-storage");
    } catch (error) {
      showUiNotice(
        "session:create-queue-storage",
        "composer",
        "warning",
        `The discarded session's local messages could not be cleared: ${formatUiError(error)}`,
      );
    }
  }

  function markOptimisticSessionFailed(
    localSessionId: string,
    error: unknown,
  ): void {
    const record = optimisticSessionRef.current;
    if (!record || record.localSessionId !== localSessionId) return;
    commitOptimisticSession(
      failOptimisticSession(record, formatUiError(error)),
    );
    clearPendingSessionCreateUi();
  }

  async function settleSessionCreate(
    connection: MalinkClient,
    sent: MalinkCommandSendResult,
  ): Promise<void> {
    let waitingForGatewayState = false;
    try {
      const completion = await waitForRecoverableSessionCreateCompletion(
        connection,
        sent,
      );
      if (completion.outcome !== "succeeded") {
        const draft = optimisticSessionRef.current;
        if (draft) {
          markOptimisticSessionFailed(
            draft.localSessionId,
            completion.error?.message ?? "Your computer could not create the session.",
          );
        }
        showUiNotice(
          "session:create",
          "session",
          "error",
          "Your computer could not create the session.",
        );
      }
      await consumeSessionCreateCompletion(
        connection,
        sent.commandId,
        completion,
      );
      waitingForGatewayState =
        completion.outcome === "succeeded" && Boolean(completion.sessionId);
      if (waitingForGatewayState) recoverUiNotice("session:create");
    } catch (error) {
      if (
        pendingSessionCreateRecoveryRef.current?.commandId === sent.commandId
      ) {
        throw error;
      }
      showUiNotice(
        "session:create",
        "session",
        "error",
        formatUiError(error),
      );
    } finally {
      if (
        !waitingForGatewayState &&
        pendingSessionCreateRecoveryRef.current?.commandId !== sent.commandId
      ) {
        clearPendingSessionCreateUi();
      }
    }
  }

  async function runSessionLifecycle(
    action: "archive",
    sessionId: string,
    onSucceeded?: () => void | Promise<void>,
    onFailed?: () => void | Promise<void>,
  ): Promise<boolean> {
    const sessionProjectId = gatewayState?.sessions.find(session => session.id === sessionId)
      ?.projectId;
    if (!sessionProjectId) {
      showUiNotice(
        `session:${action}`,
        "session",
        "error",
        "The session project route is unavailable. Refresh conversations before archiving.",
      );
      return false;
    }
    const sessionWorkspace = gatewayState?.projects?.find(
      project => project.projectId === sessionProjectId,
    );
    const capabilities = sessionWorkspace?.capabilities ?? gatewayState?.capabilities;
    const supported = capabilities?.canArchiveSession;
    if (!supported) {
      showUiNotice(
        `session:${action}`,
        "session",
        "warning",
        `This computer does not support session ${action}. Update Malink on the computer and reconnect first.`,
      );
      return false;
    }
    updateSessionLifecycleBusy((current) => {
      const next = new Map(current);
      next.set(sessionId, action);
      return next;
    });
    let connection: MalinkClient | null = null;
    try {
      connection = malinkClientRef.current;
      const sent = await sendRealCommand(
        sessionLifecyclePayload(action, sessionId),
        sessionProjectId,
      );
      if (!sent || !connection) {
        updateSessionLifecycleBusy((current) => {
          if (current.get(sessionId) !== action) return current;
          const next = new Map(current);
          next.delete(sessionId);
          return next;
        });
        return false;
      }
      setDetailsOpen(false);
      void settleSessionLifecycle(
        connection,
        sent,
        action,
        sessionId,
        onSucceeded,
        onFailed,
      );
      return true;
    } catch (error) {
      if (error instanceof CommandAcknowledgementTimeoutError && connection) {
        const recovery: PendingSessionLifecycleRecovery = {
          commandId: error.commandId,
          action,
          sessionId,
          ...(onSucceeded ? { onSucceeded } : {}),
          ...(onFailed ? { onFailed } : {}),
          timer: null,
          inFlight: false,
        };
        sessionLifecycleRecoveriesRef.current.set(error.commandId, recovery);
        setDetailsOpen(false);
        showUiNotice(
          `session:${action}`,
          "session",
          "warning",
          formatUiError(error),
        );
        continueSessionLifecycleRecovery(recovery);
        return true;
      }
      showUiNotice(
        `session:${action}`,
        "session",
        "error",
        formatUiError(error),
      );
      updateSessionLifecycleBusy((current) => {
        if (current.get(sessionId) !== action) return current;
        const next = new Map(current);
        next.delete(sessionId);
        return next;
      });
      return false;
    }
  }

  function clearSessionLifecycleRecoveries(): void {
    for (const recovery of sessionLifecycleRecoveriesRef.current.values()) {
      if (recovery.timer !== null) window.clearTimeout(recovery.timer);
    }
    sessionLifecycleRecoveriesRef.current.clear();
  }

  function scheduleSessionLifecycleRecovery(
    recovery: PendingSessionLifecycleRecovery,
  ): void {
    if (
      sessionLifecycleRecoveriesRef.current.get(recovery.commandId) !== recovery
    ) return;
    if (recovery.timer !== null) window.clearTimeout(recovery.timer);
    recovery.timer = window.setTimeout(() => {
      recovery.timer = null;
      continueSessionLifecycleRecovery(recovery);
    }, 5_000);
  }

  function continueSessionLifecycleRecovery(
    recovery: PendingSessionLifecycleRecovery,
  ): void {
    if (
      recovery.inFlight ||
      sessionLifecycleRecoveriesRef.current.get(recovery.commandId) !== recovery
    ) return;
    const connection = malinkClientRef.current;
    if (!connection || connectionStatusRef.current !== "connected") {
      scheduleSessionLifecycleRecovery(recovery);
      return;
    }
    recovery.inFlight = true;
    void (async () => {
      try {
        const sent = await connection.recoverCommand(recovery.commandId);
        if (
          sessionLifecycleRecoveriesRef.current.get(recovery.commandId) !==
          recovery
        ) return;
        sessionLifecycleRecoveriesRef.current.delete(recovery.commandId);
        recoverUiNotice(`session:${recovery.action}`);
        await settleSessionLifecycle(
          connection,
          sent,
          recovery.action,
          recovery.sessionId,
          recovery.onSucceeded,
          recovery.onFailed,
        );
      } catch (error) {
        if (
          sessionLifecycleRecoveriesRef.current.get(recovery.commandId) !==
          recovery
        ) return;
        if (
          error instanceof CommandAcknowledgementTimeoutError ||
          isCommandRecoveryPendingError(error) ||
          connectionStatusRef.current !== "connected"
        ) {
          showUiNotice(
            `session:${recovery.action}`,
            "session",
            "warning",
            "Your computer did not confirm this command. It remains queued for a safe retry.",
          );
          scheduleSessionLifecycleRecovery(recovery);
          return;
        }
        sessionLifecycleRecoveriesRef.current.delete(recovery.commandId);
        await recovery.onFailed?.();
        showUiNotice(
          `session:${recovery.action}`,
          "session",
          "error",
          formatUiError(error),
        );
        updateSessionLifecycleBusy((current) => {
          if (current.get(recovery.sessionId) !== recovery.action) return current;
          const next = new Map(current);
          next.delete(recovery.sessionId);
          return next;
        });
      } finally {
        recovery.inFlight = false;
      }
    })();
  }

  async function settleSessionLifecycle(
    connection: MalinkClient,
    sent: MalinkCommandSendResult,
    action: "archive",
    sessionId: string,
    onSucceeded?: () => void | Promise<void>,
    onFailed?: () => void | Promise<void>,
  ): Promise<void> {
    try {
      const completion = await waitForCommandCompletion(sent.completion);
      if (completion.outcome !== "succeeded") {
        await onFailed?.();
        showUiNotice(
          `session:${action}`,
          "session",
          "error",
          `The session could not be ${lifecyclePastTense(action)}.`,
        );
        return;
      }
      await onSucceeded?.();
      recoverUiNotice(`session:${action}`);
    } catch (error) {
      await onFailed?.();
      showUiNotice(
        `session:${action}`,
        "session",
        "error",
        formatUiError(error),
      );
    } finally {
      try {
        await connection.releaseCommand(sent.commandId);
      } catch (error) {
        showUiNotice(
          `session:${action}:release`,
          "session",
          "warning",
          `The completed session command could not be released locally: ${formatUiError(error)}`,
        );
      }
      updateSessionLifecycleBusy((current) => {
        if (current.get(sessionId) !== action) return current;
        const next = new Map(current);
        next.delete(sessionId);
        return next;
      });
    }
  }

  async function archiveSession(sessionId: string) {
    const session = gatewayState?.sessions.find(candidate => candidate.id === sessionId);
    const historySource = session
      ? providerHistorySources.find(source => source.projectId === session.projectId) ?? null
      : null;
    await runSessionLifecycle("archive", sessionId, () => {
      if (!session || !historySource) return;
      providerHistoryFocusRef.current = {
        gatewayNodeId: historySource.gatewayNodeId,
        projectId: session.projectId,
        provider: session.provider,
        archivedSessionId: session.id,
      };
      if (
        providerHistoryGatewayNodeIdRef.current === historySource.gatewayNodeId
        && providerHistoryProjectIdRef.current === session.projectId
        && providerHistoryProviderRef.current === session.provider
      ) {
        providerHistoryLoadedProviderRef.current = null;
      }
    });
  }

  function selectAttachments(event: ChangeEvent<HTMLInputElement>) {
    const selectedFiles = [...(event.target.files ?? [])];
    event.target.value = "";
    if (selectedFiles.length === 0) return;
    const availableSlots = MAX_MALINK_ATTACHMENTS - pendingFiles.length;
    if (availableSlots <= 0) {
      showUiNotice(
        "attachment:limits",
        "attachment",
        "warning",
        `A message can include up to ${MAX_MALINK_ATTACHMENTS} attachments.`,
      );
      return;
    }
    const accepted: File[] = [];
    let totalBytes = pendingFiles.reduce((total, file) => total + file.size, 0);
    for (const file of selectedFiles.slice(0, availableSlots)) {
      if (file.size > MAX_MALINK_ATTACHMENT_BYTES) {
        showUiNotice(
          "attachment:limits",
          "attachment",
          "warning",
          `${file.name} exceeds the ${formatFileSize(MAX_MALINK_ATTACHMENT_BYTES)} attachment limit.`,
        );
        continue;
      }
      if (totalBytes + file.size > MAX_MALINK_PROMPT_ATTACHMENT_BYTES) {
        showUiNotice(
          "attachment:limits",
          "attachment",
          "warning",
          `Attachments in one message cannot exceed ${formatFileSize(MAX_MALINK_PROMPT_ATTACHMENT_BYTES)}.`,
        );
        continue;
      }
      accepted.push(file);
      totalBytes += file.size;
    }
    if (selectedFiles.length > availableSlots) {
      showUiNotice(
        "attachment:limits",
        "attachment",
        "warning",
        `Only the first ${availableSlots} selected attachment(s) were added.`,
      );
    }
    if (accepted.length > 0) recoverUiNotice("attachment:upload");
    setPendingFiles((current) => [...current, ...accepted]);
  }

  async function sendMessage(event?: FormEvent) {
    event?.preventDefault();
    const value = draft.trim();
    if (!value && pendingFiles.length === 0) return;
    const sessionId = selectedSessionIdRef.current;
    if (!composerState.canSend || !sessionId) {
      showUiNotice(
        "composer:availability",
        "composer",
        "warning",
        composerState.reason,
      );
      return;
    }
    if (pendingPromptSessionIdsRef.current.has(sessionId)) {
      showUiNotice(
        "composer:availability",
        "composer",
        "info",
        "Securing the previous message…",
      );
      return;
    }
    const connection = malinkClientRef.current;
    if (!connection) {
      showUiNotice(
        "composer:availability",
        "composer",
        "warning",
        "The secure connection is not ready yet. Your draft is still here.",
      );
      return;
    }
    recoverUiNotice("composer:availability");
    const queueBehindActiveTurn = isStreaming;
    const activityBeforeSubmission = agentActivity;
    const submittedFiles = [...pendingFiles];
    let attachments: MalinkAttachment[] | undefined;
    if (submittedFiles.length > 0) {
      setAttachmentBusy(true);
      setSessionAgentActivity(sessionId, {
        phase: "sending",
        label: "Encrypting attachments",
        detail: `${submittedFiles.length} file${submittedFiles.length === 1 ? "" : "s"}`,
      });
      try {
        attachments = await Promise.all(
          submittedFiles.map((file) => connection.uploadAttachment(file)),
        );
        recoverUiNotice("attachment:upload");
      } catch (error) {
        showUiNotice(
          "attachment:upload",
          "attachment",
          "error",
          `Attachment upload failed: ${formatUiError(error)}`,
        );
        setSessionAgentActivity(sessionId, activityBeforeSubmission);
        return;
      } finally {
        setAttachmentBusy(false);
      }
    }
    const pendingDraft = optimisticSessionRef.current;
    if (
      pendingDraft?.phase === "creating" &&
      pendingDraft.localSessionId === sessionId
    ) {
      await queueMessageForCreatingSession(
        pendingDraft,
        value,
        attachments,
      );
      return;
    }
    const submissionHistoryScope = historyScopeRef.current;
    const submissionOriginDeviceId = deviceKeyId ?? undefined;
    const submissionOriginDeviceName = connection.deviceName;
    const optimisticId = `user-${Date.now()}-${crypto.randomUUID()}`;
    const optimisticMessage: ChatMessage = {
      id: optimisticId,
      kind: "user",
      text: value,
      time: "now",
      timestamp: Date.now(),
      sessionId,
      optimistic: true,
      deliveryState: "sending",
      attachments,
    };
    const optimisticHistoryPersisted = submissionHistoryScope
      ? saveMessageHistory(
        submissionHistoryScope,
        sessionId,
        [optimisticMessage],
      ).catch((error) => {
        showUiNotice(
          "history:save",
          "history",
          "warning",
          `Conversation history could not be saved: ${formatUiError(error)}`,
        );
        throw error;
      })
      : Promise.resolve();
    setSessionPromptSubmitting(sessionId, true);
    let result: MalinkCommandSendResult | null;
    let acknowledgementTimeout: CommandAcknowledgementTimeoutError | null = null;
    try {
      // Visibility is the durability boundary: once the user can see the
      // optimistic message, an immediate reload/background transition must be
      // able to restore it without waiting for Matrix history pagination.
      await optimisticHistoryPersisted;
      optimisticMessagesRef.current.set(optimisticId, {
        id: optimisticId,
        text: value,
        sessionId: optimisticMessage.sessionId,
      });
      rememberLiveMessage(sessionId, optimisticMessage);
      if (selectedSessionIdRef.current === sessionId) {
        followLatestRef.current = true;
        setMessages((current) => [...current, optimisticMessage]);
        setDraft("");
      }
      setSessionRunning(sessionId, true);
      if (!queueBehindActiveTurn) {
        setSessionAgentActivity(sessionId, SENDING_AGENT_ACTIVITY);
      }
      result = await sendRealCommand(
        createPromptCommandPayload({
          sessionId,
          text: value,
          attachments,
        }),
      );
    } catch (error) {
      if (!(error instanceof CommandAcknowledgementTimeoutError)) throw error;
      acknowledgementTimeout = error;
      result = null;
    } finally {
      setSessionPromptSubmitting(sessionId, false);
    }
    if (acknowledgementTimeout) {
      const optimisticReference =
        optimisticMessagesRef.current.get(optimisticId);
      if (optimisticReference) {
        optimisticReference.commandId = acknowledgementTimeout.commandId;
      }
      if (
        completedCommandResultsRef.current.delete(
          acknowledgementTimeout.commandId,
        )
      ) {
        finishLocalPromptCommand(sessionId);
      } else {
        activePromptCommandsRef.current.set(
          acknowledgementTimeout.commandId,
          sessionId,
        );
        setSessionAgentActivity(
          sessionId,
          queueBehindActiveTurn
            ? activityBeforeSubmission ?? WORKING_AGENT_ACTIVITY
            : WAITING_AGENT_ACTIVITY,
        );
      }
      setPendingFiles([]);
      showUiNotice(
        "composer:send",
        "composer",
        "warning",
        gatewayLiveness.state === "offline"
          ? "Your computer's Malink Gateway is offline. This message is saved for reconciliation and has not been submitted again."
          : "Your computer did not acknowledge this message. It is saved for reconciliation; do not send it again while Malink determines whether it ran.",
      );
      return;
    }
    if (!result) {
      finishLocalPromptCommand(sessionId);
      if (revisionConflictRef.current) {
        const conflict = revisionConflictRef.current;
        const matchesCurrentPrompt =
          conflict.payload.operation === "prompt" &&
          conflict.payload.sessionId === sessionId &&
          conflict.payload.text === value;
        const next = matchesCurrentPrompt
          ? { ...conflict, optimisticMessageId: optimisticId }
          : conflict;
        revisionConflictRef.current = next;
        setRevisionConflict(next);
        if (!matchesCurrentPrompt) {
          optimisticMessagesRef.current.delete(optimisticId);
          removeLiveMessage(sessionId, optimisticId);
          if (selectedSessionIdRef.current === sessionId) {
            setMessages((current) =>
              current.filter((message) => message.id !== optimisticId),
            );
          }
          if (submissionHistoryScope) {
            void deleteMessageHistory(
              submissionHistoryScope,
              optimisticId,
            ).catch((error) => {
              showUiNotice(
                "history:update",
                "history",
                "warning",
                `Conversation history could not be updated: ${formatUiError(error)}`,
              );
            });
          }
          if (selectedSessionIdRef.current === sessionId) {
            setDraft(value);
          }
        }
      } else if (nativeCommandReviewRef.current) {
        // The native outbox is asking the user to resolve an earlier,
        // state-dependent action. This prompt was not accepted, but that is
        // neither an Agent error nor a broken connection. Remove the
        // optimistic copy and restore the exact draft instead of adding the
        // misleading TASK NEEDS ATTENTION / connection-settings message.
        optimisticMessagesRef.current.delete(optimisticId);
        removeLiveMessage(sessionId, optimisticId);
        if (selectedSessionIdRef.current === sessionId) {
          setMessages((current) =>
            current.filter((message) => message.id !== optimisticId),
          );
          setDraft(value);
        }
        if (submissionHistoryScope) {
          void deleteMessageHistory(
            submissionHistoryScope,
            optimisticId,
          ).catch((error) => {
            showUiNotice(
              "history:update",
              "history",
              "warning",
              `Conversation history could not be updated: ${formatUiError(error)}`,
            );
          });
        }
      } else {
        optimisticMessagesRef.current.delete(optimisticId);
        const failedMessage: ChatMessage = {
          ...optimisticMessage,
          optimistic: false,
          deliveryState: "failed",
        };
        rememberLiveMessage(sessionId, failedMessage);
        if (selectedSessionIdRef.current === sessionId) {
          setMessages((current) =>
            current.map((message) =>
              message.id === optimisticId
                ? failedMessage
              : message,
            ),
          );
        }
        if (submissionHistoryScope) {
          void saveMessageHistory(
            submissionHistoryScope,
            sessionId,
            [failedMessage],
          ).catch((error) => {
            showUiNotice(
              "history:save",
              "history",
              "warning",
              `Conversation history could not be saved: ${formatUiError(error)}`,
            );
          });
        }
        const errorMessage: ChatMessage = {
          id: `matrix-error-${Date.now()}`,
          kind: "error",
          text: "The command was not sent. Open connection settings.",
          time: "now",
          timestamp: Date.now(),
          sessionId,
        };
        rememberLiveMessage(sessionId, errorMessage);
        if (selectedSessionIdRef.current === sessionId) {
          setMessages((current) => [
            ...current,
            errorMessage,
          ]);
        }
      }
    } else {
      const optimisticReference =
        optimisticMessagesRef.current.get(optimisticId);
      if (optimisticReference) {
        optimisticReference.commandId = result.commandId;
      }
      if (completedCommandResultsRef.current.delete(result.commandId)) {
        finishLocalPromptCommand(sessionId);
      } else {
        activePromptCommandsRef.current.set(result.commandId, sessionId);
        setSessionAgentActivity(
          sessionId,
          queueBehindActiveTurn
            ? activityBeforeSubmission ?? WORKING_AGENT_ACTIVITY
            : WAITING_AGENT_ACTIVITY,
        );
      }
      const sentMessage: ChatMessage = {
        ...optimisticMessage,
        commandId: result.commandId,
        revision: result.revision,
        originDeviceId: submissionOriginDeviceId,
        originDeviceName: submissionOriginDeviceName,
        deliveryState: "sent",
      };
      setPendingFiles([]);
      const wasAlreadyReconciled =
        reconciledOptimisticMessageIdsRef.current.has(optimisticId);
      if (
        !wasAlreadyReconciled &&
        selectedSessionIdRef.current === sessionId
      ) {
        setMessages((current) =>
          current.map((message) =>
            message.id === optimisticId ? sentMessage : message,
          ),
        );
      }
      if (!wasAlreadyReconciled) {
        rememberLiveMessage(sessionId, sentMessage);
      }
      if (!wasAlreadyReconciled && submissionHistoryScope) {
        void saveMessageHistory(
          submissionHistoryScope,
          sessionId,
          [sentMessage],
        ).catch((error) => {
          showUiNotice(
            "history:save",
            "history",
            "warning",
            `Conversation history could not be saved: ${formatUiError(error)}`,
          );
        });
      }
      recoverUiNotice("composer:send");
    }
  }

  async function queueMessageForCreatingSession(
    record: OptimisticSessionRecord,
    text: string,
    attachments?: MalinkAttachment[],
  ): Promise<void> {
    const scope = historyScopeRef.current;
    if (!scope) {
      showUiNotice(
        "session:create-queue-storage",
        "composer",
        "error",
        "The local encrypted message store is not ready yet. Your draft was kept.",
      );
      return;
    }
    const message: ChatMessage = {
      id: `queued-${Date.now()}-${crypto.randomUUID()}`,
      kind: "user",
      text,
      time: "now",
      timestamp: Date.now(),
      sessionId: record.localSessionId,
      optimistic: true,
      deliveryState: "queued",
      attachments,
    };
    try {
      await saveMessageHistory(scope, record.localSessionId, [message]);
    } catch (error) {
      showUiNotice(
        "session:create-queue-storage",
        "composer",
        "error",
        `The message could not be queued safely: ${formatUiError(error)}`,
      );
      return;
    }
    rememberLiveMessage(record.localSessionId, message);
    if (selectedSessionIdRef.current === record.localSessionId) {
      followLatestRef.current = true;
      setMessages((current) => [...current, message]);
      setDraft("");
    }
    setPendingFiles([]);
    setSessionAgentActivity(record.localSessionId, null);
    recoverUiNotice("session:create-queue-storage");
  }

  async function flushQueuedSessionMessages(
    sessionId: string,
    connection: MalinkClient | null = malinkClientRef.current,
  ): Promise<void> {
    const scope = historyScopeRef.current;
    if (
      !scope ||
      !connection ||
      connectionStatusRef.current !== "connected"
    ) {
      queuedSessionFlushIdsRef.current.add(sessionId);
      return;
    }
    if (queuedSessionFlushInFlightRef.current.has(sessionId)) return;
    queuedSessionFlushIdsRef.current.add(sessionId);
    queuedSessionFlushInFlightRef.current.add(sessionId);
    let completed = false;
    try {
      const queued = await loadQueuedSessionMessages(scope, sessionId);
      for (const persisted of queued) {
        const sent = await transmitQueuedSessionMessage(
          sessionId,
          { ...persisted, sessionId, optimistic: true },
        );
        if (!sent) return;
      }
      completed = true;
    } finally {
      queuedSessionFlushInFlightRef.current.delete(sessionId);
      if (completed) queuedSessionFlushIdsRef.current.delete(sessionId);
    }
  }

  async function transmitQueuedSessionMessage(
    sessionId: string,
    queuedMessage: ChatMessage,
  ): Promise<boolean> {
    const scope = historyScopeRef.current;
    if (!scope) return false;
    const sendingMessage: ChatMessage = {
      ...queuedMessage,
      sessionId,
      optimistic: true,
      deliveryState: "sending",
    };
    optimisticMessagesRef.current.set(sendingMessage.id, {
      id: sendingMessage.id,
      text: sendingMessage.text ?? "",
      sessionId,
    });
    rememberLiveMessage(sessionId, sendingMessage);
    if (selectedSessionIdRef.current === sessionId) {
      setMessages((current) =>
        current.map((message) =>
          message.id === sendingMessage.id ? sendingMessage : message,
        ),
      );
    }
    await saveMessageHistory(scope, sessionId, [sendingMessage]);
    setSessionPromptSubmitting(sessionId, true);
    setSessionRunning(sessionId, true);
    setSessionAgentActivity(sessionId, SENDING_AGENT_ACTIVITY);
    let result: MalinkCommandSendResult | null = null;
    try {
      result = await sendRealCommand(
        createPromptCommandPayload({
          sessionId,
          text: sendingMessage.text ?? "",
          attachments: sendingMessage.attachments,
        }),
      );
    } catch (error) {
      if (error instanceof CommandAcknowledgementTimeoutError) {
        const reference = optimisticMessagesRef.current.get(sendingMessage.id);
        if (reference) reference.commandId = error.commandId;
        activePromptCommandsRef.current.set(error.commandId, sessionId);
        setSessionAgentActivity(sessionId, WAITING_AGENT_ACTIVITY);
        showUiNotice(
          "composer:send",
          "composer",
          "warning",
          "The queued message is awaiting confirmation. Malink will reconcile it without sending a duplicate.",
        );
        return false;
      }
      throw error;
    } finally {
      setSessionPromptSubmitting(sessionId, false);
    }
    if (!result) {
      optimisticMessagesRef.current.delete(sendingMessage.id);
      const failed: ChatMessage = {
        ...sendingMessage,
        optimistic: false,
        deliveryState: "failed",
      };
      rememberLiveMessage(sessionId, failed);
      if (selectedSessionIdRef.current === sessionId) {
        setMessages((current) =>
          current.map((message) =>
            message.id === failed.id ? failed : message,
          ),
        );
      }
      await saveMessageHistory(scope, sessionId, [failed]);
      finishLocalPromptCommand(sessionId);
      return false;
    }
    const reference = optimisticMessagesRef.current.get(sendingMessage.id);
    if (reference) reference.commandId = result.commandId;
    if (completedCommandResultsRef.current.delete(result.commandId)) {
      finishLocalPromptCommand(sessionId);
    } else {
      activePromptCommandsRef.current.set(result.commandId, sessionId);
      setSessionAgentActivity(sessionId, WAITING_AGENT_ACTIVITY);
    }
    const sentMessage: ChatMessage = {
      ...sendingMessage,
      commandId: result.commandId,
      revision: result.revision,
      deliveryState: "sent",
    };
    rememberLiveMessage(sessionId, sentMessage);
    if (selectedSessionIdRef.current === sessionId) {
      setMessages((current) =>
        current.map((message) =>
          message.id === sentMessage.id ? sentMessage : message,
        ),
      );
    }
    await saveMessageHistory(scope, sessionId, [sentMessage]);
    recoverUiNotice("composer:send");
    return true;
  }

  function onComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Escape" && composerOptionsOpen) {
      event.preventDefault();
      setComposerOptionsOpen(false);
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void sendMessage();
    }
  }

  function restoreFailedMessage(message: ChatMessage) {
    const sessionId = message.sessionId ?? selectedSessionIdRef.current;
    if (!sessionId || !message.text) return;
    if (draft.trim()) {
      showUiNotice(
        "composer:retry",
        "composer",
        "warning",
        "Your current draft is still here. Send or clear it before restoring the failed message.",
      );
      composerTextareaRef.current?.focus();
      return;
    }
    setDraft(message.text);
    optimisticMessagesRef.current.delete(message.id);
    removeLiveMessage(sessionId, message.id);
    setMessages((current) =>
      current.filter((entry) => entry.id !== message.id),
    );
    if (historyScopeRef.current) {
      void deleteMessageHistory(historyScopeRef.current, message.id).catch(
        (error) => {
          showUiNotice(
            "history:update",
            "history",
            "warning",
            `Conversation history could not be updated: ${formatUiError(error)}`,
          );
        },
      );
    }
    if (message.attachments?.length) {
      showUiNotice(
        "composer:retry-attachments",
        "attachment",
        "warning",
        "The message text was restored. Attach its files again before sending.",
      );
    } else {
      recoverUiNotice("composer:retry");
    }
    window.requestAnimationFrame(() => composerTextareaRef.current?.focus());
  }

  async function stopStreaming(sessionId: string, activeTurnId: string) {
    if (isStopping) return;
    if (selectedSessionIdRef.current !== sessionId) return;
    setSessionStopping(sessionId, true);
    setSessionAgentActivity(sessionId, STOPPING_AGENT_ACTIVITY);
    const sent = await sendRealCommand(
      createCancelCommandPayload(sessionId, activeTurnId),
    );
    if (!sent || (await sent.completion).outcome !== "succeeded") {
      setSessionStopping(sessionId, false);
      setSessionAgentActivity(
        sessionId,
        runningSessionIds.has(sessionId) ? WORKING_AGENT_ACTIVITY : null,
      );
    }
  }

  async function decidePermission(
    message: ChatMessage,
    decision: string,
  ) {
    if (!message.requestId) {
      showUiNotice(
        "composer:permission",
        "composer",
        "error",
        "This permission request is missing its secure request ID.",
      );
      return;
    }
    const sessionId = message.sessionId ?? selectedSessionIdRef.current;
    if (!sessionId) {
      showUiNotice(
        "composer:permission",
        "composer",
        "error",
        "This permission request has no session identity.",
      );
      return;
    }
    const privilegeRequest = message.raw?.decisionType === "privilege";
    if (privilegeRequest && decision !== "deny") {
      const gatewayId = matrixConfig.gatewayId.trim();
      if (!gatewayId) {
        showUiNotice(
          "composer:permission",
          "composer",
          "error",
          "This privilege request has no trusted Gateway identity.",
        );
        return;
      }
      if (!hasPrivilegeTotp(gatewayId)) {
        setPrivilegeTotpError(null);
        setPrivilegeTotpEnrollment({ message, decision });
        return;
      }
      setDecisionStates((current) => ({
        ...current,
        [message.id]: "submitting",
      }));
      try {
        const totp = await unlockPrivilegeTotp(gatewayId);
        await submitPermissionDecision(message, decision, totp);
      } catch (error) {
        setDecisionStates((current) => ({
          ...current,
          [message.id]: "pending",
        }));
        showUiNotice(
          "composer:permission",
          "composer",
          "error",
          formatUiError(error),
        );
      }
      return;
    }
    await submitPermissionDecision(message, decision);
  }

  async function submitPermissionDecision(
    message: ChatMessage,
    decision: string,
    totp?: string,
  ) {
    const sessionId = message.sessionId ?? selectedSessionIdRef.current;
    if (!message.requestId || !sessionId) return;
    setDecisionStates((current) => ({
      ...current,
      [message.id]: "submitting",
    }));
    try {
      const sent = await sendRealCommand({
        operation: "decision",
        sessionId,
        requestId: message.requestId,
        decision,
        ...(totp ? { totp } : {}),
      });
      if (!sent) {
        setDecisionStates((current) => ({
          ...current,
          [message.id]: "pending",
        }));
        return;
      }
      const completion = await sent.completion;
      if (completion.outcome !== "succeeded") {
        throw new Error(
          completion.error?.message ??
            "Your computer could not apply this permission decision.",
        );
      }
      setDecisionStates((current) => ({
        ...current,
        [message.id]: { actionId: decision },
      }));
      recoverUiNotice("composer:permission");
    } catch (error) {
      setDecisionStates((current) => ({
        ...current,
        [message.id]: "pending",
      }));
      showUiNotice(
        "composer:permission",
        "composer",
        "error",
        formatUiError(error),
      );
    }
  }

  async function completePrivilegeTotpEnrollment(setupKey: string) {
    const pending = privilegeTotpEnrollment;
    const gatewayId = matrixConfig.gatewayId.trim();
    if (!pending || !gatewayId) return;
    setPrivilegeTotpBusy(true);
    setPrivilegeTotpError(null);
    try {
      const totp = await enrollPrivilegeTotp(gatewayId, setupKey);
      setPrivilegeTotpEnrollment(null);
      await submitPermissionDecision(
        pending.message,
        pending.decision,
        totp,
      );
    } catch (error) {
      setPrivilegeTotpError(formatUiError(error));
    } finally {
      setPrivilegeTotpBusy(false);
    }
  }

  async function updateSessionSetting(
    field: SessionSettingsField,
    value: string,
  ): Promise<void> {
    const sessionId = selectedSessionIdRef.current;
    if (!sessionId || sessionSettingsUpdate) return;
    const update = { sessionId, field, value };
    setSessionSettingsUpdate(update);
    const payload: CommandPayload = field === "model"
      ? { operation: "session.settings", sessionId, model: value }
      : field === "reasoningEffort"
        ? { operation: "session.settings", sessionId, reasoningEffort: value }
        : {
            operation: "session.settings",
            sessionId,
            permissionMode: value as
              | "default"
              | "accept_edits"
              | "plan"
              | "bypass_permissions",
          };
    try {
      const sent = await sendRealCommand(payload, undefined, {
        propagateFailure: true,
      });
      if (!sent) throw new Error("The setting update was not sent.");
      const completion = await sent.completion;
      if (completion.outcome !== "succeeded") {
        throw new Error(
          completion.error?.message ?? "The setting update did not complete.",
        );
      }
      showUiNotice(
        "session:settings",
        "composer",
        "success",
        `${sessionSettingsFieldLabel(field)} updated.`,
        3_000,
      );
    } catch (error) {
      showUiNotice(
        "session:settings",
        "composer",
        "error",
        formatUiError(error),
      );
    } finally {
      setSessionSettingsUpdate((current) => current === update ? null : current);
    }
  }

  const activeSessionSettingsUpdate = sessionSettingsUpdate?.sessionId ===
      selectedSessionId
    ? sessionSettingsUpdate
    : null;
  const settingsUpdateBusy = sessionSettingsUpdate !== null;

  return (
    <main className={`app-shell ${mobileChatOpen ? "mobile-chat-open" : ""} ${primaryView === "files" ? "file-inbox-open" : ""}`}>
      <aside className="rail" aria-label="Primary navigation">
        <div className="brand" title="Malink">
          <span>⌁</span>
        </div>
        <nav className="rail-nav">
          <button
            type="button"
            className={`rail-button ${primaryView === "chats" ? "active" : ""}`}
            aria-current={primaryView === "chats" ? "page" : undefined}
            onClick={() => setPrimaryView("chats")}
          >
            <Icon>◫</Icon>
            <span>Chats</span>
          </button>
          <button
            type="button"
            className={`rail-button ${primaryView === "files" ? "active" : ""}`}
            aria-current={primaryView === "files" ? "page" : undefined}
            onClick={() => {
              setPrimaryView("files");
              setMobileChatOpen(false);
            }}
          >
            <Icon>⇩</Icon>
            <span>Files</span>
          </button>
        </nav>
        <div className="rail-spacer" />
        <button
          type="button"
          className="rail-button"
          aria-label="Settings"
          onClick={() => setSettingsOpen(true)}
        >
          <Icon>⚙</Icon>
          <span>Settings</span>
        </button>
      </aside>

      {primaryView === "files" && (
        <section className="workspace-inbox-panel" aria-label="Workspace file inbox">
          <header className="workspace-inbox-header">
            <div>
              <span className="eyebrow">Workspace</span>
              <h1>File inbox</h1>
              <p>Files sent by local agents appear here without being attached to a conversation.</p>
            </div>
            <div className="workspace-inbox-actions">
              <span className="workspace-inbox-count">{inboxFiles.length}</span>
              <button type="button" onClick={() => setPrimaryView("chats")}>
                Back to chats
              </button>
            </div>
          </header>
          <div className="workspace-inbox-list">
            {inboxFiles.map((file) => (
              <article className="workspace-inbox-card" key={file.id}>
                <div className="workspace-inbox-meta">
                  <span className="workspace-inbox-source">
                    {file.sourceLabel || "Local Malink CLI"}
                  </span>
                  <time>{formatSessionTime(file.receivedAt)}</time>
                </div>
                {file.caption && <p>{file.caption}</p>}
                <AttachmentList
                  attachments={[file.attachment]}
                  connection={malinkClientRef.current}
                />
              </article>
            ))}
            {inboxFiles.length === 0 && (
              <div className="workspace-inbox-empty">
                <span aria-hidden="true">⇩</span>
                <strong>No files yet</strong>
                <p>Run <code>malink send-file &lt;path&gt;</code> on the Gateway computer.</p>
              </div>
            )}
          </div>
        </section>
      )}

      <section className="session-panel" aria-label="Conversations">
        <header className="session-header">
          <div>
            <span className="eyebrow">Workspace</span>
            <h1>Malink</h1>
          </div>
          <div className="session-header-actions">
            <button
              type="button"
              className={`mobile-history-button${providerHistoryLoad ? " is-loading" : ""}`}
              aria-label={providerHistoryLoad
                ? "Provider sessions are loading"
                : "Browse provider sessions"}
              aria-busy={providerHistoryLoad !== null}
              onClick={() => void openProviderHistory()}
              disabled={
                !gatewayAvailable ||
                providerHistorySources.length === 0
              }
            >
              <HistoryIcon />
            </button>
            <button
              type="button"
              className="mobile-files-button"
              aria-label="Open workspace file inbox"
              onClick={() => setPrimaryView("files")}
            >
              <FileInboxIcon />
            </button>
            <button
              type="button"
              className="mobile-search-button"
              aria-label={sessionSearchOpen ? "Close conversation search" : "Search conversations"}
              aria-expanded={sessionSearchOpen}
              aria-controls="session-search"
              onClick={() => {
                if (sessionSearchOpen) {
                  setSearch("");
                  setSessionSearchOpen(false);
                  return;
                }
                setSessionSearchOpen(true);
                window.requestAnimationFrame(() =>
                  sessionSearchRef.current?.focus(),
                );
              }}
            >
              {sessionSearchOpen ? <CloseIcon /> : <SearchIcon />}
            </button>
            <button
              type="button"
              className="new-project-button"
              aria-label="New project"
              title="New project"
              onClick={() => setNewProjectOpen(true)}
              disabled={
                newProjectBusy ||
                !gatewayAvailable ||
                projectCreationGateways.length === 0
              }
            >
              <NewProjectIcon />
            </button>
            <button
              className="round-button"
              aria-label="New conversation"
              onClick={() => setNewSessionOpen(true)}
              disabled={
                newSessionBusy ||
                Boolean(optimisticSession) ||
                !gatewayAvailable ||
                !canCreateAnySession
              }
            >
              <NewConversationIcon />
            </button>
          </div>
        </header>

        <label
          className={`search-box ${sessionSearchOpen || search ? "search-box-open" : ""}`}
        >
          <span aria-hidden="true">⌕</span>
          <input
            id="session-search"
            ref={sessionSearchRef}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search conversations"
            aria-label="Search conversations"
          />
          <kbd aria-label="Control or Command K">Ctrl/⌘ K</kbd>
        </label>

        <button
          className={`gateway-card gateway-card-button connection-state-${displayedConnectionStatus} ${
            displayedConnectionStatus === "offline" || displayedConnectionStatus === "error"
              ? "offline"
              : ""
          }`}
          aria-label={`Open connection settings, ${
            mobileConnectionSignal.label
          }`}
          title={`Connection: ${mobileConnectionSignal.label}`}
          onClick={() => setSettingsOpen(true)}
        >
          <span className="gateway-icon">G</span>
          <div>
            <strong>
              {workspaceGatewayTitle}
            </strong>
            <span className="gateway-status-copy">
              <span
                className={`mobile-connection-icon mobile-connection-${mobileConnectionSignal.state}`}
                aria-hidden="true"
              >
                <MobileConnectionIcon state={mobileConnectionSignal.state} />
              </span>
            </span>
            <span className="gateway-mobile-status" aria-hidden="true">
              <span
                className={`mobile-connection-icon mobile-connection-${mobileConnectionSignal.state}`}
              >
                <MobileConnectionIcon state={mobileConnectionSignal.state} />
              </span>
              <span className="gateway-mobile-status-copy">
                {mobileConnectionSignal.label}
              </span>
            </span>
          </div>
          <span className="gateway-more" aria-hidden="true">•••</span>
        </button>

        <UiNoticeList
          notices={sessionNotices}
          className="session-notices"
          onDismiss={dismissUiNotice}
        />

        <div className="session-list">
          {optimisticSession && (
            <button
              type="button"
              className={`session-row session-create-pending ${
                optimisticSession.phase === "creating" ? "" : "is-failed"
              } ${selectedSessionId === optimisticSession.localSessionId ? "selected" : ""}`}
              data-session-id={optimisticSession.localSessionId}
              data-session-phase={optimisticSession.phase}
              aria-pressed={selectedSessionId === optimisticSession.localSessionId}
              aria-label={`${optimisticSession.input.title?.trim() || "New session"}. ${
                optimisticSession.phase === "failed"
                  ? "Creation failed. Open to retry."
                  : optimisticSession.phase === "uncertain"
                    ? "Creation result not confirmed. Open to check again or stop waiting."
                    : "Creating. You can already send messages."
              }`}
              onClick={() => {
                setPrimaryView("chats");
                setMobileChatOpen(true);
                activateLocalSession(
                  optimisticSession.localSessionId,
                  null,
                  true,
                  true,
                );
                void restoreOptimisticSessionMessages(optimisticSession);
              }}
            >
              <span className="session-avatar violet" aria-hidden="true">
                {optimisticSession.phase === "creating" ? (
                  <i className="session-create-spinner" />
                ) : (
                  "!"
                )}
              </span>
              <span className="session-copy">
                <span className="session-title-line">
                  <strong>{optimisticSession.input.title?.trim() || "New session"}</strong>
                  <time>
                    {optimisticSession.phase === "failed"
                      ? "failed"
                      : optimisticSession.phase === "uncertain"
                        ? "check"
                        : "now"}
                  </time>
                </span>
                <span className="session-preview-line">
                  <span>
                    {optimisticSession.phase === "failed"
                      ? "Creation failed · Open to retry"
                      : optimisticSession.phase === "uncertain"
                        ? "Result not confirmed · Open to resolve"
                        : "Creating · Ready for messages"}
                  </span>
                </span>
              </span>
            </button>
          )}
          {conversationGroups.map((project) => {
            const expanded = isProjectExpanded({
              state: collapsedProjects,
              projectKey: project.key,
              searchQuery: search,
            });
            const projectSummary = summarizeProjectSessions(
              project.sessions,
              sessionReadState,
            );
            const contentId = `project-sessions-${encodeURIComponent(project.key)}`;
            return (
            <section className="project-session-group" key={project.key}>
              <button
                type="button"
                className="project-session-toggle"
                aria-expanded={expanded}
                aria-controls={contentId}
                title={project.temporary ? "Temporary workspace" : "Project"}
                aria-label={`${projectSessionSummaryLabel(
                  project.projectName,
                  projectSummary,
                )}. ${expanded ? "Collapse project" : "Expand project"}`}
                onClick={() =>
                  setCollapsedProjects((current) =>
                    toggleProjectCollapsed(current, project.key),
                  )
                }
              >
                <span
                  className={`project-chevron${expanded ? " expanded" : ""}`}
                  aria-hidden="true"
                >
                  <ProjectDisclosureIcon />
                </span>
                <span className="project-folder" aria-hidden="true">
                  <ProjectFolderIcon temporary={project.temporary} />
                </span>
                <span className="project-copy">
                  <strong>{project.projectName}</strong>
                  <small>
                    {project.temporary
                      ? project.cwd
                      : `${project.gatewayLabel} · ${project.cwd}`}
                  </small>
                </span>
                <span className="project-indicators" aria-hidden="true">
                  {projectSummary.failed > 0 && (
                    <span
                      className="project-signal project-signal-failed"
                      title={`${projectSummary.failed} failed`}
                    >
                      <SessionSignalIcon signal="failed" />
                      <b>{projectSummary.failed}</b>
                    </span>
                  )}
                  {projectSummary.ready > 0 && (
                    <span
                      className="project-signal project-signal-ready"
                      title={`${projectSummary.ready} new`}
                    >
                      <SessionSignalIcon signal="ready" />
                      <b>{projectSummary.ready}</b>
                    </span>
                  )}
                  {projectSummary.working > 0 && (
                    <span
                      className="project-signal project-signal-working"
                      title={`${projectSummary.working} working`}
                    >
                      <SessionSignalIcon signal="working" />
                      <b>{projectSummary.working}</b>
                    </span>
                  )}
                </span>
                <b aria-hidden="true">{project.sessions.length}</b>
              </button>
              {expanded && (
                <div id={contentId} className="project-session-list">
              {project.sessions.map((session) => {
                const indicator = sessionIndicator(session, sessionReadState);
                const signal = sessionListSignal(session, sessionReadState);
                const activity = agentActivitiesBySession.get(session.id);
                const lifecycleAction =
                  sessionLifecycleBusy.get(session.id) ?? null;
                const statusSummary = lifecycleAction
                  ? `${lifecycleAction === "delete" ? "Deleting" : lifecycleAction === "archive" ? "Archiving" : "Restoring"}…`
                  : activity?.detail ||
                    activity?.label ||
                    sessionSignalLabel(signal) ||
                    "Idle";
                const technicalSummary = `${session.provider}${
                  session.model ? ` · ${session.model}` : ""
                }${
                  session.reasoningEffort ? ` · ${session.reasoningEffort}` : ""
                }`;
                const visualSignal = lifecycleAction ? "working" : signal;
                const visualSignalLabel = lifecycleAction
                  ? statusSummary
                  : sessionSignalLabel(signal);
                return (
                <button
                  key={session.id}
                  data-session-id={session.id}
                  data-project-name={session.projectName}
                  aria-label={`${session.title}. ${statusSummary}. ${technicalSummary}. Updated ${formatSessionTime(session.updatedAt)}`}
                  title={`${session.title} · ${statusSummary}`}
                  data-session-signal={visualSignal}
                  aria-pressed={selectedSessionId === session.id}
                  className={`session-row ${
                    selectedSessionId === session.id
                      ? "selected"
                      : ""
                  } session-state-${indicator.activity} session-signal-${signal} ${indicator.unread ? "unread" : ""} ${lifecycleAction ? "is-busy" : ""}`}
                  onClick={() => void chooseSession(session.id)}
                  disabled={lifecycleAction === "delete"}
                >
                  <span className="session-avatar violet">
                    {sessionInitials(session.title)}
                  </span>
                  <span className="session-copy">
                    <span className="session-title-line">
                      <strong>{session.title}</strong>
                      <span className="session-title-meta">
                        <time>{formatSessionTime(session.updatedAt)}</time>
                        {visualSignal !== "idle" && (
                          <span
                            className={`session-signal-mark signal-${visualSignal} ${
                              visualSignal === "working" && !gatewayConnected
                                ? "is-paused"
                                : ""
                            }`}
                            title={visualSignalLabel ?? undefined}
                            aria-hidden="true"
                          >
                            <SessionSignalIcon signal={visualSignal} />
                          </span>
                        )}
                      </span>
                    </span>
                    {(lifecycleAction || session.extensions.length > 0) && (
                      <span className="session-preview-line">
                        {lifecycleAction && (
                          <span className="session-status-summary">
                            {statusSummary}
                          </span>
                        )}
                        {session.extensions.length > 0 && (
                          <b
                            className="session-extension-badge"
                            title={session.extensions.map((item) => item.name).join(", ")}
                          >
                            ◇ {session.extensions[0]?.name}
                            {session.extensions.length > 1
                              ? ` +${session.extensions.length - 1}`
                              : ""}
                          </b>
                        )}
                      </span>
                    )}
                  </span>
                </button>
                );
              })}
                </div>
              )}
            </section>
            );
          })}
          {!trustedGateway && (
            <div className="empty-search">
              <span>G</span>
              Connect a computer to start your first conversation
            </div>
          )}
          {trustedGateway &&
            (!gatewayState ||
              (gatewayState.sessions.length === 0 &&
                connectionStatus !== "connected")) && (
            <div
              className={`empty-search connection-progress connection-progress-${connectionPresentation.state}`}
              role="status"
            >
              <span className="connection-progress-desktop-visual" aria-hidden="true">
                {connectionPresentation.state === "progress" ||
                connectionPresentation.state === "ready" ? (
                  <span className="connection-progress-spinner" />
                ) : (
                  <span className="connection-progress-symbol">
                    {connectionPresentation.state === "offline" ? "⌁" : "!"}
                  </span>
                )}
              </span>
              <span
                className={`connection-progress-mobile-visual mobile-connection-icon mobile-connection-${mobileConnectionSignal.state}`}
                aria-hidden="true"
              >
                <MobileConnectionIcon state={mobileConnectionSignal.state} />
              </span>
              <strong className="connection-progress-desktop-title">
                {connectionStatus === "connected"
                  ? "Syncing your conversations"
                  : connectionPresentation.title}
              </strong>
              <strong className="connection-progress-mobile-title">
                {mobileConnectionSignal.label}
              </strong>
              <small className="connection-progress-detail">
                {connectionPresentation.detail}
              </small>
              <button
                type="button"
                className="connection-progress-desktop-action"
                onClick={() => setSettingsOpen(true)}
              >
                Open connection settings
              </button>
              {(mobileConnectionSignal.state === "offline" ||
                mobileConnectionSignal.state === "attention") && (
                <button
                  type="button"
                  className="connection-progress-mobile-action"
                  aria-label="Open connection settings"
                  onClick={() => setSettingsOpen(true)}
                >
                  •••
                </button>
              )}
            </div>
          )}
          {gatewayState &&
            activeSessionCount > 0 &&
            conversationGroups.length === 0 &&
            Boolean(search.trim()) && (
            <div className="empty-search">
              <span>⌕</span>
              No matching active conversations
            </div>
          )}
          {gatewayState &&
            gatewayState.sessions.length === 0 &&
            connectionStatus === "connected" &&
            !optimisticSession &&
            !pendingSessionCreate && (
              <div className="empty-search">
                <span>+</span>
                Create your first conversation
              </div>
            )}
        </div>

        <footer className="trust-footer">
          <span className="shield">✓</span>
          <span>
            <strong>Protected connection</strong>
            <small>
              {deviceKeyId
                ? `${connectionPresentation.title} · ${
                    activeDeviceCount === null
                      ? "checking approved devices"
                      : `${activeDeviceCount} approved ${
                          activeDeviceCount === 1 ? "device" : "devices"
                        }`
                  }`
                : "Preparing this device"}
            </small>
          </span>
          <button
            aria-label="Open connection settings"
            onClick={() => setSettingsOpen(true)}
          >
            ›
          </button>
        </footer>
      </section>

      <section className="conversation-panel" aria-label={conversationTitle}>
        <header className="conversation-header">
          <button
            className="mobile-back"
            onClick={() => setMobileChatOpen(false)}
            aria-label="Back to conversations"
          >
            ‹
          </button>
          <span className="conversation-avatar violet">
            {sessionInitials(conversationTitle)}
          </span>
          <div className="conversation-heading">
            <h2>{conversationTitle}</h2>
            <span className="conversation-status">
              {gatewayAvailable && gatewayState && (
                <i
                  className={`connection-dot connection-state-${displayedConnectionStatus}`}
                  aria-hidden="true"
                />
              )}
              <span className="conversation-status-copy">
                {gatewayAvailable && gatewayState ? (
                  `${activeWorkspace?.projectName || "Project"} · ${activeProvider}`
                ) : (
                  <>
                    <span
                      className="conversation-connection-desktop"
                      title={mobileConnectionSignal.label}
                    >
                      <span
                        className={`mobile-connection-icon mobile-connection-${mobileConnectionSignal.state}`}
                        aria-hidden="true"
                      >
                        <MobileConnectionIcon state={mobileConnectionSignal.state} />
                      </span>
                      <span className="visually-hidden">
                        {mobileConnectionSignal.label}
                      </span>
                    </span>
                    <span className="conversation-connection-mobile">
                      <span
                        className={`mobile-connection-icon mobile-connection-${mobileConnectionSignal.state}`}
                        aria-hidden="true"
                      >
                        <MobileConnectionIcon state={mobileConnectionSignal.state} />
                      </span>
                      {mobileConnectionSignal.label}
                    </span>
                  </>
                )}
              </span>
            </span>
          </div>
          <div className="header-actions">
            <button
              ref={detailsButtonRef}
              className={`header-button ${detailsOpen ? "pressed" : ""}`}
              aria-label="Conversation details"
              aria-controls="conversation-details-popover"
              aria-expanded={detailsOpen}
              onClick={() => setDetailsOpen((value) => !value)}
            >
              ⋯
            </button>
          </div>
        </header>

        <UiNoticeList
          notices={sessionNotices}
          className="session-notices-conversation"
          onDismiss={dismissUiNotice}
        />

        {detailsOpen && (
          <div
            ref={detailsPopoverRef}
            id="conversation-details-popover"
            className="details-popover"
            role="dialog"
            aria-label="Conversation details"
          >
            <span className="mini-label">Project</span>
            <strong>
              {activeWorkspace?.projectName || "Syncing…"}
            </strong>
            <code>{activeWorkspace?.cwd || "Syncing…"}</code>
            <span className="mini-label">Agent</span>
            <strong>{activeProvider}</strong>
            {activeWorkspace?.model && <code>{activeWorkspace.model}</code>}
            {selected?.extensions.length ? (
              <>
                <span className="mini-label">Session extensions</span>
                <div className="details-extension-list">
                  {selected.extensions.map((extension) => (
                    <span key={extension.id}>◇ {extension.name} · v{extension.version}</span>
                  ))}
                </div>
              </>
            ) : null}
            <span className="verified-line">
              <b>✓</b> This device is approved
            </span>
            {gatewaySelected && (
              <div className="session-menu-actions">
                <button
                  type="button"
                  className="session-menu-primary"
                  disabled={
                    selectedLifecycleBusy ||
                    !gatewayAvailable ||
                    !activeCapabilities?.canArchiveSession
                  }
                  onClick={() => void archiveSession(gatewaySelected.id)}
                >
                  <span aria-hidden="true">▣</span>
                  <span>
                    <strong>
                      {isStreaming ? "Archive & stop agent" : "Archive session"}
                    </strong>
                    <small>Remove from Malink; provider history remains</small>
                  </span>
                </button>
              </div>
            )}
          </div>
        )}


        <div
          className={`conversation-workspace ${toolFocus ? "is-tool-focused" : ""} ${toolFocusHistoryOpen ? "show-focus-history" : ""}`}
        >
          <div
            className="chat-feed"
            ref={feedRef}
            onScroll={handleFeedScroll}
          >
          <UiNoticeList
            notices={historyNotices}
            className="history-notices"
            onDismiss={dismissUiNotice}
          />
          <div
            className={`history-loader ${historyLoading ? "is-loading" : ""} ${historyError ? "has-error" : ""}`}
            aria-live="polite"
          >
            {historyLoading ? (
              <span>Loading earlier messages…</span>
            ) : historyError ? (
              <span className="history-inline-error">
                <span>{historyError}</span>
                <button
                  type="button"
                  onClick={() =>
                    historyRetryMode === "restore" &&
                    historySessionIdRef.current
                      ? void restoreSessionHistory(historySessionIdRef.current)
                      : void loadOlderHistory()
                  }
                >
                  Retry
                </button>
              </span>
            ) : historyHasMore ? (
              <button type="button" onClick={() => void loadOlderHistory()}>
                Load earlier messages
              </button>
            ) : messages.length > 0 ? (
              <span>Beginning of loaded history</span>
            ) : null}
          </div>
          <div className="date-divider">
            <span>Recent messages</span>
          </div>
          {historyLoading && messages.length === 0 && (
            <div className="history-skeleton" aria-hidden="true" />
          )}
          {timelineMessages.map((message, messageIndex) => {
            const isToolFocusContext =
              toolFocus?.contextMessage?.id === message.id;
            const isToolFocusSource =
              toolFocus?.toolMessage.id === message.id;
            const agentWork = isAgentWorkMessage(message);
            const previousIsAgentWork = isAgentWorkMessage(
              timelineMessages[messageIndex - 1],
            );
            const nextIsAgentWork = isAgentWorkMessage(
              timelineMessages[messageIndex + 1],
            );
            const agentTurnClass = agentWork
              ? `${previousIsAgentWork ? "agent-turn-continuation" : "agent-turn-start"} ${nextIsAgentWork ? "" : "agent-turn-end"}`
              : "";
            const isCompletedTurnResult =
              latestCompletedTurn?.result.id === message.id;
            const isTurnResult = inferredCompletedTurnResultIds.has(message.id);
            const turnPresentationClass = agentWork
              ? isTurnResult
                ? "turn-result"
                : "turn-process"
              : "";
            const turnLocationPhase = latestCompletedTurn?.promptInTranscript
              ? "ready"
              : turnHistoryLoad &&
                  turnHistoryLoad.commandId === latestCompletedTurn?.commandId
                ? turnHistoryLoad.phase
                : "loading";
            const resultContext =
              isCompletedTurnResult && latestCompletedTurn ? (
                <TurnResultContext
                  prompt={latestCompletedTurn.prompt}
                  connection={malinkClientRef.current}
                  expanded={expandedTurnId === latestCompletedTurn.commandId}
                  locationPhase={turnLocationPhase}
                  failed={latestCompletedTurn.completion.outcome === "failed"}
                  onTogglePrompt={() =>
                    setExpandedTurnId((current) =>
                      current === latestCompletedTurn.commandId
                        ? null
                        : latestCompletedTurn.commandId,
                    )
                  }
                  onLocatePrompt={jumpToTurnOrigin}
                />
              ) : null;
            if (message.kind === "notice") {
              return (
                <div
                  className={`encryption-notice ${
                    message.historical ? "" : "notice-enter"
                  }`}
                  key={message.id}
                >
                  <span className="shield">✓</span>
                  <span>{message.text}</span>
                </div>
              );
            }
            if (message.kind === "error") {
              return (
                <div
                  className={`message-row agent-row ${isTurnResult ? "turn-result" : ""} ${
                    message.historical ? "" : "message-enter"
                  }`}
                  key={message.id}
                  ref={(element) => bindMessageElement(message.id, element)}
                >
                  <div className="agent-mark error-mark">!</div>
                  <div className="bubble agent-bubble error-bubble">
                    <span className="agent-label">TASK NEEDS ATTENTION</span>
                    <p>{message.text}</p>
                    <time>{message.time}</time>
                    {resultContext}
                  </div>
                </div>
              );
            }
            if (message.kind === "user") {
              const deliveryState =
                message.deliveryState ??
                (message.revision !== undefined ? "sent" : undefined);
              return (
                <div
                  className={`message-row user-row turn-prompt ${isToolFocusContext ? "tool-focus-context-message" : ""} ${
                    message.historical ? "" : "message-enter"
                  }`}
                  key={message.id}
                  ref={(element) => bindMessageElement(message.id, element)}
                >
                  <div className="bubble user-bubble">
                    {message.originDeviceName &&
                      message.originDeviceId !== deviceKeyId && (
                        <span className="collaborator-label">
                          {message.originDeviceName}
                        </span>
                    )}
                    <p>{message.text}</p>
                    <AttachmentList
                      attachments={message.attachments}
                      connection={malinkClientRef.current}
                    />
                    <time
                      title={
                        message.revision !== undefined
                          ? `Gateway revision ${message.revision}`
                          : undefined
                      }
                    >
                      {message.time}{" "}
                      {deliveryState && (
                        <span
                          className={`delivery-indicator ${deliveryState}`}
                          aria-label={
                            deliveryState === "queued"
                              ? "Waiting for session creation"
                              : deliveryState === "sending"
                                ? "Sending"
                                : deliveryState === "failed"
                                  ? "Send failed"
                                  : "Sent"
                          }
                        >
                          {deliveryState === "queued"
                            ? "◷"
                            : deliveryState === "sending"
                              ? "…"
                              : deliveryState === "failed"
                                ? "!"
                                : "✓✓"}
                        </span>
                      )}
                    </time>
                    {deliveryState === "failed" && (
                      <button
                        type="button"
                        className="failed-message-retry"
                        onClick={() => restoreFailedMessage(message)}
                      >
                        Edit and retry
                      </button>
                    )}
                  </div>
                </div>
              );
            }
            if (message.kind === "tool") {
              if (!message.toolGroup) return null;
              return (
                <div
                  className={`message-row tool-group-row ${isToolFocusSource ? "tool-focus-source" : ""} ${agentTurnClass} ${turnPresentationClass} ${
                    message.historical ? "" : "message-enter"
                  }`}
                  key={message.id}
                >
                  <ToolActivityCard
                    group={message.toolGroup}
                    time={message.time}
                    fullText={fullToolTranscript(message.text)}
                    live={liveToolMessage?.id === message.id}
                  />
                </div>
              );
            }
            if (message.kind === "permission") {
              const resolvedActionId = resolvedDecisionActionId(message.raw);
              const decisionState = resolvedActionId
                ? { actionId: resolvedActionId }
                : decisionStates[message.id] ?? "pending";
              const extensionView = parseExtensionViewPresentation(message.raw);
              if (extensionView) {
                return (
                  <div
                    className={`message-row agent-row ${
                      message.historical ? "" : "message-enter"
                    }`}
                    key={message.id}
                  >
                    <div className="agent-mark">C</div>
                    <ExtensionViewCard
                      extensionName={extensionView.extension.name}
                      historical={message.historical}
                      onAction={(actionId) =>
                        void decidePermission(message, actionId)
                      }
                      state={decisionState}
                      time={message.time}
                      view={extensionView.view}
                      cancelActionId={extensionView.cancelActionId}
                    />
                  </div>
                );
              }
              const permissionDecisionState =
                typeof decisionState === "object"
                  ? decisionState.actionId === "deny"
                    ? "denied"
                    : "approved"
                  : decisionState;
              const permissionDetails =
                typeof message.raw?.details === "string"
                  ? message.raw.details
                  : undefined;
              const permissionActions = permissionActionOptions(message.raw);
              const privilegeRequest = message.raw?.decisionType === "privilege";
              return (
                <div
                  className={`message-row agent-row ${
                    message.historical ? "" : "message-enter"
                  }`}
                  key={message.id}
                >
                  <div className="agent-mark">C</div>
                  <div className="permission-card">
                    <div className="permission-title">
                      <span>!</span>
                      <div>
                        <strong>{message.text || "Permission required"}</strong>
                        <small>Your approval is required</small>
                      </div>
                    </div>
                    <p>
                      {privilegeRequest
                        ? "This exact command will run as root. Approval unlocks the TOTP key on this device with your fingerprint, face, or device credential."
                        : "Your choice is protected and sent only to your connected computer."}
                    </p>
                    {permissionDetails && (
                      <pre className="permission-details">{permissionDetails}</pre>
                    )}
                    {message.historical ? (
                      <div className="decision-state historical">
                        History only · request not replayed
                      </div>
                    ) : permissionDecisionState === "submitting" ? (
                      <div className="decision-state submitting">
                        {privilegeRequest
                          ? "Waiting for fingerprint or device unlock…"
                          : "Signing response…"}
                      </div>
                    ) : permissionDecisionState === "pending" ? (
                      <div className="permission-actions">
                        {permissionActions.map((action) => (
                          <button
                            className={action.deny ? "deny-button" : "approve-button"}
                            key={action.value}
                            onClick={() => void decidePermission(message, action.value)}
                            type="button"
                          >
                            {action.label}
                          </button>
                        ))}
                        {privilegeRequest && (
                          <button
                            className="totp-setup-button"
                            type="button"
                            onClick={() => {
                              setPrivilegeTotpError(null);
                              setPrivilegeTotpEnrollment({
                                message,
                                decision: "allow_once",
                              });
                            }}
                          >
                            Set up or replace TOTP
                          </button>
                        )}
                      </div>
                    ) : (
                      <div className={`decision-state ${permissionDecisionState}`}>
                        {permissionDecisionState === "approved"
                          ? `✓ ${resolvedPermissionLabel(message.raw, decisionState)}`
                          : "× Denied"}
                      </div>
                    )}
                    <time>{message.time}</time>
                  </div>
                </div>
              );
            }
            return (
              <div
                className={`message-row agent-row ${isToolFocusContext ? "tool-focus-context-message" : ""} ${agentTurnClass} ${turnPresentationClass} ${
                  message.historical ? "" : "message-enter"
                }`}
                key={message.id}
                ref={(element) => bindMessageElement(message.id, element)}
              >
                <div className="agent-mark">C</div>
                <div className="bubble agent-bubble">
                  <span className="agent-label">CODEX</span>
                  {message.format === "markdown" || !message.format ? (
                    <MarkdownContent content={message.text ?? ""} />
                  ) : (
                    <p className="message-copy">
                      {message.text}
                    </p>
                  )}
                  <AttachmentList
                    attachments={message.attachments}
                    connection={malinkClientRef.current}
                  />
                  <time>{message.time}</time>
                  {resultContext}
                </div>
              </div>
            );
          })}
            {agentActivity && (
            <div
              className={`agent-activity activity-${agentActivity.phase}`}
              key={`${agentActivity.phase}:${agentActivity.label}:${agentActivity.detail ?? ""}`}
              role="status"
              aria-label={`${agentActivity.label}${agentActivity.detail ? `. ${agentActivity.detail}` : ""}`}
              aria-live="polite"
              aria-atomic="true"
              title={`${agentActivity.label}${agentActivity.detail ? ` · ${agentActivity.detail}` : ""}`}
            >
              <span className="activity-dots" aria-hidden="true">
                <span />
                <span />
                <span />
              </span>
              <span className="activity-copy">
                <strong>{agentActivity.label}</strong>
                {agentActivity.detail && <small>{agentActivity.detail}</small>}
              </span>
            </div>
            )}
          </div>
          {toolFocus?.toolMessage.toolGroup && (
            <ToolFocusPanel
              group={toolFocus.toolMessage.toolGroup}
              historyOpen={toolFocusHistoryOpen}
              onToggleHistory={() =>
                setToolFocusHistoryKey((current) =>
                  current === toolFocusKey ? null : toolFocusKey,
                )
              }
            />
          )}
        </div>

        <div className="composer-area">
          {feedReturnAnchor?.sessionId === selectedSessionId ? (
            <button
              type="button"
              className="jump-to-latest return-to-result"
              aria-label="Return to the task result"
              title="Return to task result"
              onClick={returnToTurnResult}
            >
              <ArrowDownIcon />
              <span className="return-result-dot" aria-hidden="true" />
            </button>
          ) : feedAwayFromLatest ? (
            <button
              type="button"
              className="jump-to-latest"
              aria-label="Jump to latest messages"
              title="Latest messages"
              onClick={scrollFeedToLatest}
            >
              <ArrowDownIcon />
              {feedHasUnseenMessages && (
                <span className="latest-message-dot" aria-hidden="true" />
              )}
            </button>
          ) : null}
          <div className="context-strip">
            <div className="context-item">
              <span className="context-icon">▱</span>
              <span>
                <small>Project · Gateway</small>
                <b title={activeWorkspace?.cwd}>
                  {activeWorkspace?.projectName || "Syncing conversations…"}
                  {activeProjectGateway ? ` · ${activeProjectGateway.label}` : ""}
                </b>
              </span>
            </div>
            <div className="context-item branch-item">
              <span className="branch-mark">⑂</span>
              <code>{activeWorkspace?.provider || "Agent"}</code>
            </div>
            <span className="context-spacer" />
          </div>

          {revisionConflict && (
            <section className="revision-conflict-card" role="alert">
              <div>
                <strong>Another device updated this session</strong>
                <p>
                  {describeConflictedAction(revisionConflict.payload)} was not
                  replayed. Review the latest messages, then choose whether to
                  sign and send it against revision{" "}
                  {revisionConflict.expectedRevision}.
                </p>
              </div>
              <div className="revision-conflict-actions">
                <button
                  key="stop-agent"
                  type="button"
                  disabled={revisionConflict.busy}
                  onClick={() => void discardRevisionConflict()}
                >
                  Discard
                </button>
                <button
                  type="button"
                  disabled={revisionConflict.busy}
                  onClick={() => void confirmRevisionRetry()}
                >
                  {revisionConflict.busy ? "Checking…" : "Review complete · send"}
                </button>
              </div>
            </section>
          )}

          {nativeCommandReview && (
            <section className="revision-conflict-card" role="alert">
              <div>
                <strong>{nativeCommandReviewTitle(nativeCommandReview.operation)}</strong>
                <p>
                  {nativeCommandReviewDescription(nativeCommandReview.operation)}
                </p>
              </div>
              <div className="revision-conflict-actions">
                <button
                  type="button"
                  disabled={nativeCommandReview.busy}
                  onClick={() => void discardNativeCommandReview()}
                >
                  Discard
                </button>
                <button
                  type="button"
                  disabled={nativeCommandReview.busy}
                  onClick={() => void retryNativeCommandReview()}
                >
                  {nativeCommandReview.busy ? "Retrying…" : "Retry previous action"}
                </button>
              </div>
            </section>
          )}

          {optimisticSelected && optimisticSession && (
            <section
              className={`optimistic-session-card phase-${optimisticSession.phase}`}
              role={optimisticSession.phase === "creating" ? "status" : "alert"}
              aria-live="polite"
            >
              <span className="optimistic-session-mark" aria-hidden="true">
                {optimisticSession.phase === "creating" ? (
                  <i className="session-create-spinner" />
                ) : (
                  "!"
                )}
              </span>
              <div>
                <strong>
                  {optimisticSession.phase === "creating"
                    ? "Creating this conversation"
                    : optimisticSession.phase === "uncertain"
                      ? "Creation result not confirmed"
                      : "Conversation creation failed"}
                </strong>
                <p>
                  {optimisticSession.phase === "creating"
                    ? "You can start now. Messages are saved here and will be sent in order as soon as creation succeeds."
                    : optimisticSession.error ||
                      "Retry creation to keep this conversation and its queued messages."}
                </p>
              </div>
              {optimisticSession.phase === "failed" && (
                <div className="optimistic-session-actions">
                  <button
                    type="button"
                    onClick={retryFailedOptimisticSession}
                    disabled={newSessionBusy}
                  >
                    Retry creation
                  </button>
                  <button
                    type="button"
                    onClick={() => void discardFailedOptimisticSession()}
                    disabled={newSessionBusy}
                  >
                    Discard
                  </button>
                </div>
              )}
              {optimisticSession.phase === "uncertain" && (
                <div className="optimistic-session-actions">
                  <button
                    type="button"
                    onClick={recheckUncertainOptimisticSession}
                    disabled={connectionStatus !== "connected"}
                  >
                    Check result again
                  </button>
                  <button
                    type="button"
                    onClick={() => void stopWaitingForUncertainSession()}
                  >
                    Stop waiting
                  </button>
                </div>
              )}
            </section>
          )}

          <UiNoticeList
            notices={composerNotices}
            className="composer-notices"
            onDismiss={dismissUiNotice}
          />

          {pendingFiles.length > 0 && (
            <div className="pending-attachments" aria-label="Pending attachments">
              {pendingFiles.map((file, index) => (
                <span className="pending-attachment" key={`${file.name}:${file.size}:${index}`}>
                  <span aria-hidden="true">
                    {file.type.startsWith("image/") ? "▧" : "▤"}
                  </span>
                  <span>
                    <b>{file.name}</b>
                    <small>{formatFileSize(file.size)}</small>
                  </span>
                  <button
                    type="button"
                    aria-label={`Remove ${file.name}`}
                    disabled={attachmentBusy}
                    onClick={() =>
                      setPendingFiles((current) =>
                        current.filter((_, candidateIndex) => candidateIndex !== index),
                      )
                    }
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}

          <form
            className={`composer ${composerOptionsOpen ? "composer-options-open" : ""}`}
            onSubmit={(event) => void sendMessage(event)}
          >
            <textarea
              ref={composerTextareaRef}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={onComposerKeyDown}
              placeholder={
                gatewayAvailable
                  ? `Message ${activeProvider}…`
                  : trustedGateway
                    ? "Connect your computer to send messages"
                    : "Connect a computer to start"
              }
              aria-label={`Message ${activeProvider}`}
              rows={1}
              disabled={!composerState.canType}
            />
            <div className="composer-actions">
              <input
                ref={attachmentInputRef}
                className="attachment-input"
                type="file"
                multiple
                onChange={selectAttachments}
                tabIndex={-1}
              />
              <button
                type="button"
                className="attachment-button"
                aria-label="Attach a file"
                disabled={!composerState.canType || attachmentBusy}
                onClick={() => attachmentInputRef.current?.click()}
              >
                {attachmentBusy ? "…" : "+"}
              </button>
              <button
                type="button"
                className="composer-options-button"
                aria-label="Agent options"
                aria-expanded={composerOptionsOpen}
                aria-controls="composer-agent-options"
                onClick={() => setComposerOptionsOpen((open) => !open)}
              >
                <span aria-hidden="true">•••</span>
              </button>
              {(selected?.availableCommands.length ?? 0) > 0 && (
                <button
                  type="button"
                  className="composer-options-button provider-commands-button"
                  aria-label="Provider commands"
                  aria-expanded={providerCommandsOpen}
                  onClick={() => setProviderCommandsOpen(open => !open)}
                >
                  <span aria-hidden="true">⌘</span>
                </button>
              )}
              {providerCommandsOpen && selected && (
                <div className="provider-command-palette" role="menu" aria-label="Provider commands">
                  <header>
                    <strong>{selected.provider} commands</strong>
                    <small>Reported by the active ACP session</small>
                  </header>
                  {selected.availableCommands.map(command => (
                    <button
                      type="button"
                      role="menuitem"
                      key={command.name}
                      onClick={() => {
                        setDraft(`/${command.name}${command.inputHint ? " " : ""}`);
                        setProviderCommandsOpen(false);
                        window.requestAnimationFrame(() => composerTextareaRef.current?.focus());
                      }}
                    >
                      <code>{command.name}</code>
                      <span>
                        <strong>{command.description || command.name}</strong>
                        {command.inputHint && <small>{command.inputHint}</small>}
                      </span>
                    </button>
                  ))}
                </div>
              )}
              <div id="composer-agent-options" className="agent-controls">
                <label>
                  <span className="status-spark" />
                  <select
                    value={activeSessionSettingsUpdate?.field === "model"
                      ? activeSessionSettingsUpdate.value
                      : activeWorkspace?.model ?? ""}
                    onChange={(event) =>
                      void updateSessionSetting("model", event.target.value)
                    }
                    aria-label="Agent model"
                    disabled={
                      !sessionReady ||
                      settingsUpdateBusy ||
                      activeProviderModels.length === 0
                    }
                  >
                    {!activeWorkspace?.model && (
                      <option value="">Computer default</option>
                    )}
                    {activeProviderModels.map((model) => (
                      <option key={model.id} value={model.id}>
                        {model.name}
                      </option>
                    ))}
                  </select>
                </label>
                <span className="control-divider" />
                <label>
                  <select
                    value={
                      activeSessionSettingsUpdate?.field === "reasoningEffort"
                        ? activeSessionSettingsUpdate.value
                        : activeWorkspace?.reasoningEffort ??
                          activeModelCapability?.defaultReasoningLevel ??
                          ""
                    }
                    onChange={(event) =>
                      void updateSessionSetting(
                        "reasoningEffort",
                        event.target.value,
                      )
                    }
                    aria-label="Reasoning effort"
                    title="Reasoning effort"
                    disabled={
                      !sessionReady ||
                      settingsUpdateBusy ||
                      !activeModelCapability ||
                      activeModelCapability.supportedReasoningLevels.length === 0
                    }
                  >
                    {!activeModelCapability && (
                      <option value="">Reasoning</option>
                    )}
                    {(activeModelCapability?.supportedReasoningLevels ?? []).map(
                      (level) => (
                        <option key={level.effort} value={level.effort}>
                          {level.effort}
                          {level.effort ===
                          activeModelCapability?.defaultReasoningLevel
                            ? " (default)"
                            : ""}
                        </option>
                      ),
                    )}
                  </select>
                </label>
                {(activeCapabilities?.permissionModes.length ?? 0) >
                  1 && (
                  <>
                    <span className="control-divider" />
                    <label>
                      <select
                        value={activeSessionSettingsUpdate?.field === "permissionMode"
                          ? activeSessionSettingsUpdate.value
                          : activeWorkspace?.permissionMode ?? ""}
                        onChange={(event) =>
                          void updateSessionSetting(
                            "permissionMode",
                            event.target.value,
                          )
                        }
                        aria-label="Permission mode"
                        title="Permission mode"
                        disabled={
                          !sessionReady ||
                          settingsUpdateBusy ||
                          activeCapabilities!.permissionModes.length === 0
                        }
                      >
                        {!gatewayState && <option value="">Syncing…</option>}
                        {(activeCapabilities?.permissionModes ?? []).map(
                          (mode) => (
                            <option key={mode.id} value={mode.id}>
                              {mode.name}
                            </option>
                          ),
                        )}
                      </select>
                    </label>
                  </>
                )}
                {sessionSettingsUpdate && (
                  <span className="agent-setting-status" role="status">
                    <span className="button-spinner" aria-hidden="true" />
                    Updating {sessionSettingsFieldLabel(sessionSettingsUpdate.field).toLowerCase()}…
                  </span>
                )}
              </div>
              <div className="composer-submit-actions">
                {isStreaming && (
                  <button
                    type="button"
                    className="send-button stop-button mount-feedback"
                    onClick={() => {
                      if (selectedSessionId && selected?.activeTurnId) {
                        void stopStreaming(selectedSessionId, selected.activeTurnId);
                      }
                    }}
                    aria-label={
                      isStopping
                        ? "Stopping agent"
                        : selected?.activeTurnId
                          ? "Stop agent"
                          : "Stop unavailable while the active task syncs"
                    }
                    aria-busy={isStopping}
                    title={
                      selected?.activeTurnId
                        ? "Stop agent"
                        : "Syncing the active task before it can be stopped"
                    }
                    disabled={isStopping || !selected?.activeTurnId}
                  >
                    {isStopping ? <span className="button-spinner" /> : "■"}
                  </button>
                )}
                <button
                  key="send-message"
                  type="submit"
                  className="send-button mount-feedback"
                  disabled={!composerState.canSend}
                  aria-label={
                    composerState.mode === "queue"
                      ? "Queue message"
                      : "Send message"
                  }
                  aria-describedby="composer-status"
                  title={composerState.reason}
                >
                  ↑
                </button>
              </div>
            </div>
          </form>
          <p
            id="composer-status"
            className={`composer-hint composer-hint-${composerState.mode}`}
            role="status"
            aria-live="polite"
          >
            {composerState.reason}
          </p>
        </div>
      </section>

      {pwaUpdateState.phase === "updating" && (
        <div className="pwa-update-overlay" role="alert" aria-live="assertive">
          <span className="pwa-update-spinner" aria-hidden="true" />
          <strong>Updating Malink…</strong>
          <small>
            Loading build {pwaUpdateState.latestVersion}. This page will reopen
            automatically.
          </small>
        </div>
      )}

      {pwaUpdateState.phase === "waiting" && (
        <div className="pwa-update-toast" role="status" aria-live="polite">
          <span aria-hidden="true">↻</span>
          <span>
            <strong>Update ready</strong>
            <small>
              Finishing the queued session command before Malink reloads.
            </small>
          </span>
        </div>
      )}

      {pwaUpdateState.phase === "updated" && (
        <div className="pwa-update-toast" role="status" aria-live="polite">
          <span aria-hidden="true">✓</span>
          <span>
            <strong>Malink updated</strong>
            <small>Now running build {pwaUpdateState.currentVersion}</small>
          </span>
          <button
            type="button"
            aria-label="Dismiss update notice"
            onClick={() => pwaUpdateRef.current?.dismissUpdatedNotice()}
          >
            ×
          </button>
        </div>
      )}

      {(pairingError ?? connectionError) && !settingsOpen && (
        <button
          className="connection-toast"
          role="alert"
          onClick={() => setSettingsOpen(true)}
        >
          <span>!</span>
          <span>
            <strong>Connection needs attention</strong>
            <small>{pairingError ?? connectionError}</small>
          </span>
          <b>Open settings</b>
        </button>
      )}

      {gatewayState && (
        <NewProjectDialog
          open={newProjectOpen}
          busy={newProjectBusy}
          gateways={projectCreationGateways}
          onClose={() => {
            if (!newProjectBusy) setNewProjectOpen(false);
          }}
          onCreate={(input) => void createProject(input)}
        />
      )}

      {gatewayState && (
        <NewSessionDialog
          open={newSessionOpen}
          busy={newSessionBusy}
          fallbackGateway={fallbackProjectGateway}
          projectGateways={projectGatewaysById}
          workspace={activeWorkspace ?? gatewayState.workspace}
          workspaces={gatewayState.projects ?? [gatewayState.workspace]}
          models={gatewayState.capabilities.models}
          providers={gatewayState.capabilities.providers}
          extensions={gatewayState.capabilities.sessionExtensions}
          defaultExtensions={gatewayState.workspace.defaultExtensions}
          canUpdateProjectDefaults
          onClose={() => {
            if (!newSessionBusy) setNewSessionOpen(false);
          }}
          onCreate={(input) => void createSession(input)}
        />
      )}

      {gatewayState && (
        <ProviderHistoryDialog
          open={providerHistoryOpen}
          sourceKey={providerHistorySource?.key ?? ""}
          sources={providerHistorySources}
          provider={providerHistoryProvider || providerHistoryWorkspace?.provider || ""}
          providers={(providerHistoryCapabilities?.providers ?? []).filter(provider =>
            provider.canListSessions && provider.canInspectSessions
          )}
          sessions={providerHistorySessions}
          selected={providerHistorySelected}
          messages={providerHistoryMessages}
          loading={providerHistoryLoad?.kind ?? null}
          error={providerHistoryError}
          onClose={() => setProviderHistoryOpen(false)}
          onSourceChange={(sourceKey) => void openProviderHistory({ sourceKey })}
          onProviderChange={(provider) => void openProviderHistory({ provider })}
          onInspect={(session) => void inspectProviderHistorySession(session)}
          onRetry={() => {
            if (providerHistorySelected) {
              void inspectProviderHistorySession(providerHistorySelected);
            } else {
              void openProviderHistory({ provider: providerHistoryProvider });
            }
          }}
          onOpenManaged={openManagedProviderHistorySession}
          onContinue={continueProviderHistorySession}
        />
      )}

      <MatrixSettings
        open={settingsOpen}
        config={matrixConfig}
        status={displayedConnectionStatus}
        connectionDetail={connectionDetail}
        repairReason={connectionRepairReason}
        error={pairingError ?? connectionError}
        pairingPreview={pairingPreview}
        trustedGateway={trustedGateway}
        savedGateways={savedGateways}
        gatewayDirectory={gatewayState?.gatewayDirectory ?? null}
        pairingBusy={pairingBusy}
        deviceInvitation={deviceInvitation}
        invitationBusy={invitationBusy}
        invitationError={invitationError}
        invitationReauthRequired={invitationReauthRequired}
        gatewayEnrollmentInvitation={gatewayEnrollmentInvitation}
        pendingGatewayEnrollments={pendingGatewayEnrollments}
        approvedGatewayEnrollmentIds={visibleApprovedGatewayEnrollmentIds}
        gatewayEnrollmentBusy={gatewayEnrollmentBusy}
        gatewayEnrollmentError={gatewayEnrollmentError}
        gatewayProfileBusy={gatewayProfileBusy}
        gatewayProfileError={gatewayProfileError}
        gatewayUpdate={gatewayState?.gatewayUpdate ?? null}
        gatewayRelease={gatewayRelease}
        gatewayUpdateBusy={gatewayUpdateBusy}
        gatewayUpdateError={gatewayUpdateError ?? gatewayUpdateDiscoveryError}
        updateState={pwaUpdateState}
        nativeUpdateState={nativeUpdateState}
        nativeUpdateBusy={nativeUpdateBusy}
        nativeRuntime={nativeRuntime}
        webPushState={webPushState}
        webPushBusy={webPushBusy}
        copyPageLinkBusy={pageLinkCopyBusy}
        onChange={setMatrixConfig}
        onPairingLink={(link) => void openPairingLink(link)}
        onClearPairing={() => {
          pairingAbortRef.current?.abort();
          setPairingPreview(null);
          setPairingError(null);
          setConnectionError(null);
        }}
        onConfirmPairing={() => void confirmPairing()}
        onClose={() => setSettingsOpen(false)}
        onDisconnect={() => disconnectClient()}
        onForget={() => setForgetDialogOpen(true)}
        onPasswordLogin={(userId, password) =>
          void signInForPairing(userId, password)
        }
        onCreateInvitation={(password) =>
          void createDeviceInvitation(password)
        }
        onClearInvitation={() => {
          deviceInvitationLifecycleRef.current.clear();
          matrixLoginTokenLifecycleRef.current.clear();
          const pendingGatewayInvitation = pendingGatewayInvitationRef.current;
          if (pendingGatewayInvitation) {
            void malinkClientRef.current?.releaseCommand(
              pendingGatewayInvitation.commandId,
            );
          }
          pendingGatewayInvitationRef.current = null;
          if (invitationExpiryTimeoutRef.current !== null) {
            window.clearTimeout(invitationExpiryTimeoutRef.current);
            invitationExpiryTimeoutRef.current = null;
          }
          setDeviceInvitation(null);
          setInvitationReauthRequired(false);
          setInvitationError(null);
        }}
        onCreateGatewayEnrollment={() => void createGatewayEnrollment()}
        onApproveGatewayEnrollment={(enrollmentId, approverProjectId) =>
          void approveGatewayEnrollment(enrollmentId, approverProjectId)
        }
        onClearGatewayEnrollment={() => {
          setGatewayEnrollmentInvitation(null);
          setGatewayEnrollmentError(null);
        }}
        onRenameGateway={renameGateway}
        onRefreshGatewayUpdate={() => void runGatewayUpdate({
          operation: "gateway.update.status",
        })}
        onStartGatewayUpdate={() => void runPublishedGatewayUpdate()}
        onCheckForUpdates={() => void pwaUpdateRef.current?.checkNow()}
        onUpdateNativeApp={() => void recoverNativeAppUpdate(true)}
        onRestartApp={() => window.location.reload()}
        onCopyPageLink={() => void copyPageLinkForAnotherBrowser()}
        onRefreshNativeUpdate={() => void recoverNativeAppUpdate(false)}
        onInstallNativeUpdate={() => void recoverNativeAppUpdate(true)}
        onExportDiagnostics={exportConnectionDiagnostics}
        onEnableWebPush={() => void enableAgentNotifications()}
        onDisableWebPush={() => void disableAgentNotifications()}
      />

      <GatewayForgetDialog
        open={forgetDialogOpen}
        gatewayName={trustedGateway ? workspaceGatewayTitle : null}
        busy={false}
        onClose={() => setForgetDialogOpen(false)}
        onConfirm={() => {
          if (matrixConfig.gatewayId) {
            forgetPrivilegeTotp(matrixConfig.gatewayId);
          }
          setForgetDialogOpen(false);
          forgetMatrixConfig();
        }}
      />

      <PrivilegeTotpDialog
        key={privilegeTotpEnrollment?.message.id ?? "privilege-totp-closed"}
        open={privilegeTotpEnrollment !== null}
        busy={privilegeTotpBusy}
        error={privilegeTotpError}
        gatewayName={trustedGateway ? activeProjectGateway.label : "this computer"}
        onClose={() => {
          if (privilegeTotpBusy) return;
          setPrivilegeTotpEnrollment(null);
          setPrivilegeTotpError(null);
        }}
        onSubmit={(setupKey) =>
          void completePrivilegeTotpEnrollment(setupKey)
        }
      />
    </main>
  );
}

function commandNoticeFor(payload: CommandPayload): {
  key: string;
  scope: "session" | "composer" | "pairing";
} {
  if (
    payload.operation === "device.invite" ||
    payload.operation.startsWith("gateway.enrollment.") ||
    payload.operation.startsWith("gateway.profile.") ||
    payload.operation.startsWith("gateway.update.")
  ) {
    return { key: `pairing:${payload.operation}`, scope: "pairing" };
  }
  if (payload.operation === "prompt") {
    return { key: "composer:send", scope: "composer" };
  }
  if (payload.operation.startsWith("project.")) {
    return {
      key: `project:${payload.operation.slice("project.".length)}`,
      scope: "session",
    };
  }
  if (payload.operation.startsWith("session.")) {
    return {
      key: `session:${payload.operation.slice("session.".length)}`,
      scope: "session",
    };
  }
  return { key: `composer:${payload.operation}`, scope: "composer" };
}

function agentLifecycleFailureText(
  raw: Record<string, unknown>,
): string | null {
  if (raw.kind === "status" && raw.state === "failed") {
    return typeof raw.error === "string" && raw.error.trim()
      ? raw.error
      : "The agent session failed.";
  }
  return null;
}

function chatMessageFromIncoming(
  incoming: IncomingMalinkMessage,
  sessionId?: string,
): ChatMessage {
  return {
    id: incoming.eventId,
    eventId: incoming.eventId,
    kind: incoming.kind === "error" ? "error" : incoming.kind,
    text: incoming.text,
    time: formatMessageTime(incoming.timestamp),
    timestamp: incoming.timestamp,
    operationId: incoming.operationId,
    requestId: incoming.requestId,
    replacesEventId: incoming.replacesEventId,
    commandId: incoming.commandId,
    revision: incoming.revision,
    originDeviceId: incoming.originDeviceId,
    originDeviceName: incoming.originDeviceName,
    format: incoming.format,
    toolGroup: incoming.toolGroup,
    attachments: incoming.attachments,
    sessionId,
    historical: incoming.historical,
    raw: incoming.raw,
  };
}

function incomingMessageFromClient(
  message: MalinkMessage,
): IncomingMalinkMessage {
  return {
    eventId: message.eventId,
    sender: message.sender,
    timestamp: message.timestamp,
    encrypted: message.encrypted,
    kind: message.kind,
    text: message.text ?? "",
    sessionId: message.sessionId,
    historical: message.historical,
    operationId: message.operationId,
    requestId: message.requestId,
    replacesEventId: message.replacesEventId,
    commandId: message.commandId,
    revision: message.revision,
    originDeviceId: message.originDeviceId,
    originDeviceName: message.originDeviceName,
    activeDeviceCount: message.activeDeviceCount,
    format: message.format,
    attachments: message.attachments,
    toolGroup: message.toolGroup,
    raw: message.semantic ?? {},
  };
}

function optimisticSessionSummary(
  record: OptimisticSessionRecord,
  gatewayState: GatewayStateSnapshot | null,
): GatewaySessionSummary {
  const workspace = gatewayState?.projects?.find(
    (project) => project.projectId === record.input.projectId,
  ) ?? gatewayState?.workspace;
  return {
    id: record.localSessionId,
    title: record.input.title?.trim() || "New session",
    updatedAt: record.updatedAt,
    status: record.phase === "creating" ? "idle" : "failed",
    activityPhase: record.phase === "creating" ? "starting" : "failed",
    scope: record.input.scope ?? "project",
    projectId:
      record.input.projectId ?? workspace?.projectId ?? "pending-project",
    projectName: record.input.projectName,
    cwd: record.input.cwd,
    provider: record.input.provider || workspace?.provider || "Agent",
    ...(record.input.model ? { model: record.input.model } : {}),
    ...(record.input.reasoningEffort
      ? { reasoningEffort: record.input.reasoningEffort }
      : {}),
    extensions: (record.input.extensions ?? []).map((extension) => ({
      id: extension.id,
      name: extension.id,
      version: "pending",
    })),
    availableCommands: [],
  };
}

function permissionActionOptions(
  raw: Record<string, unknown> | undefined,
): Array<{ label: string; value: string; deny: boolean }> {
  const options = Array.isArray(raw?.options) ? raw.options : [];
  const parsed = options.flatMap((candidate) => {
    if (
      candidate === null ||
      typeof candidate !== "object" ||
      Array.isArray(candidate)
    ) return [];
    const option = candidate as Record<string, unknown>;
    if (
      typeof option.value !== "string" ||
      !option.value ||
      typeof option.label !== "string" ||
      !option.label.trim()
    ) return [];
    return [{
      label: option.label,
      value: option.value,
      deny: option.value === "deny" || option.value.startsWith("reject"),
    }];
  });
  return parsed.length > 0
    ? parsed
    : [
        { label: "Allow once", value: "allow", deny: false },
        { label: "Deny", value: "deny", deny: true },
      ];
}

function resolvedPermissionLabel(
  raw: Record<string, unknown> | undefined,
  state: ExtensionViewDecisionState,
): string {
  if (typeof state !== "object") return "Approved";
  return permissionActionOptions(raw)
    .find((option) => option.value === state.actionId)?.label ?? "Approved";
}

async function persistMessageHistoryPage(
  scope: string,
  sessionId: string,
  messages: readonly ChatMessage[],
): Promise<void> {
  const canonicalUsers = messages.filter(
    (message) => message.kind === "user" && message.eventId,
  );
  const remaining = messages.filter(
    (message) => message.kind !== "user" || !message.eventId,
  );
  await saveMessageHistory(scope, sessionId, remaining);
  for (const message of canonicalUsers) {
    await reconcileMessageHistory(scope, sessionId, message);
  }
}

function olderHistoryCursor(
  current: MessageHistoryCursor | null,
  messages: readonly ChatMessage[],
): MessageHistoryCursor | null {
  const oldest = [...messages]
    .filter((message) => message.timestamp !== undefined)
    .sort(compareChatMessages)[0];
  if (!oldest || oldest.timestamp === undefined) return current;
  const candidate = { timestamp: oldest.timestamp, id: oldest.id };
  if (
    !current ||
    candidate.timestamp < current.timestamp ||
    (candidate.timestamp === current.timestamp && candidate.id < current.id)
  ) {
    return candidate;
  }
  return current;
}

function prepareHistoryPrepend(
  feed: HTMLDivElement | null,
  target: {
    current: { scrollHeight: number; scrollTop: number } | null;
  },
): void {
  if (!feed) return;
  target.current = {
    scrollHeight: feed.scrollHeight,
    scrollTop: feed.scrollTop,
  };
}

function isNearFeedBottom(feed: HTMLDivElement): boolean {
  return feed.scrollHeight - feed.scrollTop - feed.clientHeight <= 96;
}

function formatMessageTime(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp));
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = units[0];
  for (let index = 1; index < units.length && value >= 1024; index += 1) {
    value /= 1024;
    unit = units[index];
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${unit}`;
}

function formatSessionTime(timestamp: number): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "";
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return formatMessageTime(timestamp);
  }
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
  }).format(date);
}

function sessionInitials(title: string): string {
  const initials = title
    .trim()
    .split(/\s+/u)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
  return initials || "CV";
}

function describeConflictedAction(payload: CommandPayload): string {
  switch (payload.operation) {
    case "prompt":
      return `Your prompt “${payload.text.slice(0, 80)}${
        payload.text.length > 80 ? "…" : ""
      }”`;
    case "cancel":
      return "The cancel action";
    case "decision":
      return `The ${payload.decision.replaceAll("_", " ")} permission decision`;
    case "session.settings":
      return "The session settings change";
    case "session.create":
      return "The new session request";
    case "project.create":
      return "The new project request";
    case "project.settings":
      return "The project settings request";
    case "provider.sessions.list":
      return "The provider history request";
    case "provider.session.inspect":
      return "The provider session request";
    case "session.archive":
      return "The archive request";
    case "session.restore":
      return "The restore request";
    case "session.delete":
      return "The delete request";
    case "device.invite":
      return "The device invitation request";
    case "gateway.enrollment.invite":
      return "The Gateway setup-link request";
    case "gateway.enrollment.approve":
      return "The Gateway approval request";
    case "gateway.profile.update":
      return "The Gateway name update";
    case "gateway.update.stage":
      return "The Gateway update preparation request";
    case "gateway.update.apply":
      return "The Gateway update activation request";
    case "gateway.update.status":
      return "The Gateway update status request";
  }
}

function nativeCommandReviewTitle(
  operation: CommandPayload["operation"] | undefined,
): string {
  switch (operation) {
    case "session.delete":
      return "Session deletion needs review";
    case "session.archive":
      return "Session archive needs review";
    case "session.restore":
      return "Session restore needs review";
    case "session.create":
      return "Session creation needs review";
    case "prompt":
      return "A previous prompt needs review";
    case "decision":
      return "A permission decision needs review";
    case "session.settings":
      return "A settings change needs review";
    case "cancel":
      return "A cancel action needs review";
    case "device.invite":
      return "A device invitation needs review";
    case "gateway.enrollment.invite":
      return "A Gateway setup link needs review";
    case "gateway.enrollment.approve":
      return "A Gateway approval needs review";
    case "gateway.profile.update":
      return "A Gateway name change needs review";
    default:
      return "A previous action needs review";
  }
}

function nativeCommandReviewDescription(
  operation: CommandPayload["operation"] | undefined,
): string {
  const action = (() => {
    switch (operation) {
      case "session.delete":
        return "session deletion";
      case "session.archive":
        return "session archive";
      case "session.restore":
        return "session restore";
      case "session.create":
        return "session creation";
      case "prompt":
        return "prompt";
      case "decision":
        return "permission decision";
      case "session.settings":
        return "settings change";
      case "cancel":
        return "cancel action";
      case "device.invite":
        return "device invitation";
      case "gateway.enrollment.invite":
        return "Gateway setup link";
      case "gateway.enrollment.approve":
        return "Gateway approval";
      case "gateway.profile.update":
        return "Gateway name change";
      default:
        return "action";
    }
  })();
  return `Another device changed the Gateway before this ${action} was accepted. Review the latest state, then retry it or discard it before starting new work.`;
}

function lifecyclePastTense(action: "archive"): string {
  return action === "archive" ? "archived" : action;
}

function sessionLifecyclePayload(
  action: "archive",
  sessionId: string,
): Extract<CommandPayload, { operation: "session.archive" }> {
  return { operation: "session.archive", sessionId };
}

function formatUiError(error: unknown): string {
  return formatUserFacingError(error);
}

function fullToolTranscript(text: string | undefined): string | undefined {
  return text?.startsWith("Tool transcript\n\n") ? text : undefined;
}

function deviceInvitationFromLink(link: string): boolean {
  if (link.includes("#invite=")) return true;
  try {
    decodeDeviceInvitationLink(link);
    return true;
  } catch {
    return false;
  }
}

function parseGatewayInvitationResult(input: unknown): {
  pairingLink: string;
  expiresAt: number;
} {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Your computer returned an invalid device invitation.");
  }
  const result = input as Record<string, unknown>;
  if (
    typeof result.pairingLink !== "string" ||
    !result.pairingLink ||
    typeof result.expiresAt !== "number" ||
    !Number.isSafeInteger(result.expiresAt) ||
    result.expiresAt <= Date.now()
  ) {
    throw new Error("Your computer returned an invalid device invitation.");
  }
  return {
    pairingLink: result.pairingLink,
    expiresAt: result.expiresAt,
  };
}

function parseGatewayEnrollmentInvitationResult(input: unknown): {
  enrollmentLink: string;
  expiresAt: number;
} {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("The connected Gateway returned an invalid setup link.");
  }
  const result = input as Record<string, unknown>;
  if (
    typeof result.enrollmentLink !== "string" ||
    !result.enrollmentLink.startsWith("malink://gateway-enroll#data=") ||
    typeof result.expiresAt !== "number" ||
    !Number.isSafeInteger(result.expiresAt) ||
    result.expiresAt <= Date.now()
  ) {
    throw new Error("The connected Gateway returned an invalid setup link.");
  }
  return {
    enrollmentLink: result.enrollmentLink,
    expiresAt: result.expiresAt,
  };
}

function browserDeviceName(): string {
  const userAgentData = (
    navigator as Navigator & { userAgentData?: { platform?: string } }
  ).userAgentData;
  const platform =
    userAgentData?.platform ||
    navigator.platform ||
    "Web device";
  const mobile = /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);
  return `Malink ${mobile ? "mobile" : "desktop"} · ${platform}`;
}
