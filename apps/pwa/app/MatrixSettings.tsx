"use client";

import { useRef, useState } from "react";
import type {
  MatrixConnectionConfig,
  MatrixConnectionStatus,
} from "./matrix";
import { PairingWizard } from "./PairingWizard";
import type {
  MalinkNativeRuntimeInfo,
  MalinkPublicTrust,
} from "./client/MalinkClient";
import type {
  GeneratedDeviceInvitation,
  PairingPreview,
} from "./pairing";
import { MALINK_BUILD_VERSION } from "./buildInfo";
import type { GatewayReleaseBuild } from "./buildInfo";
import type { PwaUpdateState } from "./pwaUpdate";
import type { NativeUpdateStatus } from "@malink/native-bridge";
import { useDialogFocus } from "./dialogFocus";
import {
  deriveConnectionRecoveryPlan,
  deriveConnectionPresentation,
  type ConnectionRecoveryAction,
  type ConnectionRepairReason,
} from "./connectionPresentation";
import type { WebPushNotificationState } from "./webPushNotifications";
import type {
  GatewayEnrollmentPending,
  GatewayRestartMode,
  GatewayRestartStatus,
  SignedWorkspaceGatewayDirectory,
} from "@malink/protocol";
import {
  GatewayEnrollmentPanel,
  type GatewayEnrollmentBusyState,
  type GeneratedGatewayEnrollment,
} from "./GatewayEnrollmentPanel";
import { gatewayProjectOwner } from "./projectCatalog";
import { injectedNativeBridgePort } from "./client/native/NativeRpcBridge";
import {
  nativeUpdateDownloadProgress,
  nativeUpdateOperationInProgress,
} from "./nativeUpdatePolling";
import { gatewayUpdateSettingsPresentation } from "./gatewayUpdateSettingsPresentation";
import {
  gatewayNoReplyPresentation,
  gatewayNodeLivenessPresentation,
  type GatewayNodeLiveness,
} from "./gatewayNodeLiveness";
import { GatewayNoReplyHelp } from "./GatewayNoReplyHelp";
import { workspaceGatewayRepairPlan } from "./workspaceGatewayRepair";

export const OFFICIAL_ANDROID_RELEASES_URL =
  "https://github.com/Escapingbug/malink/releases";

export type GatewayRestartNodeRuntime = {
  state: "idle" | "requesting" | "waiting" | "restarting" | "ready" | "failed";
  status?: GatewayRestartStatus;
  detail?: string;
};

type Props = {
  open: boolean;
  config: MatrixConnectionConfig;
  status: MatrixConnectionStatus;
  connectionDetail: string | null;
  repairReason: ConnectionRepairReason | null;
  error: string | null;
  pairingPreview: PairingPreview | null;
  pairingCompletion: { gatewayName: string } | null;
  trustedGateway: MalinkPublicTrust | null;
  activeDeviceCount: number | null;
  savedGateways: MalinkPublicTrust[];
  gatewayDirectory: SignedWorkspaceGatewayDirectory | null;
  availableProjectIds: readonly string[];
  pairingBusy: boolean;
  deviceInvitation: GeneratedDeviceInvitation | null;
  invitationBusy: boolean;
  invitationError: string | null;
  invitationReauthRequired: boolean;
  gatewayEnrollmentInvitation: GeneratedGatewayEnrollment | null;
  pendingGatewayEnrollments: GatewayEnrollmentPending[];
  approvedGatewayEnrollmentIds: ReadonlySet<string>;
  gatewayEnrollmentBusy: GatewayEnrollmentBusyState;
  gatewayEnrollmentError: string | null;
  gatewayProfileBusy: string | null;
  gatewayProfileError: string | null;
  gatewayRetirementBusy: string | null;
  gatewayRetirementError: { gatewayNodeId: string; detail: string } | null;
  gatewayNodeLivenessById: Readonly<Record<string, GatewayNodeLiveness>>;
  gatewayRestartRuntimeByNode: Readonly<Record<string, GatewayRestartNodeRuntime>>;
  gatewayLivenessNow: number;
  gatewayRelease: GatewayReleaseBuild | null;
  gatewayUpdateAvailableCount: number;
  gatewayUpdateNodeCount: number;
  gatewayUpdateDiscoveryError: string | null;
  gatewayUpdateDiscoveryBusy: boolean;
  updateState: PwaUpdateState;
  nativeUpdateState: NativeUpdateStatus | null;
  nativeUpdateBusy: boolean;
  nativeUpdateRequestBusy: boolean;
  diagnosticExportBusy: boolean;
  nativeRuntime: MalinkNativeRuntimeInfo | null;
  webPushState: WebPushNotificationState;
  webPushBusy: boolean;
  copyPageLinkBusy: boolean;
  signOutBusy: boolean;
  onChange(config: MatrixConnectionConfig): void;
  onPairingLink(link: string): void;
  onClearPairing(): void;
  onConfirmPairing(): void;
  onFinishPairing(): void;
  onClose(): void;
  onDisconnect(): void;
  onForget(): void;
  onCreateInvitation(password?: string): void;
  onClearInvitation(): void;
  onSaveInvitationQr(filename: string, dataBase64: string): Promise<boolean>;
  onExportAuthorizationFile(filename: string, contents: string): Promise<boolean>;
  onCreateGatewayEnrollment(): void;
  onApproveGatewayEnrollment(enrollmentId: string, approverProjectId?: string): void;
  onCancelGatewayEnrollment(request: GatewayEnrollmentPending): void;
  onClearGatewayEnrollment(): void;
  onRenameGateway(
    gatewayNodeId: string,
    gatewayName: string,
    targetProjectId: string,
  ): Promise<void>;
  onRetireGateway(
    gatewayNodeId: string,
    authorityProjectId: string,
  ): Promise<void>;
  onCheckGatewayLiveness(gatewayNodeId: string): void;
  onRestartGateway(
    gatewayNodeId: string,
    targetProjectId: string,
    mode: GatewayRestartMode,
  ): void;
  onReviewGatewayUpdates(): void;
  onRetryGatewayUpdateDiscovery(): void;
  onReconnectGatewayUpdates(): void;
  onCheckForUpdates(): void;
  onUpdateNativeApp(): void;
  onRestartApp(): void;
  onCopyPageLink(): void;
  onRefreshNativeUpdate(): void;
  onInstallNativeUpdate(): void;
  onExportDiagnostics(): Promise<boolean>;
  onEnableWebPush(): void;
  onDisableWebPush(): void;
};

export function MatrixSettings(props: Props) {
  if (!props.open) return null;
  return <MatrixSettingsDialog {...props} />;
}

