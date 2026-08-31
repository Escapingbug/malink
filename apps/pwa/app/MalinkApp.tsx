"use client";

import {
  ChangeEvent,
  FormEvent,
  KeyboardEvent,
  useCallback,
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
  artifactReferenceSchema,
  encodePairingLink,
  providerHistoryMessageSchema,
  providerSessionEntrySchema,
  gatewayUpdateStatusSchema,
  type MalinkAttachment,
  type MalinkArtifactReference,
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
import {
  MatrixSettings,
  nativeUpdateStatusText,
  OFFICIAL_ANDROID_RELEASES_URL,
} from "./MatrixSettings";
import { ConnectionOnboarding } from "./ConnectionOnboarding";
import { MalinkMark } from "./MalinkMark";
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
import {
  ProjectSettingsDialog,
  type ProjectSettingsInput,
} from "./ProjectSettingsDialog";
import { ProviderHistoryDialog } from "./ProviderHistoryDialog";
import { findRecentlyArchivedProviderSession } from "./providerHistorySessions";
import {
  buildProviderHistorySources,
  findProviderHistorySource,
  findProviderHistorySourceByKey,
  firstMatchingProviderHistorySource,
  providerHistoryCommandKey,
  providerHistoryRequestKey,
  type ProviderHistoryRouteIdentity,
  type ProviderHistorySource,
} from "./providerHistoryRouting";
import { GatewayForgetDialog } from "./GatewayForgetDialog";
import {
  GatewayUpdateDialog,
  type GatewayUpdateNodeRuntime,
} from "./GatewayUpdateDialog";
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
import { ToolFocusPanel } from "./ToolFocusPanel";
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
import { uncertainCommandRecoveryPresentation } from "./uncertainCommandRecoveryPresentation";
import {
  collidingGatewayMaintenanceSessionIds,
  gatewayMaintenanceSessionCanBeArchived,
  gatewayMaintenanceSessionShouldAutoArchive,
  gatewayUpdatePlan as buildGatewayUpdatePlan,
  gatewayUpdatePlanNodeWithLiveStatus,
  gatewayUpdateStatusNeedsPolling,
  gatewayUpdateTarget,
  legacyGatewayMaintenanceSessionsByNode,
  recoverAmbiguousGatewayUpdateCompletion,
  triggerGatewayUpdate,
  GatewayUpdateCommandFailure,
  type GatewayUpdatePlanNode,
} from "./gatewayUpdateTrigger";
import {
  clearGatewayUpdateIntent,
  readGatewayUpdateIntent,
  writeGatewayUpdateIntent,
} from "./gatewayUpdateIntent";
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
  PWA_STATE_CATALOG,
  PwaStateUpgradeBlockedError,
  resetBlockedPwaConnection,
  runPwaStateUpgrade,
  type PwaStateUpgradeProgress,
} from "./stateUpgrade";
import {
  PwaIndexedDbUpgradeBlockedError,
  pwaIndexedDbCatalog,
  resetBlockedPwaIndexedDb,
  runPwaIndexedDbUpgrade,
  type PwaIndexedDbUpgradeProgress,
} from "./indexedDbUpgrade";
import {
  clearPendingSessionCreateRecovery,
  completedSessionCreateTarget,
  isMissingSessionCreateRecoveryCommand,
  isSessionCreateRecoveryUncertain,
  pendingSessionCreateRecoveryFromOptimistic,
  readPendingSessionCreateRecovery,
  rebindPendingSessionCreateRecovery,
  sessionCreateCompletionMatchesRecovery,
  sessionCreateFailureMessage,
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
  bindOptimisticProjectCreate,
  clearOptimisticProjectCreate,
  completedProjectId,
  createOptimisticProjectCreate,
  failOptimisticProjectCreate,
  markOptimisticProjectCreateUncertain,
  optimisticProjectMatchesProjection,
  projectCreateRecoveryMatches,
  projectCreateFailureMessage,
  readOptimisticProjectCreate,
  rebindOptimisticProjectCreate,
  retryOptimisticProjectCreate,
  syncOptimisticProjectCreate,
  writeOptimisticProjectCreate,
  type OptimisticProjectCreateRecord,
} from "./projectCreateRecovery";
import {
  pendingSessionLifecycleIds,
  sessionLifecycleRouteKey,
  sessionsAvailableForAutomaticSelection,
} from "./pendingSessionDeletion";
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
  createArtifactMaterializeCommandPayload,
  createCancelCommandPayload,
  createPromptCommandPayload,
} from "./commandPayloads";
import {
  agentReceivedCommandIds,
  isHistoricalMessageDelivery,
  isLiveMessageDelivery,
  messageDeliveryPresentation,
  resolvedMessageDeliveryMode,
  userMessageDeliveryState,
} from "./messageDelivery";
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
import {
  durableCommandRecoveryNeedsAttention,
  durableCommandRecoveryPresentation,
  type DurableCommandRecoveryCheckResult,
} from "./durableCommandRecoveryPresentation";
import {
  readBackgroundCommandRecoveries,
  readDismissedCommandRecoveries,
  writeBackgroundCommandRecoveries,
  writeDismissedCommandRecoveries,
} from "./dismissedCommandRecovery";
import { connectionFailureCode } from "./connectionFailure";
import {
  automaticConnectionRetryDelay,
  connectionRecoveryDisposition,
} from "./connectionRecovery";
import { deriveGatewayLiveness } from "./gatewayLiveness";
import {
  gatewayNodeLivenessAfterProbeTimeout,
  gatewayNodeLivenessPresentation,
  gatewayNodeLivenessSummary,
  gatewayNodeLivenessTargets,
  shouldAutomaticallyCheckGatewayNode,
  type GatewayNodeLiveness,
  type GatewayNodeLivenessTarget,
} from "./gatewayNodeLiveness";
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
  sessionStatusTone,
  summarizeProjectSessions,
  type SessionListSignal,
} from "./sessionListOrder";
import {
  canonicalGatewayProjects,
  gatewayProjectOwner,
  gatewayProjectOwners,
} from "./projectCatalog";
import {
  ALL_GATEWAYS_FILTER,
  normalizeGatewayFilter,
  projectMatchesGatewayFilter,
  readGatewayFilter,
  writeGatewayFilter,
} from "./gatewayFilter";
import {
  allUiNotices,
  EMPTY_UI_NOTICE_STATE,
  globalUiNotices,
  noticesForScope,
  reduceUiNotices,
  type UiNotice,
  type UiNoticeScope,
  type UiNoticeSeverity,
} from "./uiNotices";
import {
  NotificationCenter,
  type NotificationCenterItem,
} from "./NotificationCenter";
import { writeClipboardTextWithTimeout } from "./uiClipboard";
import {
  NATIVE_BACK_PRIORITY,
  resolveMalinkBackAction,
  useNativeBackHandler,
} from "./nativeBackNavigation";
import type {
  MalinkClient,
  MalinkCommandReview,
  MalinkCommandSendResult,
  MalinkRecoveredDurableCommand,
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
  nativeMatrixSessionConfig,
  resumeNativeMatrixSessionIfAvailable,
} from "./client/createMalinkClient";
import { injectedNativeBridgePort } from "./client/native/NativeRpcBridge";
import { publicTrustFromWeb } from "./client/web/WebMalinkClient";
import {
  NATIVE_UPDATE_POLL_INTERVAL_MS,
  nativeUpdateOperationInProgress,
  shouldPollNativeUpdateStatus,
} from "./nativeUpdatePolling";
import {
  clearMessageHistoryScope,
  clearSessionMessageHistory,
  deleteMessageHistory,
  loadMessageHistoryPage,
  loadQueuedSessionMessages,
  matrixHistoryScope,
  moveSessionMessageHistory,
  reconcileMessageHistory,
  saveMessageHistory,
  type MessageHistoryCursor,
} from "./messageHistory";
import {
  shouldAutoLoadEarlierMessages,
  waitForHistoryOperation,
} from "./historyPagination";
import {
  completedTurnPresentation,
  type CompletedTurnProcess,
  type ObservedCommandCompletion,
} from "./turnPresentation";
import {
  activeTurnToolFocus,
  turnTimelineMessages,
} from "./turnTimeline";
import {
  readSelectedSessionRoute,
  writeSelectedSessionRoute,
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
  nativeMatrixRoomBindingFromPairingPreview,
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

type ProviderHistoryLoadState = ProviderHistoryRouteIdentity & {
  id: number;
  provider: string;
  kind: "sessions" | "session";
  providerSessionId?: string;
  cursor?: string;
};

type ProviderHistoryPendingCommand = ProviderHistoryRouteIdentity & {
  commandId: string;
  provider: string;
  kind: "sessions" | "session";
  providerSessionId?: string;
  cursor?: string;
};

type ProviderHistoryFocus = ProviderHistoryRouteIdentity & {
  provider: string;
  archivedSessionId: string;
};

type OpenProviderHistoryRequest = {
  sourceKey?: string;
  provider?: string;
};

type TimelinePresentationItem =
  | { kind: "message"; message: ChatMessage }
  | { kind: "process"; process: CompletedTurnProcess };

type PendingSessionLifecycleRecovery = {
  commandId: string;
  action: "archive";
  sessionId: string;
  projectId: string;
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
  selectedProjectId: string | null;
  historyScope: string;
};

function loadInitialGatewayUiState(): InitialGatewayUiState {
  if (typeof window === "undefined") {
    return {
      config: emptyMatrixConfig,
      gatewayState: null,
      selectedSessionId: null,
      selectedProjectId: null,
      historyScope: "",
    };
  }
  const config = loadMatrixConfig() ?? emptyMatrixConfig;
  const gatewayState = readGatewayUiCache(window.localStorage, config);
  if (!gatewayState) {
    return {
      config,
      gatewayState: null,
      selectedSessionId: null,
      selectedProjectId: null,
      historyScope: "",
    };
  }
  const historyScope = matrixHistoryScope({
    gatewayId: config.gatewayId,
    conversationId: config.conversationId,
    roomId: config.roomId,
  });
  const remembered = readSelectedSessionRoute(window.localStorage, historyScope);
  const selectedSession = remembered
    ? gatewayState.sessions.find(session =>
        session.id === remembered.sessionId &&
        (!remembered.projectId || session.projectId === remembered.projectId),
      )
    : undefined;
  const fallbackSession = selectedSession ??
    (gatewayState.currentSessionId
      ? gatewayState.sessions.find(session =>
          session.id === gatewayState.currentSessionId &&
          session.projectId === gatewayState.workspace.projectId,
        ) ?? gatewayState.sessions.find(session => session.id === gatewayState.currentSessionId)
      : undefined) ??
    gatewayState.sessions.find(session => session.status !== "archived") ??
    gatewayState.sessions[0];
  return {
    config,
    gatewayState,
    selectedSessionId: fallbackSession?.id ?? null,
    selectedProjectId: fallbackSession?.projectId ?? null,
    historyScope,
  };
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
const RECOVERED_COMMAND_CHECK_TIMEOUT_MS = 15_000;
const RECOVERED_COMMAND_RETRY_DELAY_MS = 60_000;
const RECOVERED_COMMAND_FAILURE_RETRY_DELAY_MS = 15_000;
const LOCAL_HISTORY_FOREGROUND_TIMEOUT_MS = 5_000;
const BACKGROUND_HISTORY_SOURCE_TIMEOUT_MS = 65_000;
const PROJECT_CREATE_RESULT_TIMEOUT_MS = 60_000;
const PROVIDER_HISTORY_RESULT_TIMEOUT_MS = 60_000;
const GATEWAY_UPDATE_DISCOVERY_INTERVAL_MS = 15 * 60_000;
const GATEWAY_LIVE_STATUS_TIMEOUT_MS = 12_000;
const GATEWAY_UPDATE_PROGRESS_POLL_MS = 10_000;

type GatewayUpdateProbeRecord = {
  commandId: string;
  completion: Promise<CommandCompletion>;
  completed: boolean;
  status: GatewayUpdateStatus | null;
  consume(completion: CommandCompletion): GatewayUpdateStatus | null;
};

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

function ChatsIcon() {
  return (
    <svg aria-hidden="true" className="rail-icon" viewBox="0 0 24 24">
      <path d="M5.25 5.25h13.5c.83 0 1.5.67 1.5 1.5v8.5c0 .83-.67 1.5-1.5 1.5h-7.5l-4.7 3v-3h-1.3c-.83 0-1.5-.67-1.5-1.5v-8.5c0-.83.67-1.5 1.5-1.5Z" />
      <path d="M8 9.25h8M8 12.75h5.5" />
    </svg>
  );
}

function FilesIcon() {
  return (
    <svg aria-hidden="true" className="rail-icon" viewBox="0 0 24 24">
      <path d="M4.25 5.25h15.5v13.5H4.25z" />
      <path d="M8 14.75h1.5l1 1.5h3l1-1.5H16" />
      <path d="M12 7.75v5M9.75 10.5 12 12.75l2.25-2.25" />
    </svg>
  );
}

function NotificationIcon() {
  return (
    <svg aria-hidden="true" className="rail-icon toolbar-icon" viewBox="0 0 24 24">
      <path d="M6.25 16.75h11.5l-1.5-2.25V10a4.25 4.25 0 0 0-8.5 0v4.5l-1.5 2.25Z" />
      <path d="M10 19a2.2 2.2 0 0 0 4 0" />
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg aria-hidden="true" className="rail-icon" viewBox="0 0 24 24">
      <circle cx="12" cy="12" r="3.25" />
      <path d="M9.85 3.9h4.3l.5 2.05 1.4.8 2.02-.6 2.15 3.72-1.53 1.46v1.62l1.53 1.46-2.15 3.72-2.02-.6-1.4.8-.5 2.05h-4.3l-.5-2.05-1.4-.8-2.02.6-2.15-3.72 1.53-1.46v-1.62L3.78 9.87l2.15-3.72 2.02.6 1.4-.8.5-2.05Z" />
    </svg>
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

function ProcessDisclosureIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d="M7 6.5h10M7 12h10M7 17.5h10" />
      <circle cx="4" cy="6.5" r="1" />
      <circle cx="4" cy="12" r="1" />
      <circle cx="4" cy="17.5" r="1" />
    </svg>
  );
}

function ProcessChevronIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d="m8 10 4 4 4-4" />
    </svg>
  );
}

function AttachmentGlyph() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d="m8.2 12.8 5.9-5.9a3 3 0 0 1 4.2 4.2l-7.5 7.5a4.5 4.5 0 0 1-6.4-6.4l7-7" />
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

function TurnProcessDisclosure({
  process,
  expanded,
  onToggle,
}: {
  process: CompletedTurnProcess;
  expanded: boolean;
  onToggle(): void;
}) {
  const stepLabel = `${process.stepCount} ${
    process.stepCount === 1 ? "step" : "steps"
  }`;
  const processDetails = [
    process.attachmentCount > 0
      ? `${process.attachmentCount} ${
          process.attachmentCount === 1 ? "attachment" : "attachments"
        }`
      : null,
    process.failedStepCount > 0
      ? `${process.failedStepCount} failed`
      : null,
  ].filter(Boolean);
  const actionLabel = `${expanded ? "Hide" : "Show"} ${stepLabel} from this task${
    processDetails.length > 0 ? `. ${processDetails.join(", ")}` : ""
  }`;
  return (
    <div className={`turn-process-disclosure ${expanded ? "is-expanded" : ""}`}>
      <button
        type="button"
        aria-expanded={expanded}
        aria-label={actionLabel}
        title={actionLabel}
        onClick={onToggle}
      >
        <ProcessDisclosureIcon />
        <span>{stepLabel}</span>
        {process.attachmentCount > 0 && (
          <span
            className="turn-process-attachment"
            aria-label={`${process.attachmentCount} ${
              process.attachmentCount === 1 ? "attachment" : "attachments"
            }`}
            title={`${process.attachmentCount} ${
              process.attachmentCount === 1 ? "attachment" : "attachments"
            }`}
          >
            <AttachmentGlyph />
            {process.attachmentCount}
          </span>
        )}
        {process.failedStepCount > 0 && (
          <span
            className="turn-process-failure"
            aria-label={`${process.failedStepCount} failed`}
            title={`${process.failedStepCount} failed`}
          />
        )}
        <ProcessChevronIcon />
      </button>
    </div>
  );
}

