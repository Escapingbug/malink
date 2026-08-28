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
  type ConnectionRecoveryAction,
  type ConnectionRepairReason,
} from "./connectionPresentation";
import type { WebPushNotificationState } from "./webPushNotifications";
import type {
  GatewayEnrollmentPending,
  SignedWorkspaceGatewayDirectory,
} from "@malink/protocol";
import {
  GatewayEnrollmentPanel,
  type GatewayEnrollmentBusyState,
  type GeneratedGatewayEnrollment,
} from "./GatewayEnrollmentPanel";
import { gatewayProjectOwner } from "./projectCatalog";
import { injectedNativeBridgePort } from "./client/native/NativeRpcBridge";

type Props = {
  open: boolean;
  config: MatrixConnectionConfig;
  status: MatrixConnectionStatus;
  connectionDetail: string | null;
  repairReason: ConnectionRepairReason | null;
  error: string | null;
  pairingPreview: PairingPreview | null;
  trustedGateway: MalinkPublicTrust | null;
  savedGateways: MalinkPublicTrust[];
  gatewayDirectory: SignedWorkspaceGatewayDirectory | null;
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
  gatewayRelease: GatewayReleaseBuild | null;
  gatewayUpdateAvailableCount: number;
  gatewayUpdateNodeCount: number;
  gatewayUpdateDiscoveryError: string | null;
  updateState: PwaUpdateState;
  nativeUpdateState: NativeUpdateStatus | null;
  nativeUpdateBusy: boolean;
  nativeRuntime: MalinkNativeRuntimeInfo | null;
  webPushState: WebPushNotificationState;
  webPushBusy: boolean;
  copyPageLinkBusy: boolean;
  onChange(config: MatrixConnectionConfig): void;
  onPairingLink(link: string): void;
  onClearPairing(): void;
  onConfirmPairing(): void;
  onClose(): void;
  onDisconnect(): void;
  onForget(): void;
  onPasswordLogin(userId: string, password: string): void;
  onCreateInvitation(password?: string): void;
  onClearInvitation(): void;
  onCreateGatewayEnrollment(): void;
  onApproveGatewayEnrollment(enrollmentId: string, approverProjectId?: string): void;
  onClearGatewayEnrollment(): void;
  onRenameGateway(
    gatewayNodeId: string,
    gatewayName: string,
    targetProjectId: string,
  ): Promise<void>;
  onReviewGatewayUpdates(): void;
  onCheckForUpdates(): void;
  onUpdateNativeApp(): void;
  onRestartApp(): void;
  onCopyPageLink(): void;
  onRefreshNativeUpdate(): void;
  onInstallNativeUpdate(): void;
  onExportDiagnostics(): void;
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
  trustedGateway,
  savedGateways,
  gatewayDirectory,
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
  gatewayRelease,
  gatewayUpdateAvailableCount,
  gatewayUpdateNodeCount,
  gatewayUpdateDiscoveryError,
  updateState,
  nativeUpdateState,
  nativeUpdateBusy,
  nativeRuntime,
  webPushState,
  webPushBusy,
  copyPageLinkBusy,
  onChange,
  onPairingLink,
  onClearPairing,
  onConfirmPairing,
  onClose,
  onDisconnect,
  onForget,
  onPasswordLogin,
  onCreateInvitation,
  onClearInvitation,
  onCreateGatewayEnrollment,
  onApproveGatewayEnrollment,
  onClearGatewayEnrollment,
  onRenameGateway,
  onReviewGatewayUpdates,
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
  const effectiveRepairReason = repairReason ?? manualRepairReason;
  const repairRequired = effectiveRepairReason !== null;
  const [loginPassword, setLoginPassword] = useState("");
  const [addingGateway, setAddingGateway] = useState(false);
  const [editingGatewayNodeId, setEditingGatewayNodeId] = useState<string | null>(null);
  const [gatewayNameDraft, setGatewayNameDraft] = useState("");
  const connected =
    status === "connected" ||
    status === "securing" ||
    status === "reconnecting";
  const nativeHostDetected = injectedNativeBridgePort() !== null;
  const actionBusy =
    pairingBusy ||
    invitationBusy ||
    gatewayEnrollmentBusy !== null ||
    gatewayProfileBusy !== null ||
    webPushBusy ||
    nativeUpdateBusy ||
    copyPageLinkBusy;
  const busy =
    status === "connecting" ||
    status === "securing" ||
    actionBusy;
  const needsAccount =
    Boolean(pairingPreview) && (!trustedGateway || repairRequired);
  const hasSavedConnection = Boolean(
    config.homeserver.trim() &&
      config.userId.trim() &&
      config.accessToken.trim() &&
      config.roomId.trim(),
  );
  const directoryGatewayProfiles = (gatewayDirectory?.directory.gateways ?? []).map(
    gateway => ({
      gatewayId: gateway.workspaceId,
      gatewayNodeId: gateway.gatewayNodeId,
      gatewayName: gateway.gatewayName,
      computerName: gateway.computerName,
      buildId: gateway.buildId,
      targetProjectId: gateway.projects?.[0]?.projectId,
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
        targetProjectId: undefined as string | undefined,
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
    ? "Loading the current Gateway authorization…"
    : pairingPreview
      ? "Finish the current connection setup before adding another Gateway"
      : repairRequired
        ? "Repair the current connection before adding another Gateway"
        : status !== "connected"
          ? "Reconnect the current Gateway before adding another Gateway"
          : `${gatewayProfiles.length} available to every authorized client`;
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
    setLoginPassword("");
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
        onExportDiagnostics();
    }
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
            <span className="eyebrow">Devices</span>
            <h2 id="matrix-settings-title">
              {repairRequired
                ? "Repair connection"
                : trustedGateway
                  ? "Connection"
                  : "Connect a computer"}
            </h2>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            onClick={requestClose}
            aria-label="Close connection settings"
            disabled={actionBusy}
          >
            ×
          </button>
        </header>

        <div className="settings-security-note">
          <span>✓</span>
          <p>
            {addingGateway
              ? "The setup link only tells the new Gateway where to request access. It joins only after you approve the matching code."
              : "Scan a one-time code from Malink on your computer. Only devices you approve can see or send messages."}
          </p>
        </div>

        {nativeHostDetected && (
          <NativeUpdateSettings
            state={nativeUpdateState}
            busy={nativeUpdateBusy}
            onRefresh={onRefreshNativeUpdate}
            onInstall={onInstallNativeUpdate}
          />
        )}

        {showGatewayManagement && (
          <section className="gateway-profile-list" aria-label="Workspace Gateways">
            <header>
              <span>
                <strong>Workspace Gateways</strong>
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
                    ? `Review request (${pendingGatewayEnrollments.length})`
                    : "Add Gateway"}
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
                return (
                  <div
                    key={gatewayProfileId}
                    className="active"
                  >
                    <span className="gateway-device-mark" aria-hidden="true">G</span>
                    <span>
                      <strong>
                        {gatewayIdentity.label}
                      </strong>
                      <small title={gatewayProfileId}>
                        Computer: {gatewayIdentity.computerName}
                      </small>
                      <small title={gateway.buildId ?? "This Gateway did not report a build ID"}>
                        Build: {gateway.buildId ?? "Not reported"} · Node {gatewayIdentity.shortId}
                      </small>
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
                    </span>
                    {editing ? (
                      <b aria-hidden="true">✓</b>
                    ) : (
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
                    )}
                  </div>
                );
              })}
              {gatewayProfiles.length === 0 && (
                <div className="active" aria-live="polite">
                  <span className="gateway-device-mark" aria-hidden="true">G</span>
                  <span>
                    <strong>Current Gateway</strong>
                    <small>Loading its saved profile…</small>
                  </span>
                  <b>…</b>
                </div>
              )}
            </div>
          </section>
        )}

        {recoveryPlan && !repairRequired && (
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
                disabled={
                  busy ||
                  (recoveryPlan.primary.action === "copy-page-link" &&
                    copyPageLinkBusy) ||
                  (recoveryPlan.primary.action === "update-native-app" &&
                    nativeUpdateBusy)
                }
                onClick={() => runRecoveryAction(recoveryPlan.primary.action)}
              >
                {recoveryPlan.primary.action === "update-native-app" &&
                nativeUpdateBusy
                  ? "Checking APK…"
                  : recoveryPlan.primary.action === "copy-page-link" &&
                      copyPageLinkBusy
                    ? "Copying link…"
                  : recoveryPlan.primary.label}
              </button>
              {recoveryPlan.secondary && (
                <button
                  type="button"
                  disabled={
                    busy ||
                    (recoveryPlan.secondary.action === "copy-page-link" &&
                      copyPageLinkBusy) ||
                    (recoveryPlan.secondary.action === "update-native-app" &&
                      nativeUpdateBusy)
                  }
                  onClick={() => runRecoveryAction(recoveryPlan.secondary!.action)}
                >
                  {recoveryPlan.secondary.action === "copy-page-link" &&
                  copyPageLinkBusy
                    ? "Copying link…"
                    : recoveryPlan.secondary.label}
                </button>
              )}
            </div>
            {recoveryPlan.primary.action === "update-native-app" &&
              nativeUpdateState && (
                <small>{nativeUpdateStatusText(nativeUpdateState)}</small>
              )}
          </section>
        )}

        {addingGateway && (
          <GatewayEnrollmentPanel
            invitation={gatewayEnrollmentInvitation}
            pending={pendingGatewayEnrollments}
            approvedEnrollmentIds={approvedGatewayEnrollmentIds}
            busy={gatewayEnrollmentBusy}
            error={gatewayEnrollmentError}
            onCreate={onCreateGatewayEnrollment}
            onApprove={onApproveGatewayEnrollment}
            onClear={() => {
              setAddingGateway(false);
              onClearGatewayEnrollment();
            }}
          />
        )}

        {!addingGateway && <PairingWizard
          preview={pairingPreview}
          trustedGateway={trustedGateway}
          repairReason={effectiveRepairReason}
          busy={pairingBusy}
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
          onCreateInvitation={onCreateInvitation}
          onClearInvitation={onClearInvitation}
        />}

        {(needsAccount || trustedGateway) && (
          <details className="connection-details" open={needsAccount}>
            <summary>
              <span>
                <strong>Connection details</strong>
                <small>
                  {needsAccount
                    ? "Sign in once to finish adding this device"
                    : status === "securing"
                      ? "Checking your approved computer"
                    : connected
                      ? "Protected and up to date"
                      : "Saved on this device"}
                </small>
              </span>
              <b>
                {status === "securing"
                  ? "Checking"
                  : connected
                    ? "Online"
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
                <>
                  <label className="wide-field">
                    <span>Account ID</span>
                    <input
                      value={config.userId}
                      placeholder="@you:example.org"
                      autoComplete="username"
                      spellCheck={false}
                      onChange={(event) =>
                        onChange({ ...config, userId: event.target.value })
                      }
                    />
                  </label>
                  <label className="wide-field">
                    <span>Account password</span>
                    <input
                      type="password"
                      value={loginPassword}
                      placeholder="Your account password"
                      autoComplete="current-password"
                      onChange={(event) => setLoginPassword(event.target.value)}
                    />
                  </label>
                  <button
                    type="button"
                    className="matrix-password-login-button wide-field"
                    disabled={
                      busy || !config.userId.trim() || !loginPassword
                    }
                    onClick={() => {
                      onPasswordLogin(config.userId, loginPassword);
                      setLoginPassword("");
                    }}
                  >
                    {pairingBusy ? "Signing in…" : "Sign in"}
                  </button>
                  <p className="matrix-session-hint wide-field">
                    This signs in only this Malink device. You will never be
                    asked to copy a private access token.
                  </p>
                </>
              )}
              {config.accessToken && (
                <p className="matrix-session-hint wide-field">
                  Signed in as {config.userId || "your account"} on this device.
                </p>
              )}
              <details className="advanced-token-field wide-field">
                <summary>Advanced: use an access token</summary>
                <label>
                  <span>Access token</span>
                  <input
                    type="password"
                    value={config.accessToken}
                    placeholder="syt_••••••••••••"
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(event) =>
                      onChange({
                        ...config,
                        accessToken: event.target.value,
                      })
                    }
                  />
                </label>
              </details>
              <label>
                <span>Conversation channel</span>
                <input value={config.roomId} readOnly placeholder="From QR code" />
              </label>
            </div>
          </details>
        )}

        {!nativeRuntime && trustedGateway && (
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
        )}

        {trustedGateway && gatewayRelease && gatewayUpdateNodeCount > 0 && (
          <section className="gateway-update-settings" aria-live="polite">
            <span>
              <strong>Gateway software</strong>
              <small>
                {gatewayUpdateAvailableCount > 0
                  ? `${gatewayUpdateAvailableCount} ${gatewayUpdateAvailableCount === 1 ? "Gateway needs" : "Gateways need"} release ${gatewayRelease.releaseId}.`
                  : `Review ${gatewayUpdateNodeCount} ${gatewayUpdateNodeCount === 1 ? "Gateway" : "Gateways"} and their live status.`}
              </small>
              {gatewayUpdateDiscoveryError && (
                <em role="alert">Update discovery: {gatewayUpdateDiscoveryError}</em>
              )}
            </span>
            <button type="button" onClick={onReviewGatewayUpdates}>
              {gatewayUpdateAvailableCount > 0 ? "Review update" : "View versions"}
            </button>
          </section>
        )}

        {error && (
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

        <div className="settings-build-version">
          <details className="settings-build-details">
            <summary>Advanced diagnostics</summary>
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
                <small>{updateStatusText(updateState)}</small>
                {nativeHostDetected && (
                  <small>{nativeUpdateStatusText(nativeUpdateState)}</small>
                )}
                {gatewayRelease && (
                  <small>
                    Published Gateway update <code>{gatewayRelease.releaseId}</code>
                  </small>
                )}
              </span>
              <div className="settings-build-actions">
                <button type="button" onClick={onExportDiagnostics}>
                  Export diagnostics
                </button>
                {nativeHostDetected && (
                  <button
                    type="button"
                    onClick={() => {
                      window.location.href = "malink://static-service-settings";
                    }}
                  >
                    Change static service
                  </button>
                )}
                <button
                  type="button"
                  onClick={onCheckForUpdates}
                  disabled={
                    updateState.phase === "checking" ||
                    updateState.phase === "updating" ||
                    updateState.phase === "waiting"
                  }
                >
                  {updateState.phase === "checking" ? "Checking…" : "Check for updates"}
                </button>
              </div>
            </div>
          </details>
        </div>

        <footer>
          <button
            type="button"
            className="forget-button"
            onClick={onForget}
            disabled={busy}
          >
            {trustedGateway ? "Remove computer" : "Clear local setup"}
          </button>
          <span className="settings-spacer" />
          {connected ? (
            <button
              className="disconnect-button"
              onClick={onDisconnect}
              disabled={pairingBusy || invitationBusy}
            >
              Disconnect
            </button>
          ) : null}
        </footer>
      </section>
    </div>
  );
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
  const installable =
    state?.phase === "ready" || state?.phase === "permission_required";
  const installing = state?.phase === "installing";
  const label = installing
    ? "Installing APK…"
    : busy
      ? installable
        ? "Installing APK…"
        : "Checking APK…"
    : state?.phase === "permission_required"
      ? "Allow and install"
      : state?.phase === "ready"
        ? "Install APK update"
        : state?.phase === "failed"
          ? "Retry APK check"
          : state
            ? "Refresh APK status"
            : "Check APK update";
  return (
    <section className="native-update-settings" aria-live="polite">
      <span>
        <strong>Android app</strong>
        <small>{nativeUpdateStatusText(state)}</small>
        <small>Uses the selected static service; Workspace authorization is not required.</small>
      </span>
      <button
        type="button"
        disabled={busy || installing}
        onClick={installable ? onInstall : onRefresh}
      >
        {label}
      </button>
    </section>
  );
}

export function nativeUpdateStatusText(state: NativeUpdateStatus | null): string {
  if (!state) return "APK: check the native update channel from this device";
  const latest = state.latestVersionName ?? "the latest APK";
  switch (state.phase) {
    case "checking":
      return "APK: receiving the latest release from your Gateway…";
    case "available":
      return `APK: ${latest} is available`;
    case "downloading":
      return state.totalBytes
        ? `APK: downloading ${Math.floor(((state.downloadedBytes ?? 0) / state.totalBytes) * 100)}%`
        : "APK: downloading…";
    case "ready":
      return `APK: ${latest} is ready to install`;
    case "installing":
      return "APK: handing the verified update to Android…";
    case "permission_required":
      return "APK: Android needs permission to install this update";
    case "failed":
      return "APK: the last update attempt failed; the current app remains unchanged";
    case "current":
      return "APK: up to date; static releases are checked automatically";
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