function MatrixSettingsDialog({
  open,
  config,
  status,
  connectionDetail,
  error,
  pairingPreview,
  pairingCompletion,
  trustedGateway,
  activeDeviceCount,
  savedGateways,
  gatewayDirectory,
  availableProjectIds,
  repairReason,
  pairingBusy,
  deviceInvitation,
  invitationBusy,
  invitationError,
  invitationReauthRequired,
  gatewayEnrollmentInvitation,
  pendingGatewayEnrollments,
  approvedGatewayEnrollmentIds,
  gatewayEnrollmentBusy,
  gatewayEnrollmentError,
  gatewayProfileBusy,
  gatewayProfileError,
  gatewayRetirementBusy,
  gatewayRetirementError,
  gatewayNodeLivenessById,
  gatewayRestartRuntimeByNode,
  gatewayLivenessNow,
  gatewayRelease,
  gatewayUpdateAvailableCount,
  gatewayUpdateNodeCount,
  gatewayUpdateDiscoveryError,
  gatewayUpdateDiscoveryBusy,
  updateState,
  nativeUpdateState,
  nativeUpdateBusy,
  nativeUpdateRequestBusy,
  diagnosticExportBusy,
  nativeRuntime,
  webPushState,
  webPushBusy,
  copyPageLinkBusy,
  signOutBusy,
  onChange,
  onPairingLink,
  onClearPairing,
  onConfirmPairing,
  onFinishPairing,
  onClose,
  onDisconnect,
  onForget,
  onCreateInvitation,
  onClearInvitation,
  onSaveInvitationQr,
  onExportAuthorizationFile,
  onCreateGatewayEnrollment,
  onApproveGatewayEnrollment,
  onCancelGatewayEnrollment,
  onClearGatewayEnrollment,
  onRenameGateway,
  onRetireGateway,
  onCheckGatewayLiveness,
  onRestartGateway,
  onReviewGatewayUpdates,
  onRetryGatewayUpdateDiscovery,
  onReconnectGatewayUpdates,
  onCheckForUpdates,
  onUpdateNativeApp,
  onRestartApp,
  onCopyPageLink,
  onRefreshNativeUpdate,
  onInstallNativeUpdate,
  onExportDiagnostics,
  onEnableWebPush,
  onDisableWebPush,
}: Props) {
  const [manualRepairReason, setManualRepairReason] =
    useState<ConnectionRepairReason | null>(null);
  const [activeSection, setActiveSection] = useState<
    "workspace" | "devices" | "computers" | "support"
  >("workspace");
  const effectiveRepairReason = repairReason ?? manualRepairReason;
  const repairRequired = effectiveRepairReason !== null;
  const [addingGateway, setAddingGateway] = useState(false);
  const [editingGatewayNodeId, setEditingGatewayNodeId] = useState<string | null>(null);
  const [restartConfirmationNodeId, setRestartConfirmationNodeId] = useState<string | null>(null);
  const [gatewayNameDraft, setGatewayNameDraft] = useState("");
  const [diagnosticExportStatus, setDiagnosticExportStatus] = useState<
    "started" | "failed" | null
  >(null);
  const connected =
    status === "connected" ||
    status === "securing" ||
    status === "reconnecting";
  const nativeHostDetected = injectedNativeBridgePort() !== null;
  const gatewaySoftware = gatewayUpdateSettingsPresentation({
    trusted: trustedGateway !== null,
    ...(gatewayRelease ? { releaseId: gatewayRelease.releaseId } : {}),
    discoveryBusy: gatewayUpdateDiscoveryBusy,
    discoveryError: gatewayUpdateDiscoveryError,
    directoryState: gatewayDirectory === null
      ? "missing"
      : gatewayDirectory.directory.gateways.length === 0
        ? "empty"
        : "ready",
    connectionStatus: status,
    availableCount: gatewayUpdateAvailableCount,
    nodeCount: gatewayUpdateNodeCount,
  });
  const actionBusy =
    pairingBusy ||
    invitationBusy ||
    gatewayEnrollmentBusy !== null ||
    gatewayProfileBusy !== null ||
    webPushBusy ||
    nativeUpdateRequestBusy ||
    diagnosticExportBusy ||
    copyPageLinkBusy ||
    gatewayRetirementBusy !== null ||
    signOutBusy;
  const busy =
    status === "connecting" ||
    status === "securing" ||
    status === "reconnecting" ||
    actionBusy;
  const needsAccount =
    Boolean(pairingPreview) && (!trustedGateway || repairRequired);
  const hasSavedConnection = Boolean(
    config.homeserver.trim() &&
      config.userId.trim() &&
      config.accessToken.trim() &&
      config.roomId.trim(),
  );
  const hasIncompleteLocalSetup = !hasSavedConnection && Boolean(
    config.homeserver.trim() ||
      config.userId.trim() ||
      config.roomId.trim() ||
      config.gatewayId.trim() ||
      pairingPreview,
  );
  const setupMode =
    !trustedGateway || repairRequired || Boolean(pairingPreview) || Boolean(pairingCompletion);
  const connectionPresentation = deriveConnectionPresentation(status, connectionDetail);
  const availableProjectIdSet = new Set(availableProjectIds);
  const onlineGatewayNodeIds = new Set(
    (gatewayDirectory?.directory.gateways ?? [])
      .filter(gateway => gatewayNodeLivenessPresentation(
        gatewayNodeLivenessById[gateway.gatewayNodeId],
        gatewayLivenessNow,
      ).state === "online")
      .map(gateway => gateway.gatewayNodeId),
  );
  const workspaceRepair = workspaceGatewayRepairPlan(
    gatewayDirectory,
    availableProjectIdSet,
    onlineGatewayNodeIds,
  );
  const directoryGatewayProfiles = (gatewayDirectory?.directory.gateways ?? []).map(
    gateway => ({
      gatewayId: gateway.workspaceId,
      gatewayNodeId: gateway.gatewayNodeId,
      gatewayName: gateway.gatewayName,
      computerName: gateway.computerName,
      buildId: gateway.buildId,
      onlineUpdate: gateway.onlineUpdate === true,
      targetProjectId: gateway.projects?.find(project =>
        availableProjectIdSet.has(project.projectId)
      )?.projectId,
      projectCount: gateway.projects?.length ?? 0,
    }),
  );
  const savedGatewayProfiles = (savedGateways.length > 0
    ? savedGateways
    : trustedGateway
      ? [trustedGateway]
      : []).map(gateway => ({
        gatewayId: gateway.gatewayId,
        gatewayNodeId: gateway.gatewayNodeId,
        gatewayName: gateway.gatewayName,
        computerName: undefined as string | undefined,
        buildId: undefined as string | undefined,
        onlineUpdate: false,
        targetProjectId: undefined as string | undefined,
        projectCount: 0,
      }));
  const gatewayProfiles = directoryGatewayProfiles.length > 0
    ? directoryGatewayProfiles
    : savedGatewayProfiles;
  const showGatewayManagement =
    hasSavedConnection || gatewayProfiles.length > 0;
  const gatewayManagementReady =
    Boolean(trustedGateway) &&
    status === "connected" &&
    !repairRequired &&
    !pairingPreview;
  const gatewayManagementDetail = !trustedGateway
    ? "Loading Workspace computer authorization…"
    : pairingPreview
      ? "Finish adding this device before adding another computer"
      : repairRequired
        ? "Repair this device before adding another computer"
        : status !== "connected"
          ? "Resume this device's Workspace connection before adding another computer"
          : workspaceRepair && workspaceRepair.unavailableProjects > 0
            ? `${workspaceRepair.availableProjects} of ${workspaceRepair.totalProjects} projects available; finish recovery from the affected computer card below`
            : `${gatewayProfiles.length} ${gatewayProfiles.length === 1 ? "computer" : "computers"} available to every authorized device`;
  const recoveryPlan = deriveConnectionRecoveryPlan({
    status,
    detail: connectionDetail,
    hasSavedConnection,
    nativeRuntimeAvailable: nativeRuntime !== null,
  });
  const dialogRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const requestClose = () => {
    if (actionBusy) return;
    onClose();
  };

  useDialogFocus({
    open,
    containerRef: dialogRef,
    initialFocusRef: closeButtonRef,
    escapeDisabled: actionBusy,
    onEscape: requestClose,
  });

  const runRecoveryAction = (action: ConnectionRecoveryAction) => {
    switch (action) {
      case "new-invitation":
        setManualRepairReason("manual");
        return;
      case "check-updates":
        onCheckForUpdates();
        return;
      case "update-native-app":
        onUpdateNativeApp();
        return;
      case "reload-app":
        onRestartApp();
        return;
      case "copy-page-link":
        onCopyPageLink();
        return;
      case "export-diagnostics":
        void onExportDiagnostics();
    }
  };
  const pwaUpdateBusy =
    updateState.phase === "checking" ||
    updateState.phase === "updating" ||
    updateState.phase === "waiting";
  const recoveryActionInFlight = (action: ConnectionRecoveryAction) =>
    (action === "check-updates" && pwaUpdateBusy) ||
    (action === "update-native-app" && nativeUpdateBusy) ||
    (action === "copy-page-link" && copyPageLinkBusy);
  const recoveryActionLabel = (
    action: ConnectionRecoveryAction,
    fallback: string,
  ) => {
    if (action === "check-updates" && pwaUpdateBusy) {
      if (updateState.phase === "checking") return "Checking updates…";
      if (updateState.phase === "waiting") return "Update waiting…";
      return "Applying update…";
    }
    if (action === "update-native-app" && nativeUpdateBusy) {
      if (
        nativeUpdateState?.phase === "ready" ||
        nativeUpdateState?.phase === "permission_required"
      ) {
        return "Installing APK…";
      }
      if (nativeUpdateState?.phase === "downloading") {
        return "Downloading APK…";
      }
      return "Checking APK…";
    }
    if (action === "copy-page-link" && copyPageLinkBusy) {
      return "Copying link…";
    }
    return fallback;
  };

  return (
    <div
      className="settings-backdrop"
      role="presentation"
      onMouseDown={requestClose}
    >
      <section
        ref={dialogRef}
        className="matrix-settings pairing-settings"
        role="dialog"
        aria-modal="true"
        aria-labelledby="matrix-settings-title"
        aria-busy={busy}
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <span className="eyebrow">
              {setupMode ? "Secure device setup" : "Workspace settings"}
            </span>
            <h2 id="matrix-settings-title">
              {pairingCompletion
                ? "Device added"
                : repairRequired
                ? "Repair connection"
                : setupMode
                  ? "Add this device"
                  : "Manage Malink"}
            </h2>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            onClick={requestClose}
            aria-label="Close settings"
            disabled={actionBusy}
          >
            ×
          </button>
        </header>

        {!setupMode && (
          <nav className="settings-navigation" aria-label="Settings sections">
            {([
              ["workspace", "Workspace"],
              ["devices", "Devices"],
              ["computers", "Computers"],
              ["support", "App & support"],
            ] as const).map(([section, label]) => (
              <button
                key={section}
                type="button"
                className={activeSection === section ? "is-active" : ""}
                aria-current={activeSection === section ? "page" : undefined}
                onClick={() => {
                  setAddingGateway(false);
                  setActiveSection(section);
                }}
              >
                {label}
                {section === "computers" && gatewayUpdateAvailableCount > 0 && (
                  <b aria-label={`${gatewayUpdateAvailableCount} updates available`}>
                    {gatewayUpdateAvailableCount}
                  </b>
                )}
              </button>
            ))}
          </nav>
        )}

        <div className="matrix-settings-body">
        <section className="settings-group settings-connection-group">
          <SettingsGroupHeading
            eyebrow={setupMode
              ? "One-time invitation"
              : activeSection === "workspace"
                ? "Workspace"
                : activeSection === "devices"
                  ? "Authorized access"
                  : activeSection === "computers"
                    ? "Agent hosts"
                    : "This application"}
            title={setupMode
              ? pairingCompletion
                ? "Setup complete"
                : "Add this device to a Workspace"
              : activeSection === "workspace"
                ? "Workspace overview"
                : activeSection === "devices"
                  ? "Devices"
                  : activeSection === "computers"
                    ? "Workspace computers"
                    : "Application & support"}
            detail={setupMode
              ? "Use an invitation created by an authorized device or Workspace computer."
              : activeSection === "workspace"
                ? "See whether this device can sync and which Workspace computers are available."
                : activeSection === "devices"
                  ? "Manage this phone or browser and invite another device."
                  : activeSection === "computers"
                    ? "Manage the computers that run projects and Agents."
                    : "Keep this app current and collect diagnostic information when needed."}
          />

          {(setupMode || activeSection === "devices" || activeSection === "computers") && (
          <div className="settings-security-note">
            <span>✓</span>
            <p>
              {addingGateway
                ? "The new computer joins only after you approve its matching verification code."
                : activeSection === "devices" && !setupMode
                  ? "Each device receives its own authorization. Adding a device never copies another device's private key."
                  : "The invitation works once and expires. Confirm its Workspace and verification code before continuing."}
            </p>
          </div>
          )}

        {!setupMode && activeSection === "workspace" && (
          <div className="workspace-overview" aria-live="polite">
            <section className={`workspace-health workspace-health-${connectionPresentation.state}`}>
              <span className="workspace-health-mark" aria-hidden="true">
                {connectionPresentation.state === "ready" ? "✓" :
                  connectionPresentation.state === "progress" ? "↻" : "!"}
              </span>
              <span>
                <small>This device</small>
                <strong>{connectionPresentation.title}</strong>
                <p>{connectionPresentation.detail}</p>
              </span>
              {status !== "connected" && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={onReconnectGatewayUpdates}
                >
                  {status === "connecting" || status === "securing" || status === "reconnecting"
                    ? "Connecting…"
                    : "Resume connection"}
                </button>
              )}
            </section>
            <div className="workspace-facts">
              <button type="button" onClick={() => setActiveSection("devices")}>
                <small>Authorized devices</small>
                <strong>{activeDeviceCount ?? "Checking"}</strong>
                <span>Manage devices</span>
              </button>
              <button type="button" onClick={() => setActiveSection("computers")}>
                <small>Workspace computers</small>
                <strong>{gatewayProfiles.length}</strong>
                <span>
                  {onlineGatewayNodeIds.size} online
                  {gatewayUpdateAvailableCount > 0
                    ? ` · ${gatewayUpdateAvailableCount} update${gatewayUpdateAvailableCount === 1 ? "" : "s"}`
                    : ""}
                </span>
              </button>
              <span>
                <small>Available projects</small>
                <strong>{availableProjectIds.length}</strong>
                <span>Ready on this device</span>
              </span>
            </div>
          </div>
        )}

        {!setupMode && activeSection === "computers" && (
          <section className={`computer-software-summary ${gatewaySoftware.attention ? "needs-attention" : ""}`}>
            <span>
              <small>Software across Workspace computers</small>
              <strong>
                {gatewayUpdateAvailableCount > 0
                  ? `${gatewayUpdateAvailableCount} update${gatewayUpdateAvailableCount === 1 ? "" : "s"} available`
                  : gatewayUpdateNodeCount > 0
                    ? "Computer versions checked"
                    : "Waiting for computer information"}
              </strong>
              <p role={gatewaySoftware.attention ? "alert" : "status"}>
                {gatewaySoftware.detail}
              </p>
            </span>
            {gatewaySoftware.action && gatewaySoftware.actionLabel && (
              <button
                type="button"
                disabled={gatewayUpdateDiscoveryBusy || busy}
                onClick={gatewaySoftware.action === "review"
                  ? onReviewGatewayUpdates
                  : gatewaySoftware.action === "retry-discovery"
                    ? onRetryGatewayUpdateDiscovery
                    : onReconnectGatewayUpdates}
              >
                {gatewaySoftware.action === "reconnect" &&
                (status === "connecting" || status === "securing" || status === "reconnecting")
                  ? "Connecting…"
                  : gatewaySoftware.actionLabel}
              </button>
            )}
          </section>
        )}

        {showGatewayManagement && !setupMode && activeSection === "computers" && (
          <section className="gateway-profile-list" aria-label="Workspace computers">
            <header>
              <span>
                <strong>Workspace computers</strong>
                <small>{gatewayManagementDetail}</small>
              </span>
              <button
                type="button"
                disabled={busy || !gatewayManagementReady}
                onClick={() => setAddingGateway((current) => !current)}
              >
                {addingGateway
                  ? "Close"
                  : pendingGatewayEnrollments.length > 0
                    ? `Review or add (${pendingGatewayEnrollments.length})`
                    : "Add computer"}
              </button>
            </header>
            <div>
              {gatewayProfiles.map((gateway) => {
                const gatewayProfileId = gateway.gatewayNodeId ?? gateway.gatewayId;
                const gatewayIdentity = gatewayProjectOwner(
                  gatewayProfileId,
                  gateway.gatewayName,
                  gateway.computerName,
                );
                const editing = editingGatewayNodeId === gatewayProfileId;
                const targetProjectId = gateway.targetProjectId;
                const repairNode = workspaceRepair?.nodes.find(
                  node => node.gatewayNodeId === gatewayProfileId,
                );
                const liveCheckAvailable = gateway.onlineUpdate && Boolean(targetProjectId);
                const livenessValue: GatewayNodeLiveness = liveCheckAvailable
                  ? gatewayNodeLivenessById[gatewayProfileId] ?? { state: "unknown" }
                  : {
                      state: "unavailable",
                      detail: targetProjectId
                        ? "This Gateway build does not advertise the signed live-status capability."
                        : "This client has no synchronized project route for a signed live check.",
                    };
                const liveness = gatewayNodeLivenessPresentation(
                  livenessValue,
                  gatewayLivenessNow,
                );
                const noReply = gatewayNoReplyPresentation({
                  gatewayLabel: gatewayIdentity.label,
                  consecutiveNoReplies: livenessValue.consecutiveNoReplies,
                });
                const lastVerified = gatewayLastVerifiedText(
                  gatewayNodeLivenessById[gatewayProfileId]?.lastVerifiedAt,
                  gatewayLivenessNow,
                );
                const updateAvailable = Boolean(
                  gatewayRelease && gateway.buildId && gateway.buildId !== gatewayRelease.buildId,
                );
                const restartRuntime = gatewayRestartRuntimeByNode[gatewayProfileId]
                  ?? { state: "idle" as const };
                const restartBusy = restartRuntime.state === "requesting" ||
                  restartRuntime.state === "waiting" ||
                  restartRuntime.state === "restarting";
                const restartConfirming = restartConfirmationNodeId === gatewayProfileId;
                const canRestart = gatewayManagementReady && liveCheckAvailable &&
                  Boolean(targetProjectId) && liveness.state === "online";
                return (
                  <div
                    key={gatewayProfileId}
                    className="gateway-profile-card active"
                  >
                    <div className="gateway-profile-overview">
                      <span className="gateway-device-mark" aria-hidden="true">G</span>
                      <span className="gateway-profile-identity">
                        <strong>{gatewayIdentity.label}</strong>
                        <small title={gatewayProfileId}>
                          {gatewayIdentity.computerName} · {gateway.projectCount}{" "}
                          {gateway.projectCount === 1 ? "project" : "projects"}
                        </small>
                      </span>
                      <span
                        className={
                          `gateway-profile-liveness gateway-profile-liveness-${liveness.state}` +
                          (liveness.state === "unreachable"
                            ? noReply.persistent
                              ? " gateway-profile-liveness-attention"
                              : " gateway-profile-liveness-timeout"
                            : "")
                        }
                        aria-live="polite"
                        title={liveness.detail}
                      >
                        <i aria-hidden="true" />
                        <strong>{liveness.label}</strong>
                      </span>
                    </div>
                    <div className={`gateway-profile-software ${updateAvailable ? "has-update" : ""}`}>
                      <span>
                        <small>Gateway software</small>
                        <strong>
                          {updateAvailable
                            ? "Update available"
                            : gateway.buildId
                              ? "Up to date"
                              : "Version not reported"}
                        </strong>
                        <small>
                          {gateway.buildId
                            ? `Installed build ${gateway.buildId}`
                            : "Check this computer when it is online."}
                        </small>
                      </span>
                      {(updateAvailable || gatewayUpdateDiscoveryError) && (
                        <button
                          type="button"
                          disabled={busy || !gatewayManagementReady}
                          onClick={gatewayUpdateDiscoveryError
                            ? onRetryGatewayUpdateDiscovery
                            : onReviewGatewayUpdates}
                        >
                          {gatewayUpdateDiscoveryBusy
                            ? "Checking…"
                            : gatewayUpdateDiscoveryError
                              ? "Retry update check"
                              : "Review update"}
                        </button>
                      )}
                    </div>
                    <div className="gateway-profile-restart">
                      <span>
                        <small>Provider changes</small>
                        <strong>Restart Gateway to load them</strong>
                        <small>
                          After adding or changing a Provider on this computer, restart its
                          Gateway before creating a session with that Provider.
                        </small>
                      </span>
                      {!restartConfirming && (
                        <button
                          type="button"
                          disabled={busy || restartBusy || !canRestart}
                          title={!gateway.onlineUpdate
                            ? "Update this Gateway Host before using remote restart."
                            : !targetProjectId
                              ? "This Gateway has no synchronized project route."
                              : liveness.state !== "online"
                                ? "Check status first so Malink can verify this Gateway is online."
                                : "Restart this Gateway process"}
                          onClick={() => setRestartConfirmationNodeId(gatewayProfileId)}
                        >
                          {restartRuntime.state === "requesting"
                            ? "Sending…"
                            : restartRuntime.state === "waiting"
                              ? "Waiting for idle…"
                              : restartRuntime.state === "restarting"
                                ? "Restarting…"
                                : restartRuntime.state === "failed"
                                  ? "Retry restart"
                                  : restartRuntime.state === "ready"
                                    ? "Restart again"
                                    : "Restart Gateway"}
                        </button>
                      )}
                    </div>
                    {restartConfirming && targetProjectId && (
                      <div className="gateway-restart-confirmation" role="alert">
                        <span>
                          <strong>Restart {gatewayIdentity.label}?</strong>
                          <small>
                            New sessions will be unavailable briefly. Waiting for idle preserves
                            active work; restarting now interrupts active Agent turns.
                          </small>
                        </span>
                        <span>
                          <button
                            type="button"
                            className="connect-button"
                            disabled={busy || restartBusy}
                            onClick={() => {
                              setRestartConfirmationNodeId(null);
                              onRestartGateway(gatewayProfileId, targetProjectId, "when_idle");
                            }}
                          >
                            Restart when idle
                          </button>
                          <button
                            type="button"
                            className="danger-button"
                            disabled={busy || restartBusy}
                            onClick={() => {
                              setRestartConfirmationNodeId(null);
                              onRestartGateway(gatewayProfileId, targetProjectId, "force");
                            }}
                          >
                            Restart now
                          </button>
                          <button
                            type="button"
                            disabled={busy || restartBusy}
                            onClick={() => setRestartConfirmationNodeId(null)}
                          >
                            Cancel
                          </button>
                        </span>
                      </div>
                    )}
                    {restartRuntime.state !== "idle" && (
                      <p
                        className={`gateway-restart-status gateway-restart-status-${restartRuntime.state}`}
                        role={restartRuntime.state === "failed" ? "alert" : "status"}
                        aria-live="polite"
                      >
                        <strong>{gatewayRestartStateLabel(restartRuntime.state)}</strong>{" "}
                        {restartRuntime.detail ?? restartRuntime.status?.detail ??
                          gatewayRestartStateDetail(restartRuntime.state)}
                      </p>
                    )}
                    <details className="gateway-profile-details">
                      <summary>Technical details</summary>
                      <dl>
                        <div>
                          <dt>Build</dt>
                          <dd title={gateway.buildId ?? "This Gateway did not report a build ID"}>
                            {gateway.buildId ?? "Not reported"}
                          </dd>
                        </div>
                        <div>
                          <dt>Node</dt>
                          <dd title={gatewayProfileId}>{gatewayIdentity.shortId}</dd>
                        </div>
                      </dl>
                      <p>
                        {liveness.detail}{lastVerified ? ` ${lastVerified}` : ""}
                      </p>
                    </details>
                    {livenessValue.state === "unreachable" && (
                      <GatewayNoReplyHelp
                        gatewayLabel={gatewayIdentity.label}
                        consecutiveNoReplies={livenessValue.consecutiveNoReplies}
                        onExportDiagnostics={onExportDiagnostics}
                        diagnosticExportBusy={diagnosticExportBusy}
                      />
                    )}
                    {(Boolean(repairNode?.unavailableProjectIds.length) ||
                      livenessValue.state === "unreachable") && repairNode && (
                      <GatewayRecoveryCard
                        gatewayNodeId={gatewayProfileId}
                        gatewayLabel={gatewayIdentity.label}
                        projectCount={gateway.projectCount}
                        unavailableProjectCount={repairNode.unavailableProjectIds.length}
                        authorityProjectId={repairNode.retirementAuthorityProjectId}
                        retirementBlocker={repairNode.retirementBlocker}
                        busy={busy || gatewayRetirementBusy !== null}
                        retiring={gatewayRetirementBusy === gatewayProfileId}
                        error={gatewayRetirementError?.gatewayNodeId === gatewayProfileId
                          ? gatewayRetirementError.detail
                          : null}
                        onAdd={() => setAddingGateway(true)}
                        onReviewGatewayUpdates={onReviewGatewayUpdates}
                        onRetire={onRetireGateway}
                      />
                    )}
                    {editing && (
                      <form
                        className="gateway-profile-rename"
                        onSubmit={(event) => {
                          event.preventDefault();
                          if (!targetProjectId || !gatewayNameDraft.trim()) return;
                          void onRenameGateway(
                            gatewayProfileId,
                            gatewayNameDraft.trim(),
                            targetProjectId,
                          ).then(() => setEditingGatewayNodeId(null)).catch(() => undefined);
                        }}
                      >
                        <label>
                          <span>Custom name</span>
                          <input
                            value={gatewayNameDraft}
                            maxLength={128}
                            autoComplete="off"
                            disabled={gatewayProfileBusy === gatewayProfileId}
                            onChange={(event) => setGatewayNameDraft(event.target.value)}
                          />
                        </label>
                        <span>
                          <button
                            type="submit"
                            className="connect-button"
                            disabled={
                              gatewayProfileBusy === gatewayProfileId ||
                              !gatewayNameDraft.trim() ||
                              gatewayNameDraft.trim() === gateway.gatewayName
                            }
                          >
                            {gatewayProfileBusy === gatewayProfileId ? "Saving…" : "Save"}
                          </button>
                          <button
                            type="button"
                            disabled={gatewayProfileBusy === gatewayProfileId}
                            onClick={() => setEditingGatewayNodeId(null)}
                          >
                            Cancel
                          </button>
                        </span>
                        {gatewayProfileError && (
                          <em role="alert">{gatewayProfileError}</em>
                        )}
                      </form>
                    )}
                    {!editing && (
                      <span className="gateway-profile-actions">
                        <button
                          type="button"
                          disabled={
                            busy ||
                            !gatewayManagementReady ||
                            !liveCheckAvailable ||
                            !liveness.canCheck
                          }
                          title={liveness.detail}
                          onClick={() => onCheckGatewayLiveness(gatewayProfileId)}
                        >
                          {liveness.state === "checking"
                            ? "Checking…"
                            : liveness.state === "unreachable"
                              ? noReply.retryLabel
                              : "Check status"}
                        </button>
                        <button
                          type="button"
                          disabled={busy || !gatewayManagementReady || !targetProjectId}
                          title={targetProjectId
                            ? `Rename ${gatewayIdentity.label}`
                            : "This Gateway has no available project route"}
                          onClick={() => {
                            setEditingGatewayNodeId(gatewayProfileId);
                            setGatewayNameDraft(gateway.gatewayName);
                          }}
                        >
                          Rename
                        </button>
                      </span>
                    )}
                  </div>
                );
              })}
              {gatewayProfiles.length === 0 && (
                <div className="gateway-profile-card active" aria-live="polite">
                  <div className="gateway-profile-overview">
                    <span className="gateway-device-mark" aria-hidden="true">G</span>
                    <span className="gateway-profile-identity">
                      <strong>Workspace computer</strong>
                      <small>Loading its saved profile…</small>
                    </span>
                    <span className="gateway-profile-liveness gateway-profile-liveness-checking">
                      <i aria-hidden="true" />
                      <strong>Loading</strong>
                    </span>
                  </div>
                </div>
              )}
            </div>
          </section>
        )}

        {recoveryPlan && !repairRequired && (setupMode || activeSection === "workspace") && (
          <section className="connection-recovery-panel" aria-live="polite">
            <div>
              <span className="connection-recovery-mark" aria-hidden="true">!</span>
              <span>
                <strong>{recoveryPlan.title}</strong>
                <p>{recoveryPlan.detail}</p>
              </span>
            </div>
            <div className="connection-recovery-actions">
              <button
                type="button"
                className="connect-button"
                disabled={busy || recoveryActionInFlight(recoveryPlan.primary.action)}
                onClick={() => runRecoveryAction(recoveryPlan.primary.action)}
              >
                {recoveryActionLabel(
                  recoveryPlan.primary.action,
                  recoveryPlan.primary.label,
                )}
              </button>
              {recoveryPlan.secondary && (
                <button
                  type="button"
                  disabled={busy || recoveryActionInFlight(recoveryPlan.secondary.action)}
                  onClick={() => runRecoveryAction(recoveryPlan.secondary!.action)}
                >
                  {recoveryActionLabel(
                    recoveryPlan.secondary.action,
                    recoveryPlan.secondary.label,
                  )}
                </button>
              )}
            </div>
            {recoveryPlan.primary.action === "update-native-app" &&
              nativeUpdateState && (
                <small>{nativeUpdateStatusText(nativeUpdateState)}</small>
              )}
          </section>
        )}

        {!setupMode && activeSection === "computers" && addingGateway && (
          <GatewayEnrollmentPanel
            invitation={gatewayEnrollmentInvitation}
            pending={pendingGatewayEnrollments}
            approvedEnrollmentIds={approvedGatewayEnrollmentIds}
            busy={gatewayEnrollmentBusy}
            error={gatewayEnrollmentError}
            onCreate={onCreateGatewayEnrollment}
            onApprove={onApproveGatewayEnrollment}
            onCancel={onCancelGatewayEnrollment}
            onClear={() => {
              setAddingGateway(false);
              onClearGatewayEnrollment();
            }}
          />
        )}

        {!setupMode && activeSection === "devices" && (
          <section className="current-device-card" aria-live="polite">
            <span className="current-device-mark" aria-hidden="true">
              {nativeHostDetected ? "A" : "W"}
            </span>
            <span>
              <small>This device</small>
              <strong>{nativeHostDetected ? "Android app" : "This browser"}</strong>
              <p>
                {status === "connected"
                  ? "Authorized and synchronizing this Workspace."
                  : "Authorization is saved; syncing is currently paused or reconnecting."}
              </p>
            </span>
            <span className="current-device-actions">
              {status === "connected" ? (
                <button type="button" disabled={busy} onClick={onDisconnect}>
                  Pause syncing
                </button>
              ) : (
                <button type="button" disabled={busy} onClick={onReconnectGatewayUpdates}>
                  {status === "connecting" || status === "securing" || status === "reconnecting"
                    ? "Connecting…"
                    : "Resume syncing"}
                </button>
              )}
            </span>
          </section>
        )}

        {(setupMode || (!addingGateway && activeSection === "devices")) && <PairingWizard
          preview={pairingPreview}
          trustedGateway={trustedGateway}
          repairReason={effectiveRepairReason}
          busy={pairingBusy}
          connectionStatus={status}
          progressDetail={connectionDetail}
          error={error}
          completion={pairingCompletion}
          canConfirm={Boolean(config.accessToken)}
          deviceInvitation={deviceInvitation}
          invitationBusy={invitationBusy}
          invitationError={invitationError}
          invitationReauthRequired={invitationReauthRequired}
          onLink={onPairingLink}
          onClear={() => {
            setAddingGateway(false);
            onClearPairing();
          }}
          onConfirm={onConfirmPairing}
          onFinish={onFinishPairing}
          onCreateInvitation={onCreateInvitation}
          onClearInvitation={onClearInvitation}
          onSaveQrCode={onSaveInvitationQr}
          onExportAuthorizationFile={onExportAuthorizationFile}
          />}

        {(needsAccount || (!setupMode && activeSection === "support")) && (
          <details className="connection-details" open={needsAccount}>
            <summary>
              <span>
                <strong>Connection details</strong>
                <small>
                  {needsAccount
                    ? "Sign in once to finish adding this device"
                    : status === "securing"
                      ? "Checking your approved computer"
                    : "Technical account and channel identifiers"}
                </small>
              </span>
              <b>
                {status === "securing"
                  ? "Checking"
                  : connected
                    ? "Advanced"
                    : needsAccount
                    ? "Sign in"
                      : "Details"}
              </b>
            </summary>

            <div className="matrix-form-grid compact-matrix-form">
              <label className="wide-field">
                <span>Account provider</span>
                <input
                  value={config.homeserver}
                  readOnly={Boolean(pairingPreview || trustedGateway)}
                  placeholder="Provided by your computer"
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) =>
                    onChange({ ...config, homeserver: event.target.value })
                  }
                />
              </label>
              {needsAccount && !config.accessToken && (
                <p className="matrix-session-hint wide-field" role="alert">
                  This invitation does not contain a valid one-time device sign-in.
                  Request a new invitation from an approved Malink device or Gateway.
                </p>
              )}
              {config.accessToken && (
                <p className="matrix-session-hint wide-field">
                  Signed in as {config.userId || "your account"} on this device.
                </p>
              )}
              <label>
                <span>Conversation channel</span>
                <input value={config.roomId} readOnly placeholder="From QR code" />
              </label>
            </div>
          </details>
        )}
        </section>

        {!setupMode && activeSection === "support" && (
          <section className="settings-group settings-app-group">
            <SettingsGroupHeading
              eyebrow="Application"
              title="App & updates"
              detail="Choose where the interface loads from and keep each Malink component current."
            />

            {nativeHostDetected && (
              <PwaSourceSettings
                runtime={nativeRuntime}
                onChange={() => {
                  window.location.href = "malink://static-service-settings";
                }}
              />
            )}

            {nativeHostDetected && (
              <NativeUpdateSettings
                state={nativeUpdateState}
                busy={nativeUpdateBusy}
                onRefresh={onRefreshNativeUpdate}
                onInstall={onInstallNativeUpdate}
              />
            )}

            <PwaUpdateSettings state={updateState} onCheck={onCheckForUpdates} />

          </section>
        )}

        {!setupMode && activeSection === "support" && !nativeRuntime && trustedGateway && (
          <section className="settings-group settings-notification-group">
            <SettingsGroupHeading
              eyebrow="Attention"
              title="Notifications"
              detail="Control whether this browser can alert you when an agent needs attention."
            />
            <section className="web-push-settings" aria-live="polite">
              <span>
                <strong>Agent notifications</strong>
                <small>{webPushStatusText(webPushState)}</small>
                {webPushState.status === "error" && (
                  <em>{webPushState.detail}</em>
                )}
              </span>
              {webPushState.status === "enabled" ? (
                <button
                  type="button"
                  disabled={webPushBusy}
                  onClick={onDisableWebPush}
                >
                  {webPushBusy ? "Disabling…" : "Disable"}
                </button>
              ) : webPushState.status === "prompt" || webPushState.status === "error" ? (
                <button
                  type="button"
                  disabled={webPushBusy || status !== "connected"}
                  onClick={onEnableWebPush}
                >
                  {webPushBusy ? "Enabling…" : "Enable"}
                </button>
              ) : null}
            </section>
          </section>
        )}

        {error && !setupMode && activeSection === "workspace" && (
          <div className="connection-error" role="alert">
            <strong>
              {pairingPreview && !trustedGateway
                ? "Setup needs attention"
                : "Connection needs attention"}
            </strong>
            <span>{error}</span>
            {nativeRuntime && (
              <span className="connection-error-build">
                Native APK <code>{nativeRuntime.runtimeVersion}</code>
              </span>
            )}
          </div>
        )}

        {!setupMode && activeSection === "support" && (
        <section className="settings-group settings-support-group">
          <SettingsGroupHeading
            eyebrow="Support"
            title="Diagnostics & recovery"
            detail="Export a support report or inspect exact build identifiers."
          />
          <div className="settings-diagnostic-card">
            <span>
              <strong>Diagnostic report</strong>
              <small>Connection state and bounded build details for troubleshooting.</small>
              {diagnosticExportStatus && (
                <small role="status">
                  {diagnosticExportStatus === "started"
                    ? nativeHostDetected
                      ? "Android diagnostic share sheet opened."
                      : "Diagnostic report download started."
                    : nativeHostDetected
                      ? "The Android diagnostic share sheet could not be opened."
                      : "The diagnostic report could not be downloaded."}
                </small>
              )}
            </span>
            <button
              type="button"
              disabled={diagnosticExportBusy}
              aria-busy={diagnosticExportBusy}
              onClick={() => void (async () => {
                setDiagnosticExportStatus(null);
                const exported = await onExportDiagnostics();
                setDiagnosticExportStatus(exported ? "started" : "failed");
              })()}
            >
              {diagnosticExportBusy ? "Exporting diagnostics…" : "Export diagnostics"}
            </button>
          </div>
          <div className="settings-build-version">
            <details className="settings-build-details">
              <summary>Build and version details</summary>
              <div className="settings-build-details-body">
                <span>
                  PWA build <code>{MALINK_BUILD_VERSION}</code>
                  {nativeRuntime && (
                    <>
                      <small>
                        Native APK <code>{nativeRuntime.runtimeVersion}</code>
                      </small>
                      <small>
                        Native build <code>{nativeRuntime.runtimeBuild}</code>
                      </small>
                    </>
                  )}
                  {gatewayRelease && (
                    <small>
                      Published Gateway update <code>{gatewayRelease.releaseId}</code>
                    </small>
                  )}
                </span>
              </div>
            </details>
          </div>
        </section>
        )}

        {((!setupMode && activeSection === "devices" && hasSavedConnection) ||
          (setupMode && hasIncompleteLocalSetup && !pairingCompletion)) && (
          <DeviceRemovalSettings
            deviceKind={
              hasSavedConnection
                ? nativeHostDetected
                  ? "android"
                  : "browser"
                : null
            }
            busy={signOutBusy}
            onRemove={onForget}
          />
        )}
        </div>
      </section>
    </div>
  );
}