function TurnResultState({
  outcome,
}: {
  outcome: ObservedCommandCompletion["outcome"];
}) {
  if (outcome === "failed") return null;
  const label = outcome === "cancelled" ? "Task stopped" : "Task completed";
  return (
    <span
      className={`turn-result-state is-${outcome}`}
      aria-label={label}
      title={label}
      role="img"
    >
      {outcome === "cancelled" ? (
        <span aria-hidden="true">■</span>
      ) : (
        <CheckCircleIcon />
      )}
    </span>
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

function DurableCommandRecoveryNotice({
  command,
  connectionStatus,
  gatewayAvailable,
  journalReconciliationAvailable,
  manualAndroidUpdateRequired,
  busy,
  nativeUpdateBusy,
  connectionBusy,
  diagnosticExportBusy,
  lastCheck,
  onCheck,
  onReconnect,
  onUpdateAndroid,
  onOpenAndroidReleases,
  onExportDiagnostics,
  onDismiss,
}: {
  command: MalinkRecoveredDurableCommand;
  connectionStatus: MatrixConnectionStatus;
  gatewayAvailable: boolean;
  journalReconciliationAvailable: boolean;
  manualAndroidUpdateRequired: boolean;
  busy: boolean;
  nativeUpdateBusy: boolean;
  connectionBusy: boolean;
  diagnosticExportBusy: boolean;
  lastCheck?: DurableCommandRecoveryCheckResult;
  onCheck(): void;
  onReconnect(): void;
  onUpdateAndroid(): void;
  onOpenAndroidReleases(): void;
  onExportDiagnostics(): void;
  onDismiss?: () => void;
}) {
  const presentation = durableCommandRecoveryPresentation({
    state: command.state,
    connectionStatus,
    gatewayAvailable,
    journalReconciliationAvailable,
    manualAndroidUpdateRequired,
    lastCheck,
  });
  const commandLabel = command.commandId.length > 16
    ? `${command.commandId.slice(0, 12)}…${command.commandId.slice(-4)}`
    : command.commandId;
  const primaryBusy = busy ||
    (presentation.primaryAction === "update-native-app" && nativeUpdateBusy) ||
    (presentation.primaryAction === "reconnect" && connectionBusy);
  return (
    <section className="durable-command-recovery" role="status" aria-live="polite">
      <div className="durable-command-recovery-heading">
        <span aria-hidden="true">↻</span>
        <span>
          <strong>{presentation.title}</strong>
          <small>{presentation.stateLabel}</small>
        </span>
        {onDismiss && (
          <button
            type="button"
            className="durable-command-recovery-close"
            aria-label="Hide previous action recovery"
            title="Hide this notice; background recovery will continue"
            onClick={onDismiss}
          >
            ×
          </button>
        )}
      </div>
      <p>{presentation.detail}</p>
      <small className="durable-command-recovery-meta">
        Command {commandLabel} · saved {formatRecoveryTimestamp(command.submittedAt)} ·
        last changed {formatRecoveryTimestamp(command.updatedAt)}
        {lastCheck && <> · last checked {formatRecoveryTimestamp(lastCheck.checkedAt)}</>}
      </small>
      <div className="durable-command-recovery-actions">
        {presentation.primaryAction && presentation.primaryLabel && (
          <button
            type="button"
            className="primary"
            disabled={primaryBusy}
            onClick={
              presentation.primaryAction === "check"
                ? onCheck
                : presentation.primaryAction === "reconnect"
                  ? onReconnect
                  : presentation.primaryAction === "update-native-app"
                      ? onUpdateAndroid
                      : onOpenAndroidReleases
            }
          >
            {primaryBusy
              ? presentation.primaryAction === "reconnect"
                ? "Reconnecting…"
                : presentation.primaryAction === "update-native-app"
                  ? "Android update in progress…"
                  : "Checking…"
              : presentation.primaryLabel}
          </button>
        )}
        <button
          type="button"
          disabled={diagnosticExportBusy}
          aria-busy={diagnosticExportBusy}
          onClick={onExportDiagnostics}
        >
          {diagnosticExportBusy ? "Exporting diagnostics…" : "Export diagnostics"}
        </button>
        {onDismiss && (
          <button type="button" onClick={onDismiss}>
            Hide
          </button>
        )}
      </div>
    </section>
  );
}

type PwaUpgradeGateState =
  | {
      phase: "preparing";
      scope: "local-storage" | "indexed-db";
      completed: number;
      total: number;
      currentItemId: string | null;
    }
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
    scope: "local-storage",
    completed: 0,
    total: PWA_STATE_CATALOG.length,
    currentItemId: PWA_STATE_CATALOG[0]?.id ?? null,
  });
  const [upgradeRepairBusy, setUpgradeRepairBusy] = useState(false);
  const upgradeRepairBusyRef = useRef(false);
  const [upgradeRepairError, setUpgradeRepairError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        runPwaStateUpgrade(
          window.localStorage,
          Date.now(),
          PWA_STATE_CATALOG,
          (progress: PwaStateUpgradeProgress) => {
            if (!active) return;
            setUpgrade({
              phase: "preparing",
              scope: "local-storage",
              ...progress,
            });
          },
        );
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
        const indexedDbCatalog = pwaIndexedDbCatalog(window.indexedDB);
        if (active) {
          setUpgrade({
            phase: "preparing",
            scope: "indexed-db",
            completed: 0,
            total: indexedDbCatalog.length,
            currentItemId: indexedDbCatalog[0]?.id ?? null,
          });
        }
        await runPwaIndexedDbUpgrade(
          window.localStorage,
          window.indexedDB,
          Date.now(),
          indexedDbCatalog,
          (progress: PwaIndexedDbUpgradeProgress) => {
            if (!active) return;
            setUpgrade({
              phase: "preparing",
              scope: "indexed-db",
              ...progress,
            });
          },
        );
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
    const step = upgrade.scope === "local-storage" ? 1 : 2;
    const progressLabel = pwaUpgradeProgressLabel(
      upgrade.scope,
      upgrade.currentItemId,
    );
    return (
      <main className="upgrade-gate" aria-busy="true">
        <section className="upgrade-gate-card" role="status">
          <span className="upgrade-gate-mark" aria-hidden="true">M</span>
          <div className="upgrade-gate-copy">
            <p className="eyebrow">Step {step} of 2</p>
            <h1>Preparing Malink</h1>
            <p>
              {upgrade.scope === "local-storage"
                ? "Checking saved connection and recovery state."
                : "Checking secure local databases before the workspace opens."}
            </p>
            <div className="upgrade-gate-progress">
              <span>
                <strong>{progressLabel}</strong>
                <small>{upgrade.completed} of {upgrade.total} complete</small>
              </span>
              <progress
                aria-label={`Preparation progress: ${upgrade.completed} of ${upgrade.total}`}
                max={Math.max(upgrade.total, 1)}
                value={upgrade.completed}
              />
            </div>
            <small className="upgrade-gate-hint">
              Malink preserves identity and queued commands if a check needs attention.
            </small>
          </div>
        </section>
      </main>
    );
  }
  if (upgrade.phase === "blocked") {
    const canReset = upgrade.error.blockedKeys.length > 0;
    const resetBlockedConnection = async () => {
      if (upgradeRepairBusyRef.current || !canReset) return;
      if (!window.confirm(
        "Reset this browser connection? Other devices and Gateway history are not deleted, but this browser must be invited again.",
      )) return;
      upgradeRepairBusyRef.current = true;
      setUpgradeRepairBusy(true);
      setUpgradeRepairError(null);
      try {
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
      } catch (error) {
        setUpgradeRepairError(formatUiError(error));
        upgradeRepairBusyRef.current = false;
        setUpgradeRepairBusy(false);
      }
    };
    return (
      <main className="upgrade-gate" aria-busy={upgradeRepairBusy}>
        <section className="upgrade-gate-card" role="alert">
          <div>
            <p className="eyebrow">Local state needs repair</p>
            <h1>This version did not start</h1>
            <p>{upgrade.error.message}</p>
            <p>
              Malink preserved identity and trust data instead of deleting it during
              an uncertain upgrade.
            </p>
            {upgradeRepairError && (
              <p className="upgrade-gate-error" role="alert">
                Reset failed: {upgradeRepairError}
              </p>
            )}
            <div className="upgrade-gate-actions">
              <button
                type="button"
                disabled={upgradeRepairBusy}
                onClick={() => window.location.reload()}
              >
                Try again
              </button>
              {canReset ? (
                <button
                  type="button"
                  className="danger-button"
                  disabled={upgradeRepairBusy}
                  onClick={() => void resetBlockedConnection()}
                >
                  {upgradeRepairBusy
                    ? "Resetting browser connection…"
                    : "Reset this browser connection"}
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

const PWA_LOCAL_STATE_PROGRESS_LABELS: Readonly<Record<string, string>> = {
  "matrix-connection": "Saved connection",
  "matrix-connections": "Connection profiles",
  "gateway-trust": "Gateway authorization",
  "gateway-trust-profiles": "Approved Gateways",
  "pending-pairing": "Pending device setup",
  "pending-session-create-projection": "Pending conversations",
  "pending-project-create-projection": "Pending projects",
  "native-event-cursor": "Native event position",
  "gateway-ui-projection": "Workspace cache",
  "selected-session": "Selected conversations",
  "session-read-markers": "Read state",
  "project-disclosure": "Project display state",
};

const PWA_INDEXED_DB_PROGRESS_LABELS: Readonly<Record<string, string>> = {
  "matrix-identity-and-command-sequences": "Identity and command records",
  "replay-protection": "Replay protection",
  "matrix-crypto-store": "Encrypted Matrix state",
  "mlp3-command-outbox": "Queued commands",
  "mlp3-inbox-and-projection": "Verified workspace state",
  "conversation-history-projection": "Conversation history",
  "matrix-sync-projection": "Matrix synchronization cache",
};

function pwaUpgradeProgressLabel(
  scope: "local-storage" | "indexed-db",
  currentItemId: string | null,
): string {
  if (currentItemId === null) return "Finishing this step";
  return (
    scope === "local-storage"
      ? PWA_LOCAL_STATE_PROGRESS_LABELS[currentItemId]
      : PWA_INDEXED_DB_PROGRESS_LABELS[currentItemId]
  ) ?? "Checking saved app data";
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
  // This is client-local inventory view state, not an active Gateway or
  // transport switch. Commands still route through each project's signed
  // Gateway Directory owner.
  const [gatewayFilterSelection, setGatewayFilterSelection] = useState(() => ({
    workspaceId: initialGatewayUi.config.gatewayId,
    gatewayNodeId: readGatewayFilter(
      typeof window === "undefined" ? null : window.localStorage,
      initialGatewayUi.config.gatewayId,
    ),
  }));
  const [sessionSearchOpen, setSessionSearchOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [attachmentBusy, setAttachmentBusy] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [feedAwayFromLatest, setFeedAwayFromLatest] = useState(false);
  const [feedHasUnseenMessages, setFeedHasUnseenMessages] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyCheckingRemote, setHistoryCheckingRemote] = useState(false);
  const [historyHasMore, setHistoryHasMore] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyRetryMode, setHistoryRetryMode] = useState<
    "restore" | "older" | null
  >(null);
  const [observedCommandCompletions, setObservedCommandCompletions] = useState<
    ObservedCommandCompletion[]
  >([]);
  const [expandedProcessTurnIds, setExpandedProcessTurnIds] = useState<
    Set<string>
  >(() => new Set());
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(
    initialGatewayUi.selectedSessionId,
  );
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(
    initialGatewayUi.selectedProjectId,
  );
  const [runningSessionIds, setRunningSessionIds] = useState<Set<string>>(
    () => sessionIdsWithStatus(initialGatewayUi.gatewayState, "running", "stopping"),
  );
  const [stoppingSessionIds, setStoppingSessionIds] = useState<Set<string>>(
    () => sessionIdsWithStatus(initialGatewayUi.gatewayState, "stopping"),
  );
  const stoppingSessionIdsRef = useRef(stoppingSessionIds);
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
  const [notificationCenterOpen, setNotificationCenterOpen] = useState(false);
  const [hiddenAttentionKeys, setHiddenAttentionKeys] = useState<Set<string>>(
    () => new Set(),
  );
  const [matrixConfig, setMatrixConfig] = useState<MatrixConnectionConfig>(
    initialGatewayUi.config,
  );
  const storedGatewayFilter = useMemo(
    () => readGatewayFilter(
      typeof window === "undefined" ? null : window.localStorage,
      matrixConfig.gatewayId,
    ),
    [matrixConfig.gatewayId],
  );
  const gatewayFilter = gatewayFilterSelection.workspaceId === matrixConfig.gatewayId
    ? gatewayFilterSelection.gatewayNodeId
    : storedGatewayFilter;
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
  const nativeUpdatePollInFlightRef = useRef(false);
  const nativeUpdateStateRef = useRef<NativeUpdateStatus | null>(null);
  const nativeUpdateActionBusy =
    nativeUpdateBusy || nativeUpdateOperationInProgress(nativeUpdateState);
  const [diagnosticExportBusy, setDiagnosticExportBusy] = useState(false);
  const diagnosticExportFlightRef = useRef<Promise<boolean> | null>(null);
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
  const [gatewayUpdateDialogOpen, setGatewayUpdateDialogOpen] = useState(false);
  const [dismissedGatewayUpdateNoticeKey, setDismissedGatewayUpdateNoticeKey] =
    useState<string | null>(null);
  const [gatewayUpdateActiveNodeId, setGatewayUpdateActiveNodeId] =
    useState<string | null>(null);
  const [gatewayUpdateRuntimeByNode, setGatewayUpdateRuntimeByNode] = useState<
    Record<string, GatewayUpdateNodeRuntime>
  >({});
  const [gatewayArchivePreflightSessionIds, setGatewayArchivePreflightSessionIds] =
    useState<Set<string>>(() => new Set());
  const gatewayArchivePreflightSessionIdsRef = useRef<Set<string>>(new Set());
  const [gatewayNodeLivenessById, setGatewayNodeLivenessById] = useState<
    Record<string, GatewayNodeLiveness>
  >({});
  const [gatewayLivenessNow, setGatewayLivenessNow] = useState(() => Date.now());
  const [gatewayUpdateDiscoveryError, setGatewayUpdateDiscoveryError] =
    useState<string | null>(null);
  const [gatewayUpdateDiscoveryBusy, setGatewayUpdateDiscoveryBusy] =
    useState(false);
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
  const [projectSettingsProjectId, setProjectSettingsProjectId] = useState<string | null>(null);
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
  const [projectSettingsBusy, setProjectSettingsBusy] = useState(false);
  const [optimisticProjectCreate, setOptimisticProjectCreate] =
    useState<OptimisticProjectCreateRecord | null>(() =>
      typeof window === "undefined"
        ? null
        : readOptimisticProjectCreate(window.localStorage, {
            gatewayId: initialGatewayUi.config.gatewayId,
            conversationId: initialGatewayUi.config.conversationId,
          }),
    );
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
  const [recoveredNativeCommands, setRecoveredNativeCommands] = useState<
    MalinkRecoveredDurableCommand[]
  >([]);
  const [recoveredNativeCommandFlightIds, setRecoveredNativeCommandFlightIds] =
    useState<Set<string>>(() => new Set());
  const [recoveredNativeCommandChecks, setRecoveredNativeCommandChecks] =
    useState<Record<string, DurableCommandRecoveryCheckResult>>({});
  const [dismissedRecoveredCommandVersions, setDismissedRecoveredCommandVersions] =
    useState<Set<string>>(() => readDismissedCommandRecoveries(
      typeof window === "undefined" ? null : window.localStorage,
    ));
  const [backgroundRecoveredCommandVersions, setBackgroundRecoveredCommandVersions] =
    useState<Set<string>>(() => readBackgroundCommandRecoveries(
      typeof window === "undefined" ? null : window.localStorage,
    ));
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
  const pwaUpdateStateRef = useRef<PwaUpdateState>({
    phase: "current",
    currentVersion: MALINK_BUILD_VERSION,
  });
  const pwaReloadBlockedRef = useRef(false);
  const gatewayUpdateDiscoveryBusyRef = useRef(false);
  const gatewayUpdateProbeKeysRef = useRef(new Set<string>());
  const gatewayUpdateProbeCommandsRef = useRef(
    new Map<string, GatewayUpdateProbeRecord>(),
  );
  const gatewayAutoArchiveKeysRef = useRef(new Set<string>());
  const gatewayUpdateResumeKeysRef = useRef(new Set<string>());
  const gatewayNodeByProjectRef = useRef(
    new Map<string, { gatewayNodeId: string }>(),
  );
  const gatewayNodeBySessionRef = useRef(new Map<string, string>());
  const ambiguousGatewayMaintenanceSessionIdsRef = useRef<ReadonlySet<string>>(
    new Set(),
  );
  const gatewayNodeLivenessRef = useRef<Record<string, GatewayNodeLiveness>>({});
  const gatewayNodeProbeFlightsRef = useRef(new Set<string>());
  const gatewayNodeAutomaticProbeKeysRef = useRef(new Set<string>());
  const executeGatewayUpdateRef = useRef<(
    payload: Extract<CommandPayload, { operation: `gateway.update.${string}` }>,
    targetProjectId: string,
    timeoutMs?: number,
  ) => Promise<GatewayUpdateStatus>>(async () => {
    throw new Error("Gateway update runtime is not ready.");
  });
  executeGatewayUpdateRef.current = executeGatewayUpdate;
  const connectionStatusRef = useRef<MatrixConnectionStatus>("offline");
  const matrixSessionRepairRequiredRef = useRef(false);
  const pendingSessionCreateRecoveryRef =
    useRef<PendingSessionCreateRecovery | null>(null);
  const optimisticProjectCreateRef =
    useRef<OptimisticProjectCreateRecord | null>(optimisticProjectCreate);
  const projectCreateRecoveryInFlightRef = useRef<{
    commandId: string;
    connection: MalinkClient;
  } | null>(null);
  const projectCreateRecoveryTimerRef = useRef<number | null>(null);
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
  const recoveredNativeCommandsRef = useRef(
    new Map<string, MalinkRecoveredDurableCommand>(),
  );
  const recoveredNativeCommandFlightsRef = useRef(new Set<string>());
  const recoveredNativeCommandTimerRef = useRef<number | null>(null);
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
  const presentedCompletedTurnIdsRef = useRef(new Set<string>());
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
  const selectedProjectIdRef = useRef<string | null>(
    initialGatewayUi.selectedProjectId,
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
  const historyProjectIdRef = useRef<string | null>(
    initialGatewayUi.selectedProjectId,
  );
  const historyCursorRef = useRef<MessageHistoryCursor | null>(null);
  const historyGenerationRef = useRef(0);
  const historyLoadingRef = useRef(false);
  const historyRemoteFlightRef = useRef<{
    sessionId: string;
    projectId?: string;
    generation: number;
    connection: MalinkClient;
  } | null>(null);
  const providerHistoryProviderRef = useRef("");
  const providerHistoryGatewayNodeIdRef = useRef("");
  const providerHistoryProjectIdRef = useRef("");
  const providerHistoryLoadRef = useRef<ProviderHistoryLoadState | null>(null);
  const providerHistoryBackgroundedRef = useRef(false);
  const providerHistoryLoadIdRef = useRef(0);
  const providerHistoryLoadedProviderRef = useRef<string | null>(null);
  const providerHistoryFocusRef = useRef<ProviderHistoryFocus | null>(null);
  const providerHistoryPendingCommandsRef = useRef(
    new Map<string, ProviderHistoryPendingCommand>(),
  );
  const providerHistoryCommandFlightsRef = useRef(
    new Map<string, Promise<CommandCompletion>>(),
  );
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
      (session) => session.id === selectedSessionId &&
        (!selectedProjectId || session.projectId === selectedProjectId),
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
    ? sessionLifecycleBusy.get(
        sessionLifecycleRouteKey(gatewaySelected.projectId, gatewaySelected.id),
      ) ?? null
    : null;
  const selectedLifecycleBusy = selectedLifecycleAction !== null;
  const completedTurns = useMemo(
    () =>
      completedTurnPresentation(
        messages,
        observedCommandCompletions,
        selectedSessionId,
      ),
    [messages, observedCommandCompletions, selectedSessionId],
  );
  const nativeBackAction = resolveMalinkBackAction({
    deleteDialogOpen: false,
    deleteDialogBusy: false,
    notificationCenterOpen,
    providerHistoryOpen,
    gatewayUpdateDialogOpen,
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
        case "close-notification-center":
          setNotificationCenterOpen(false);
          break;
        case "close-provider-history":
          closeProviderHistory();
          break;
        case "close-gateway-update":
          setGatewayUpdateDialogOpen(false);
          break;
        case "close-new-project":
          setNewProjectOpen(false);
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
  gatewayNodeByProjectRef.current = projectGatewaysById;
  const gatewayNodeBySession = new Map<string, string>();
  const ambiguousGatewayNodeSessions = new Set<string>();
  for (const session of gatewayState?.sessions ?? []) {
    const gatewayNodeId = projectGatewaysById.get(session.projectId)?.gatewayNodeId ??
      (session.projectId === gatewayState?.workspace.projectId
        ? fallbackProjectGateway.gatewayNodeId
        : undefined);
    if (!gatewayNodeId || ambiguousGatewayNodeSessions.has(session.id)) continue;
    const existing = gatewayNodeBySession.get(session.id);
    if (existing && existing !== gatewayNodeId) {
      gatewayNodeBySession.delete(session.id);
      ambiguousGatewayNodeSessions.add(session.id);
    } else {
      gatewayNodeBySession.set(session.id, gatewayNodeId);
    }
  }
  gatewayNodeBySessionRef.current = gatewayNodeBySession;
  const gatewayFilterOptions = useMemo(
    () => (gatewayState?.gatewayDirectory?.directory.gateways ?? [])
      .map(gateway => gatewayProjectOwner(
        gateway.gatewayNodeId,
        gateway.gatewayName,
        gateway.computerName,
      ))
      .sort((left, right) =>
        left.label.localeCompare(right.label) ||
        left.gatewayNodeId.localeCompare(right.gatewayNodeId),
      ),
    [gatewayState?.gatewayDirectory],
  );
  const activeGatewayFilter = gatewayFilterOptions.length > 0
    ? normalizeGatewayFilter(
        gatewayFilter,
        gatewayFilterOptions.map(gateway => gateway.gatewayNodeId),
      )
    : ALL_GATEWAYS_FILTER;
  const gatewayScopedSessions = useMemo(
    () => visibleGatewaySessions.filter(session => projectMatchesGatewayFilter(
      activeGatewayFilter,
      session.projectId,
      projectGatewaysById,
      fallbackProjectGateway.gatewayNodeId,
    )),
    [
      activeGatewayFilter,
      fallbackProjectGateway.gatewayNodeId,
      projectGatewaysById,
      visibleGatewaySessions,
    ],
  );
  const filteredSessions = useMemo(
    () =>
      gatewayScopedSessions.filter((session) => {
        const owner = projectGatewaysById.get(session.projectId) ?? fallbackProjectGateway;
        return `${session.title} ${session.projectName} ${session.cwd} ${session.provider} ${session.model ?? ""} ${owner.gatewayName} ${owner.computerName} ${owner.gatewayNodeId}`
          .toLowerCase()
          .includes(search.toLowerCase());
      }),
    [fallbackProjectGateway, gatewayScopedSessions, projectGatewaysById, search],
  );
  const activeFilteredSessions = filteredSessions;
  const activeSessionCount = gatewayScopedSessions.length;
  const gatewayScopedProjects = useMemo(
    () => (gatewayState?.projects ?? []).filter(project => projectMatchesGatewayFilter(
      activeGatewayFilter,
      project.projectId,
      projectGatewaysById,
      fallbackProjectGateway.gatewayNodeId,
    )),
    [
      activeGatewayFilter,
      fallbackProjectGateway.gatewayNodeId,
      gatewayState?.projects,
      projectGatewaysById,
    ],
  );
  const gatewayScopedWorkspace = gatewayState?.workspace && projectMatchesGatewayFilter(
    activeGatewayFilter,
    gatewayState.workspace.projectId,
    projectGatewaysById,
    fallbackProjectGateway.gatewayNodeId,
  )
    ? gatewayState.workspace
    : undefined;
  const canonicalProjectsById = useMemo(
    () =>
      new Map(
        canonicalGatewayProjects(
          gatewayScopedWorkspace,
          gatewayScopedSessions,
          gatewayScopedProjects,
        ).map((project) => [project.projectId, project]),
      ),
    [gatewayScopedProjects, gatewayScopedSessions, gatewayScopedWorkspace],
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
  const scratchGroups = useMemo(() => {
    const groups = new Map<string, {
      key: string;
      projectId: string;
      projectName: string;
      cwd: string;
      gatewayLabel: string;
      sessions: NonNullable<typeof gatewayState>["sessions"];
      temporary: true;
    }>();
    for (const session of activeFilteredSessions) {
      if (session.scope !== "scratch") continue;
      const owner = projectGatewaysById.get(session.projectId) ?? fallbackProjectGateway;
      const group = groups.get(owner.gatewayNodeId) ?? {
        key: `${matrixConfig.gatewayId}\u0000${owner.gatewayNodeId}\u0000scratch`,
        projectId: `scratch:${owner.gatewayNodeId}`,
        projectName: "Temporary",
        cwd: "Isolated workspace · not linked to a project",
        gatewayLabel: owner.label,
        sessions: [],
        temporary: true,
      };
      group.sessions.push(session);
      groups.set(owner.gatewayNodeId, group);
    }
    const ordered = [...groups.values()];
    for (const group of ordered) {
      group.sessions.sort((left, right) =>
        compareSessionsForAction(left, right, sessionReadState),
      );
    }
    ordered.sort((left, right) =>
      compareProjectSessionsForAction(
        left.sessions,
        right.sessions,
        sessionReadState,
      ) || left.gatewayLabel.localeCompare(right.gatewayLabel),
    );
    return ordered;
  }, [
    activeFilteredSessions,
    fallbackProjectGateway,
    matrixConfig.gatewayId,
    projectGatewaysById,
    sessionReadState,
  ]);
  const conversationGroups = useMemo(() => [
    ...scratchGroups,
    ...projectGroups.map((project) => ({ ...project, temporary: false as const })),
  ], [projectGroups, scratchGroups]);
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
  const globalNotices = globalUiNotices(uiNotices);
  const centerUiNotices = allUiNotices(uiNotices);
  const recoveredNativeCommandNotices = recoveredNativeCommands.filter(
    command =>
      command.state !== "needs_review" &&
      !recoveredNativeCommandIsOwned(command.commandId) &&
      durableCommandRecoveryNeedsAttention(
        recoveredNativeCommandChecks[command.commandId],
        backgroundRecoveredCommandVersions.has(
          recoveredCommandNoticeVersion(command),
        ),
      ),
  );
  const visibleRecoveredNativeCommand = recoveredNativeCommandNotices.find(
    command =>
      !dismissedRecoveredCommandVersions.has(recoveredCommandNoticeVersion(command)),
  ) ?? null;
  const gatewayConnected = gatewayAvailable;
  const isStreaming = Boolean(
    selectedSessionId && runningSessionIds.has(selectedSessionId),
  );
  const toolFocus = useMemo(
    () => activeTurnToolFocus(messages, isStreaming),
    [isStreaming, messages],
  );
  const liveToolMessage = toolFocus?.toolMessage ?? null;
  const timelineMessages = useMemo(
    () => turnTimelineMessages(messages),
    [messages],
  );
  const presentedTimeline = useMemo<TimelinePresentationItem[]>(() => {
    const items: TimelinePresentationItem[] = [];
    for (const message of timelineMessages) {
      const process = completedTurns.processByMessageId.get(message.id);
      if (!process) {
        items.push({ kind: "message", message });
        continue;
      }
      const expanded = expandedProcessTurnIds.has(process.commandId);
      if (message.id === process.firstMessageId) {
        items.push({ kind: "process", process });
      }
      if (expanded) items.push({ kind: "message", message });
    }
    return items;
  }, [completedTurns, expandedProcessTurnIds, timelineMessages]);
  useLayoutEffect(() => {
    const completedTurnIds = new Set(
      [...completedTurns.resultByMessageId.values()].map(
        (result) => result.commandId,
      ),
    );
    const newlyCompleted = [...completedTurnIds].filter(
      (commandId) => !presentedCompletedTurnIdsRef.current.has(commandId),
    );
    presentedCompletedTurnIdsRef.current = completedTurnIds;
    if (newlyCompleted.length === 0 || followLatestRef.current) return;
    // Preserve a user's reading target if a turn finishes while they are
    // inspecting earlier output. History and follow-latest views stay compact.
    setExpandedProcessTurnIds((current) => {
      const next = new Set(current);
      for (const commandId of newlyCompleted) next.add(commandId);
      return next;
    });
  }, [completedTurns]);
  const isStopping = Boolean(
    selectedSessionId && stoppingSessionIds.has(selectedSessionId),
  );
  const agentActivity = selectedSessionId
    ? agentActivitiesBySession.get(selectedSessionId) ?? null
    : null;
  const receivedPromptCommandIds = useMemo(
    () =>
      agentReceivedCommandIds({
        sessionId: selectedSessionId,
        session: gatewaySelected,
        messages,
        completions: observedCommandCompletions,
      }),
    [gatewaySelected, messages, observedCommandCompletions, selectedSessionId],
  );
  useLayoutEffect(() => {
    resizeComposerTextarea(composerTextareaRef.current);
  }, [draft, selectedSessionId]);

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
  const allWorkspaceProjects = gatewayState?.projects ??
    (gatewayState ? [gatewayState.workspace] : []);
  const preferredSessionCreationWorkspace = selected
    ? allWorkspaceProjects.find(project => project.projectId === selected.projectId)
    : gatewayState?.workspace;
  const gatewayFilterDefaultWorkspace = activeGatewayFilter === ALL_GATEWAYS_FILTER ||
      (preferredSessionCreationWorkspace && projectMatchesGatewayFilter(
        activeGatewayFilter,
        preferredSessionCreationWorkspace.projectId,
        projectGatewaysById,
        fallbackProjectGateway.gatewayNodeId,
      ))
    ? preferredSessionCreationWorkspace ?? gatewayState?.workspace
    : allWorkspaceProjects.find(project => projectMatchesGatewayFilter(
        activeGatewayFilter,
        project.projectId,
        projectGatewaysById,
        fallbackProjectGateway.gatewayNodeId,
      ));
  const activeProjectGateway = activeWorkspace
    ? projectGatewaysById.get(activeWorkspace.projectId) ?? fallbackProjectGateway
    : fallbackProjectGateway;
  const projectSettingsWorkspace = projectSettingsProjectId
    ? gatewayState?.projects?.find(project => project.projectId === projectSettingsProjectId)
      ?? (gatewayState?.workspace.projectId === projectSettingsProjectId
        ? gatewayState.workspace
        : null)
    : null;
  const projectSettingsGateway = projectSettingsWorkspace
    ? projectGatewaysById.get(projectSettingsWorkspace.projectId) ?? fallbackProjectGateway
    : fallbackProjectGateway;
  const projectSettingsGatewayDescriptor = gatewayState?.gatewayDirectory?.directory.gateways
    .find(gateway => gateway.gatewayNodeId === projectSettingsGateway.gatewayNodeId);
  const projectSettingsRoute = projectSettingsGatewayDescriptor?.projects
    ?.find(project => project.projectId === projectSettingsWorkspace?.projectId);
  const projectSettingsIsControlRoute = Boolean(
    (projectSettingsRoute
      && projectSettingsGatewayDescriptor
      && projectSettingsRoute.roomId === projectSettingsGatewayDescriptor.transport.roomId)
    || (!projectSettingsGatewayDescriptor
      && projectSettingsWorkspace?.projectId === matrixConfig.projectId),
  );
  const projectSettingsCanDelete = projectSettingsWorkspace
    ? !projectSettingsIsControlRoute
      && (gatewayState?.projects ?? [gatewayState?.workspace].filter(Boolean)).filter(project => {
        if (!project) return false;
        const owner = projectGatewaysById.get(project.projectId) ?? fallbackProjectGateway;
        return owner.gatewayNodeId === projectSettingsGateway.gatewayNodeId;
      }).length > 1
    : false;
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
  const canCreateAnySession = allWorkspaceProjects
    .filter(project => projectMatchesGatewayFilter(
      activeGatewayFilter,
      project.projectId,
      projectGatewaysById,
      fallbackProjectGateway.gatewayNodeId,
    ))
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
  const presentedProjectCreationGateways = useMemo(
    () => activeGatewayFilter === ALL_GATEWAYS_FILTER
      ? projectCreationGateways
      : [...projectCreationGateways].sort((left, right) =>
          Number(right.gatewayNodeId === activeGatewayFilter) -
          Number(left.gatewayNodeId === activeGatewayFilter),
        ),
    [activeGatewayFilter, projectCreationGateways],
  );
  const knownGatewayProjectIds = useMemo(
    () => new Set(
      (gatewayState?.projects ?? (gatewayState ? [gatewayState.workspace] : []))
        .map((project) => project.projectId),
    ),
    [gatewayState],
  );
  const gatewayNodeProbeTargets = useMemo(
    () => gatewayNodeLivenessTargets({
      directory: gatewayState?.gatewayDirectory,
      knownProjectIds: knownGatewayProjectIds,
    }),
    [gatewayState?.gatewayDirectory, knownGatewayProjectIds],
  );
  const gatewayNodeProbeTargetsById = useMemo(
    () => new Map(
      gatewayNodeProbeTargets.map((target) => [target.gatewayNodeId, target]),
    ),
    [gatewayNodeProbeTargets],
  );
  const gatewayUpdateDirectoryPlan = useMemo(() =>
    buildGatewayUpdatePlan({
      directory: gatewayState?.gatewayDirectory,
      knownProjectIds: knownGatewayProjectIds,
      release: gatewayRelease,
    }), [gatewayRelease, gatewayState?.gatewayDirectory, knownGatewayProjectIds]);
  const gatewayUpdateReleaseKey = gatewayRelease
    ? `${gatewayRelease.releaseId}\0${gatewayRelease.buildId}`
    : null;
  const gatewayUpdateRuntimeForRelease = useMemo(
    () => Object.fromEntries(
      Object.entries(gatewayUpdateRuntimeByNode).filter(
        ([, runtime]) => runtime.releaseKey === gatewayUpdateReleaseKey,
      ),
    ),
    [gatewayUpdateReleaseKey, gatewayUpdateRuntimeByNode],
  );
  const gatewayUpdatePlan = useMemo(
    () => gatewayRelease
      ? gatewayUpdateDirectoryPlan.map(node => gatewayUpdatePlanNodeWithLiveStatus({
          node,
          release: gatewayRelease,
          status: gatewayUpdateRuntimeForRelease[node.gatewayNodeId]?.status,
        }))
      : gatewayUpdateDirectoryPlan,
    [gatewayRelease, gatewayUpdateDirectoryPlan, gatewayUpdateRuntimeForRelease],
  );
  const legacyGatewayMaintenanceSessions = useMemo(
    () => legacyGatewayMaintenanceSessionsByNode({
      nodes: gatewayUpdatePlan,
      projectedSessions: gatewayState?.sessions ?? [],
    }),
    [gatewayState?.sessions, gatewayUpdatePlan],
  );
  const gatewayUpdateAvailableCount = gatewayUpdatePlan.filter(
    node => node.state === "available",
  ).length;
  const gatewayUpdateRuntimePresentation = useMemo(() => {
    if (!gatewayRelease || !gatewayState) return gatewayUpdateRuntimeForRelease;
    let presentation = gatewayUpdateRuntimeForRelease;
    for (const node of gatewayUpdatePlan) {
      const runtime = gatewayUpdateRuntimeForRelease[node.gatewayNodeId];
      const startedAt = runtime?.startedAt;
      if (!node.targetProjectId || !startedAt || runtime.maintenanceSessionId) continue;
      const candidates = gatewayState.sessions
        .filter(session =>
          session.projectId === node.targetProjectId &&
          session.scope === "scratch" &&
          session.title.startsWith("Gateway update "),
        )
        .sort((left, right) => right.updatedAt - left.updatedAt);
      const session = candidates.find(candidate =>
        candidate.title.includes(gatewayRelease.releaseId),
      ) ?? candidates.find(candidate => candidate.updatedAt >= startedAt - 5_000);
      if (!session) continue;
      presentation = {
        ...presentation,
        [node.gatewayNodeId]: {
          ...runtime,
          maintenanceSessionId: session.id,
        },
      };
    }
    for (const node of gatewayUpdatePlan) {
      const runtime = presentation[node.gatewayNodeId];
      if (!runtime?.maintenanceSessionId || !node.targetProjectId) continue;
      const maintenanceSession = gatewayState.sessions.find(session =>
        session.id === runtime.maintenanceSessionId &&
        session.projectId === node.targetProjectId,
      );
      if (!maintenanceSession) continue;
      presentation = {
        ...presentation,
        [node.gatewayNodeId]: {
          ...runtime,
          maintenanceSessionArchiveAvailable:
            maintenanceSession.status !== "archived" &&
            gatewayMaintenanceSessionCanBeArchived(runtime.status),
          maintenanceSessionArchived:
            maintenanceSession.status === "archived",
          maintenanceSessionArchiveBusy: sessionLifecycleBusy.has(
            sessionLifecycleRouteKey(
              maintenanceSession.projectId,
              maintenanceSession.id,
            ),
          ) || gatewayArchivePreflightSessionIds.has(runtime.maintenanceSessionId),
          maintenanceSessionArchiveChecking:
            gatewayArchivePreflightSessionIds.has(runtime.maintenanceSessionId),
        },
      };
    }
    const collidingSessionIds = collidingGatewayMaintenanceSessionIds({
      nodeSessions: gatewayUpdatePlan.map(node => {
        const maintenanceSessionId =
          presentation[node.gatewayNodeId]?.maintenanceSessionId;
        return {
          gatewayNodeId: node.gatewayNodeId,
          ...(maintenanceSessionId ? { maintenanceSessionId } : {}),
        };
      }),
      projectedSessions: gatewayState.sessions,
    });
    if (collidingSessionIds.size > 0) {
      for (const node of gatewayUpdatePlan) {
        const runtime = presentation[node.gatewayNodeId];
        if (
          !runtime?.maintenanceSessionId ||
          !collidingSessionIds.has(runtime.maintenanceSessionId)
        ) continue;
        const maintenanceSession = node.targetProjectId
          ? gatewayState.sessions.find(session =>
              session.id === runtime.maintenanceSessionId &&
              session.projectId === node.targetProjectId,
            )
          : undefined;
        presentation = {
          ...presentation,
          [node.gatewayNodeId]: {
            ...runtime,
            maintenanceSessionAmbiguous: true,
            maintenanceSessionArchiveAvailable:
              maintenanceSession !== undefined &&
              maintenanceSession.status !== "archived" &&
              gatewayMaintenanceSessionCanBeArchived(runtime.status),
            maintenanceSessionArchived:
              maintenanceSession?.status === "archived",
            maintenanceSessionArchiveBusy: Boolean(
              maintenanceSession && sessionLifecycleBusy.has(
                sessionLifecycleRouteKey(
                  maintenanceSession.projectId,
                  maintenanceSession.id,
                ),
              ),
            ) || gatewayArchivePreflightSessionIds.has(runtime.maintenanceSessionId),
            maintenanceSessionArchiveChecking:
              gatewayArchivePreflightSessionIds.has(runtime.maintenanceSessionId),
          },
        };
      }
    }
    for (const node of gatewayUpdatePlan) {
      const legacySession = legacyGatewayMaintenanceSessions.get(node.gatewayNodeId);
      const runtime = presentation[node.gatewayNodeId];
      if (!legacySession || legacySession.id === runtime?.maintenanceSessionId) continue;
      presentation = {
        ...presentation,
        [node.gatewayNodeId]: {
          ...(runtime ?? { state: "unchecked" as const }),
          legacyMaintenanceSessionId: legacySession.id,
          legacyMaintenanceSessionArchiveAvailable:
            legacySession.status !== "archived" &&
            gatewayMaintenanceSessionCanBeArchived(runtime?.status),
          legacyMaintenanceSessionArchived:
            legacySession.status === "archived",
          legacyMaintenanceSessionArchiveBusy: sessionLifecycleBusy.has(
            sessionLifecycleRouteKey(legacySession.projectId, legacySession.id),
          ) || gatewayArchivePreflightSessionIds.has(legacySession.id),
          legacyMaintenanceSessionArchiveChecking:
            gatewayArchivePreflightSessionIds.has(legacySession.id),
        },
      };
    }
    return presentation;
  }, [
    gatewayRelease,
    gatewayState,
    gatewayUpdatePlan,
    gatewayUpdateRuntimeForRelease,
    gatewayArchivePreflightSessionIds,
    legacyGatewayMaintenanceSessions,
    sessionLifecycleBusy,
  ]);
  const ambiguousGatewayMaintenanceSessionIds = useMemo(
    () => new Set(
      [...collidingGatewayMaintenanceSessionIds({
        nodeSessions: [],
        projectedSessions: gatewayState?.sessions ?? [],
      })].filter(sessionId => sessionId.startsWith("gateway-update-")),
    ),
    [gatewayState?.sessions],
  );
  ambiguousGatewayMaintenanceSessionIdsRef.current =
    ambiguousGatewayMaintenanceSessionIds;
  const gatewayUpdateNoticeKey = gatewayRelease && gatewayUpdateAvailableCount > 0
    ? `${gatewayRelease.releaseId}\0${gatewayRelease.buildId}\0${gatewayUpdatePlan
        .filter(node => node.state === "available")
        .map(node => `${node.gatewayNodeId}:${node.currentBuildId ?? "unknown"}`)
        .sort()
        .join("\0")}`
    : null;
  const gatewayNodeSummary = useMemo(
    () => gatewayNodeLivenessSummary({
      gatewayNodeIds: gatewayNodeProbeTargets.map((target) => target.gatewayNodeId),
      values: gatewayNodeLivenessById,
      now: gatewayLivenessNow,
    }),
    [gatewayLivenessNow, gatewayNodeLivenessById, gatewayNodeProbeTargets],
  );
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

  function syncRecoveredNativeCommands(): void {
    setRecoveredNativeCommands(
      [...recoveredNativeCommandsRef.current.values()].sort((left, right) =>
        left.submittedAt - right.submittedAt ||
        left.commandId.localeCompare(right.commandId)),
    );
  }

  function syncRecoveredNativeCommandFlights(): void {
    setRecoveredNativeCommandFlightIds(
      new Set(recoveredNativeCommandFlightsRef.current),
    );
  }

  function forgetRecoveredNativeCommand(...commandIds: string[]): void {
    for (const commandId of commandIds) {
      recoveredNativeCommandsRef.current.delete(commandId);
      setRecoveredNativeCommandChecks((current) => {
        if (!(commandId in current)) return current;
        const next = { ...current };
        delete next[commandId];
        return next;
      });
    }
    syncRecoveredNativeCommands();
  }

  function dismissRecoveredNativeCommandNotices(): void {
    const noticeVersions = [...recoveredNativeCommandsRef.current.values()]
      .filter(command =>
        command.state !== "needs_review" &&
        !recoveredNativeCommandIsOwned(command.commandId),
      )
      .map(recoveredCommandNoticeVersion);
    if (noticeVersions.length === 0) return;
    setDismissedRecoveredCommandVersions((current) => {
      const next = new Set(current);
      for (const noticeVersion of noticeVersions) next.add(noticeVersion);
      if (next.size === current.size) return current;
      writeDismissedCommandRecoveries(window.localStorage, next);
      return next;
    });
  }

  function backgroundRecoveredNativeCommandNotice(commandId: string): void {
    const command = recoveredNativeCommandsRef.current.get(commandId);
    if (!command || recoveredNativeCommandIsOwned(commandId)) return;
    const noticeVersion = recoveredCommandNoticeVersion(command);
    setBackgroundRecoveredCommandVersions((current) => {
      if (current.has(noticeVersion)) return current;
      const next = new Set(current);
      next.add(noticeVersion);
      writeBackgroundCommandRecoveries(window.localStorage, next);
      return next;
    });
  }

  function selectGatewayFilter(gatewayNodeId: string): void {
    setGatewayFilterSelection({
      workspaceId: matrixConfig.gatewayId,
      gatewayNodeId,
    });
    try {
      writeGatewayFilter(
        window.localStorage,
        matrixConfig.gatewayId,
        gatewayNodeId,
      );
      recoverUiNotice("gateway-filter-storage");
    } catch (error) {
      showUiNotice(
        "gateway-filter-storage",
        "session",
        "warning",
        `This Gateway view is active for now, but the preference could not be saved: ${formatUiError(error)}`,
      );
    }
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

  function clearUiNotice(key: string) {
    dispatchUiNotice({ type: "clear", key });
  }

  function hideAttention(key: string): void {
    setHiddenAttentionKeys((current) => {
      if (current.has(key)) return current;
      const next = new Set(current);
      next.add(key);
      return next;
    });
  }

  function showAttention(key: string): void {
    setHiddenAttentionKeys((current) => {
      if (!current.has(key)) return current;
      const next = new Set(current);
      next.delete(key);
      return next;
    });
  }

  function openNotificationCenter(): void {
    for (const notice of globalUiNotices(uiNotices)) {
      dismissUiNotice(notice.key);
    }
    dismissRecoveredNativeCommandNotices();
    if (gatewayUpdateNoticeKey) {
      setDismissedGatewayUpdateNoticeKey(gatewayUpdateNoticeKey);
    }
    const keys = [
      connectionAttentionKey,
      revisionConflict
        ? `state:revision:${revisionConflict.commandId}`
        : null,
      nativeCommandReview
        ? `state:native-review:${nativeCommandReview.commandId}`
        : null,
      optimisticSession && optimisticSession.phase !== "creating"
        ? `state:session-create:${optimisticSession.localSessionId}:${optimisticSession.phase}`
        : null,
      optimisticProjectCreate &&
        (optimisticProjectCreate.phase === "failed" ||
          optimisticProjectCreate.phase === "uncertain")
        ? `state:project-create:${optimisticProjectCreate.localId}:${optimisticProjectCreate.phase}`
        : null,
    ].filter((key): key is string => key !== null);
    if (keys.length > 0) {
      setHiddenAttentionKeys((current) => new Set([...current, ...keys]));
    }
    setNotificationCenterOpen(true);
  }

  function recoverUiNotice(key: string) {
    dispatchUiNotice({ type: "operation-recovered", key });
  }

  async function checkForPwaUpdates(): Promise<void> {
    const updater = pwaUpdateRef.current;
    if (!updater) {
      showUiNotice(
        "update:pwa-check",
        "update",
        "warning",
        "The update checker is still starting. Try again in a moment.",
      );
      return;
    }
    showUiNotice(
      "update:pwa-check",
      "update",
      "info",
      "Checking for a newer Malink version in the background…",
      null,
    );
    try {
      await updater.checkNow();
      const result = pwaUpdateStateRef.current;
      if (result.phase === "current") {
        showUiNotice(
          "update:pwa-check",
          "diagnostics",
          "success",
          "Malink is up to date.",
          4_000,
        );
      } else if (result.phase === "unavailable") {
        showUiNotice(
          "update:pwa-check",
          "update",
          "warning",
          "Malink could not check for updates right now. Your current version is still running.",
        );
      } else {
        recoverUiNotice("update:pwa-check");
      }
    } catch (error) {
      showUiNotice(
        "update:pwa-check",
        "diagnostics",
        "warning",
        `Malink could not check for updates: ${formatUiError(error)}`,
      );
    }
  }

  function closeProviderHistory(): void {
    setProviderHistoryOpen(false);
    if (!providerHistoryLoadRef.current) return;
    providerHistoryBackgroundedRef.current = true;
    showUiNotice(
      "provider:history-background",
      "background",
      "info",
      providerHistoryLoadRef.current.kind === "session"
        ? "Provider session history is loading in the background. You can keep working."
        : "Provider sessions are loading in the background. You can keep working.",
      null,
    );
  }

  function finishProviderHistoryBackground(
    failure: string | null = null,
  ): void {
    if (!providerHistoryBackgroundedRef.current) return;
    providerHistoryBackgroundedRef.current = false;
    showUiNotice(
      "provider:history-background",
      "background",
      failure ? "warning" : "success",
      failure
        ? `Provider History needs attention: ${failure}`
        : "Provider History finished loading. Reopen it whenever you are ready.",
      failure ? undefined : 5_000,
    );
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
    const next = new Set(stoppingSessionIdsRef.current);
    if (stopping) next.add(sessionId);
    else next.delete(sessionId);
    stoppingSessionIdsRef.current = next;
    setStoppingSessionIds(next);
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
  }

  useEffect(() => {
    writeProjectDisclosureState(window.localStorage, collapsedProjects);
  }, [collapsedProjects]);

  useEffect(() => {
    writeSessionReadState(window.localStorage, sessionReadState);
  }, [sessionReadState]);

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
    const record = optimisticProjectCreateRef.current;
    if (!record) return;
    if (record.phase === "submitting" && !record.commandId) {
      commitOptimisticProjectCreate(
        failOptimisticProjectCreate(
          record,
          "Project creation stopped before its secure command was saved. Retry creation to continue.",
        ),
      );
      return;
    }
    setOptimisticProjectCreate(record);
    // This restores one local record for the initial Matrix binding. Recovery
    // resumes when the connection's ready promise settles below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const record = optimisticProjectCreateRef.current;
    if (!record || record.phase !== "syncing" || !gatewayState) return;
    const projects = gatewayState.projects ?? [gatewayState.workspace];
    if (!optimisticProjectMatchesProjection(record, projects)) return;
    removeOptimisticProjectCreate(record.localId);
    recoverUiNotice("project:create");
    // The helpers intentionally update refs and storage atomically.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gatewayState, optimisticProjectCreate]);

  useEffect(() => {
    let recovery = readPendingSessionCreateRecovery(window.localStorage);
    let optimistic = readOptimisticSession(window.localStorage, {
      gatewayId: matrixConfig.gatewayId,
      conversationId: matrixConfig.conversationId,
    });
    if (!recovery && optimistic) {
      recovery = pendingSessionCreateRecoveryFromOptimistic(optimistic);
      if (recovery) {
        try {
          writePendingSessionCreateRecovery(window.localStorage, recovery);
        } catch {
          // The in-memory recovery still reconciles this page. A later missing
          // command result converts the stale local row into a discardable
          // failed draft instead of leaving it in `creating` forever.
        }
      }
    }
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
        "Your computer accepted the secure command. Malink is still checking its final result in the background; checking it again cannot create a duplicate.",
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
    const updater = registerPwaUpdates((state) => {
      pwaUpdateStateRef.current = state;
      setPwaUpdateState(state);
    }, {
      canReload: () => !pwaReloadBlockedRef.current,
    });
    pwaUpdateRef.current = updater;
    return () => {
      pwaUpdateRef.current = null;
      updater.dispose();
    };
  }, []);

  const refreshGatewayUpdateDiscovery = useCallback(async (
    signal?: AbortSignal,
  ): Promise<void> => {
    if (gatewayUpdateDiscoveryBusyRef.current) return;
    gatewayUpdateDiscoveryBusyRef.current = true;
    setGatewayUpdateDiscoveryBusy(true);
    try {
      const release = await discoverLatestGatewayAgentUpdate(fetch, signal);
      if (signal?.aborted) return;
      setGatewayUpdateDiscoveryError(null);
      setGatewayRelease((current) =>
        release && current?.releaseId === release.releaseId && current.buildId === release.buildId
          ? current
          : release,
      );
    } catch (error) {
      if (signal?.aborted) return;
      const detail = formatUiError(error);
      console.warn(`[gateway-update/discovery] ${detail}`, error);
      setGatewayUpdateDiscoveryError(detail);
    } finally {
      gatewayUpdateDiscoveryBusyRef.current = false;
      if (!signal?.aborted) setGatewayUpdateDiscoveryBusy(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const refresh = () => {
      if (document.visibilityState !== "visible") return;
      void refreshGatewayUpdateDiscovery(controller.signal);
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
  }, [refreshGatewayUpdateDiscovery]);

  useEffect(() => {
    if (gatewayNodeProbeTargets.length === 0) return;
    const refreshClock = () => setGatewayLivenessNow(Date.now());
    const timer = window.setInterval(refreshClock, 30_000);
    return () => window.clearInterval(timer);
  }, [gatewayNodeProbeTargets.length]);

  useEffect(() => {
    const knownNodeIds = new Set(
      gatewayNodeProbeTargets.map((target) => target.gatewayNodeId),
    );
    const retained = Object.fromEntries(
      Object.entries(gatewayNodeLivenessRef.current).filter(([gatewayNodeId]) =>
        knownNodeIds.has(gatewayNodeId),
      ),
    );
    for (const target of gatewayNodeProbeTargets) {
      if (target.canProbe || retained[target.gatewayNodeId]) continue;
      retained[target.gatewayNodeId] = {
        state: "unavailable",
        detail: target.unavailableReason === "route"
          ? "This client has no synchronized project route for a signed live check."
          : "This Gateway build does not advertise the signed live-status capability.",
      };
    }
    gatewayNodeLivenessRef.current = retained;
    setGatewayNodeLivenessById(retained);
  }, [gatewayNodeProbeTargets]);

  useEffect(() => {
    if (connectionStatus !== "connected") return;
    const generation = matrixStartupGenerationRef.current;
    for (const target of gatewayNodeProbeTargets) {
      if (!target.canProbe) continue;
      const key = `${generation}\0${target.gatewayNodeId}\0${target.targetProjectId ?? ""}\0${gatewayUpdateReleaseKey ?? ""}`;
      if (gatewayNodeAutomaticProbeKeysRef.current.has(key)) continue;
      gatewayNodeAutomaticProbeKeysRef.current.add(key);
      void probeGatewayNodeLiveness(target);
    }
    // The generation and per-node key prevent duplicate probes while allowing
    // every replacement Matrix client to verify each Gateway independently.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionStatus, gatewayNodeProbeTargets, gatewayUpdateReleaseKey]);

  useEffect(() => {
    const checkStaleNodes = () => {
      if (
        connectionStatusRef.current !== "connected" ||
        document.visibilityState !== "visible"
      ) return;
      const now = Date.now();
      for (const target of gatewayNodeProbeTargets) {
        if (
          target.canProbe &&
          shouldAutomaticallyCheckGatewayNode(
            gatewayNodeLivenessRef.current[target.gatewayNodeId],
            now,
          )
        ) {
          void probeGatewayNodeLiveness(target);
        }
      }
    };
    checkStaleNodes();
    const timer = window.setInterval(checkStaleNodes, 30_000);
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") checkStaleNodes();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
    // The probe function owns its per-node flight lock; current refs keep this
    // foreground trigger independent from render-local callback identities.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gatewayNodeProbeTargets, gatewayUpdateReleaseKey]);

  useEffect(() => {
    if (!gatewayUpdateDialogOpen) {
      gatewayUpdateProbeKeysRef.current.clear();
      return;
    }
    if (
      connectionStatus !== "connected" ||
      !gatewayRelease
    ) return;
    for (const node of gatewayUpdatePlan) {
      const target = gatewayNodeProbeTargetsById.get(node.gatewayNodeId);
      if (!gatewayUpdateTarget(node) || !target?.canProbe) continue;
      const key = `${gatewayRelease.releaseId}\0${gatewayRelease.buildId}\0${node.gatewayNodeId}`;
      if (gatewayUpdateProbeKeysRef.current.has(key)) continue;
      gatewayUpdateProbeKeysRef.current.add(key);
      void probeGatewayNodeLiveness(target);
    }
    // The probe function deliberately reads the current command refs. The
    // immutable release/node key above prevents state replies from re-probing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    connectionStatus,
    gatewayNodeProbeTargetsById,
    gatewayRelease,
    gatewayUpdateDialogOpen,
    gatewayUpdatePlan,
  ]);

  useEffect(() => {
    if (
      connectionStatus !== "connected" ||
      !gatewayRelease
    ) return;
    const checkProgress = () => {
      for (const node of gatewayUpdatePlan) {
        const runtime = gatewayUpdateRuntimeForRelease[node.gatewayNodeId];
        const status = runtime?.status;
        const activationStillSettling = status !== undefined && [
          "waiting_for_idle",
          "scheduled",
          "activating",
          "probation",
        ].includes(status.phase);
        const needsProgress = runtime?.state === "starting" || (
          gatewayUpdateStatusNeedsPolling(status) &&
          (status?.currentBuildId !== gatewayRelease.buildId || activationStillSettling)
        );
        if (!needsProgress) continue;
        const target = gatewayNodeProbeTargetsById.get(node.gatewayNodeId);
        if (target?.canProbe) void probeGatewayNodeLiveness(target);
      }
    };
    checkProgress();
    const timer = window.setInterval(checkProgress, GATEWAY_UPDATE_PROGRESS_POLL_MS);
    return () => window.clearInterval(timer);
    // Probe flights are de-duplicated by node. Runtime status changes recreate
    // this bounded timer and stop it as soon as the update reaches a user or
    // terminal boundary.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    connectionStatus,
    gatewayNodeProbeTargetsById,
    gatewayRelease,
    gatewayUpdatePlan,
    gatewayUpdateRuntimeForRelease,
  ]);

  useEffect(() => {
    if (connectionStatus !== "connected") return;
    for (const node of gatewayUpdatePlan) {
      if (!node.targetProjectId) continue;
      const intent = readGatewayUpdateIntent(
        window.localStorage,
        matrixConfig.gatewayId,
        node.gatewayNodeId,
      );
      if (!intent || intent.projectId !== node.targetProjectId) continue;
      const status = gatewayUpdateRuntimeForRelease[node.gatewayNodeId]?.status;
      if (!status) continue;
      if (
        ["scheduled", "activating", "probation", "committed", "rolled_back", "failed", "repair_required"]
          .includes(status.phase)
      ) {
        clearGatewayUpdateIntent(
          window.localStorage,
          matrixConfig.gatewayId,
          node.gatewayNodeId,
        );
        continue;
      }
      if (
        status.phase !== "staged" ||
        status.releaseId !== intent.releaseId ||
        status.targetBuildId !== intent.buildId ||
        gatewayUpdateActiveNodeId !== null
      ) continue;
      const key = `${node.gatewayNodeId}\0${status.updateId ?? status.releaseId}\0${status.updatedAt}`;
      if (gatewayUpdateResumeKeysRef.current.has(key)) continue;
      gatewayUpdateResumeKeysRef.current.add(key);
      void startGatewayUpdateNode(node).finally(() => {
        gatewayUpdateResumeKeysRef.current.delete(key);
      });
    }
    // The saved intent is written only after an explicit user action. It lets
    // a current client finish the old two-command protocol if the browser was
    // closed after stage but before apply, without touching pre-existing staged
    // updates that have no current-client intent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    connectionStatus,
    gatewayUpdateActiveNodeId,
    gatewayUpdatePlan,
    gatewayUpdateRuntimeForRelease,
    matrixConfig.gatewayId,
  ]);

  useEffect(() => {
    if (connectionStatus !== "connected") return;
    for (const node of gatewayUpdatePlan) {
      if (!node.targetProjectId) continue;
      const runtime = gatewayUpdateRuntimePresentation[node.gatewayNodeId];
      const status = runtime?.status;
      if (!gatewayMaintenanceSessionShouldAutoArchive(status)) continue;
      const sessionIds = [
        runtime.maintenanceSessionId,
        runtime.legacyMaintenanceSessionId,
      ].filter((value): value is string => Boolean(value));
      for (const sessionId of sessionIds) {
        const session = gatewayState?.sessions.find(candidate =>
          candidate.id === sessionId && candidate.projectId === node.targetProjectId,
        );
        if (!session || session.status === "archived") continue;
        const key = `${node.targetProjectId}\0${sessionId}\0${status.updatedAt}`;
        if (gatewayAutoArchiveKeysRef.current.has(key)) continue;
        gatewayAutoArchiveKeysRef.current.add(key);
        void archiveSession(sessionId, node.targetProjectId).catch(error => {
          gatewayAutoArchiveKeysRef.current.delete(key);
          console.warn(
            `[gateway-update/auto-archive] ${formatUiError(error)}`,
            error,
          );
        });
      }
    }
    // A committed status is the authenticated update transaction's cleanup
    // boundary. archiveSession sends the existing authenticated lifecycle
    // command, so old Gateways require no state migration.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    connectionStatus,
    gatewayState?.sessions,
    gatewayUpdatePlan,
    gatewayUpdateRuntimePresentation,
  ]);

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
      if (!trustedGateway) return;
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
  }, [trustedGateway]);

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
    if (connectionStatus !== "connecting" && connectionStatus !== "securing") {
      return;
    }
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
  }, [connectionStatus]);

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
    if (!injectedNativeBridgePort()) return;
    let active = true;
    // The updater owns a short native-bridge lease before Matrix restoration
    // starts below. This keeps APK recovery available even when this origin
    // has no saved Workspace authorization.
    void advanceNativeAppUpdate({ installReady: false })
      .then((status) => {
        if (active) {
          nativeUpdateStateRef.current = status;
          setNativeUpdateState(status);
        }
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!settingsOpen || !injectedNativeBridgePort()) return;
    let active = true;
    const startedAt = Date.now();
    const poll = async () => {
      if (
        !active ||
        nativeUpdateBusyRef.current ||
        nativeUpdatePollInFlightRef.current ||
        !shouldPollNativeUpdateStatus(
          nativeUpdateStateRef.current,
          Date.now() - startedAt,
        )
      ) return;
      const connection = malinkClientRef.current;
      // A persistent native client may be acquiring the only WebView bridge.
      // Wait until it is attached, then read through that client instead of
      // queuing a short lease behind a connection that may live indefinitely.
      if (!connection && matrixStartupRef.current !== null) return;
      nativeUpdatePollInFlightRef.current = true;
      try {
        const status = await requestNativeUpdateStatus(connection, false);
        if (active) {
          nativeUpdateStateRef.current = status;
          setNativeUpdateState(status);
        }
      } catch {
        // The manual action remains available. A transient bridge handoff must
        // not turn an optional status refresh into a connection error.
      } finally {
        nativeUpdatePollInFlightRef.current = false;
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), NATIVE_UPDATE_POLL_INTERVAL_MS);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [settingsOpen]);

  useEffect(() => {
    const route = pairingRouteFromUrl(window.location.href);
    const link = route.pairingLink;
    const invitation = route.deviceInvitation;
    const legacyShortInvitation = route.legacyShortInvitation;
    const deferStoredStartupForPairing =
      shouldDeferStoredMatrixStartupForPairing({
        pairingLink: link,
        deviceInvitation: invitation,
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
    void (async () => {
      if (rejectedQueryPairing) {
        await Promise.resolve();
        setConnectionError(
          "Pairing links in the URL query are not accepted. Scan the QR code or use a fragment invitation.",
        );
        setSettingsOpen(true);
        return;
      }
      if (legacyShortInvitation) {
        await Promise.resolve();
        setConnectionError(
          "This invitation used the retired short-link service. Create and share a new self-contained invitation.",
        );
        setSettingsOpen(true);
        return;
      }
      // The invitation flow owns native bridge startup for this boot. Restoring
      // a stored native session at the same time would attach a second Web
      // client before the one-time Matrix bootstrap can acquire the port.
      if (deferStoredStartupForPairing) return;
      const nativeSession = await resumeNativeMatrixSessionIfAvailable();
      if (nativeSession) {
        const nativeConfig = nativeMatrixSessionConfig(nativeSession);
        clearPendingPairing();
        setMatrixConfig(nativeConfig);
        saveMatrixConfig(nativeConfig);
        setSettingsOpen(false);
        await connectMalinkClient(nativeConfig, true, true);
        return;
      }
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
      if (!hasPairingRoute(route)) return;
      window.history.replaceState(
        window.history.state,
        "",
        route.sanitizedPath,
      );
      if (route.deviceInvitation) void openDeviceInvitation(route.deviceInvitation);
      else if (route.pairingLink) void openPairingLink(route.pairingLink);
      else if (route.legacyShortInvitation) {
        setConnectionError(
          "This invitation used the retired short-link service. Create and share a new self-contained invitation.",
        );
        setSettingsOpen(true);
      }
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
      if (recoveredNativeCommandTimerRef.current !== null) {
        window.clearTimeout(recoveredNativeCommandTimerRef.current);
        recoveredNativeCommandTimerRef.current = null;
      }
      recoveredNativeCommandsRef.current.clear();
      recoveredNativeCommandFlightsRef.current.clear();
      malinkClientRef.current?.dispose();
    },
    [],
  );

  function receiveMatrixMessage(incoming: IncomingMalinkMessage) {
    if (
      incoming.encrypted &&
      isLiveMessageDelivery(incoming)
    ) {
      const gatewayNodeId = incoming.projectId
        ? gatewayNodeByProjectRef.current.get(incoming.projectId)?.gatewayNodeId
        : incoming.sessionId
          ? gatewayNodeBySessionRef.current.get(incoming.sessionId)
          : undefined;
      if (gatewayNodeId) {
        const verifiedAt = Date.now();
        updateGatewayNodeLiveness(gatewayNodeId, current => ({
          ...current,
          state: "online",
          checkedAt: verifiedAt,
          lastVerifiedAt: verifiedAt,
          consecutiveNoReplies: 0,
          detail: "Recent signed Gateway activity was received.",
        }));
        setGatewayUpdateNodeRuntime(gatewayNodeId, current => ({
          ...current,
          state: "online",
          checkedAt: verifiedAt,
          lastVerifiedAt: verifiedAt,
          consecutiveNoReplies: 0,
          detail: undefined,
        }));
      }
    }
    if (incoming.revision !== undefined) {
      setGatewayRevision((current) =>
        current === null ? incoming.revision! : Math.max(current, incoming.revision!),
      );
    }
    const sessionId =
      incoming.sessionId ?? selectedSessionIdRef.current ?? undefined;
    const liveSessionKey = sessionId
      ? historyCacheSessionId(sessionId, incoming.projectId)
      : undefined;
    if (sessionId && isLiveMessageDelivery(incoming)) {
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
        removeLiveMessage(liveSessionKey ?? sessionId, replacementTarget);
        if (
          selectedSessionIdRef.current === sessionId &&
          (!incoming.projectId || selectedProjectIdRef.current === incoming.projectId)
        ) {
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
    if (sessionId && isLiveMessageDelivery(incoming)) {
      rememberLiveMessage(liveSessionKey ?? sessionId, message, {
        reconcileMessageId: optimisticMessageId,
      });
    }
    if (sessionId && historyScopeRef.current) {
      const cacheSessionId = historyCacheSessionId(
        sessionId,
        incoming.projectId,
      );
      const persist =
        message.kind === "user" && message.eventId
          ? reconcileMessageHistory(
              historyScopeRef.current,
              cacheSessionId,
              message,
              optimisticMessageId,
            )
          : saveMessageHistory(historyScopeRef.current, cacheSessionId, [message]);
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
      (sessionId !== selectedSessionIdRef.current ||
        (incoming.projectId !== undefined &&
          selectedProjectIdRef.current !== incoming.projectId))
    ) {
      return;
    }
    if (incoming.requestId && !isHistoricalMessageDelivery(incoming)) {
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
    if (!followLatestRef.current && isLiveMessageDelivery(incoming)) {
      setFeedHasUnseenMessages(true);
    }
    setMessages((current) =>
      mergeChatMessage(current, message, {
        reconcileMessageId: optimisticMessageId,
      }),
    );
  }

  function historyCacheSessionId(
    sessionId: string,
    projectId?: string,
  ): string {
    return projectId &&
      ambiguousGatewayMaintenanceSessionIdsRef.current.has(sessionId)
      ? `project:${projectId}\0session:${sessionId}`
      : sessionId;
  }

  function recoverLateHistory(page: MalinkHistoryRecovery): void {
    const scope = historyScopeRef.current;
    if (!scope) return;
    const recovered = page.messages.map((message) => {
      const incoming = incomingMessageFromClient(message);
      const deliveryMode = resolvedMessageDeliveryMode(incoming);
      return chatMessageFromIncoming(
        {
          ...incoming,
          deliveryMode,
          historical: deliveryMode === "history",
        },
        message.sessionId ?? page.sessionId,
      );
    });
    // Presentation persistence is a cache, not a delivery gate. A blocked
    // IndexedDB write must not hide already-verified native history.
    const recoveredProjectId = page.messages.find(message => message.projectId)?.projectId;
    persistRecoveredHistoryInBackground(
      scope,
      historyCacheSessionId(page.sessionId, recoveredProjectId),
      recovered,
    );
    if (historySessionIdRef.current !== page.sessionId) return;
    if (
      recoveredProjectId &&
      historyProjectIdRef.current !== recoveredProjectId
    ) return;
    historyCursorRef.current = olderHistoryCursor(
      historyCursorRef.current,
      recovered,
    );
    setMessages((current) => mergeChatMessages(current, recovered));
    setHistoryHasMore(page.hasMore);
    setHistoryError(null);
    setHistoryRetryMode(null);
  }

  function persistRecoveredHistoryInBackground(
    scope: string,
    sessionId: string,
    messages: readonly ChatMessage[],
  ): void {
    if (messages.length === 0) return;
    void persistMessageHistoryPage(scope, sessionId, messages).catch((error) => {
      showUiNotice(
        `history:save:${sessionId}`,
        "history",
        "warning",
        `Recovered history is visible, but its local cache could not be updated: ${formatUiError(error)}`,
      );
    });
  }

  function loadRemoteHistoryInBackground(
    sessionId: string,
    projectId: string | undefined,
    scope: string,
    connection: MalinkClient,
    generation: number,
    prepend: boolean,
  ): void {
    const active = historyRemoteFlightRef.current;
    if (
      active?.sessionId === sessionId
      && active.projectId === projectId
      && active.generation === generation
      && active.connection === connection
    ) return;

    const isCurrent = () =>
      generation === historyGenerationRef.current
      && historySessionIdRef.current === sessionId
      && historyProjectIdRef.current === (projectId ?? null)
      && malinkClientRef.current === connection;
    const flight = {
      sessionId,
      ...(projectId ? { projectId } : {}),
      generation,
      connection,
    };
    historyRemoteFlightRef.current = flight;
    if (isCurrent()) {
      setHistoryCheckingRemote(true);
      setHistoryError(null);
      setHistoryRetryMode(null);
    }
    void (async () => {
      try {
        const remote = await waitForHistoryOperation(
          connection.loadHistoryPage(sessionId, undefined, projectId),
          BACKGROUND_HISTORY_SOURCE_TIMEOUT_MS,
          "Matrix conversation history",
        );
        const olderMessages = remote.messages.map((message) =>
          chatMessageFromIncoming(
            {
              ...incomingMessageFromClient(message),
              deliveryMode: "history",
              historical: true,
            },
            message.sessionId ?? sessionId,
          ),
        );
        persistRecoveredHistoryInBackground(
          scope,
          historyCacheSessionId(sessionId, projectId),
          olderMessages,
        );
        if (!isCurrent()) return;
        if (olderMessages.length > 0) {
          if (prepend) prepareHistoryPrepend(feedRef.current, prependScrollRef);
          historyCursorRef.current = olderHistoryCursor(
            historyCursorRef.current,
            olderMessages,
          );
          setMessages((current) => mergeChatMessages(current, olderMessages));
        }
        setHistoryHasMore(remote.hasMore);
        setHistoryError(null);
        setHistoryRetryMode(null);
      } catch (error) {
        if (!isCurrent()) return;
        // Keep one explicit retry available, but never let a layout-driven
        // scroll event turn a slow Matrix archive into an automatic loop.
        setHistoryHasMore(true);
        setHistoryError(
          `Older history could not be loaded: ${formatUiError(error)}`,
        );
        setHistoryRetryMode("older");
      } finally {
        if (historyRemoteFlightRef.current === flight) {
          historyRemoteFlightRef.current = null;
        }
        if (isCurrent()) setHistoryCheckingRemote(false);
      }
    })();
  }

  function loadInitialConnectionHistoryInBackground(
    sessionId: string,
    projectId: string | undefined,
    scope: string,
    connection: MalinkClient,
    generation: number,
    cachedHasMore: boolean,
  ): void {
    const active = historyRemoteFlightRef.current;
    if (
      active?.sessionId === sessionId
      && active.projectId === projectId
      && active.generation === generation
      && active.connection === connection
    ) return;

    const isCurrent = () =>
      generation === historyGenerationRef.current
      && historySessionIdRef.current === sessionId
      && historyProjectIdRef.current === (projectId ?? null)
      && malinkClientRef.current === connection;
    const flight = {
      sessionId,
      ...(projectId ? { projectId } : {}),
      generation,
      connection,
    };
    historyRemoteFlightRef.current = flight;
    if (isCurrent()) {
      setHistoryCheckingRemote(true);
      setHistoryError(null);
      setHistoryRetryMode(null);
    }
    void (async () => {
      try {
        const local = await waitForHistoryOperation(
          connection.loadLocalHistory(sessionId, projectId),
          BACKGROUND_HISTORY_SOURCE_TIMEOUT_MS,
          "Local client conversation projection",
        );
        const localMessages = local.messages.map((message) =>
          chatMessageFromIncoming(
            {
              ...incomingMessageFromClient(message),
              deliveryMode: "history",
              historical: true,
            },
            message.sessionId ?? sessionId,
          ),
        );
        persistRecoveredHistoryInBackground(
          scope,
          historyCacheSessionId(sessionId, projectId),
          localMessages,
        );
        if (!isCurrent()) return;
        if (localMessages.length > 0) {
          historyCursorRef.current = olderHistoryCursor(
            historyCursorRef.current,
            localMessages,
          );
          setMessages((current) => mergeChatMessages(current, localMessages));
        }
        const localHasMore = cachedHasMore || local.hasMore;
        setHistoryHasMore(localHasMore);
        if (localHasMore) {
          setHistoryError(null);
          setHistoryRetryMode(null);
          return;
        }

        const remote = await waitForHistoryOperation(
          connection.loadHistoryPage(sessionId, undefined, projectId),
          BACKGROUND_HISTORY_SOURCE_TIMEOUT_MS,
          "Matrix conversation history",
        );
        const remoteMessages = remote.messages.map((message) =>
          chatMessageFromIncoming(
            {
              ...incomingMessageFromClient(message),
              deliveryMode: "history",
              historical: true,
            },
            message.sessionId ?? sessionId,
          ),
        );
        persistRecoveredHistoryInBackground(
          scope,
          historyCacheSessionId(sessionId, projectId),
          remoteMessages,
        );
        if (!isCurrent()) return;
        if (remoteMessages.length > 0) {
          historyCursorRef.current = olderHistoryCursor(
            historyCursorRef.current,
            remoteMessages,
          );
          setMessages((current) => mergeChatMessages(current, remoteMessages));
        }
        setHistoryHasMore(remote.hasMore);
        setHistoryError(null);
        setHistoryRetryMode(null);
      } catch (error) {
        if (!isCurrent()) return;
        setHistoryHasMore(cachedHasMore);
        setHistoryError(
          `Conversation history could not be restored: ${formatUiError(error)}`,
        );
        setHistoryRetryMode("restore");
      } finally {
        if (historyRemoteFlightRef.current === flight) {
          historyRemoteFlightRef.current = null;
        }
        if (isCurrent()) setHistoryCheckingRemote(false);
      }
    })();
  }

  async function restoreSessionHistory(
    sessionId: string,
    connection: MalinkClient | null = malinkClientRef.current,
    projectId?: string,
  ): Promise<void> {
    const scope = historyScopeRef.current;
    if (!scope) return;
    const cacheSessionId = historyCacheSessionId(sessionId, projectId);
    const generation = ++historyGenerationRef.current;
    historySessionIdRef.current = sessionId;
    historyProjectIdRef.current = projectId ?? null;
    historyCursorRef.current = null;
    followLatestRef.current = true;
    historyLoadingRef.current = true;
    setHistoryLoading(true);
    setHistoryCheckingRemote(false);
    setHistoryError(null);
    setHistoryRetryMode(null);
    setHistoryHasMore(false);
    setMessages([]);
    setDecisionStates({});
    try {
      const cached = await waitForHistoryOperation(
        loadMessageHistoryPage(scope, cacheSessionId),
        LOCAL_HISTORY_FOREGROUND_TIMEOUT_MS,
        "Local conversation history",
      );
      if (
        generation !== historyGenerationRef.current ||
        historySessionIdRef.current !== sessionId ||
        historyProjectIdRef.current !== (projectId ?? null)
      ) {
        return;
      }
      const cachedMessages = cached.messages.map((message) => ({
        ...message,
        sessionId,
        deliveryMode: "history" as const,
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
        void saveMessageHistory(
          scope,
          cacheSessionId,
          interruptedSends,
        ).catch((error) => {
          showUiNotice(
            `history:save:${sessionId}`,
            "history",
            "warning",
            `Interrupted message state is visible, but its local cache could not be updated: ${formatUiError(error)}`,
          );
        });
      }
      const liveMessages =
        liveMessagesBySessionRef.current.get(cacheSessionId) ?? [];
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
      setHistoryHasMore(cached.hasMore);

      if (!connection) return;
      connection.markHistoryLoaded(
        sessionId,
        cachedMessages.flatMap((message) =>
          message.eventId ? [message.eventId] : [],
        ),
        projectId,
      );
      // Browser persistence is the only foreground restore. Native/Web local
      // projection and Matrix relations continue behind a bounded status row,
      // so neither a bridge handoff nor the homeserver can keep the feed in
      // `Loading earlier messages`.
      loadInitialConnectionHistoryInBackground(
        sessionId,
        projectId,
        scope,
        connection,
        generation,
        cached.hasMore,
      );
    } catch (error) {
      if (
        generation === historyGenerationRef.current &&
        historySessionIdRef.current === sessionId
      ) {
        setHistoryError(
          `Conversation history could not be restored: ${formatUiError(error)}`,
        );
        setHistoryRetryMode("restore");
        if (connection) {
          // A damaged or blocked presentation cache must not cut off the
          // authoritative native/Web projection. A successful background
          // restore clears this transient cache error.
          loadInitialConnectionHistoryInBackground(
            sessionId,
            projectId,
            scope,
            connection,
            generation,
            false,
          );
        }
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
    const projectId = historyProjectIdRef.current ?? undefined;
    const scope = historyScopeRef.current;
    if (
      !sessionId ||
      !scope ||
      historyLoadingRef.current ||
      !historyHasMore
    ) {
      return;
    }
    const cacheSessionId = historyCacheSessionId(sessionId, projectId);
    const generation = historyGenerationRef.current;
    historyLoadingRef.current = true;
    setHistoryLoading(true);
    setHistoryError(null);
    setHistoryRetryMode(null);
    try {
      const cached = await waitForHistoryOperation(
        loadMessageHistoryPage(scope, cacheSessionId, {
          before: historyCursorRef.current,
        }),
        LOCAL_HISTORY_FOREGROUND_TIMEOUT_MS,
        "Local conversation history",
      );
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
          deliveryMode: "history" as const,
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
        // Consume one local page immediately. Matrix pagination begins only at
        // the local edge and never extends the foreground loading indicator.
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
          projectId,
        );
        setHistoryHasMore(cached.hasMore);
        if (!cached.hasMore) {
          loadRemoteHistoryInBackground(
            sessionId,
            projectId,
            scope,
            connection,
            generation,
            true,
          );
        }
        return;
      }

      const connection = malinkClientRef.current;
      if (!connection) {
        setHistoryHasMore(false);
        return;
      }
      setHistoryHasMore(false);
      loadRemoteHistoryInBackground(
        sessionId,
        projectId,
        scope,
        connection,
        generation,
        true,
      );
    } catch (error) {
      if (
        generation === historyGenerationRef.current &&
        historySessionIdRef.current === sessionId
      ) {
        setHistoryError(
          `Older history could not be loaded: ${formatUiError(error)}`,
        );
        setHistoryRetryMode("older");
        const connection = malinkClientRef.current;
        if (connection) {
          setHistoryHasMore(false);
          loadRemoteHistoryInBackground(
            sessionId,
            projectId,
            scope,
            connection,
            generation,
            true,
          );
        }
      }
    } finally {
      if (generation === historyGenerationRef.current) {
        historyLoadingRef.current = false;
        setHistoryLoading(false);
      }
    }
  }

  function handleFeedScroll() {
    const feed = feedRef.current;
    if (!feed) return;
    followLatestRef.current = isNearFeedBottom(feed);
    setFeedAwayFromLatest(!followLatestRef.current);
    if (followLatestRef.current) setFeedHasUnseenMessages(false);
    if (shouldAutoLoadEarlierMessages({
      scrollTop: feed.scrollTop,
      hasMore: historyHasMore,
      loading: historyLoadingRef.current,
      checkingRemote: historyCheckingRemote,
      hasError: Boolean(historyError),
    })) {
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

  function activateLocalSession(
    sessionId: string | null,
    connection: MalinkClient | null = malinkClientRef.current,
    revealProject = true,
    skipHistoryRestore = false,
    requestedProjectId?: string,
  ) {
    const openedSession = gatewayState?.sessions.find(
      (session) => session.id === sessionId &&
        (!requestedProjectId || session.projectId === requestedProjectId),
    );
    const projectId = sessionId
      ? openedSession?.projectId ?? requestedProjectId ?? null
      : null;
    const sessionChanged = selectedSessionIdRef.current !== sessionId ||
      selectedProjectIdRef.current !== projectId;
    selectedSessionIdRef.current = sessionId;
    selectedProjectIdRef.current = projectId;
    setSelectedSessionId(sessionId);
    setSelectedProjectId(projectId);
    if (historyScopeRef.current) {
      writeSelectedSessionRoute(
        window.localStorage,
        historyScopeRef.current,
        sessionId ? { sessionId, ...(projectId ? { projectId } : {}) } : null,
      );
    }
    if (openedSession) {
      setSessionReadState((current) => markSessionRead(current, openedSession));
      if (sessionChanged && revealProject) {
        const projectKey = openedSession.scope === "scratch"
          ? `${matrixConfig.gatewayId}\u0000${
              (projectGatewaysById.get(openedSession.projectId) ?? fallbackProjectGateway)
                .gatewayNodeId
            }\u0000scratch`
          : gatewayProjectKey(
              matrixConfig.gatewayId,
              openedSession.projectId,
            );
        setCollapsedProjects((current) =>
          setProjectCollapsed(current, projectKey, false),
        );
      }
    }
    if (!sessionChanged) return;
    setExpandedProcessTurnIds(new Set());
    followLatestRef.current = true;
    setFeedAwayFromLatest(false);
    setFeedHasUnseenMessages(false);
    setComposerOptionsOpen(false);
    historyGenerationRef.current += 1;
    historySessionIdRef.current = sessionId;
    historyProjectIdRef.current = projectId;
    historyCursorRef.current = null;
    setHistoryCheckingRemote(false);
    setMessages([]);
    setDecisionStates({});
    setHistoryHasMore(Boolean(sessionId) && !skipHistoryRestore);
    setHistoryError(null);
    setHistoryRetryMode(null);
    if (!sessionId || skipHistoryRestore) {
      historyLoadingRef.current = false;
      setHistoryLoading(false);
    } else if (connection) {
      void restoreSessionHistory(sessionId, connection, projectId ?? undefined);
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

  function commitOptimisticProjectCreate(
    record: OptimisticProjectCreateRecord,
  ): void {
    optimisticProjectCreateRef.current = record;
    setOptimisticProjectCreate(record);
    try {
      writeOptimisticProjectCreate(window.localStorage, record);
    } catch (error) {
      showUiNotice(
        "project:create-storage",
        "session",
        "warning",
        `Project creation remains visible while this page stays open, but could not be saved for reload: ${formatUiError(error)}`,
      );
    }
  }

  function removeOptimisticProjectCreate(localId: string): void {
    if (optimisticProjectCreateRef.current?.localId !== localId) return;
    optimisticProjectCreateRef.current = null;
    setOptimisticProjectCreate(null);
    if (projectCreateRecoveryTimerRef.current !== null) {
      window.clearTimeout(projectCreateRecoveryTimerRef.current);
      projectCreateRecoveryTimerRef.current = null;
    }
    try {
      clearOptimisticProjectCreate(window.localStorage, localId);
    } catch (error) {
      showUiNotice(
        "project:create-storage",
        "session",
        "warning",
        `The completed project creation marker could not be cleared: ${formatUiError(error)}`,
      );
    }
  }

  function markOptimisticProjectCreateFailed(
    localId: string,
    error: unknown,
  ): void {
    const record = optimisticProjectCreateRef.current;
    if (!record || record.localId !== localId) return;
    commitOptimisticProjectCreate(
      failOptimisticProjectCreate(record, formatUiError(error)),
    );
  }

  function holdProjectCreateForConflictReview(
    localId: string,
    commandId: string,
  ): boolean {
    const record = optimisticProjectCreateRef.current;
    if (!record || record.localId !== localId) return false;
    const bound = record.commandId
      ? rebindOptimisticProjectCreate(
          record,
          record.commandId,
          commandId,
        )
      : bindOptimisticProjectCreate(record, commandId);
    if (!bound) return false;
    commitOptimisticProjectCreate(
      markOptimisticProjectCreateUncertain(
        bound,
        "Project creation is waiting for conflict review. Confirm or discard the saved command before retrying.",
      ),
    );
    return true;
  }

  function schedulePendingProjectCreateRecovery(
    connection: MalinkClient,
  ): void {
    if (projectCreateRecoveryTimerRef.current !== null) {
      window.clearTimeout(projectCreateRecoveryTimerRef.current);
    }
    projectCreateRecoveryTimerRef.current = window.setTimeout(() => {
      projectCreateRecoveryTimerRef.current = null;
      if (
        malinkClientRef.current === connection &&
        connectionStatusRef.current === "connected"
      ) {
        continuePendingProjectCreate(connection);
      }
    }, 5_000);
  }

  function continuePendingProjectCreate(
    connection: MalinkClient,
    acknowledgedCommand?: MalinkCommandSendResult,
  ): void {
    const record = optimisticProjectCreateRef.current;
    if (
      !record?.commandId ||
      record.phase === "syncing" ||
      record.phase === "failed"
    ) {
      return;
    }
    if (
      acknowledgedCommand &&
      acknowledgedCommand.commandId !== record.commandId
    ) {
      return;
    }
    if (
      projectCreateRecoveryInFlightRef.current?.commandId === record.commandId
    ) {
      return;
    }
    projectCreateRecoveryInFlightRef.current = {
      commandId: record.commandId,
      connection,
    };
    void (async () => {
      let activeCommandId = record.commandId!;
      try {
        const sent = acknowledgedCommand ??
          (await connection.recoverCommand(activeCommandId));
        if (sent.commandId !== activeCommandId) {
          const current = optimisticProjectCreateRef.current;
          const rebound = current
            ? rebindOptimisticProjectCreate(
                current,
                activeCommandId,
                sent.commandId,
              )
            : null;
          if (!rebound) return;
          activeCommandId = rebound.commandId!;
          commitOptimisticProjectCreate(rebound);
          projectCreateRecoveryInFlightRef.current = {
            commandId: activeCommandId,
            connection,
          };
        }
        recoverUiNotice("project:create");
        const completion = await waitForCommandCompletion(
          sent.completion,
          PROJECT_CREATE_RESULT_TIMEOUT_MS,
        );
        await consumeProjectCreateCompletion(
          connection,
          activeCommandId,
          completion,
        );
      } catch (error) {
        const current = optimisticProjectCreateRef.current;
        if (!current || current.commandId !== activeCommandId) return;
        if (
          error instanceof CommandRevisionConflictError ||
          error instanceof CommandReviewRequiredError
        ) {
          const commandId = error instanceof CommandRevisionConflictError
            ? error.commandId
            : error.review.commandId;
          holdProjectCreateForConflictReview(current.localId, commandId);
          if (error instanceof CommandRevisionConflictError) {
            const conflict: RevisionConflictNotice = {
              commandId: error.commandId,
              expectedRevision: error.expectedRevision,
              payload: error.payload,
              busy: false,
            };
            revisionConflictRef.current = conflict;
            setRevisionConflict(conflict);
          } else {
            const review: NativeCommandReviewNotice = {
              ...error.review,
              busy: false,
            };
            nativeCommandReviewRef.current = review;
            setNativeCommandReview(review);
          }
          showUiNotice(
            "project:create",
            "session",
            "warning",
            "Project creation is saved and needs conflict review before it can continue.",
          );
          return;
        }
        if (isMissingSessionCreateRecoveryCommand(error)) {
          markOptimisticProjectCreateFailed(
            current.localId,
            "The saved project creation command is no longer available. The project may still appear if the Gateway completed it before local recovery was lost.",
          );
          showUiNotice(
            "project:create",
            "session",
            "warning",
            "The unfinished local project command is no longer available. Check the project list before retrying.",
          );
          return;
        }
        const uncertain =
          error instanceof CommandCompletionTimeoutError ||
          Date.now() - current.createdAt >= PROJECT_CREATE_RESULT_TIMEOUT_MS;
        if (uncertain) {
          commitOptimisticProjectCreate(
            markOptimisticProjectCreateUncertain(
              current,
              "The Gateway accepted this project command, but its final result has not arrived yet. Malink will keep checking the same command.",
            ),
          );
          showUiNotice(
            "project:create",
            "session",
            "warning",
            "Project creation is taking longer than expected. You can keep working while Malink checks the original command.",
          );
        } else {
          commitOptimisticProjectCreate(
            markOptimisticProjectCreateUncertain(
              current,
              `Malink could not confirm the project result yet: ${formatUiError(error)}`,
            ),
          );
          showUiNotice(
            "project:create",
            "session",
            "warning",
            `Project result recovery hit an error and will retry the same command: ${formatUiError(error)}`,
          );
        }
        if (
          malinkClientRef.current === connection &&
          connectionStatusRef.current === "connected"
        ) {
          schedulePendingProjectCreateRecovery(connection);
        }
      } finally {
        if (
          projectCreateRecoveryInFlightRef.current?.commandId === activeCommandId
        ) {
          projectCreateRecoveryInFlightRef.current = null;
        }
        const currentConnection = malinkClientRef.current;
        if (
          optimisticProjectCreateRef.current?.commandId === activeCommandId &&
          currentConnection &&
          currentConnection !== connection &&
          connectionStatusRef.current === "connected"
        ) {
          continuePendingProjectCreate(currentConnection);
        }
      }
    })();
  }

  async function consumeProjectCreateCompletion(
    connection: MalinkClient,
    commandId: string,
    completion: CommandCompletion,
  ): Promise<void> {
    const record = optimisticProjectCreateRef.current;
    if (!record || record.commandId !== commandId) return;
    try {
      completedCommandResultsRef.current.delete(commandId);
      const failure = projectCreateFailureMessage(completion);
      if (failure) {
        markOptimisticProjectCreateFailed(record.localId, failure);
        showUiNotice("project:create", "session", "error", failure);
        return;
      }
      const projectId = completedProjectId(completion);
      if (!projectId) {
        markOptimisticProjectCreateFailed(
          record.localId,
          "The Gateway reported success without a project identity. Refresh before retrying.",
        );
        showUiNotice(
          "project:create",
          "session",
          "error",
          "The project result was incomplete. Refresh before retrying so the existing project is not duplicated.",
        );
        return;
      }
      commitOptimisticProjectCreate(
        syncOptimisticProjectCreate(record, projectId),
      );
      showUiNotice(
        "project:create",
        "session",
        "success",
        `${record.input.name} was created. Its encrypted project view is syncing in the background.`,
        7_000,
      );
    } finally {
      try {
        await connection.releaseCommand(commandId);
      } catch (error) {
        showUiNotice(
          "project:create-release",
          "session",
          "warning",
          `Project creation finished, but its completed local command could not be cleaned up yet: ${formatUiError(error)}`,
        );
      }
    }
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
              "Your computer accepted the secure command. Malink is still checking its final result in the background; checking it again cannot create a duplicate.",
            ),
          );
          clearPendingSessionCreateUi();
          showUiNotice(
            "session:create",
            "session",
            "warning",
            "Session creation has not reached a confirmed result yet. Malink will keep checking the same saved command and will not submit it twice.",
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
    const currentProjectCreate = optimisticProjectCreateRef.current;
    const projectCreateForBinding = currentProjectCreate &&
      projectCreateRecoveryMatches(currentProjectCreate, configInput)
      ? currentProjectCreate
      : readOptimisticProjectCreate(window.localStorage, configInput);
    if (currentProjectCreate !== projectCreateForBinding) {
      optimisticProjectCreateRef.current = projectCreateForBinding;
      setOptimisticProjectCreate(projectCreateForBinding);
      if (projectCreateRecoveryTimerRef.current !== null) {
        window.clearTimeout(projectCreateRecoveryTimerRef.current);
        projectCreateRecoveryTimerRef.current = null;
      }
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
      setObservedCommandCompletions([]);
      setExpandedProcessTurnIds(new Set());
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
      setSelectedProjectId(null);
      setRunningSessionIds(new Set());
      stoppingSessionIdsRef.current = new Set();
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
      selectedProjectIdRef.current = null;
      historySessionIdRef.current = null;
      historyProjectIdRef.current = null;
      historyCursorRef.current = null;
      historyGenerationRef.current += 1;
      historyLoadingRef.current = false;
      setHistoryLoading(false);
      setHistoryCheckingRemote(false);
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
      const rememberedSession = readSelectedSessionRoute(
        window.localStorage,
        historyScopeRef.current,
      );
      if (!automaticRecovery && !preserveGatewayProjection) {
        selectedSessionIdRef.current = rememberedSession?.sessionId ?? null;
        selectedProjectIdRef.current = rememberedSession?.projectId ?? null;
        setSelectedSessionId(rememberedSession?.sessionId ?? null);
        setSelectedProjectId(rememberedSession?.projectId ?? null);
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
                scheduleRecoveredNativeCommandReconciliation(
                  activeConnection,
                  1_000,
                );
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
        onSessionCreateRecovered(recovery) {
          if (!isCurrentStartup()) return;
          const draft = optimisticSessionRef.current;
          if (
            !draft ||
            draft.commandId ||
            draft.phase !== "failed" ||
            recovery.submittedAt < draft.createdAt - 5_000
          ) return;
          rememberPendingSessionCreate(draft.input, recovery.commandId);
          commitOptimisticSession(
            bindOptimisticSession(
              retryOptimisticSession(draft),
              recovery.commandId,
              recovery.completion.sessionId,
            ),
          );
          const activeConnection = malinkClientRef.current;
          if (activeConnection) continuePendingSessionCreate(activeConnection);
        },
        onDurableCommandRecovered(command) {
          if (!isCurrentStartup()) return;
          recoveredNativeCommandsRef.current.set(command.commandId, command);
          syncRecoveredNativeCommands();
        },
        onCommandResult(result) {
          if (!isCurrentStartup()) return;
          observeCommandCompletion(result);
          const pendingSessionCreate = pendingSessionCreateRecoveryRef.current;
          const activeConnection = malinkClientRef.current;
          if (
            activeConnection &&
            sessionCreateCompletionMatchesRecovery(
              pendingSessionCreate,
              result,
            )
          ) {
            // The bounded foreground waiter may already have timed out. This
            // authenticated terminal event is still the result of the exact
            // persisted create command, so consume it immediately without
            // submitting or reserving another command.
            void consumeSessionCreateCompletion(
              activeConnection,
              result.commandId,
              result,
            );
            return;
          }
          const gatewayUpdateProbe = [...gatewayUpdateProbeCommandsRef.current.values()]
            .find(probe => probe.commandId === result.commandId);
          if (gatewayUpdateProbe) {
            // A native WebView can reconnect after the foreground waiter has
            // timed out. Consume the authenticated terminal event through the
            // still-owned node probe instead of leaving that probe attached to
            // the disposed client's Promise or submitting another command.
            gatewayUpdateProbe.consume(result);
            return;
          }
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
          continuePendingProjectCreate(connection);
          continuePendingSessionCreate(connection);
          scheduleRecoveredNativeCommandReconciliation(connection, 1_000);
          const sessionId = selectedSessionIdRef.current;
          if (
            sessionId &&
            optimisticSessionRef.current?.localSessionId === sessionId
          ) {
            void restoreOptimisticSessionMessages(optimisticSessionRef.current);
          } else if (sessionId) {
            void restoreSessionHistory(
              sessionId,
              connection,
              selectedProjectIdRef.current ?? undefined,
            );
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
    if (recoveredNativeCommandTimerRef.current !== null) {
      window.clearTimeout(recoveredNativeCommandTimerRef.current);
      recoveredNativeCommandTimerRef.current = null;
    }
    recoveredNativeCommandsRef.current.clear();
    recoveredNativeCommandFlightsRef.current.clear();
    setRecoveredNativeCommands([]);
    setRecoveredNativeCommandFlightIds(new Set());
    setRecoveredNativeCommandChecks({});
    completionObservationOrderRef.current = 0;
    setObservedCommandCompletions([]);
    setExpandedProcessTurnIds(new Set());
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
    if (projectCreateRecoveryTimerRef.current !== null) {
      window.clearTimeout(projectCreateRecoveryTimerRef.current);
      projectCreateRecoveryTimerRef.current = null;
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
    setSelectedProjectId(null);
    setGatewayState(null);
    setGatewayRevision(null);
    selectedSessionIdRef.current = null;
    selectedProjectIdRef.current = null;
    historyGenerationRef.current += 1;
    historySessionIdRef.current = null;
    historyProjectIdRef.current = null;
    historyCursorRef.current = null;
    historyLoadingRef.current = false;
    setHistoryLoading(false);
    setHistoryCheckingRemote(false);
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
    selectedProjectIdRef.current = null;
    setSelectedSessionId(null);
    setSelectedProjectId(null);
    setPairingPreview(null);
    setDeviceInvitation(null);
    setInvitationReauthRequired(false);
    setConnectionError(null);
    setPairingError(null);
    setMessages([]);
    if (historyScope) {
      writeSelectedSessionRoute(window.localStorage, historyScope, null);
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
          roomBinding: nativeMatrixRoomBindingFromPairingPreview(preview),
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
            roomBinding: nativeMatrixRoomBindingFromPairingPreview(preview),
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
          if (fullInvitation.expiresAt <= Date.now() + 15_000) {
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
          return fullInvitation;
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
      setGatewayEnrollmentInvitation({
        link: enrollment.enrollmentLink,
        expiresAt: enrollment.expiresAt,
      });
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

  function setGatewayUpdateNodeRuntime(
    gatewayNodeId: string,
    update: (current: GatewayUpdateNodeRuntime) => GatewayUpdateNodeRuntime,
  ): void {
    setGatewayUpdateRuntimeByNode(current => ({
      ...current,
      [gatewayNodeId]: {
        ...update(
          current[gatewayNodeId]?.releaseKey === gatewayUpdateReleaseKey
            ? current[gatewayNodeId]
            : { state: "unchecked" },
        ),
        ...(gatewayUpdateReleaseKey ? { releaseKey: gatewayUpdateReleaseKey } : {}),
      },
    }));
  }

  function setGatewayArchivePreflight(sessionId: string, checking: boolean): void {
    const next = new Set(gatewayArchivePreflightSessionIdsRef.current);
    if (checking) next.add(sessionId);
    else next.delete(sessionId);
    gatewayArchivePreflightSessionIdsRef.current = next;
    setGatewayArchivePreflightSessionIds(next);
  }

  async function archiveGatewayMaintenanceSession(
    node: GatewayUpdatePlanNode,
    sessionId: string,
  ): Promise<void> {
    if (gatewayArchivePreflightSessionIdsRef.current.has(sessionId)) return;
    setGatewayArchivePreflight(sessionId, true);
    try {
      const target = gatewayNodeProbeTargetsById.get(node.gatewayNodeId);
      const status = target
        ? await probeGatewayNodeLiveness(target)
        : null;
      if (!gatewayMaintenanceSessionCanBeArchived(status ?? undefined)) {
        showUiNotice(
          `gateway-update:archive-blocked:${node.gatewayNodeId}`,
          "update",
          "warning",
          "This update session is still owned by the Gateway supervisor. It will be archived automatically after the update is committed or safely rolled back.",
          10_000,
        );
        return;
      }
      if (node.targetProjectId) {
        await archiveSession(sessionId, node.targetProjectId);
      }
    } finally {
      setGatewayArchivePreflight(sessionId, false);
    }
  }

  function updateGatewayNodeLiveness(
    gatewayNodeId: string,
    update: (current: GatewayNodeLiveness) => GatewayNodeLiveness,
  ): GatewayNodeLiveness {
    const current = gatewayNodeLivenessRef.current[gatewayNodeId] ?? {
      state: "unknown",
    };
    const next = update(current);
    const values = {
      ...gatewayNodeLivenessRef.current,
      [gatewayNodeId]: next,
    };
    gatewayNodeLivenessRef.current = values;
    setGatewayNodeLivenessById(values);
    setGatewayLivenessNow(Date.now());
    return next;
  }

  async function probeGatewayNodeLiveness(
    target: GatewayNodeLivenessTarget,
  ): Promise<GatewayUpdateStatus | null> {
    const gatewayNodeId = target.gatewayNodeId;
    const gatewayLabel = target.computerName ?? target.gatewayName;
    if (!target.canProbe || !target.targetProjectId) {
      updateGatewayNodeLiveness(gatewayNodeId, current => ({
        ...current,
        state: "unavailable",
        detail: target.unavailableReason === "route"
          ? "This client has no synchronized project route for a signed live check."
          : "This Gateway build does not advertise the signed live-status capability.",
      }));
      return null;
    }
    if (connectionStatusRef.current !== "connected") return null;
    if (gatewayNodeProbeFlightsRef.current.has(gatewayNodeId)) return null;
    gatewayNodeProbeFlightsRef.current.add(gatewayNodeId);
    const probeStartedAt = Date.now();
    updateGatewayNodeLiveness(gatewayNodeId, current => ({
      ...current,
      state: "checking",
      checkedAt: probeStartedAt,
      detail: undefined,
    }));
    setGatewayUpdateNodeRuntime(gatewayNodeId, current => ({
      ...current,
      state: "checking",
      detail: undefined,
    }));
    let probe = gatewayUpdateProbeCommandsRef.current.get(gatewayNodeId) ?? null;
    let commandId = probe?.commandId ?? null;
    const applyCompletion = (completion: CommandCompletion): GatewayUpdateStatus | null => {
      const checkedAt = Date.now();
      updateGatewayNodeLiveness(gatewayNodeId, current => ({
        ...current,
        state: "online",
        checkedAt,
        lastVerifiedAt: checkedAt,
        consecutiveNoReplies: 0,
        detail: completion.outcome === "succeeded"
          ? undefined
          : completion.error?.message
            ? `This Gateway replied, but its update supervisor reported: ${completion.error.message}`
            : "This Gateway replied, but its update supervisor is unavailable.",
      }));
      if (completion.outcome !== "succeeded") {
        setGatewayUpdateNodeRuntime(gatewayNodeId, current => ({
          ...current,
          state: "online",
          checkedAt,
          lastVerifiedAt: checkedAt,
          consecutiveNoReplies: 0,
          detail: completion.error?.message
            ? `Gateway replied, but its update supervisor reported: ${completion.error.message}`
            : "Gateway replied, but its update supervisor is unavailable.",
        }));
        return null;
      }
      const status = gatewayUpdateStatusSchema.parse(completion.result);
      setGatewayState(current => current ? { ...current, gatewayUpdate: status } : current);
      setGatewayUpdateNodeRuntime(gatewayNodeId, current => ({
        ...current,
        state: "online",
        checkedAt,
        lastVerifiedAt: checkedAt,
        consecutiveNoReplies: 0,
        status,
        maintenanceSessionId:
          status.releaseId === gatewayRelease?.releaseId
            ? status.maintenanceSessionId
            : undefined,
        detail: undefined,
      }));
      return status;
    };
    const releaseProbe = async (completedCommandId: string): Promise<boolean> => {
      const pending = gatewayUpdateProbeCommandsRef.current.get(gatewayNodeId);
      if (pending?.commandId !== completedCommandId) return false;
      try {
        const connection = malinkClientRef.current;
        if (!connection) return false;
        await connection.releaseCommand(completedCommandId);
      } catch (error) {
        console.warn(
          `[gateway-update/probe-release] ${formatUiError(error)}`,
          error,
        );
      }
      if (
        gatewayUpdateProbeCommandsRef.current.get(gatewayNodeId)?.commandId ===
        completedCommandId
      ) {
        gatewayUpdateProbeCommandsRef.current.delete(gatewayNodeId);
      }
      completedCommandResultsRef.current.delete(completedCommandId);
      return true;
    };
    const observeLateCompletion = (pending: GatewayUpdateProbeRecord): void => {
      void pending.completion.then((completion) => {
        pending.consume(completion);
      }).catch(() => {
        // A bounded native completion observer can expire while the durable
        // command remains recoverable. Keep the actionable no-reply state;
        // Retry will recover the same identity on older native hosts.
      });
    };
    try {
      if (probe) {
        const connection = malinkClientRef.current;
        if (!connection) throw new Error("The connected client is unavailable.");
        const recovered = await connection.recoverCommand(probe.commandId);
        if (recovered.commandId !== probe.commandId) {
          gatewayUpdateProbeCommandsRef.current.delete(gatewayNodeId);
          probe.commandId = recovered.commandId;
          commandId = recovered.commandId;
        }
        probe.completion = recovered.completion;
        gatewayUpdateProbeCommandsRef.current.set(gatewayNodeId, probe);
      } else {
        const sent = await sendRealCommand({
          operation: "gateway.update.status",
        }, target.targetProjectId, {
          autoRetryRevisionConflict: true,
          propagateFailure: true,
        });
        if (!sent) {
          throw new Error("The client could not send the signed live-status request.");
        }
        commandId = sent.commandId;
        const created: GatewayUpdateProbeRecord = {
          commandId,
          completion: sent.completion,
          completed: false,
          status: null,
          consume(completion) {
            if (created.completed) return created.status;
            const pending = gatewayUpdateProbeCommandsRef.current.get(gatewayNodeId);
            if (pending !== created || created.commandId !== completion.commandId) return null;
            created.completed = true;
            try {
              created.status = applyCompletion(completion);
              return created.status;
            } catch (error) {
              setGatewayUpdateNodeRuntime(gatewayNodeId, current => ({
                ...current,
                state: "error",
                checkedAt: Date.now(),
                detail: `The Gateway returned an invalid live-status result: ${formatUiError(error)}`,
              }));
              return null;
            } finally {
              void releaseProbe(completion.commandId);
            }
          },
        };
        probe = created;
        gatewayUpdateProbeCommandsRef.current.set(gatewayNodeId, created);
      }
      const completion = await waitForCommandCompletion(
        probe.completion,
        GATEWAY_LIVE_STATUS_TIMEOUT_MS,
      );
      return probe.consume(completion);
    } catch (error) {
      if (error instanceof CommandCompletionTimeoutError && commandId !== null && probe) {
        const checkedAt = Date.now();
        const liveness = updateGatewayNodeLiveness(gatewayNodeId, current =>
          gatewayNodeLivenessAfterProbeTimeout({
            current,
            probeStartedAt,
            checkedAt,
            gatewayLabel,
          }),
        );
        setGatewayUpdateNodeRuntime(gatewayNodeId, current => ({
          ...current,
          state: liveness.state === "online" ? "online" : "unreachable",
          checkedAt: liveness.checkedAt,
          lastVerifiedAt: liveness.lastVerifiedAt,
          consecutiveNoReplies: liveness.consecutiveNoReplies,
          detail: liveness.detail,
        }));
        // A timeout is not a terminal result. Keep the exact read-only command
        // durable and ask the native host to reconcile it through the Gateway
        // journal and bounded Matrix history. Releasing here would discard the
        // command identity immediately before the recovery path can use it.
        try {
          const connection = malinkClientRef.current;
          if (!connection) throw new Error("The connected client is unavailable.");
          const recovered = await connection.recoverCommand(commandId);
          if (recovered.commandId !== probe.commandId) {
            gatewayUpdateProbeCommandsRef.current.delete(gatewayNodeId);
            probe.commandId = recovered.commandId;
          }
          probe.completion = recovered.completion;
          gatewayUpdateProbeCommandsRef.current.set(gatewayNodeId, probe);
        } catch (recoveryError) {
          console.warn(
            `[gateway-update/probe-recovery] ${formatUiError(recoveryError)}`,
            recoveryError,
          );
        }
        observeLateCompletion(probe);
        return null;
      }
      const detail = commandId === null
        ? `The live-status command was not sent: ${formatUiError(error)}`
        : formatUiError(error);
      updateGatewayNodeLiveness(gatewayNodeId, current => ({
        ...current,
        state: "unknown",
        checkedAt: Date.now(),
        detail,
      }));
      setGatewayUpdateNodeRuntime(gatewayNodeId, current => ({
        ...current,
        state: "error",
        checkedAt: Date.now(),
        detail,
      }));
      return null;
    } finally {
      gatewayNodeProbeFlightsRef.current.delete(gatewayNodeId);
    }
  }

  async function startGatewayUpdateNode(node: GatewayUpdatePlanNode): Promise<void> {
    if (!gatewayRelease || gatewayUpdateActiveNodeId) return;
    const target = gatewayUpdateTarget(node);
    if (!target || node.state !== "available") return;
    setGatewayUpdateActiveNodeId(node.gatewayNodeId);
    try {
      const runtime = gatewayUpdateRuntimeForRelease[node.gatewayNodeId];
      const recentlyOnline =
        runtime?.state === "online" &&
        runtime.status !== undefined &&
        runtime.checkedAt !== undefined &&
        Date.now() - runtime.checkedAt <= 30_000;
      const liveStatus = recentlyOnline
        ? runtime.status
        : await probeGatewayNodeLiveness(
            gatewayNodeProbeTargetsById.get(node.gatewayNodeId) ?? {
              gatewayNodeId: node.gatewayNodeId,
              gatewayName: node.gatewayName,
              ...(node.computerName ? { computerName: node.computerName } : {}),
              ...(node.currentBuildId ? { currentBuildId: node.currentBuildId } : {}),
              ...(node.targetProjectId ? { targetProjectId: node.targetProjectId } : {}),
              canProbe: Boolean(node.targetProjectId),
              ...(!node.targetProjectId ? { unavailableReason: "route" as const } : {}),
            },
          );
      if (!liveStatus) return;
      const intentRelease = liveStatus.phase === "staged" &&
        liveStatus.releaseId &&
        liveStatus.targetBuildId
        ? {
            releaseId: liveStatus.releaseId,
            buildId: liveStatus.targetBuildId,
          }
        : {
            releaseId: gatewayRelease.releaseId,
            buildId: gatewayRelease.buildId,
          };
      const intentPersisted = writeGatewayUpdateIntent(window.localStorage, {
        version: 1,
        workspaceId: matrixConfig.gatewayId,
        gatewayNodeId: node.gatewayNodeId,
        projectId: target.targetProjectId,
        ...intentRelease,
        requestedAt: Date.now(),
      });
      if (!intentPersisted) {
        showUiNotice(
          `gateway-update:intent:${node.gatewayNodeId}`,
          "update",
          "warning",
          "The update can continue now, but this browser could not save automatic resume state. Keep this page open until preparation finishes.",
        );
      }
      if (gatewayUpdateNoticeKey) {
        setDismissedGatewayUpdateNoticeKey(gatewayUpdateNoticeKey);
      }
      setGatewayUpdateNodeRuntime(node.gatewayNodeId, current => ({
        ...current,
        state: "starting",
        startedAt: Date.now(),
        detail: undefined,
        commandFailureCode: undefined,
        commandFailureRetryable: undefined,
      }));
      const stagedReleaseId = liveStatus.phase === "staged"
        ? liveStatus.releaseId
        : undefined;
      const status = stagedReleaseId && liveStatus.targetBuildId
        ? await executeGatewayUpdateRef.current({
            operation: "gateway.update.apply",
            releaseId: stagedReleaseId,
            mode: "when_idle",
          }, target.targetProjectId)
        : await triggerGatewayUpdate({
            release: gatewayRelease,
            target,
            send: (command, targetProjectId) =>
              executeGatewayUpdateRef.current(command, targetProjectId),
          });
      setGatewayUpdateNodeRuntime(node.gatewayNodeId, current => ({
        ...current,
        state: "online",
        checkedAt: Date.now(),
        status,
        maintenanceSessionId: status.maintenanceSessionId,
        commandFailureCode: undefined,
        commandFailureRetryable: undefined,
      }));
      clearGatewayUpdateIntent(
        window.localStorage,
        matrixConfig.gatewayId,
        node.gatewayNodeId,
      );
      showUiNotice(
        `gateway-update:${node.gatewayNodeId}`,
        "connection",
        "success",
        status.phase === "committed"
          ? `${node.gatewayName} already runs release ${status.releaseId ?? gatewayRelease.releaseId}.`
          : ["waiting_for_idle", "scheduled", "activating", "probation"].includes(status.phase)
            ? `${node.gatewayName} scheduled release ${status.releaseId ?? gatewayRelease.releaseId} and will switch after current Agent work finishes.`
            : `${node.gatewayName} created its maintenance session and will continue automatically.`,
        8_000,
      );
    } catch (error) {
      clearGatewayUpdateIntent(
        window.localStorage,
        matrixConfig.gatewayId,
        node.gatewayNodeId,
      );
      const detail = formatUiError(error);
      const commandFailure = error instanceof GatewayUpdateCommandFailure
        ? error
        : null;
      setGatewayUpdateNodeRuntime(node.gatewayNodeId, current => ({
        ...current,
        state: "error",
        detail,
        ...(commandFailure
          ? {
              commandFailureCode: commandFailure.code,
              commandFailureRetryable: commandFailure.retryable,
            }
          : {}),
      }));
      // Stage failures such as a missing published Prompt are persisted by the
      // supervisor before the command fails. Refresh that signed status now so
      // the user immediately receives the correct recovery action instead of
      // being left with a disabled panel that only changes after a manual check.
      const probeTarget = gatewayNodeProbeTargetsById.get(node.gatewayNodeId);
      if (probeTarget) {
        const refreshed = await probeGatewayNodeLiveness(probeTarget);
        if (refreshed && commandFailure) {
          setGatewayUpdateNodeRuntime(node.gatewayNodeId, current => ({
            ...current,
            commandFailureCode: commandFailure.code,
            commandFailureRetryable: commandFailure.retryable,
          }));
        }
      }
      showUiNotice(
        `gateway-update:${node.gatewayNodeId}`,
        "connection",
        "warning",
        `${node.gatewayName} could not complete its Gateway update request: ${detail}`,
      );
    } finally {
      setGatewayUpdateActiveNodeId(null);
    }
  }

  function openGatewayUpdateSession(projectId: string, sessionId: string): void {
    setGatewayUpdateDialogOpen(false);
    setPrimaryView("chats");
    setMobileChatOpen(true);
    activateLocalSession(sessionId, malinkClientRef.current, true, false, projectId);
  }

  async function executeGatewayUpdate(
    payload: Extract<CommandPayload, { operation: `gateway.update.${string}` }>,
    targetProjectId: string | undefined,
    timeoutMs?: number,
  ) {
    let commandId: string | null = null;
    let completion: CommandCompletion;
    try {
      const sent = await sendRealCommand(payload, targetProjectId, {
        autoRetryRevisionConflict: true,
        propagateFailure: true,
      });
      if (!sent) throw new Error("The connected client could not send the Gateway update request.");
      commandId = sent.commandId;
      completion = await waitForCommandCompletion(
        sent.completion,
        timeoutMs ?? (payload.operation === "gateway.update.status" ? 60_000 : 30 * 60_000),
      );
    } finally {
      if (commandId) {
        completedCommandResultsRef.current.delete(commandId);
        await malinkClientRef.current?.releaseCommand(commandId).catch(() => undefined);
      }
    }
    if (completion.outcome !== "succeeded") {
      throw new GatewayUpdateCommandFailure(
        completion.error?.message ?? "The Gateway update request did not complete.",
        completion.error?.code ?? "gateway_update_failed",
        completion.error?.retryable === true,
      );
    }
    const parsed = gatewayUpdateStatusSchema.safeParse(completion.result);
    let status: GatewayUpdateStatus;
    if (parsed.success) {
      status = parsed.data;
    } else if (payload.operation !== "gateway.update.status") {
      status = await recoverAmbiguousGatewayUpdateCompletion({
        operation: payload.operation,
        releaseId: payload.releaseId,
        readStatus: () => executeGatewayUpdate(
          { operation: "gateway.update.status" },
          targetProjectId,
          60_000,
        ),
      });
    } else {
      throw new Error(
        "The Gateway signed a successful status reply, but it did not contain a readable update status. " +
          "The update command was not repeated. Update the Gateway Host manually or export diagnostics if this continues.",
      );
    }
    setGatewayState((current) => current ? { ...current, gatewayUpdate: status } : current);
    return status;
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
    if (nativeUpdateOperationInProgress(nativeUpdateStateRef.current)) return;
    nativeUpdateBusyRef.current = true;
    setNativeUpdateBusy(true);
    try {
      const current = nativeUpdateStateRef.current;
      const checkNow = !(
        installReady &&
        (current?.phase === "ready" || current?.phase === "permission_required")
      );
      const status = await requestNativeUpdateStatus(
        malinkClientRef.current,
        installReady,
        checkNow,
      );
      nativeUpdateStateRef.current = status;
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
          status.detailCode === "manual_check_unavailable"
            ? "This installed APK predates immediate checks. It will still check automatically, or open the official APK releases from Settings."
            : "The APK update did not complete. Restart Malink and try again; if it still fails, export diagnostics.",
        );
      }
    } catch {
      setNativeUpdateState((current) => {
        const failed = current ? {
          ...current,
          phase: "failed" as const,
          detailCode: "bridge_request_failed",
        } : current;
        nativeUpdateStateRef.current = failed;
        return failed;
      });
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
      await writeClipboardTextWithTimeout(pageLink);
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

  function exportConnectionDiagnostics(): Promise<boolean> {
    const existing = diagnosticExportFlightRef.current;
    if (existing) return existing;
    setDiagnosticExportBusy(true);
    const flight = performConnectionDiagnosticsExport();
    diagnosticExportFlightRef.current = flight;
    void flight.finally(() => {
      if (diagnosticExportFlightRef.current !== flight) return;
      diagnosticExportFlightRef.current = null;
      setDiagnosticExportBusy(false);
    });
    return flight;
  }

  async function performConnectionDiagnosticsExport(): Promise<boolean> {
    try {
      const report = createConnectionDiagnostics({
        buildVersion: MALINK_BUILD_VERSION,
        status: connectionStatus,
        detail: connectionDetail,
        deviceKeyId,
        nativeRuntime,
        gateways: gatewayState?.gatewayDirectory?.directory.gateways,
        gatewayHealth: gatewayNodeProbeTargets.map(target => {
          const liveness = gatewayNodeLivenessRef.current[target.gatewayNodeId];
          const update = gatewayUpdateRuntimeByNode[target.gatewayNodeId]?.status;
          return {
            gatewayNodeId: target.gatewayNodeId,
            state: liveness?.state ?? "unknown",
            ...(liveness?.checkedAt !== undefined ? { checkedAt: liveness.checkedAt } : {}),
            ...(liveness?.lastVerifiedAt !== undefined
              ? { lastVerifiedAt: liveness.lastVerifiedAt }
              : {}),
            ...(liveness?.consecutiveNoReplies !== undefined
              ? { consecutiveNoReplies: liveness.consecutiveNoReplies }
              : {}),
            ...(update
              ? {
                  update: {
                    phase: update.phase,
                    ...(update.releaseId ? { releaseId: update.releaseId } : {}),
                    ...(update.currentBuildId
                      ? { currentBuildId: update.currentBuildId }
                      : {}),
                    ...(update.targetBuildId
                      ? { targetBuildId: update.targetBuildId }
                      : {}),
                    updatedAt: update.updatedAt,
                  },
                }
              : {}),
          };
        }),
        online: navigator.onLine,
        visibility: document.visibilityState,
        userAgent: navigator.userAgent,
      });
      const connection = malinkClientRef.current;
      if (connection?.runtime === "native") {
        if (!connection.exportDiagnostics || !(await connection.exportDiagnostics())) {
          throw new Error(
            "This APK cannot open the Android diagnostic share sheet. Update the APK and try again.",
          );
        }
        showUiNotice(
          "diagnostics:exported",
          "update",
          "success",
          "Android opened the diagnostic share sheet. Choose where to save or send the report.",
          8_000,
        );
        return true;
      }
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
      showUiNotice(
        "diagnostics:exported",
        "diagnostics",
        "success",
        "Diagnostic download started.",
        5_000,
      );
      return true;
    } catch (error) {
      showUiNotice(
        "diagnostics:export-failed",
        "update",
        "error",
        `Diagnostic export failed: ${formatUiError(error)}`,
        12_000,
      );
      return false;
    }
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
    if (
      pendingSessionCreateRecoveryRef.current?.commandId !== commandId
    ) return;
    let sessionToReveal: string | null = null;
    let skipHistoryRestore = false;
    try {
      completedCommandResultsRef.current.delete(commandId);
      const failureMessage = sessionCreateFailureMessage(completion);
      if (failureMessage) {
        const draft = optimisticSessionRef.current;
        if (draft) {
          markOptimisticSessionFailed(draft.localSessionId, failureMessage);
        }
        showUiNotice(
          "session:create",
          "session",
          "error",
          failureMessage,
        );
        return;
      }
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
          const projectId = current.input.projectId ?? null;
          selectedSessionIdRef.current = remoteSessionId;
          selectedProjectIdRef.current = projectId;
          historySessionIdRef.current = remoteSessionId;
          historyProjectIdRef.current = projectId;
          setSelectedSessionId(remoteSessionId);
          setSelectedProjectId(projectId);
          setMessages(localMessages);
          if (scope) {
            writeSelectedSessionRoute(
              window.localStorage,
              scope,
              {
                sessionId: remoteSessionId,
                ...(projectId ? { projectId } : {}),
              },
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
      if (conflict.payload.operation === "project.create") {
        const record = optimisticProjectCreateRef.current;
        if (record?.commandId === conflict.commandId) {
          const rebound = rebindOptimisticProjectCreate(
            record,
            conflict.commandId,
            result.commandId,
          );
          if (rebound) {
            commitOptimisticProjectCreate(rebound);
            revisionConflictRef.current = null;
            setRevisionConflict(null);
            continuePendingProjectCreate(connection, result);
            return;
          }
        }
      }
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
        if (conflict.payload.operation === "project.create") {
          const record = optimisticProjectCreateRef.current;
          if (record) {
            holdProjectCreateForConflictReview(
              record.localId,
              error.commandId,
            );
          }
        }
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
      if (conflict.payload.operation === "project.create") {
        const record = optimisticProjectCreateRef.current;
        if (record?.commandId === conflict.commandId) {
          markOptimisticProjectCreateFailed(
            record.localId,
            "Project creation was discarded after conflict review.",
          );
        }
      }
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
      const projectCreate = optimisticProjectCreateRef.current;
      if (projectCreate?.commandId === review.commandId) {
        const rebound = rebindOptimisticProjectCreate(
          projectCreate,
          review.commandId,
          sent.commandId,
        );
        if (rebound) {
          commitOptimisticProjectCreate(rebound);
          retriedCommandId = null;
          nativeCommandReviewRef.current = null;
          setNativeCommandReview(null);
          continuePendingProjectCreate(connection, sent);
          return;
        }
      }
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
        const projectCreate = optimisticProjectCreateRef.current;
        if (projectCreate?.commandId === review.commandId) {
          holdProjectCreateForConflictReview(
            projectCreate.localId,
            error.review.commandId,
          );
        }
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
      const projectCreate = optimisticProjectCreateRef.current;
      if (projectCreate?.commandId === review.commandId) {
        markOptimisticProjectCreateFailed(
          projectCreate.localId,
          "Project creation was discarded after conflict review.",
        );
      }
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

  function chooseSession(id: string, projectId?: string) {
    setPrimaryView("chats");
    setMobileChatOpen(true);
    activateLocalSession(id, malinkClientRef.current, true, false, projectId);
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
    const requestKey = providerHistoryCommandKey(load);
    const pending = providerHistoryPendingCommandsRef.current.get(requestKey);
    if (pending) {
      const connection = malinkClientRef.current;
      if (!connection || connectionStatus !== "connected") {
        throw new Error("Reconnect to your computer before retrying provider history.");
      }
      const recovered = await connection.recoverCommand(pending.commandId);
      providerHistoryPendingCommandsRef.current.set(requestKey, {
        ...pending,
        commandId: recovered.commandId,
      });
      return recovered;
    }
    const sent = await sendRealCommand(payload, load.projectId);
    if (!sent) {
      throw new Error(
        "Provider history could not be sent. Check the connection notice, then retry.",
      );
    }
    providerHistoryPendingCommandsRef.current.set(requestKey, {
      commandId: sent.commandId,
      gatewayNodeId: load.gatewayNodeId,
      projectId: load.projectId,
      provider: load.provider,
      kind: load.kind,
      ...(load.providerSessionId === undefined
        ? {}
        : { providerSessionId: load.providerSessionId }),
      ...(load.cursor === undefined ? {} : { cursor: load.cursor }),
    });
    return sent;
  }

  async function finishProviderHistoryCommand(
    load: ProviderHistoryLoadState,
    sent: MalinkCommandSendResult,
  ): Promise<CommandCompletion> {
    const completion = await waitForCommandCompletion(
      sent.completion,
      PROVIDER_HISTORY_RESULT_TIMEOUT_MS,
    );
    const requestKey = providerHistoryCommandKey(load);
    const pending = providerHistoryPendingCommandsRef.current.get(requestKey);
    if (pending?.commandId === sent.commandId) {
      providerHistoryPendingCommandsRef.current.delete(requestKey);
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

  async function executeProviderHistoryCommand(
    load: ProviderHistoryLoadState,
    payload: Extract<
      CommandPayload,
      { operation: "provider.sessions.list" | "provider.session.inspect" }
    >,
  ): Promise<CommandCompletion> {
    const requestKey = providerHistoryCommandKey(load);
    const currentFlight = providerHistoryCommandFlightsRef.current.get(requestKey);
    if (currentFlight) return currentFlight;
    const flight = (async () => {
      const sent = await sendOrRecoverProviderHistoryCommand(load, payload);
      return finishProviderHistoryCommand(load, sent);
    })();
    providerHistoryCommandFlightsRef.current.set(requestKey, flight);
    try {
      return await flight;
    } finally {
      if (providerHistoryCommandFlightsRef.current.get(requestKey) === flight) {
        providerHistoryCommandFlightsRef.current.delete(requestKey);
      }
    }
  }

  async function openProviderHistory(request: OpenProviderHistoryRequest = {}) {
    providerHistoryBackgroundedRef.current = false;
    recoverUiNotice("provider:history-background");
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
    let backgroundFailure: string | null = null;
    try {
      const loadedProviderSessions: ProviderSessionEntry[] = [];
      let cursor: string | undefined;
      do {
        const pageLoad: ProviderHistoryLoadState = {
          ...load,
          ...(cursor === undefined ? {} : { cursor }),
        };
        const completion = await executeProviderHistoryCommand(
          pageLoad,
          {
            operation: "provider.sessions.list",
            provider,
            ...(cursor === undefined ? {} : { cursor }),
          },
        );
        if (completion.outcome !== "succeeded") {
          throw new Error(completion.error?.message || "Provider history could not be loaded.");
        }
        const result = completion.result;
        if (!result || typeof result !== "object" || Array.isArray(result) || result.type !== "provider.sessions.listed") {
          throw new Error("The provider returned an invalid session list.");
        }
        const page = Array.isArray(result.sessions)
          ? result.sessions.map(entry => providerSessionEntrySchema.parse(entry))
          : [];
        loadedProviderSessions.push(...page);
        cursor = typeof result.nextCursor === "string" ? result.nextCursor : undefined;
        if (cursor && page.length === 0) {
          throw new Error("The provider returned an empty history page with another page pending.");
        }
        if (providerHistoryLoadRef.current?.id === load.id) {
          setProviderHistorySessions([...loadedProviderSessions]);
        }
      } while (cursor);
      if (providerHistoryLoadRef.current?.id === load.id) {
        providerHistoryLoadedProviderRef.current = providerKey;
        setProviderHistorySessions(loadedProviderSessions);
        const currentFocus = providerHistoryFocusRef.current;
        if (
          currentFocus?.gatewayNodeId === source.gatewayNodeId
          && currentFocus.projectId === source.projectId
          && currentFocus.provider === provider
        ) {
          focusedSession = findRecentlyArchivedProviderSession(
            loadedProviderSessions,
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
        backgroundFailure = error instanceof CommandCompletionTimeoutError
          ? "The signed result has not reached this device yet. Reopen Provider History to recover the same request safely; it will not run twice."
          : formatUiError(error);
        setProviderHistoryError(backgroundFailure);
      }
    } finally {
      if (providerHistoryLoadRef.current?.id === load.id) {
        providerHistoryLoadRef.current = null;
        setProviderHistoryLoad(null);
        finishProviderHistoryBackground(backgroundFailure);
      }
    }
    if (focusedSession) {
      await inspectProviderHistorySession(focusedSession);
    }
  }

  async function inspectProviderHistorySession(session: ProviderSessionEntry) {
    const provider = providerHistoryProviderRef.current;
    if (!provider) return;
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
    let backgroundFailure: string | null = null;
    try {
      const completion = await executeProviderHistoryCommand(
        load,
        {
          operation: "provider.session.inspect",
          provider,
          providerSessionId: session.sessionId,
        },
      );
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
        backgroundFailure = formatUiError(error);
        setProviderHistoryError(backgroundFailure);
      }
    } finally {
      if (providerHistoryLoadRef.current?.id === load.id) {
        providerHistoryLoadRef.current = null;
        setProviderHistoryLoad(null);
        finishProviderHistoryBackground(backgroundFailure);
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
    providerHistoryBackgroundedRef.current = false;
    recoverUiNotice("provider:history-background");
    setProviderHistoryOpen(false);
    chooseSession(sessionId, source.projectId);
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
    providerHistoryBackgroundedRef.current = false;
    recoverUiNotice("provider:history-background");
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

  async function createProject(
    input: NewProjectInput,
    retryRecord?: OptimisticProjectCreateRecord,
  ): Promise<void> {
    if (newProjectBusy) return;
    if (optimisticProjectCreateRef.current && !retryRecord) {
      showUiNotice(
        "project:create",
        "session",
        "info",
        "Finish or dismiss the current project creation before starting another one.",
      );
      setNewProjectOpen(false);
      return;
    }
    const target = projectCreationGateways.find(gateway =>
      gateway.gatewayNodeId === input.gatewayNodeId &&
      gateway.targetProjectId === input.targetProjectId,
    );
    if (!target) {
      showUiNotice(
        "project:create",
        "session",
        "error",
        "The selected Gateway route changed. Reopen project creation and try again.",
      );
      return;
    }
    const gatewayLabel = gatewayProjectOwner(
      target.gatewayNodeId,
      target.gatewayName,
      target.computerName,
    ).label;
    const localRecord = retryRecord
      ? retryOptimisticProjectCreate({
          ...retryRecord,
          gatewayLabel,
          input,
        })
      : createOptimisticProjectCreate(
          input,
          {
            gatewayId: matrixConfig.gatewayId,
            conversationId: matrixConfig.conversationId,
          },
          gatewayLabel,
          `local-project:${crypto.randomUUID()}`,
        );
    commitOptimisticProjectCreate(localRecord);
    setNewProjectOpen(false);
    setNewProjectBusy(true);
    recoverUiNotice("project:create");
    showUiNotice(
      "project:create",
      "session",
      "info",
      `${input.name} is being created in the background. You can keep working.`,
    );
    let connection: MalinkClient | null = null;
    try {
      await waitForUiCommit();
      connection = malinkClientRef.current;
      const sent = await sendRealCommand({
        operation: "project.create",
        name: input.name,
        cwd: input.cwd,
        ...(input.provider ? { provider: input.provider } : {}),
        createDirectory: input.createDirectory,
      }, target.targetProjectId, {
        autoRetryRevisionConflict: true,
        propagateFailure: true,
      });
      if (!sent || !connection) {
        throw new Error("The secure project command was not accepted.");
      }
      const current = optimisticProjectCreateRef.current;
      if (!current || current.localId !== localRecord.localId) return;
      commitOptimisticProjectCreate(
        bindOptimisticProjectCreate(current, sent.commandId),
      );
      continuePendingProjectCreate(connection, sent);
    } catch (error) {
      if (error instanceof CommandAcknowledgementTimeoutError && connection) {
        const current = optimisticProjectCreateRef.current;
        if (current?.localId === localRecord.localId) {
          commitOptimisticProjectCreate(
            bindOptimisticProjectCreate(current, error.commandId),
          );
        }
        showUiNotice(
          "project:create",
          "session",
          "warning",
          "Project creation is queued securely. Malink will resume this same command without creating a duplicate.",
        );
        continuePendingProjectCreate(connection);
      } else if (
        error instanceof CommandRevisionConflictError ||
        error instanceof CommandReviewRequiredError
      ) {
        const commandId = error instanceof CommandRevisionConflictError
          ? error.commandId
          : error.review.commandId;
        if (holdProjectCreateForConflictReview(localRecord.localId, commandId)) {
          showUiNotice(
            "project:create",
            "session",
            "warning",
            "Project creation is saved and needs conflict review before it can continue.",
          );
        }
      } else {
        markOptimisticProjectCreateFailed(localRecord.localId, error);
        showUiNotice(
          "project:create",
          "session",
          "error",
          formatUiError(error),
        );
      }
    } finally {
      setNewProjectBusy(false);
    }
  }

  async function updateProjectSettings(input: ProjectSettingsInput): Promise<void> {
    const project = projectSettingsWorkspace;
    if (!project || projectSettingsBusy) return;
    setProjectSettingsBusy(true);
    let commandId: string | null = null;
    try {
      const sent = await sendRealCommand({
        operation: "project.settings",
        name: input.name,
        model: input.model,
        reasoningEffort: input.reasoningEffort,
      }, project.projectId, { propagateFailure: true });
      if (!sent) return;
      commandId = sent.commandId;
      const completion = await sent.completion;
      if (completion.outcome !== "succeeded") {
        throw new Error(completion.error?.message ?? "The project settings could not be updated.");
      }
      setProjectSettingsProjectId(null);
      showUiNotice(
        "project:settings",
        "session",
        "success",
        `${input.name} was updated. New conversations will use its new defaults.`,
        6_000,
      );
    } catch (error) {
      showUiNotice("project:settings", "session", "error", formatUiError(error));
    } finally {
      if (commandId) {
        completedCommandResultsRef.current.delete(commandId);
        await malinkClientRef.current?.releaseCommand(commandId).catch(() => undefined);
      }
      setProjectSettingsBusy(false);
    }
  }

  async function deleteProject(): Promise<void> {
    const project = projectSettingsWorkspace;
    if (!project || projectSettingsBusy || !projectSettingsCanDelete) return;
    setProjectSettingsBusy(true);
    let commandId: string | null = null;
    try {
      const sent = await sendRealCommand(
        { operation: "project.delete" },
        project.projectId,
        { propagateFailure: true },
      );
      if (!sent) return;
      commandId = sent.commandId;
      const completion = await sent.completion;
      if (completion.outcome !== "succeeded") {
        throw new Error(completion.error?.message ?? "The project could not be deleted.");
      }
      const nextSession = gatewayState?.sessions.find(session =>
        session.projectId !== project.projectId && session.status !== "archived"
      );
      if (selected?.projectId === project.projectId) {
        activateLocalSession(nextSession?.id ?? null);
      }
      setProjectSettingsProjectId(null);
      showUiNotice(
        "project:delete",
        "session",
        "success",
        `${project.projectName} was removed from Malink. Its working directory was not erased.`,
        7_000,
      );
    } catch (error) {
      showUiNotice("project:delete", "session", "error", formatUiError(error));
    } finally {
      if (commandId) {
        completedCommandResultsRef.current.delete(commandId);
        await malinkClientRef.current?.releaseCommand(commandId).catch(() => undefined);
      }
      setProjectSettingsBusy(false);
    }
  }

  function retryFailedOptimisticProjectCreate(): void {
    const record = optimisticProjectCreateRef.current;
    if (!record || record.phase !== "failed" || newProjectBusy) return;
    void createProject(record.input, record);
  }

  function recheckUncertainOptimisticProjectCreate(): void {
    const record = optimisticProjectCreateRef.current;
    const connection = malinkClientRef.current;
    if (
      !record?.commandId ||
      record.phase !== "uncertain" ||
      !connection ||
      connectionStatusRef.current !== "connected" ||
      projectCreateRecoveryInFlightRef.current
    ) {
      return;
    }
    commitOptimisticProjectCreate({
      ...record,
      phase: "creating",
      error: undefined,
      updatedAt: Date.now(),
    });
    continuePendingProjectCreate(connection);
  }

  function dismissOptimisticProjectCreate(): void {
    const record = optimisticProjectCreateRef.current;
    if (!record || record.phase === "creating" || record.phase === "syncing") {
      return;
    }
    if (
      record.phase === "uncertain" &&
      !window.confirm(
        "Stop showing this pending project? The Gateway may still finish the original command, and the project will then appear normally.",
      )
    ) {
      return;
    }
    removeOptimisticProjectCreate(record.localId);
    recoverUiNotice("project:create");
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
    try {
      // Let React commit the pending row before Matrix encryption, IndexedDB,
      // acknowledgement, and command-result work begins.
      await waitForUiCommit();
      const connection = malinkClientRef.current;
      if (!connection) {
        throw new Error("The secure session command was not accepted.");
      }
      if (input.setAsProjectDefault) {
        const settingsUpdate = await sendRealCommand({
          operation: "project.settings",
          model: input.model ?? null,
          reasoningEffort: input.reasoningEffort ?? null,
          defaultExtensions: input.extensions ?? [],
        }, input.projectId);
        if (!settingsUpdate || (await settingsUpdate.completion).outcome !== "succeeded") {
          throw new Error("The project defaults could not be updated.");
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
      if (!sent) {
        throw new Error("The secure session command was not accepted.");
      }
      rememberPendingSessionCreate(input, sent.commandId);
      // The native client has durably accepted the command at this point. Set
      // this before any presentation work so a later UI failure can never turn
      // a real command into a retryable draft that creates a duplicate.
      durableCommandRecorded = true;
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
      continuePendingSessionCreate(connection, sent);
    } catch (error) {
      const connection = malinkClientRef.current;
      if (error instanceof CommandAcknowledgementTimeoutError) {
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
        if (connection) continuePendingSessionCreate(connection);
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
    requestedProjectId?: string,
    onSucceeded?: () => void | Promise<void>,
    onFailed?: () => void | Promise<void>,
  ): Promise<boolean> {
    const matchingSessions = gatewayState?.sessions.filter(
      session => session.id === sessionId,
    ) ?? [];
    if (!requestedProjectId && matchingSessions.length > 1) {
      const gatewayMaintenanceSession = sessionId.startsWith("gateway-update-");
      showUiNotice(
        `session:${action}`,
        "session",
        "warning",
        gatewayMaintenanceSession
          ? "This older Gateway update session exists on more than one computer. Open Gateway software and archive it from the named Gateway so Malink cannot send the action to the wrong computer."
          : "This session identity appears under more than one project. Refresh conversations before trying again; Malink did not send an ambiguous archive command.",
      );
      if (gatewayMaintenanceSession) setGatewayUpdateDialogOpen(true);
      return false;
    }
    const sessionProjectId = requestedProjectId ?? matchingSessions[0]?.projectId;
    const session = sessionProjectId
      ? matchingSessions.find(candidate => candidate.projectId === sessionProjectId)
      : undefined;
    if (!sessionProjectId || !session) {
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
    const lifecycleKey = sessionLifecycleRouteKey(sessionProjectId, sessionId);
    updateSessionLifecycleBusy((current) => {
      const next = new Map(current);
      next.set(lifecycleKey, action);
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
          if (current.get(lifecycleKey) !== action) return new Map(current);
          const next = new Map(current);
          next.delete(lifecycleKey);
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
        sessionProjectId,
        onSucceeded,
        onFailed,
      );
      return true;
    } catch (error) {
      if (error instanceof CommandAcknowledgementTimeoutError && connection) {
        const recovery = rememberSessionLifecycleRecovery(
          error.commandId,
          action,
          sessionId,
          sessionProjectId,
          onSucceeded,
          onFailed,
        );
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
        if (current.get(lifecycleKey) !== action) return new Map(current);
        const next = new Map(current);
        next.delete(lifecycleKey);
        return next;
      });
      return false;
    }
  }

  function rememberSessionLifecycleRecovery(
    commandId: string,
    action: "archive",
    sessionId: string,
    projectId: string,
    onSucceeded?: () => void | Promise<void>,
    onFailed?: () => void | Promise<void>,
  ): PendingSessionLifecycleRecovery {
    const existing = sessionLifecycleRecoveriesRef.current.get(commandId);
    if (existing) return existing;
    const recovery: PendingSessionLifecycleRecovery = {
      commandId,
      action,
      sessionId,
      projectId,
      ...(onSucceeded ? { onSucceeded } : {}),
      ...(onFailed ? { onFailed } : {}),
      timer: null,
      inFlight: false,
    };
    sessionLifecycleRecoveriesRef.current.set(commandId, recovery);
    return recovery;
  }

  function recoveredNativeCommandIsOwned(commandId: string): boolean {
    return pendingSessionCreateRecoveryRef.current?.commandId === commandId
      || optimisticProjectCreateRef.current?.commandId === commandId
      || sessionLifecycleRecoveriesRef.current.has(commandId)
      || nativeCommandReviewRef.current?.commandId === commandId;
  }

  function scheduleRecoveredNativeCommandReconciliation(
    connection: MalinkClient,
    delayMs = 5_000,
  ): void {
    if (recoveredNativeCommandTimerRef.current !== null) {
      window.clearTimeout(recoveredNativeCommandTimerRef.current);
    }
    recoveredNativeCommandTimerRef.current = window.setTimeout(() => {
      recoveredNativeCommandTimerRef.current = null;
      if (
        malinkClientRef.current === connection
        && connectionStatusRef.current === "connected"
      ) {
        reconcileRecoveredNativeCommands(connection);
      }
    }, delayMs);
  }

  function reconcileRecoveredNativeCommands(connection: MalinkClient): void {
    for (const [commandId, command] of recoveredNativeCommandsRef.current) {
      if (
        command.state === "needs_review"
        || recoveredNativeCommandIsOwned(commandId)
        || recoveredNativeCommandFlightsRef.current.has(commandId)
      ) {
        continue;
      }
      recoveredNativeCommandFlightsRef.current.add(commandId);
      syncRecoveredNativeCommandFlights();
      void (async () => {
        let currentCommandId = commandId;
        let retryDelayMs: number | null = null;
        try {
          const sent = await connection.recoverCommand(commandId);
          currentCommandId = sent.commandId;
          if (currentCommandId !== commandId) {
            recoveredNativeCommandsRef.current.delete(commandId);
            recoveredNativeCommandsRef.current.set(currentCommandId, {
              ...command,
              commandId: currentCommandId,
            });
            recoveredNativeCommandFlightsRef.current.add(currentCommandId);
            syncRecoveredNativeCommands();
            syncRecoveredNativeCommandFlights();
          }
          if (recoveredNativeCommandIsOwned(currentCommandId)) return;
          await waitForCommandCompletion(
            sent.completion,
            RECOVERED_COMMAND_CHECK_TIMEOUT_MS,
          );
          if (recoveredNativeCommandIsOwned(currentCommandId)) return;
          await connection.releaseCommand(currentCommandId);
          completedCommandResultsRef.current.delete(commandId);
          completedCommandResultsRef.current.delete(currentCommandId);
          forgetRecoveredNativeCommand(commandId, currentCommandId);
          recoverUiNotice("command:startup-recovery");
        } catch (error) {
          if (
            error instanceof CommandReviewRequiredError
            || isMissingSessionCreateRecoveryCommand(error)
          ) {
            forgetRecoveredNativeCommand(commandId, currentCommandId);
            return;
          }
          retryDelayMs = error instanceof CommandCompletionTimeoutError
            ? RECOVERED_COMMAND_RETRY_DELAY_MS
            : RECOVERED_COMMAND_FAILURE_RETRY_DELAY_MS;
          const checkedAt = Date.now();
          const currentNoticeCommand =
            recoveredNativeCommandsRef.current.get(currentCommandId);
          const alreadyRecoveringInBackground = currentNoticeCommand
            ? readBackgroundCommandRecoveries(window.localStorage).has(
                recoveredCommandNoticeVersion(currentNoticeCommand),
              )
            : false;
          setRecoveredNativeCommandChecks((current) => ({
            ...current,
            [currentCommandId]: error instanceof CommandCompletionTimeoutError
              ? {
                  status: "no-response",
                  checkedAt,
                }
              : {
                  status: "failed",
                  checkedAt,
                  detail: formatUiError(error),
                },
          }));
          if (
            error instanceof CommandCompletionTimeoutError &&
            !alreadyRecoveringInBackground
          ) {
            backgroundRecoveredNativeCommandNotice(currentCommandId);
            showUiNotice(
              `command:background-recovery:${currentCommandId}`,
              "background",
              "info",
              "The Gateway did not return a signed result yet. Malink will keep recovering this action in the background; you can continue using the app.",
              7_000,
            );
          }
        } finally {
          recoveredNativeCommandFlightsRef.current.delete(commandId);
          recoveredNativeCommandFlightsRef.current.delete(currentCommandId);
          syncRecoveredNativeCommandFlights();
          if (
            retryDelayMs !== null
            && malinkClientRef.current === connection
            && connectionStatusRef.current === "connected"
          ) {
            scheduleRecoveredNativeCommandReconciliation(
              connection,
              retryDelayMs,
            );
          }
        }
      })();
    }
  }

  function checkRecoveredNativeCommandsNow(): void {
    const connection = malinkClientRef.current;
    if (!connection || connectionStatusRef.current !== "connected") {
      setSettingsOpen(true);
      return;
    }
    if (recoveredNativeCommandTimerRef.current !== null) {
      window.clearTimeout(recoveredNativeCommandTimerRef.current);
      recoveredNativeCommandTimerRef.current = null;
    }
    reconcileRecoveredNativeCommands(connection);
  }

  function reconnectForRecoveredNativeCommand(): void {
    setSettingsOpen(true);
    reconnectWorkspaceFromUi();
  }

  function reconnectWorkspaceFromUi(): void {
    const status = connectionStatusRef.current;
    if (
      status === "connecting" ||
      status === "securing" ||
      status === "reconnecting"
    ) return;
    void connectMalinkClient(matrixConfig, false);
  }

  function updateAndroidForRecoveredNativeCommand(): void {
    setSettingsOpen(true);
    void recoverNativeAppUpdate(true);
  }

  function openOfficialAndroidReleases(): void {
    window.open(OFFICIAL_ANDROID_RELEASES_URL, "_blank", "noopener,noreferrer");
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
        if (sent.commandId !== recovery.commandId) {
          sessionLifecycleRecoveriesRef.current.delete(recovery.commandId);
          recovery.commandId = sent.commandId;
          sessionLifecycleRecoveriesRef.current.set(recovery.commandId, recovery);
        }
        recoverUiNotice(`session:${recovery.action}`);
        await settleSessionLifecycle(
          connection,
          sent,
          recovery.action,
          recovery.sessionId,
          recovery.projectId,
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
          const lifecycleKey = sessionLifecycleRouteKey(
            recovery.projectId,
            recovery.sessionId,
          );
          if (current.get(lifecycleKey) !== recovery.action) return new Map(current);
          const next = new Map(current);
          next.delete(lifecycleKey);
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
    projectId: string,
    onSucceeded?: () => void | Promise<void>,
    onFailed?: () => void | Promise<void>,
  ): Promise<void> {
    let completion: CommandCompletion;
    try {
      completion = await waitForCommandCompletion(sent.completion);
    } catch (error) {
      if (
        error instanceof CommandCompletionTimeoutError
        || isCommandRecoveryPendingError(error)
        || connectionStatusRef.current !== "connected"
      ) {
        const recovery = rememberSessionLifecycleRecovery(
          sent.commandId,
          action,
          sessionId,
          projectId,
          onSucceeded,
          onFailed,
        );
        showUiNotice(
          `session:${action}`,
          "session",
          "warning",
          "Your computer accepted this action. Malink will keep checking the same command until its final result arrives.",
        );
        scheduleSessionLifecycleRecovery(recovery);
        return;
      }
      await onFailed?.();
      showUiNotice(
        `session:${action}`,
        "session",
        "error",
        formatUiError(error),
      );
      updateSessionLifecycleBusy((current) => {
        const lifecycleKey = sessionLifecycleRouteKey(projectId, sessionId);
        if (current.get(lifecycleKey) !== action) return new Map(current);
        const next = new Map(current);
        next.delete(lifecycleKey);
        return next;
      });
      return;
    }

    try {
      await connection.releaseCommand(sent.commandId);
    } catch (error) {
      if (!isMissingSessionCreateRecoveryCommand(error)) {
        const recovery = rememberSessionLifecycleRecovery(
          sent.commandId,
          action,
          sessionId,
          projectId,
          onSucceeded,
          onFailed,
        );
        showUiNotice(
          `session:${action}:release`,
          "session",
          "warning",
          "The completed action is saved, but its local recovery record still needs cleanup. Malink will retry it automatically.",
        );
        scheduleSessionLifecycleRecovery(recovery);
        return;
      }
    }

    completedCommandResultsRef.current.delete(sent.commandId);
    forgetRecoveredNativeCommand(sent.commandId);
    const recovery = sessionLifecycleRecoveriesRef.current.get(sent.commandId);
    if (recovery?.timer != null) window.clearTimeout(recovery.timer);
    sessionLifecycleRecoveriesRef.current.delete(sent.commandId);
    try {
      if (completion.outcome !== "succeeded") {
        await onFailed?.();
        showUiNotice(
          `session:${action}`,
          "session",
          "error",
          `The session could not be ${lifecyclePastTense(action)}.`,
        );
      } else {
        await onSucceeded?.();
        recoverUiNotice(`session:${action}`);
        recoverUiNotice(`session:${action}:release`);
      }
    } catch (error) {
      showUiNotice(
        `session:${action}`,
        "session",
        "error",
        formatUiError(error),
      );
    } finally {
      updateSessionLifecycleBusy((current) => {
        const lifecycleKey = sessionLifecycleRouteKey(projectId, sessionId);
        if (current.get(lifecycleKey) !== action) return new Map(current);
        const next = new Map(current);
        next.delete(lifecycleKey);
        return next;
      });
    }
  }

  async function archiveSession(sessionId: string, projectId?: string) {
    const session = gatewayState?.sessions.find(candidate =>
      candidate.id === sessionId &&
      (!projectId || candidate.projectId === projectId),
    );
    const historySource = session
      ? providerHistorySources.find(source => source.projectId === session.projectId) ?? null
      : null;
    await runSessionLifecycle("archive", sessionId, projectId, () => {
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
    if (
      event.key === "Enter" &&
      (event.ctrlKey || event.metaKey) &&
      !event.nativeEvent.isComposing
    ) {
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
    if (stoppingSessionIdsRef.current.has(sessionId)) return;
    if (selectedSessionIdRef.current !== sessionId) return;
    setSessionStopping(sessionId, true);
    setSessionAgentActivity(sessionId, STOPPING_AGENT_ACTIVITY);
    let accepted = false;
    try {
      const sent = await sendRealCommand(
        createCancelCommandPayload(sessionId, activeTurnId),
      );
      if (!sent) return;
      const completion = await sent.completion;
      accepted = completion.outcome === "succeeded";
      if (!accepted) {
        showUiNotice(
          `session:stop:${sessionId}`,
          "session",
          "error",
          completion.error?.message ?? "The Agent did not accept the stop request.",
        );
      }
    } catch (error) {
      showUiNotice(
        `session:stop:${sessionId}`,
        "session",
        "warning",
        `Malink could not confirm the stop request: ${formatUiError(error)}`,
      );
    } finally {
      if (!accepted) {
        setSessionStopping(sessionId, false);
        setSessionAgentActivity(
          sessionId,
          runningSessionIds.has(sessionId) ? WORKING_AGENT_ACTIVITY : null,
        );
      }
    }
  }

  async function materializeArtifact(
    sessionId: string,
    reference: MalinkArtifactReference,
  ): Promise<"materialized" | "changed"> {
    let commandId: string | null = null;
    try {
      const sent = await sendRealCommand(
        createArtifactMaterializeCommandPayload(
          sessionId,
          reference.id,
          reference.statRevision,
        ),
        activeWorkspace?.projectId,
        { propagateFailure: true },
      );
      if (!sent) throw new Error("The referenced file request was not queued.");
      commandId = sent.commandId;
      const completion = await waitForCommandCompletion(sent.completion, 30 * 60_000);
      if (completion.outcome !== "succeeded") {
        throw new Error(
          completion.error?.message ?? "The referenced file could not be prepared.",
        );
      }
      const result = completion.result;
      return result
        && typeof result === "object"
        && !Array.isArray(result)
        && result.status === "changed"
        ? "changed"
        : "materialized";
    } finally {
      if (commandId) {
        completedCommandResultsRef.current.delete(commandId);
        await malinkClientRef.current?.releaseCommand(commandId).catch(() => undefined);
      }
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
  const journalReconciliationAvailable = nativeRuntime === null ||
    nativeRuntime.commandJournalReconciliation === true;
  const manualAndroidUpdateRequired =
    nativeUpdateState?.detailCode === "manual_check_unavailable";
  const connectionTransitionBusy = connectionStatus === "connecting" ||
    connectionStatus === "securing" ||
    connectionStatus === "reconnecting";
  const recoveryActionBusy = (action: string | null | undefined): boolean =>
    (action === "update-native-app" && nativeUpdateActionBusy) ||
    (action === "reconnect" && connectionTransitionBusy);
  const recoveryActionLabel = (
    action: string | null | undefined,
    fallback: string,
  ): string => {
    if (action === "update-native-app" && nativeUpdateActionBusy) {
      if (nativeUpdateState?.phase === "downloading" ||
          nativeUpdateState?.phase === "available") {
        return "Downloading APK…";
      }
      if (nativeUpdateState?.phase === "installing") return "Installing APK…";
      return "Checking APK…";
    }
    if (action === "reconnect" && connectionTransitionBusy) return "Reconnecting…";
    return fallback;
  };
  const uncertainSessionRecovery = optimisticSession?.phase === "uncertain"
    ? uncertainCommandRecoveryPresentation({
        subject: "conversation",
        connectionStatus,
        gatewayAvailable,
        journalReconciliationAvailable,
        manualAndroidUpdateRequired,
      })
    : null;
  const uncertainProjectRecovery = optimisticProjectCreate?.phase === "uncertain"
    ? uncertainCommandRecoveryPresentation({
        subject: "project",
        connectionStatus,
        gatewayAvailable,
        journalReconciliationAvailable,
        manualAndroidUpdateRequired,
      })
    : null;

  const closeNotificationsThen = (action: () => void) => () => {
    setNotificationCenterOpen(false);
    action();
  };
  const notificationCenterItems: NotificationCenterItem[] = centerUiNotices.map(
    (notice) => ({
      key: `ui:${notice.key}`,
      severity: notice.severity,
      title: uiNoticeTitle(notice.scope),
      detail: notice.message,
      meta: `${notice.hidden ? "Hidden" : "Visible"} · ${formatRecoveryTimestamp(notice.createdAt)}`,
      actions: [{
        label: "Clear",
        onClick: () => clearUiNotice(notice.key),
      }],
    }),
  );

  for (const command of recoveredNativeCommandNotices) {
    const presentation = durableCommandRecoveryPresentation({
      state: command.state,
      connectionStatus,
      gatewayAvailable,
      journalReconciliationAvailable,
      manualAndroidUpdateRequired,
      lastCheck: recoveredNativeCommandChecks[command.commandId],
    });
    const primaryAction = (() => {
      switch (presentation.primaryAction) {
        case "check": return checkRecoveredNativeCommandsNow;
        case "reconnect": return reconnectForRecoveredNativeCommand;
        case "update-native-app": return updateAndroidForRecoveredNativeCommand;
        case "open-apk-releases": return openOfficialAndroidReleases;
        case null: return null;
      }
    })();
    notificationCenterItems.push({
      key: `recovery:${recoveredCommandNoticeVersion(command)}`,
      severity: command.state === "failed" ? "error" : "warning",
      title: presentation.title,
      detail: presentation.detail,
      meta: `Command ${command.commandId} · saved ${formatRecoveryTimestamp(command.submittedAt)} · last changed ${formatRecoveryTimestamp(command.updatedAt)}`,
      actions: [
        ...(primaryAction && presentation.primaryLabel
          ? [{
              label: recoveryActionLabel(
                presentation.primaryAction,
                presentation.primaryLabel,
              ),
              primary: true,
              disabled: recoveredNativeCommandFlightIds.has(command.commandId) ||
                recoveryActionBusy(presentation.primaryAction),
              onClick: closeNotificationsThen(primaryAction),
            }]
          : []),
        {
          label: diagnosticExportBusy ? "Exporting diagnostics…" : "Export diagnostics",
          disabled: diagnosticExportBusy,
          onClick: exportConnectionDiagnostics,
        },
      ],
    });
  }

  const connectionAttention = pairingError ?? connectionError;
  const connectionAttentionKey = connectionAttention
    ? `state:connection:${connectionAttention}`
    : null;
  if (connectionAttention) {
    notificationCenterItems.push({
      key: "state:connection",
      severity: "error",
      title: "Connection needs attention",
      detail: connectionAttention,
      actions: [{
        label: "Open settings",
        primary: true,
        onClick: closeNotificationsThen(() => setSettingsOpen(true)),
      }],
    });
  }
  if (historyError) {
    notificationCenterItems.push({
      key: "state:history",
      severity: "error",
      title: "Conversation history could not be loaded",
      detail: historyError,
      actions: [{
        label: "Open conversation",
        primary: true,
        onClick: closeNotificationsThen(() => {
          setPrimaryView("chats");
          setMobileChatOpen(true);
        }),
      }],
    });
  }
  if (optimisticSession && optimisticSession.phase !== "creating") {
    notificationCenterItems.push({
      key: `state:session-create:${optimisticSession.localSessionId}:${optimisticSession.phase}`,
      severity: optimisticSession.phase === "failed" ? "error" : "warning",
      title: optimisticSession.phase === "failed"
        ? "Conversation creation failed"
        : "Conversation creation is awaiting confirmation",
      detail: optimisticSession.phase === "uncertain"
        ? uncertainSessionRecovery?.detail ?? "Malink is verifying the original command."
        : optimisticSession.error ?? "Retry creation to keep the queued conversation.",
      actions: [{
        label: "Open conversation",
        primary: true,
        onClick: closeNotificationsThen(() => {
          showAttention(
            `state:session-create:${optimisticSession.localSessionId}:${optimisticSession.phase}`,
          );
          setPrimaryView("chats");
          setMobileChatOpen(true);
          activateLocalSession(optimisticSession.localSessionId);
        }),
      }],
    });
  }
  if (
    optimisticProjectCreate &&
    (optimisticProjectCreate.phase === "failed" ||
      optimisticProjectCreate.phase === "uncertain")
  ) {
    notificationCenterItems.push({
      key: `state:project-create:${optimisticProjectCreate.localId}:${optimisticProjectCreate.phase}`,
      severity: optimisticProjectCreate.phase === "failed" ? "error" : "warning",
      title: optimisticProjectCreate.phase === "failed"
        ? "Project creation failed"
        : "Project creation is awaiting confirmation",
      detail: optimisticProjectCreate.phase === "uncertain"
        ? uncertainProjectRecovery?.detail ?? "Malink is verifying the original command."
        : optimisticProjectCreate.error ?? "Open the project entry to retry or discard it.",
      actions: [
        {
          label: "Show in projects",
          primary: true,
          onClick: closeNotificationsThen(() => {
            showAttention(
              `state:project-create:${optimisticProjectCreate.localId}:${optimisticProjectCreate.phase}`,
            );
            setPrimaryView("chats");
            setMobileChatOpen(false);
          }),
        },
        {
          label: "Stop tracking",
          onClick: dismissOptimisticProjectCreate,
        },
      ],
    });
  }
  if (revisionConflict) {
    notificationCenterItems.push({
      key: `state:revision:${revisionConflict.commandId}`,
      severity: "warning",
      title: "Another device updated this conversation",
      detail: `${describeConflictedAction(revisionConflict.payload)} was not replayed. Review the latest messages before deciding whether to send it again.`,
      actions: [{
        label: "Open conversation",
        primary: true,
        onClick: closeNotificationsThen(() => {
          showAttention(`state:revision:${revisionConflict.commandId}`);
          setPrimaryView("chats");
          setMobileChatOpen(true);
        }),
      }],
    });
  }
  if (nativeCommandReview) {
    notificationCenterItems.push({
      key: `state:native-review:${nativeCommandReview.commandId}`,
      severity: "warning",
      title: nativeCommandReviewTitle(nativeCommandReview.operation),
      detail: nativeCommandReviewDescription(nativeCommandReview.operation),
      actions: [{
        label: "Open conversation",
        primary: true,
        onClick: closeNotificationsThen(() => {
          showAttention(`state:native-review:${nativeCommandReview.commandId}`);
          setPrimaryView("chats");
          setMobileChatOpen(true);
        }),
      }],
    });
  }

  if (gatewayUpdateAvailableCount > 0 && gatewayRelease) {
    notificationCenterItems.push({
      key: `state:gateway-release:${gatewayUpdateNoticeKey ?? gatewayRelease.releaseId}`,
      severity: "info",
      title: "Gateway software update available",
      detail: `${gatewayUpdateAvailableCount} ${gatewayUpdateAvailableCount === 1 ? "Gateway has" : "Gateways have"} release ${gatewayRelease.releaseId} available.`,
      actions: [{
        label: "Review Gateways",
        primary: true,
        onClick: closeNotificationsThen(() => setGatewayUpdateDialogOpen(true)),
      }],
    });
  }
  for (const [gatewayNodeId, runtime] of Object.entries(
    gatewayUpdateRuntimePresentation,
  )) {
    if (runtime.state === "unchecked" || runtime.state === "online") continue;
    const node = gatewayUpdatePlan.find(candidate =>
      candidate.gatewayNodeId === gatewayNodeId
    );
    const owner = gatewayProjectOwner(
      gatewayNodeId,
      node?.gatewayName ?? "",
      node?.computerName ?? "",
    );
    notificationCenterItems.push({
      key: `state:gateway-update:${gatewayNodeId}:${runtime.state}`,
      severity: runtime.state === "error"
        ? "error"
        : runtime.state === "unreachable"
          ? "warning"
          : "info",
      title: runtime.state === "starting"
        ? `${owner.label} is preparing its update`
        : runtime.state === "checking"
          ? `Checking ${owner.label}`
          : runtime.state === "unreachable"
            ? `${owner.label} did not answer`
            : `${owner.label} update failed`,
      detail: runtime.detail ?? (runtime.state === "starting"
        ? "The local maintenance Agent continues in the background."
        : "Open Gateway software for the latest signed status."),
      actions: [{
        label: "Open Gateway software",
        primary: true,
        onClick: closeNotificationsThen(() => setGatewayUpdateDialogOpen(true)),
      }],
    });
  }
  if (gatewayUpdateDiscoveryError) {
    notificationCenterItems.push({
      key: "state:gateway-update-discovery",
      severity: "error",
      title: "Gateway release channel could not be loaded",
      detail: gatewayUpdateDiscoveryError,
      actions: [{
        label: "Open settings",
        primary: true,
        onClick: closeNotificationsThen(() => setSettingsOpen(true)),
      }],
    });
  }

  const settingsErrors = [
    ["device-invitation", "Device invitation needs attention", invitationError],
    ["gateway-enrollment", "Gateway setup needs attention", gatewayEnrollmentError],
    ["gateway-profile", "Gateway profile update failed", gatewayProfileError],
  ] as const;
  for (const [key, title, detail] of settingsErrors) {
    if (!detail) continue;
    notificationCenterItems.push({
      key: `state:${key}`,
      severity: "error",
      title,
      detail,
      actions: [{
        label: "Open settings",
        primary: true,
        onClick: closeNotificationsThen(() => setSettingsOpen(true)),
      }],
    });
  }
  if (providerHistoryError) {
    notificationCenterItems.push({
      key: "state:provider-history",
      severity: "error",
      title: "Provider history could not be loaded",
      detail: providerHistoryError,
      actions: [{
        label: "Open Provider History",
        primary: true,
        onClick: closeNotificationsThen(() => setProviderHistoryOpen(true)),
      }],
    });
  }
  if (privilegeTotpError) {
    notificationCenterItems.push({
      key: "state:privilege-totp",
      severity: "error",
      title: "Permission verification failed",
      detail: privilegeTotpError,
    });
  }
  if (nativeUpdateState && [
    "available",
    "downloading",
    "ready",
    "installing",
    "permission_required",
    "failed",
  ].includes(nativeUpdateState.phase)) {
    notificationCenterItems.push({
      key: `state:native-update:${nativeUpdateState.phase}`,
      severity: nativeUpdateState.phase === "failed"
        ? "error"
        : nativeUpdateState.phase === "permission_required"
          ? "warning"
          : "info",
      title: "Android app update",
      detail: nativeUpdateStatusText(nativeUpdateState),
      actions: [{
        label: "Open settings",
        primary: true,
        onClick: closeNotificationsThen(() => setSettingsOpen(true)),
      }],
    });
  }
  if (pwaUpdateState.phase !== "current" && pwaUpdateState.phase !== "checking") {
    notificationCenterItems.push({
      key: `state:pwa-update:${pwaUpdateState.phase}`,
      severity: pwaUpdateState.phase === "unavailable" ? "warning" : "info",
      title: pwaUpdateState.phase === "updated"
        ? "Malink was updated"
        : pwaUpdateState.phase === "unavailable"
          ? "Malink update check is unavailable"
          : "Malink update in progress",
      detail: pwaUpdateState.phase === "updated"
        ? `Now running build ${pwaUpdateState.currentVersion}.`
        : pwaUpdateState.phase === "unavailable"
          ? "The current version remains active. You can retry from settings."
          : `Preparing build ${pwaUpdateState.latestVersion}.`,
      actions: pwaUpdateState.phase === "unavailable"
        ? [{
            label: "Open settings",
            primary: true,
            onClick: closeNotificationsThen(() => setSettingsOpen(true)),
          }]
        : undefined,
    });
  }
  const notificationCount = notificationCenterItems.length;

  return (
    <main className={`app-shell ${mobileChatOpen ? "mobile-chat-open" : ""} ${primaryView === "files" ? "file-inbox-open" : ""}`}>
      {!notificationCenterOpen &&
        (globalNotices.length > 0 || visibleRecoveredNativeCommand) && (
        <div className="global-ui-notices">
          <UiNoticeList
            notices={globalNotices}
            onDismiss={dismissUiNotice}
          />
          {visibleRecoveredNativeCommand && (
            <DurableCommandRecoveryNotice
              command={visibleRecoveredNativeCommand}
              connectionStatus={connectionStatus}
              gatewayAvailable={gatewayAvailable}
              journalReconciliationAvailable={journalReconciliationAvailable}
              manualAndroidUpdateRequired={manualAndroidUpdateRequired}
              busy={recoveredNativeCommandFlightIds.has(
                visibleRecoveredNativeCommand.commandId,
              )}
              nativeUpdateBusy={nativeUpdateActionBusy}
              connectionBusy={connectionTransitionBusy}
              diagnosticExportBusy={diagnosticExportBusy}
              lastCheck={recoveredNativeCommandChecks[
                visibleRecoveredNativeCommand.commandId
              ]}
              onCheck={checkRecoveredNativeCommandsNow}
              onReconnect={reconnectForRecoveredNativeCommand}
              onUpdateAndroid={updateAndroidForRecoveredNativeCommand}
              onOpenAndroidReleases={openOfficialAndroidReleases}
              onExportDiagnostics={exportConnectionDiagnostics}
              onDismiss={dismissRecoveredNativeCommandNotices}
            />
          )}
        </div>
      )}
      <aside className="rail" aria-label="Primary navigation">
        <div className="brand" role="img" aria-label="Malink">
          <MalinkMark />
        </div>
        <nav className="rail-nav">
          <button
            type="button"
            className={`rail-button ${primaryView === "chats" ? "active" : ""}`}
            aria-current={primaryView === "chats" ? "page" : undefined}
            onClick={() => setPrimaryView("chats")}
          >
            <ChatsIcon />
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
            <FilesIcon />
            <span>Files</span>
          </button>
        </nav>
        <div className="rail-spacer" />
        <button
          type="button"
          className={`rail-button rail-notification-button ${notificationCenterOpen ? "active" : ""}`}
          aria-label={`Notifications and issues, ${notificationCount} active`}
          aria-expanded={notificationCenterOpen}
          onClick={openNotificationCenter}
        >
          <NotificationIcon />
          <span>Notices</span>
          {notificationCount > 0 && (
            <b className="notification-count" aria-hidden="true">
              {notificationCount > 99 ? "99+" : notificationCount}
            </b>
          )}
        </button>
        <button
          type="button"
          className="rail-button"
          aria-label="Settings"
          onClick={() => setSettingsOpen(true)}
        >
          <SettingsIcon />
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
                <p>Run <code>malink send-file &lt;path&gt;</code> on the connected computer.</p>
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
              className="mobile-notification-button"
              aria-label={`Notifications and issues, ${notificationCount} active`}
              aria-expanded={notificationCenterOpen}
              onClick={openNotificationCenter}
            >
              <NotificationIcon />
              {notificationCount > 0 && (
                <b className="notification-count" aria-hidden="true">
                  {notificationCount > 99 ? "99+" : notificationCount}
                </b>
              )}
            </button>
            {trustedGateway && (
              <button
                type="button"
                className={`mobile-history-button${providerHistoryLoad ? " is-loading" : ""}`}
                aria-label={providerHistoryLoad
                  ? "Provider sessions are loading"
                  : !gatewayAvailable
                    ? "Reconnect your computer to browse provider sessions"
                    : providerHistorySources.length === 0
                      ? "No provider sessions are available"
                      : "Browse provider sessions"}
                aria-busy={providerHistoryLoad !== null}
                title={!gatewayAvailable
                  ? "Reconnect your computer to browse provider sessions"
                  : providerHistorySources.length === 0
                    ? "No provider sessions are available"
                    : "Browse provider sessions"}
                onClick={() => void openProviderHistory()}
                disabled={
                  !gatewayAvailable ||
                  providerHistorySources.length === 0
                }
              >
                <HistoryIcon />
              </button>
            )}
            <button
              type="button"
              className="mobile-files-button"
              aria-label="Open workspace file inbox"
              onClick={() => setPrimaryView("files")}
            >
              <FileInboxIcon />
            </button>
            {trustedGateway && (
              <>
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
                    Boolean(optimisticProjectCreate) ||
                    !gatewayAvailable ||
                    projectCreationGateways.length === 0
                  }
                >
                  <NewProjectIcon />
                </button>
                <button
                  type="button"
                  className="round-button"
                  aria-label={!gatewayAvailable
                    ? "Reconnect your computer to create a conversation"
                    : !canCreateAnySession
                      ? "No project can start a conversation"
                      : "New conversation"}
                  title={!gatewayAvailable
                    ? "Reconnect your computer to create a conversation"
                    : !canCreateAnySession
                      ? "No project can start a conversation"
                      : "New conversation"}
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
              </>
            )}
          </div>
        </header>

        {trustedGateway && (
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
        )}

        <button
          className={`gateway-card gateway-card-button connection-state-${displayedConnectionStatus} ${
            displayedConnectionStatus === "offline" || displayedConnectionStatus === "error"
              ? "offline"
              : ""
          }`}
          aria-label={`Open connection settings, ${mobileConnectionSignal.label}${
            gatewayNodeProbeTargets.length > 0 ? `; Gateways: ${gatewayNodeSummary}` : ""
          }`}
          title={`Connection: ${mobileConnectionSignal.label}${
            gatewayNodeProbeTargets.length > 0 ? `; Gateways: ${gatewayNodeSummary}` : ""
          }`}
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
              <span>
                {gatewayNodeProbeTargets.length > 0
                  ? gatewayNodeSummary
                  : mobileConnectionSignal.label}
              </span>
            </span>
            <span className="gateway-mobile-status" aria-hidden="true">
              <span
                className={`mobile-connection-icon mobile-connection-${mobileConnectionSignal.state}`}
              >
                <MobileConnectionIcon state={mobileConnectionSignal.state} />
              </span>
              <span className="gateway-mobile-status-copy">
                {gatewayNodeProbeTargets.length > 0
                  ? `${mobileConnectionSignal.label} · ${gatewayNodeSummary}`
                  : mobileConnectionSignal.label}
              </span>
            </span>
          </div>
          <span className="gateway-more" aria-hidden="true">•••</span>
        </button>

        {gatewayFilterOptions.length > 1 && (
          <label className="gateway-filter-control">
            <span>View</span>
            <select
              value={activeGatewayFilter}
              aria-label="Filter conversations by computer"
              onChange={(event) => selectGatewayFilter(event.target.value)}
            >
              <option value={ALL_GATEWAYS_FILTER}>All computers</option>
              {gatewayFilterOptions.map(gateway => (
                <option key={gateway.gatewayNodeId} value={gateway.gatewayNodeId}>
                  {gateway.label} · {gatewayNodeLivenessPresentation(
                    gatewayNodeLivenessById[gateway.gatewayNodeId],
                    gatewayLivenessNow,
                  ).label}
                </option>
              ))}
            </select>
          </label>
        )}

        <UiNoticeList
          notices={sessionNotices}
          className="session-notices"
          onDismiss={dismissUiNotice}
        />

        <div className="session-list">
          {optimisticSession && projectMatchesGatewayFilter(
            activeGatewayFilter,
            optimisticSession.input.projectId ?? gatewayState?.workspace.projectId ?? "",
            projectGatewaysById,
            fallbackProjectGateway.gatewayNodeId,
          ) && (
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
          {optimisticProjectCreate &&
            (activeGatewayFilter === ALL_GATEWAYS_FILTER ||
              optimisticProjectCreate.input.gatewayNodeId === activeGatewayFilter) &&
            (!(optimisticProjectCreate.phase === "failed" ||
              optimisticProjectCreate.phase === "uncertain") ||
              !hiddenAttentionKeys.has(
                `state:project-create:${optimisticProjectCreate.localId}:${optimisticProjectCreate.phase}`,
              )) &&
            (!search.trim() ||
              `${optimisticProjectCreate.input.name} ${optimisticProjectCreate.input.cwd} ${optimisticProjectCreate.gatewayLabel}`
                .toLowerCase()
                .includes(search.toLowerCase())) && (
            <section
              className={`project-session-group project-create-pending project-create-${optimisticProjectCreate.phase}`}
              data-project-create-phase={optimisticProjectCreate.phase}
              aria-label={`${optimisticProjectCreate.input.name}. ${
                optimisticProjectCreate.phase === "failed"
                  ? "Creation failed."
                  : optimisticProjectCreate.phase === "uncertain"
                    ? "Creation is taking longer than expected."
                    : optimisticProjectCreate.phase === "syncing"
                      ? "Created and syncing."
                      : "Creating in the background."
              }`}
            >
              <div
                className="project-session-toggle project-create-status"
                role="status"
                aria-live="polite"
              >
                <span className="project-create-mark" aria-hidden="true">
                  {optimisticProjectCreate.phase === "failed" ||
                  optimisticProjectCreate.phase === "uncertain" ? (
                    "!"
                  ) : optimisticProjectCreate.phase === "syncing" ? (
                    "✓"
                  ) : (
                    <i className="project-create-spinner" />
                  )}
                </span>
                <span className="project-folder" aria-hidden="true">
                  <ProjectFolderIcon temporary={false} />
                </span>
                <span className="project-copy">
                  <strong>{optimisticProjectCreate.input.name}</strong>
                  <small>
                    {optimisticProjectCreate.gatewayLabel} · {optimisticProjectCreate.input.cwd}
                  </small>
                </span>
                <span className="project-create-actions">
                  {optimisticProjectCreate.phase === "failed" && (
                    <button
                      type="button"
                      onClick={retryFailedOptimisticProjectCreate}
                      disabled={!gatewayAvailable || newProjectBusy}
                    >
                      Retry
                    </button>
                  )}
                  {optimisticProjectCreate.phase === "uncertain" && (
                    uncertainProjectRecovery?.primaryAction && (
                      <button
                        type="button"
                        disabled={recoveryActionBusy(
                          uncertainProjectRecovery.primaryAction,
                        )}
                        onClick={
                          uncertainProjectRecovery.primaryAction === "check"
                            ? recheckUncertainOptimisticProjectCreate
                            : uncertainProjectRecovery.primaryAction === "reconnect"
                              ? reconnectForRecoveredNativeCommand
                            : uncertainProjectRecovery.primaryAction === "update-native-app"
                              ? updateAndroidForRecoveredNativeCommand
                              : openOfficialAndroidReleases
                        }
                      >
                        {recoveryActionLabel(
                          uncertainProjectRecovery.primaryAction,
                          uncertainProjectRecovery.primaryLabel,
                        )}
                      </button>
                    )
                  )}
                  {optimisticProjectCreate.phase === "uncertain" && (
                    <button
                      type="button"
                      disabled={diagnosticExportBusy}
                      aria-busy={diagnosticExportBusy}
                      onClick={() => void exportConnectionDiagnostics()}
                    >
                      {diagnosticExportBusy ? "Exporting diagnostics…" : "Export diagnostics"}
                    </button>
                  )}
                  {(optimisticProjectCreate.phase === "failed" ||
                    optimisticProjectCreate.phase === "uncertain") && (
                    <button
                      type="button"
                      aria-label="Hide project creation notice"
                      onClick={() => hideAttention(
                        `state:project-create:${optimisticProjectCreate.localId}:${optimisticProjectCreate.phase}`,
                      )}
                    >
                      ×
                    </button>
                  )}
                </span>
                <b aria-hidden="true">
                  {optimisticProjectCreate.phase === "failed"
                    ? "failed"
                    : optimisticProjectCreate.phase === "uncertain"
                      ? "check"
                      : optimisticProjectCreate.phase === "syncing"
                        ? "sync"
                        : "now"}
                </b>
              </div>
              {(optimisticProjectCreate.error || uncertainProjectRecovery) && (
                <p className="project-create-error">
                  {uncertainProjectRecovery?.detail ?? optimisticProjectCreate.error}
                </p>
              )}
            </section>
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
              <div className="project-session-heading">
              <button
                type="button"
                className="project-session-toggle"
                aria-expanded={expanded}
                aria-controls={contentId}
                title={project.temporary
                  ? `Temporary workspace on ${project.gatewayLabel}`
                  : `Project on ${project.gatewayLabel}`}
                aria-label={`${projectSessionSummaryLabel(
                  `${project.projectName} on ${project.gatewayLabel}`,
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
                    {project.gatewayLabel} · {project.cwd}
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
              {!project.temporary && (
                <button
                  type="button"
                  className="project-manage-button"
                  aria-label={`Manage ${project.projectName}`}
                  title="Project settings"
                  disabled={projectSettingsBusy}
                  onClick={() => setProjectSettingsProjectId(project.projectId)}
                >
                  <span aria-hidden="true">•••</span>
                </button>
              )}
              </div>
              {expanded && (
                <div id={contentId} className="project-session-list">
              {project.sessions.map((session) => {
                const indicator = sessionIndicator(session, sessionReadState);
                const signal = sessionListSignal(session, sessionReadState);
                const activity = agentActivitiesBySession.get(session.id);
                const lifecycleAction =
                  sessionLifecycleBusy.get(
                    sessionLifecycleRouteKey(session.projectId, session.id),
                  ) ?? null;
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
                const visualSignal = lifecycleAction || activity
                  ? "working"
                  : signal;
                const visualSignalLabel = lifecycleAction
                  ? statusSummary
                  : activity?.label || sessionSignalLabel(signal);
                const statusTone = sessionStatusTone({
                  signal,
                  activityPhase: activity?.phase,
                  lifecycleBusy: Boolean(lifecycleAction),
                  gatewayConnected,
                });
                const showStatusSummary =
                  Boolean(lifecycleAction || activity) || signal !== "idle";
                return (
                <button
                  key={`${session.projectId}\0${session.id}`}
                  data-session-id={session.id}
                  data-project-name={session.projectName}
                  aria-label={`${session.title}. ${statusSummary}. ${technicalSummary}. Updated ${formatSessionTime(session.updatedAt)}`}
                  title={`${session.title} · ${statusSummary}`}
                  data-session-signal={visualSignal}
                  aria-pressed={
                    selectedSessionId === session.id &&
                    selectedProjectId === session.projectId
                  }
                  className={`session-row ${
                    selectedSessionId === session.id &&
                    selectedProjectId === session.projectId
                      ? "selected"
                      : ""
                  } session-state-${indicator.activity} session-signal-${visualSignal} ${indicator.unread ? "unread" : ""} ${lifecycleAction ? "is-busy" : ""}`}
                  onClick={() => {
                    void chooseSession(session.id, session.projectId);
                  }}
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
                    {(showStatusSummary || session.extensions.length > 0) && (
                      <span className="session-preview-line">
                        {showStatusSummary && (
                          <span
                            className={`session-status-summary session-status-${statusTone}`}
                          >
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
            <div className="empty-search connection-list-empty">
              <strong>Your workspace is ready</strong>
              <small>Connect a computer to load projects and conversations.</small>
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
            conversationGroups.length === 0 &&
            Boolean(search.trim()) && (
            <div className="empty-search">
              <span>⌕</span>
              No matching active conversations
            </div>
          )}
          {gatewayState &&
            activeGatewayFilter !== ALL_GATEWAYS_FILTER &&
            activeSessionCount === 0 &&
            conversationGroups.length === 0 &&
            !optimisticSession &&
            !optimisticProjectCreate &&
            !search.trim() && (
              <div className="empty-search">
                <span>G</span>
                No conversations or projects on this Gateway
              </div>
            )}
          {gatewayState &&
            gatewayState.sessions.length === 0 &&
            activeGatewayFilter === ALL_GATEWAYS_FILTER &&
            connectionStatus === "connected" &&
            !optimisticSession &&
            !pendingSessionCreate && (
              <div className="empty-search empty-search-action">
                <span aria-hidden="true">+</span>
                <strong>Create your first conversation</strong>
                <small>Choose a project and agent to start working.</small>
                <button
                  type="button"
                  onClick={() => setNewSessionOpen(true)}
                  disabled={!canCreateAnySession || newSessionBusy}
                >
                  {canCreateAnySession
                    ? "New conversation"
                    : "No available project"}
                </button>
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

      <section
        className={`conversation-panel ${!trustedGateway ? "is-onboarding" : ""}`}
        aria-label={conversationTitle}
      >
        {!trustedGateway && (
          <ConnectionOnboarding onConnect={() => setSettingsOpen(true)} />
        )}
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
                  onClick={() => {
                    void archiveSession(gatewaySelected.id, gatewaySelected.projectId);
                  }}
                >
                  <span aria-hidden="true">▣</span>
                  <span>
                    <strong>
                      {isStreaming ? "Archive & stop agent" : "Archive session"}
                    </strong>
                    <small>
                      Remove from Malink; provider history remains
                    </small>
                  </span>
                </button>
              </div>
            )}
          </div>
        )}


        <div
          className={`conversation-workspace ${toolFocus ? "is-tool-focused" : ""}`}
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
                      ? void restoreSessionHistory(
                          historySessionIdRef.current,
                          malinkClientRef.current,
                          historyProjectIdRef.current ?? undefined,
                        )
                      : void loadOlderHistory()
                  }
                >
                  Retry
                </button>
              </span>
            ) : historyCheckingRemote ? (
              <span>Restoring conversation history in the background…</span>
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
          {presentedTimeline.map((item, itemIndex) => {
            if (item.kind === "process") {
              const expanded = expandedProcessTurnIds.has(
                item.process.commandId,
              );
              return (
                <TurnProcessDisclosure
                  process={item.process}
                  expanded={expanded}
                  key={`process:${item.process.commandId}`}
                  onToggle={() =>
                    setExpandedProcessTurnIds((current) => {
                      const next = new Set(current);
                      if (next.has(item.process.commandId)) {
                        next.delete(item.process.commandId);
                      } else {
                        next.add(item.process.commandId);
                      }
                      return next;
                    })
                  }
                />
              );
            }
            const message = item.message;
            const artifactReferences = artifactReferencesFromRaw(message.raw);
            const artifactAttachmentIds = new Set(
              artifactReferences.map(reference => reference.id),
            );
            const agentWork = isAgentWorkMessage(message);
            const previousItem = presentedTimeline[itemIndex - 1];
            const nextItem = presentedTimeline[itemIndex + 1];
            const previousIsAgentWork = isAgentWorkMessage(
              previousItem?.kind === "message" ? previousItem.message : undefined,
            );
            const nextIsAgentWork = isAgentWorkMessage(
              nextItem?.kind === "message" ? nextItem.message : undefined,
            );
            const agentTurnClass = agentWork
              ? `${previousIsAgentWork ? "agent-turn-continuation" : "agent-turn-start"} ${nextIsAgentWork ? "" : "agent-turn-end"}`
              : "";
            const result = completedTurns.resultByMessageId.get(message.id);
            const isTurnResult = Boolean(result);
            const isTurnProcess = completedTurns.processByMessageId.has(
              message.id,
            );
            const turnPresentationClass = isTurnResult
              ? "turn-result"
              : isTurnProcess
                ? "turn-process"
                : "";
            if (message.kind === "notice") {
              return (
                <div
                  className={`encryption-notice ${
                    isLiveMessageDelivery(message) ? "notice-enter" : ""
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
                  className={`message-row agent-row ${turnPresentationClass} ${
                    isLiveMessageDelivery(message) ? "message-enter" : ""
                  }`}
                  key={message.id}
                >
                  <div className="agent-mark error-mark">!</div>
                  <div className="bubble agent-bubble error-bubble">
                    <span className="agent-label">TASK NEEDS ATTENTION</span>
                    <p>{message.text}</p>
                    <time>{message.time}</time>
                  </div>
                </div>
              );
            }
            if (message.kind === "user") {
              const deliveryState =
                message.deliveryState ??
                (message.revision !== undefined ? "sent" : undefined);
              const delivery = messageDeliveryPresentation(
                userMessageDeliveryState(
                  deliveryState,
                  message.commandId,
                  receivedPromptCommandIds,
                ),
              );
              return (
                <div
                  className={`message-row user-row turn-prompt ${
                    isLiveMessageDelivery(message) ? "message-enter" : ""
                  }`}
                  key={message.id}
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
                      {delivery && (
                        <span
                          className={`delivery-indicator ${delivery.state}`}
                          aria-label={delivery.label}
                          title={delivery.label}
                        >
                          {delivery.symbol}
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
                  className={`message-row tool-group-row ${agentTurnClass} ${turnPresentationClass} ${
                    isLiveMessageDelivery(message) ? "message-enter" : ""
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
                    className={`message-row agent-row ${turnPresentationClass} ${
                      isLiveMessageDelivery(message) ? "message-enter" : ""
                    }`}
                    key={message.id}
                  >
                    <div className="agent-mark">C</div>
                    <ExtensionViewCard
                      extensionName={extensionView.extension.name}
                      historical={isHistoricalMessageDelivery(message)}
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
                  className={`message-row agent-row ${turnPresentationClass} ${
                    isLiveMessageDelivery(message) ? "message-enter" : ""
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
                    {isHistoricalMessageDelivery(message) ? (
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
                className={`message-row agent-row ${agentTurnClass} ${turnPresentationClass} ${
                  isLiveMessageDelivery(message) ? "message-enter" : ""
                }`}
                key={message.id}
              >
                <div className="agent-mark">C</div>
                <div className="bubble agent-bubble">
                  <span className="agent-label">
                    CODEX
                    {result && <TurnResultState outcome={result.outcome} />}
                  </span>
                  {message.format === "markdown" || !message.format ? (
                    <MarkdownContent
                      content={message.text ?? ""}
                      artifactReferences={artifactReferences}
                      attachments={message.attachments}
                      connection={malinkClientRef.current}
                      onMaterializeArtifact={message.sessionId
                        ? reference => materializeArtifact(message.sessionId!, reference)
                        : undefined}
                    />
                  ) : (
                    <p className="message-copy">
                      {message.text}
                    </p>
                  )}
                  <AttachmentList
                    attachments={message.attachments?.filter(
                      attachment => !artifactAttachmentIds.has(attachment.id),
                    )}
                    connection={malinkClientRef.current}
                  />
                  <time>{message.time}</time>
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
            />
          )}
        </div>

        <div className="composer-area">
          {feedAwayFromLatest ? (
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
                <small>Project · Computer</small>
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

          {revisionConflict && !hiddenAttentionKeys.has(
            `state:revision:${revisionConflict.commandId}`,
          ) && (
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
                  type="button"
                  disabled={revisionConflict.busy}
                  onClick={() => hideAttention(
                    `state:revision:${revisionConflict.commandId}`,
                  )}
                >
                  Hide
                </button>
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

          {nativeCommandReview && !hiddenAttentionKeys.has(
            `state:native-review:${nativeCommandReview.commandId}`,
          ) && (
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
                  onClick={() => hideAttention(
                    `state:native-review:${nativeCommandReview.commandId}`,
                  )}
                >
                  Hide
                </button>
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

          {optimisticSelected &&
            optimisticSession &&
            !hiddenAttentionKeys.has(
              `state:session-create:${optimisticSession.localSessionId}:${optimisticSession.phase}`,
            ) && (
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
                    : optimisticSession.phase === "uncertain"
                      ? uncertainSessionRecovery?.detail ??
                        "Malink is still verifying the original creation command."
                      : optimisticSession.error ||
                        "Retry creation to keep this conversation and its queued messages."}
                </p>
              </div>
              {optimisticSession.phase === "failed" && (
                <div className="optimistic-session-actions">
                  <button
                    type="button"
                    onClick={() => hideAttention(
                      `state:session-create:${optimisticSession.localSessionId}:${optimisticSession.phase}`,
                    )}
                  >
                    Hide
                  </button>
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
                    onClick={() => hideAttention(
                      `state:session-create:${optimisticSession.localSessionId}:${optimisticSession.phase}`,
                    )}
                  >
                    Hide
                  </button>
                  {uncertainSessionRecovery?.primaryAction && (
                    <button
                      type="button"
                      disabled={recoveryActionBusy(
                        uncertainSessionRecovery.primaryAction,
                      )}
                      onClick={
                        uncertainSessionRecovery.primaryAction === "check"
                          ? recheckUncertainOptimisticSession
                          : uncertainSessionRecovery.primaryAction === "reconnect"
                            ? reconnectForRecoveredNativeCommand
                          : uncertainSessionRecovery.primaryAction === "update-native-app"
                            ? updateAndroidForRecoveredNativeCommand
                            : openOfficialAndroidReleases
                      }
                    >
                      {recoveryActionLabel(
                        uncertainSessionRecovery.primaryAction,
                        uncertainSessionRecovery.primaryLabel,
                      )}
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={diagnosticExportBusy}
                    aria-busy={diagnosticExportBusy}
                    onClick={() => void exportConnectionDiagnostics()}
                  >
                    {diagnosticExportBusy ? "Exporting diagnostics…" : "Export diagnostics"}
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
              aria-keyshortcuts="Control+Enter Meta+Enter"
              placeholder={
                gatewayAvailable
                  ? `Message ${activeProvider}…`
                  : trustedGateway
                    ? "Connect your computer to send messages"
                    : "Connect a computer to start"
              }
              aria-label={`Message ${activeProvider}`}
              rows={2}
              disabled={!composerState.canType}
            />
            <span
              id="composer-send-shortcut"
              className="composer-send-shortcut"
            >
              <kbd>Ctrl/⌘</kbd>
              <span>+</span>
              <kbd>Enter</kbd>
              <span>to send</span>
            </span>
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
                  aria-describedby="composer-status composer-send-shortcut"
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

      {gatewayRelease &&
        gatewayUpdateNoticeKey &&
        dismissedGatewayUpdateNoticeKey !== gatewayUpdateNoticeKey &&
        !gatewayUpdateDialogOpen &&
        !notificationCenterOpen && (
        <div className="gateway-update-toast" role="status" aria-live="polite">
          <span aria-hidden="true">G</span>
          <span>
            <strong>Gateway update available</strong>
            <small>
              {gatewayUpdateAvailableCount} {gatewayUpdateAvailableCount === 1
                ? "Gateway needs"
                : "Gateways need"} release {gatewayRelease.releaseId}. Nothing starts without your approval.
            </small>
          </span>
          <button
            type="button"
            className="gateway-update-toast-review"
            onClick={() => {
              setDismissedGatewayUpdateNoticeKey(gatewayUpdateNoticeKey);
              setGatewayUpdateDialogOpen(true);
            }}
          >
            Review
          </button>
          <button
            type="button"
            className="gateway-update-toast-dismiss"
            aria-label="Dismiss Gateway update notice"
            onClick={() => setDismissedGatewayUpdateNoticeKey(gatewayUpdateNoticeKey)}
          >
            ×
          </button>
        </div>
      )}

      {connectionAttention &&
        connectionAttentionKey &&
        !hiddenAttentionKeys.has(connectionAttentionKey) &&
        !settingsOpen &&
        !notificationCenterOpen && (
        <div className="connection-toast" role="alert">
          <span>!</span>
          <button
            type="button"
            className="connection-toast-open"
            onClick={() => setSettingsOpen(true)}
          >
            <strong>Connection needs attention</strong>
            <small>{connectionAttention}</small>
            <b>Open settings</b>
          </button>
          <button
            type="button"
            className="connection-toast-dismiss"
            aria-label="Hide connection notice"
            onClick={() => hideAttention(connectionAttentionKey)}
          >
            ×
          </button>
        </div>
      )}

      {gatewayState && (
        <NewProjectDialog
          open={newProjectOpen}
          busy={newProjectBusy}
          gateways={presentedProjectCreationGateways}
          onClose={() => setNewProjectOpen(false)}
          onCreate={(input) => void createProject(input)}
        />
      )}

      {projectSettingsWorkspace && (
        <ProjectSettingsDialog
          key={projectSettingsWorkspace.projectId}
          open
          busy={projectSettingsBusy}
          project={projectSettingsWorkspace}
          gatewayLabel={projectSettingsGateway.label}
          fallbackModels={gatewayState?.capabilities.models ?? []}
          canDelete={projectSettingsCanDelete}
          onClose={() => {
            if (!projectSettingsBusy) setProjectSettingsProjectId(null);
          }}
          onSave={(input) => void updateProjectSettings(input)}
          onDelete={() => void deleteProject()}
        />
      )}

      {gatewayRelease && gatewayUpdatePlan.length > 0 && (
        <GatewayUpdateDialog
          open={gatewayUpdateDialogOpen}
          connected={connectionStatus === "connected"}
          release={gatewayRelease}
          nodes={gatewayUpdatePlan}
          runtimeByNode={gatewayUpdateRuntimePresentation}
          activeGatewayNodeId={gatewayUpdateActiveNodeId}
          onClose={() => setGatewayUpdateDialogOpen(false)}
          onProbe={(node) => {
            const target = gatewayNodeProbeTargetsById.get(node.gatewayNodeId);
            if (target) void probeGatewayNodeLiveness(target);
          }}
          onStart={(node) => void startGatewayUpdateNode(node)}
          onOpenSession={openGatewayUpdateSession}
          onArchiveSession={(node, sessionId) =>
            void archiveGatewayMaintenanceSession(node, sessionId)
          }
          onExportDiagnostics={exportConnectionDiagnostics}
          diagnosticExportBusy={diagnosticExportBusy}
        />
      )}

      <NotificationCenter
        open={notificationCenterOpen}
        items={notificationCenterItems}
        onClose={() => setNotificationCenterOpen(false)}
      />

      {gatewayState && (
        <NewSessionDialog
          open={newSessionOpen}
          busy={newSessionBusy}
          fallbackGateway={fallbackProjectGateway}
          projectGateways={projectGatewaysById}
          workspace={gatewayFilterDefaultWorkspace ?? gatewayState.workspace}
          workspaces={allWorkspaceProjects}
          models={gatewayState.capabilities.models}
          providers={gatewayState.capabilities.providers}
          extensions={gatewayState.capabilities.sessionExtensions}
          defaultExtensions={
            (gatewayFilterDefaultWorkspace ?? gatewayState.workspace).defaultExtensions
          }
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
          recoveryLabel={providerHistoryError
            ? connectionStatus !== "connected"
              ? "Reconnect Workspace"
              : providerHistorySource
                ? "Retry request"
                : null
            : null}
          onClose={closeProviderHistory}
          onSourceChange={(sourceKey) => void openProviderHistory({ sourceKey })}
          onProviderChange={(provider) => void openProviderHistory({ provider })}
          onInspect={(session) => void inspectProviderHistorySession(session)}
          onRetry={() => {
            if (connectionStatus !== "connected") {
              setProviderHistoryOpen(false);
              reconnectForRecoveredNativeCommand();
              return;
            }
            if (!providerHistorySource) return;
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
        gatewayNodeLivenessById={gatewayNodeLivenessById}
        gatewayLivenessNow={gatewayLivenessNow}
        gatewayRelease={gatewayRelease}
        gatewayUpdateAvailableCount={gatewayUpdateAvailableCount}
        gatewayUpdateNodeCount={gatewayUpdatePlan.length}
        gatewayUpdateDiscoveryError={gatewayUpdateDiscoveryError}
        gatewayUpdateDiscoveryBusy={gatewayUpdateDiscoveryBusy}
        updateState={pwaUpdateState}
        nativeUpdateState={nativeUpdateState}
        nativeUpdateBusy={nativeUpdateActionBusy}
        nativeUpdateRequestBusy={nativeUpdateBusy}
        diagnosticExportBusy={diagnosticExportBusy}
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
        onCheckGatewayLiveness={(gatewayNodeId) => {
          const target = gatewayNodeProbeTargetsById.get(gatewayNodeId);
          if (target) void probeGatewayNodeLiveness(target);
        }}
        onReviewGatewayUpdates={() => {
          setSettingsOpen(false);
          setGatewayUpdateDialogOpen(true);
        }}
        onRetryGatewayUpdateDiscovery={() => {
          void refreshGatewayUpdateDiscovery();
        }}
        onReconnectGatewayUpdates={reconnectWorkspaceFromUi}
        onCheckForUpdates={() => void checkForPwaUpdates()}
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

async function requestNativeUpdateStatus(
  connection: MalinkClient | null,
  installReady: boolean,
  checkNow = false,
): Promise<NativeUpdateStatus> {
  if (!connection?.nativeUpdateStatus) {
    return advanceNativeAppUpdate({ installReady, checkNow });
  }
  let status = checkNow && connection.checkNativeUpdate
    ? await connection.checkNativeUpdate()
    : await connection.nativeUpdateStatus();
  if (
    installReady &&
    connection.installNativeUpdate &&
    (status.phase === "ready" || status.phase === "permission_required")
  ) {
    status = await connection.installNativeUpdate();
  }
  return status;
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
  if (payload.operation === "artifact.materialize") {
    return { key: `artifact:${payload.referenceId}`, scope: "session" };
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

function artifactReferencesFromRaw(
  raw: Record<string, unknown> | undefined,
): MalinkArtifactReference[] {
  if (!Array.isArray(raw?.artifactReferences)) return [];
  return raw.artifactReferences.flatMap(value => {
    const parsed = artifactReferenceSchema.safeParse(value);
    return parsed.success ? [parsed.data] : [];
  });
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
  const deliveryMode = resolvedMessageDeliveryMode(incoming);
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
    deliveryMode,
    historical: deliveryMode === "history",
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
    projectId: message.projectId,
    deliveryMode: message.deliveryMode,
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

function resizeComposerTextarea(textarea: HTMLTextAreaElement | null): void {
  if (!textarea) return;
  textarea.style.height = "auto";
  const style = window.getComputedStyle(textarea);
  const minHeight = Number.parseFloat(style.minHeight) || 0;
  const parsedMaxHeight = Number.parseFloat(style.maxHeight);
  const maxHeight = Number.isFinite(parsedMaxHeight)
    ? parsedMaxHeight
    : Number.POSITIVE_INFINITY;
  const contentHeight = textarea.scrollHeight;
  const height = Math.max(minHeight, Math.min(contentHeight, maxHeight));
  textarea.style.height = `${Math.ceil(height)}px`;
  textarea.style.overflowY = contentHeight > height ? "auto" : "hidden";
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

function formatRecoveryTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "at an unknown time";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function recoveredCommandNoticeVersion(
  command: MalinkRecoveredDurableCommand,
): string {
  return `${command.commandId}\0${command.state}\0${command.updatedAt}`;
}

function uiNoticeTitle(scope: UiNoticeScope): string {
  switch (scope) {
    case "connection": return "Connection";
    case "pairing": return "Authorization";
    case "background": return "Background operation";
    case "history": return "Conversation history";
    case "session": return "Conversation or project";
    case "composer": return "Agent command";
    case "attachment": return "Attachment";
    case "update": return "Software update";
  }
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
    case "artifact.materialize":
      return "The referenced file request";
    case "session.settings":
      return "The session settings change";
    case "session.create":
      return "The new session request";
    case "project.create":
      return "The new project request";
    case "project.settings":
      return "The project settings request";
    case "project.delete":
      return "The project deletion request";
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