export function GatewayRecoveryCard({
  gatewayNodeId,
  gatewayLabel,
  projectCount,
  unavailableProjectCount,
  authorityProjectId,
  retirementBlocker,
  busy,
  retiring,
  error,
  onAdd,
  onReviewGatewayUpdates,
  onRetire,
}: {
  gatewayNodeId: string;
  gatewayLabel: string;
  projectCount: number;
  unavailableProjectCount: number;
  authorityProjectId: string | null;
  retirementBlocker: "gateway_update_required" | "gateway_online_required" | null;
  busy: boolean;
  retiring: boolean;
  error: string | null;
  onAdd(): void;
  onReviewGatewayUpdates(): void;
  onRetire(gatewayNodeId: string, authorityProjectId: string): Promise<void>;
}) {
  const [confirming, setConfirming] = useState(false);
  return (
    <section className="gateway-repair-card" aria-live="polite">
      <span>
        <strong>
          {unavailableProjectCount > 0
            ? `${unavailableProjectCount} ${
              unavailableProjectCount === 1 ? "project is" : "projects are"
            } unavailable`
            : "This computer needs attention"}
        </strong>
        <small>
          Start Malink on this computer to restore it automatically. If it can no longer
          reconnect, add the computer again or continue without its unavailable projects.
        </small>
      </span>
      <div className="gateway-repair-actions">
        <button type="button" disabled={busy} onClick={onAdd}>
          Add this computer again
        </button>
        <button
          type="button"
          className="gateway-retire-button"
          disabled={busy || !authorityProjectId}
          title={authorityProjectId
            ? `Permanently retire ${gatewayLabel}`
            : retirementBlocker === "gateway_update_required"
              ? "Update another online Gateway before removing this computer"
              : "Connect another Workspace computer before removing this one"}
          onClick={() => setConfirming(true)}
        >
          Continue without this computer…
        </button>
      </div>
      {retirementBlocker === "gateway_update_required" && (
        <div className="gateway-repair-update-required">
          <em>
            Another computer is online, but its Gateway version cannot safely complete
            this removal. Update that Gateway first; Malink will then make this action
            available.
          </em>
          <button type="button" disabled={busy} onClick={onReviewGatewayUpdates}>
            Review Gateway updates
          </button>
        </div>
      )}
      {retirementBlocker === "gateway_online_required" && (
        <em>
          Another connected computer is required before Malink can safely remove this
          unavailable one.
        </em>
      )}
      {confirming && (
        <div className="gateway-retirement-confirmation" role="alert">
          <strong>Continue without {gatewayLabel}?</strong>
          <p>
            Malink will remove its {projectCount} {projectCount === 1 ? "project" : "projects"}
            {" "}and related conversations from every client. Files on that computer are not
            deleted. You can add the computer again later, but unavailable Malink history may not
            return.
          </p>
          <span>
            <button type="button" disabled={retiring} onClick={() => setConfirming(false)}>
              Keep Gateway
            </button>
            <button
              type="button"
              className="danger-confirm-button"
              disabled={busy || !authorityProjectId}
              onClick={() => {
                if (!authorityProjectId) return;
                void onRetire(gatewayNodeId, authorityProjectId)
                  .then(() => setConfirming(false))
                  .catch(() => undefined);
              }}
            >
              {retiring ? "Removing…" : "Remove computer and continue"}
            </button>
          </span>
          {error && <em role="alert">{error}</em>}
        </div>
      )}
    </section>
  );
}

export function DeviceRemovalSettings({
  deviceKind,
  busy,
  onRemove,
}: {
  deviceKind: "android" | "browser" | null;
  busy: boolean;
  onRemove(): void;
}) {
  return (
    <section className="settings-danger-zone settings-danger-zone-standalone">
      <span>
        <strong>
          {deviceKind === "android"
            ? "Sign out this device"
            : deviceKind === "browser"
              ? "Sign out this device"
              : "Discard incomplete setup"}
        </strong>
        <small>
          {deviceKind === "android"
            ? "Remove this Android app’s local account, device authorization, pending commands, and cached history."
            : deviceKind === "browser"
              ? "Remove this browser’s local account, device authorization, pending commands, and cached history."
              : "Remove only the unfinished invitation and connection information stored on this device."}
        </small>
      </span>
      <button
        type="button"
        className="forget-button"
        onClick={onRemove}
        disabled={busy}
      >
        {deviceKind
          ? busy
            ? "Signing out…"
            : "Sign out this device"
          : "Discard setup"}
      </button>
    </section>
  );
}

function SettingsGroupHeading({
  eyebrow,
  title,
  detail,
}: {
  eyebrow: string;
  title: string;
  detail: string;
}) {
  return (
    <header className="settings-group-heading">
      <span className="eyebrow">{eyebrow}</span>
      <h3>{title}</h3>
      <p>{detail}</p>
    </header>
  );
}

export function PwaSourceSettings({
  runtime,
  onChange,
}: {
  runtime: MalinkNativeRuntimeInfo | null;
  onChange(): void;
}) {
  const source = runtime?.pwaSource;
  const currentBaseUrl = source?.currentBaseUrl ?? currentDocumentBaseUrl();
  const sourceLabel = source?.source === "official"
    ? "Official"
    : source?.source === "custom"
      ? "Custom"
      : "Current";
  return (
    <section className="pwa-source-settings" aria-live="polite">
      <span className="pwa-source-mark" aria-hidden="true">↗</span>
      <span>
        <span className="pwa-source-title">
          <strong>PWA address</strong>
          <b className={`pwa-source-badge is-${source?.source ?? "current"}`}>
            {sourceLabel}
          </b>
        </span>
        <code title={currentBaseUrl}>{currentBaseUrl}</code>
        <small>
          {source?.source === "custom"
            ? "This interface comes from a custom service. Change it only to an address you trust."
            : "This address provides the Malink interface and its update channel."}
        </small>
      </span>
      <button type="button" onClick={onChange}>Change address</button>
    </section>
  );
}

export function PwaUpdateSettings({
  state,
  onCheck,
}: {
  state: PwaUpdateState;
  onCheck(): void;
}) {
  const checking = state.phase === "checking";
  const busy = checking || state.phase === "updating" || state.phase === "waiting";
  return (
    <section className="pwa-update-settings" aria-live="polite">
      <span>
        <strong>Web interface</strong>
        <small>{updateStatusText(state)} · Build {MALINK_BUILD_VERSION}</small>
      </span>
      <button type="button" onClick={onCheck} disabled={busy}>
        {checking ? "Checking…" : "Check for updates"}
      </button>
    </section>
  );
}

function currentDocumentBaseUrl(): string {
  if (typeof document === "undefined") return "Current Android app address";
  try {
    return new URL(".", document.baseURI).href;
  } catch {
    return document.baseURI;
  }
}

function gatewayLastVerifiedText(
  lastVerifiedAt: number | undefined,
  now: number,
): string | null {
  if (lastVerifiedAt === undefined) return null;
  const elapsed = Math.max(0, now - lastVerifiedAt);
  if (elapsed < 60_000) return "Last verified just now.";
  if (elapsed < 60 * 60_000) {
    const minutes = Math.floor(elapsed / 60_000);
    return `Last verified ${minutes} ${minutes === 1 ? "minute" : "minutes"} ago.`;
  }
  if (elapsed < 24 * 60 * 60_000) {
    const hours = Math.floor(elapsed / (60 * 60_000));
    return `Last verified ${hours} ${hours === 1 ? "hour" : "hours"} ago.`;
  }
  return `Last verified ${new Date(lastVerifiedAt).toLocaleString()}.`;
}

function updateStatusText(state: PwaUpdateState): string {
  switch (state.phase) {
    case "checking":
      return "Checking the deployed version…";
    case "updating":
      return `Updating to ${state.latestVersion}…`;
    case "waiting":
      return `Update ${state.latestVersion} is waiting for the queued command`;
    case "updated":
      return `Updated from ${state.previousVersion}`;
    case "unavailable":
      return "Could not check right now";
    case "current":
      return state.checkedAt ? "Up to date" : "Automatic updates enabled";
  }
}

export function NativeUpdateSettings({
  state,
  busy,
  onRefresh,
  onInstall,
}: {
  state: NativeUpdateStatus | null;
  busy: boolean;
  onRefresh(): void;
  onInstall(): void;
}) {
  const legacyManualCheck =
    state?.detailCode === "manual_check_unavailable";
  const installable =
    state?.phase === "ready" || state?.phase === "permission_required";
  const installing = state?.phase === "installing";
  const operationInProgress = busy || nativeUpdateOperationInProgress(state);
  const downloadProgress = nativeUpdateDownloadProgress(state);
  const label = installing
    ? "Installing APK…"
    : state?.phase === "downloading" || state?.phase === "available"
      ? "Downloading APK…"
    : state?.phase === "checking"
      ? "Checking APK…"
    : busy
      ? installable
        ? "Installing APK…"
        : "Checking APK…"
    : state?.phase === "permission_required"
      ? "Allow and install"
      : state?.phase === "ready"
        ? "Install APK update"
        : state?.phase === "failed"
          ? legacyManualCheck
            ? "Open APK releases"
            : "Retry APK check"
          : state
            ? "Refresh APK status"
            : "Check APK update";
  return (
    <section className="native-update-settings" aria-live="polite">
      <span>
        <strong>Android app</strong>
        <small>{nativeUpdateStatusText(state)}</small>
        {downloadProgress && (
          <progress
            aria-label="APK download progress"
            max={downloadProgress.totalBytes}
            value={downloadProgress.downloadedBytes}
          />
        )}
        <small>
          APK checks use the selected PWA address without Workspace authorization.
          Workspace features still require authorization.
        </small>
        {legacyManualCheck && (
          <small>
            This installed APK predates immediate checks. It will still check on
            its schedule, or you can <a href="https://github.com/Escapingbug/malink/releases">open the official APK releases</a>.
          </small>
        )}
      </span>
      {legacyManualCheck ? (
        <a
          className="native-update-action"
          href={OFFICIAL_ANDROID_RELEASES_URL}
          target="_blank"
          rel="noreferrer"
        >
          {label}
        </a>
      ) : (
        <button
          type="button"
          disabled={operationInProgress}
          aria-busy={operationInProgress}
          onClick={installable ? onInstall : onRefresh}
        >
          {label}
        </button>
      )}
    </section>
  );
}

export function nativeUpdateStatusText(state: NativeUpdateStatus | null): string {
  if (!state) return "APK: check the native update channel from this device";
  if (state.detailCode === "manual_check_unavailable") {
    return "APK: this installed version cannot start an immediate check";
  }
  const latest = state.latestVersionName ?? "the latest APK";
  switch (state.phase) {
    case "checking":
      return "APK: checking the selected static release channel…";
    case "available":
      return `APK: ${latest} is available`;
    case "downloading":
      return nativeUpdateDownloadProgress(state)?.label ?? "APK: downloading…";
    case "ready":
      return `APK: ${latest} is ready to install`;
    case "installing":
      return "APK: handing the verified update to Android…";
    case "permission_required":
      return "APK: Android needs permission to install this update";
    case "failed":
      return `APK: update check failed (${state.detailCode ?? "unknown_error"}); the current app remains unchanged`;
    case "current":
      return "APK: up to date; static releases are checked automatically";
  }
}

function gatewayRestartStateLabel(state: GatewayRestartNodeRuntime["state"]): string {
  switch (state) {
    case "requesting":
      return "Restart requested."
    case "waiting":
      return "Waiting for active work."
    case "restarting":
      return "Gateway is restarting."
    case "ready":
      return "Restart complete."
    case "failed":
      return "Restart did not complete."
    case "idle":
      return "";
  }
}

function gatewayRestartStateDetail(state: GatewayRestartNodeRuntime["state"]): string {
  switch (state) {
    case "requesting":
      return "Sending the signed restart request.";
    case "waiting":
      return "Gateway will restart automatically after active Agent turns finish.";
    case "restarting":
      return "Waiting for a signed reply from the replacement Gateway process.";
    case "ready":
      return "Provider changes are now loaded.";
    case "failed":
      return "Check this computer or export diagnostics, then retry.";
    case "idle":
      return "";
  }
}

function webPushStatusText(state: WebPushNotificationState): string {
  switch (state.status) {
    case "enabled":
      return "System notifications arrive when agent tasks finish in the background.";
    case "blocked":
      return "Notifications are blocked in this browser's site settings.";
    case "unsupported":
      return "This browser does not support Web Push notifications.";
    case "unavailable":
      return "Connect to a compatible Gateway to enable system notifications.";
    case "error":
      return "The notification setting could not be synchronized.";
    case "prompt":
      return "Get a system notification when an agent task completes or fails.";
  }
}
