"use client";

import React, { useEffect, useRef, useState } from "react";
import type { GatewayDeploymentStatus, GatewayUpdateStatus } from "@malink/protocol";
import type { GatewayReleaseBuild } from "./buildInfo";
import { useDialogFocus } from "./dialogFocus";
import {
  gatewayUpdateCanContinuePublishedRelease,
  gatewayUpdateRequiresForwardOnlyConfirmation,
  gatewayUpdateStatusSupersededByDirectory,
  type GatewayUpdatePlanNode,
} from "./gatewayUpdateTrigger";
import {
  GatewayUpdateFailureHelp,
  GatewayUpdateRequestFailureHelp,
} from "./GatewayNoReplyHelp";
import type { GatewayNodeLiveness } from "./gatewayNodeLiveness";
import { gatewayProjectOwner } from "./projectCatalog";
import { gatewayUpdateRecoveryAction } from "./gatewayUpdateRecovery";
import { computerUserState } from "./computerUserState";
import { gatewayVersionChoices } from "./gatewayVersionChoices";
import { GatewayManagement } from "./GatewayManagement";
import { ComputerActionDialog, ComputerActionPanel } from "./ComputerActionPanel";

export type GatewayUpdateNodeRuntime = {
  state: "unchecked" | "checking" | "unreachable" | "online" | "starting" | "error";
  releaseKey?: string;
  checkedAt?: number;
  versionCheckedAt?: number;
  versionCheckError?: string;
  versionSwitchError?: string;
  lastVerifiedAt?: number;
  consecutiveNoReplies?: number;
  startedAt?: number;
  detail?: string;
  status?: GatewayUpdateStatus;
  maintenanceSessionId?: string;
  maintenanceSessionAmbiguous?: boolean;
  maintenanceSessionArchiveAvailable?: boolean;
  maintenanceSessionArchiveBusy?: boolean;
  maintenanceSessionArchiveChecking?: boolean;
  maintenanceSessionArchived?: boolean;
  legacyMaintenanceSessionId?: string;
  legacyMaintenanceSessionArchiveAvailable?: boolean;
  legacyMaintenanceSessionArchiveBusy?: boolean;
  legacyMaintenanceSessionArchiveChecking?: boolean;
  legacyMaintenanceSessionArchived?: boolean;
  commandFailureCode?: string;
  commandFailureRetryable?: boolean;
};

export type GatewayUpdateActiveAction = "when_idle" | "force" | "discard" | "check_versions" | "select_version";

type Props = {
  open: boolean;
  connected: boolean;
  release: GatewayReleaseBuild | null;
  embedded?: boolean;
  managementOnly?: boolean;
  nodes: GatewayUpdatePlanNode[];
  runtimeByNode: Readonly<Record<string, GatewayUpdateNodeRuntime>>;
  livenessByNode?: Readonly<Record<string, GatewayNodeLiveness>>;
  activeGatewayNodeIds: ReadonlySet<string>;
  activeGatewayModesByNode?: Readonly<Record<string, GatewayUpdateActiveAction>>;
  deploymentsByComputer?: Readonly<Record<string, GatewayDeploymentStatus>>;
  onClose(): void;
  onStart(node: GatewayUpdatePlanNode, mode: "when_idle" | "force"): void;
  onPromote(node: GatewayUpdatePlanNode, mode: "when_idle" | "force"): void;
  onDiscard(node: GatewayUpdatePlanNode): void;
  onSelectVersion?(node: GatewayUpdatePlanNode, releaseId: string, generation: number): void;
  onCheckVersions?(node: GatewayUpdatePlanNode): void;
  onRecover?(node: GatewayUpdatePlanNode): void;
  recoveryBusy?: boolean;
  onOpenProject(projectId: string): void;
  onOpenSession(projectId: string, sessionId: string): void;
  onArchiveSession(node: GatewayUpdatePlanNode, sessionId: string): void;
  onExportDiagnostics(): void;
  diagnosticExportBusy?: boolean;
};

export function GatewayUpdateDialog(props: Props) {
  if (!props.open) return null;
  return <GatewayUpdateDialogContent {...props} />;
}

function GatewayUpdateDialogContent({
  open,
  connected,
  release: publishedRelease,
  embedded = false,
  managementOnly = false,
  nodes,
  runtimeByNode,
  livenessByNode = {},
  activeGatewayNodeIds,
  activeGatewayModesByNode = {},
  deploymentsByComputer = {},
  onClose,
  onStart,
  onPromote,
  onDiscard,
  onSelectVersion,
  onCheckVersions,
  onRecover,
  recoveryBusy = false,
  onOpenProject,
  onOpenSession,
  onArchiveSession,
  onExportDiagnostics,
  diagnosticExportBusy = false,
}: Props) {
  const release = publishedRelease ?? { releaseId: "", buildId: "" };
  const [versionSelection, setVersionSelection] = useState<{ nodeId: string; releaseId: string; generation: number } | null>(null);
  const refreshRef = useRef({ nodes, runtimeByNode, activeGatewayNodeIds, onCheckVersions });
  refreshRef.current = { nodes, runtimeByNode, activeGatewayNodeIds, onCheckVersions };
  useEffect(() => {
    if (!embedded || !connected || managementOnly) return;
    const tick = () => {
      if (document.visibilityState !== "visible" || !navigator.onLine) return;
      const current = refreshRef.current;
      for (const node of current.nodes) {
        const runtime = current.runtimeByNode[node.gatewayNodeId];
        if (!node.onlineUpdate || current.activeGatewayNodeIds.has(node.gatewayNodeId)) continue;
        // Refresh on entry only when stale; retained data remains visible during the read.
        if (runtime?.versionCheckedAt && Date.now() - runtime.versionCheckedAt < 300_000) continue;
        current.onCheckVersions?.(node);
      }
    };
    tick();
    const timer = window.setInterval(tick, 30_000);
    document.addEventListener("visibilitychange", tick);
    window.addEventListener("online", tick);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
      window.removeEventListener("online", tick);
    };
  }, [embedded, connected, managementOnly]);
  const [forceConfirmationNodeId, setForceConfirmationNodeId] = useState<string | null>(null);
  const [completionConfirmationNodeId, setCompletionConfirmationNodeId] = useState<string | null>(null);
  const [advancedNodes, setAdvancedNodes] = useState<ReadonlySet<string>>(new Set());
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const forceConfirmationRef = useRef<HTMLDivElement>(null);
  useDialogFocus({
    open: open && !embedded,
    containerRef: dialogRef,
    initialFocusRef: closeRef,
    onEscape: onClose,
  });
  useEffect(() => {
    if (!forceConfirmationNodeId) return;
    const frame = window.requestAnimationFrame(() => {
      forceConfirmationRef.current?.scrollIntoView({ block: "nearest" });
      forceConfirmationRef.current?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [forceConfirmationNodeId]);
  const availableCount = nodes.filter(node => node.state === "available").length;
  const ordered = [...nodes].sort((left, right) =>
    updateStateOrder(left.state) - updateStateOrder(right.state)
      || left.gatewayName.localeCompare(right.gatewayName),
  );

  return (
    <div
      className={embedded ? "computer-update-content" : "gateway-update-backdrop"}
      role="presentation"
      onMouseDown={embedded ? undefined : onClose}
    >
      <section
        ref={dialogRef}
        className={embedded ? "gateway-update-dialog is-embedded" : "gateway-update-dialog"}
        role={embedded ? "region" : "dialog"}
        aria-modal={embedded ? undefined : true}
        aria-label={embedded ? "Computer versions and update" : "Install Gateway updates"}
        tabIndex={-1}
        onMouseDown={event => event.stopPropagation()}
      >
        {!embedded && <header>
          <div>
            <span className="eyebrow">Workspace computers</span>
            <h2 id="gateway-update-title">Install Gateway updates</h2>
            <p>
              {availableCount === 0
                ? "Every reachable computer is current or shows the action it needs."
                : `${availableCount} ${availableCount === 1 ? "computer has" : "computers have"} an update available.`}
            </p>
          </div>
          <button
            ref={closeRef}
            type="button"
            aria-label="Close Gateway update"
            onClick={onClose}
          >
            ×
          </button>
        </header>}

        {!embedded && publishedRelease && <div className="gateway-update-release">
          <span aria-hidden="true">↻</span>
          <span>
            <small>Available release</small>
            <strong>{release.releaseId}</strong>
            <code>{release.buildId}</code>
          </span>
        </div>}

        {!embedded && <p className="gateway-update-explanation">
          Start an update session to prepare the new version. Review its result, then explicitly switch when ready.
          You can leave settings while it works.
        </p>}

        <div className="gateway-update-node-list">
          {ordered.map(node => {
            const owner = gatewayProjectOwner(
              node.gatewayNodeId,
              node.gatewayName,
              node.computerName,
            );
            const runtime = runtimeByNode[node.gatewayNodeId] ?? { state: "unchecked" };
            const deployment = node.computerId
              ? deploymentsByComputer[node.computerId]
              : undefined;
            const deploymentOwner = deployment?.active.gatewayNodeId === node.gatewayNodeId;
            const deploymentInProgress = deploymentOwner && deployment.phase !== "steady";
            const updateCompleted = runtime.status?.executionTracks
              ? runtime.status.executionTracks.phase === "steady" && runtime.status.currentBuildId === release.buildId
              : deploymentOwner && deployment.phase === "steady" &&
              deployment.active.buildId === release.buildId &&
              (Boolean(deployment.recovery) || deployment.detail === "All projects and sessions now use the promoted Gateway");
            const maintenanceCleanupAllowed = !deploymentInProgress &&
              (!node.blueGreenUpdate || deployment?.phase === "steady");
            const signedUpdateStatus = gatewayUpdateStatusForPresentation(
              runtime.status,
              release,
              node,
            );
            const knownUpdateFailure = signedUpdateStatus?.phase === "failed" ||
              signedUpdateStatus?.phase === "repair_required" ||
              signedUpdateStatus?.phase === "rolled_back";
            const recovery = gatewayUpdateRecoveryAction({
              status: signedUpdateStatus,
              release,
              commandFailure: {
                code: runtime.commandFailureCode,
                retryable: runtime.commandFailureRetryable,
              },
            });
            const stagedPublishedRelease = gatewayUpdateCanContinuePublishedRelease({
              status: signedUpdateStatus,
              release,
            });
            const forwardOnlyConfirmation = stagedPublishedRelease &&
              gatewayUpdateRequiresForwardOnlyConfirmation(signedUpdateStatus);
            const updateActionAvailable = recovery.kind === "start" ||
              recovery.kind === "continue" || recovery.kind === "retry";
            const statusWasSuperseded =
              gatewayUpdateStatusSupersededByDirectory(node, runtime.status);
            const targetInstalled =
              (signedUpdateStatus?.currentBuildId === release.buildId ||
                (statusWasSuperseded && node.currentBuildId === release.buildId)) &&
              !knownUpdateFailure;
            const showUpdateProgress = Boolean(
              !node.blueGreenUpdate &&
              !deploymentInProgress &&
              signedUpdateStatus &&
              signedUpdateStatus.phase !== "idle" &&
              signedUpdateStatus.phase !== "committed" &&
              (signedUpdateStatus.phase !== "staged" || stagedPublishedRelease) &&
              !targetInstalled,
            );
            const runtimeNeedsAttention = knownUpdateFailure ||
              (runtime.state === "error" && !signedUpdateStatus);
            const canRequestUpdate =
              connected &&
              node.state === "available" &&
              updateActionAvailable &&
              !activeGatewayNodeIds.has(node.gatewayNodeId);
            const active = activeGatewayNodeIds.has(node.gatewayNodeId);
            const activeMode = activeGatewayModesByNode[node.gatewayNodeId];
            const forceConfirming = forceConfirmationNodeId === node.gatewayNodeId;
            const candidateTrial = deploymentOwner && deployment.phase === "trial";
            const candidateNode = candidateTrial
              ? nodes.find(candidate =>
                  candidate.gatewayNodeId === deployment.candidate?.gatewayNodeId)
              : undefined;
            const userState = computerUserState({ connected, now: Date.now(), runtime,
              liveness: livenessByNode[node.gatewayNodeId], action: activeMode,
              currentBuild: node.currentBuildId, targetBuild: publishedRelease?.buildId,
              deployment: deploymentOwner ? deployment : undefined });
            return (
              <article
                key={node.gatewayNodeId}
                className={`gateway-update-node gateway-update-node-${node.state}`}
              >
                {embedded && !managementOnly && <GatewayManagement node={node} runtime={runtime}
                  latestBuild={publishedRelease?.buildId} connected={connected} busy={active}
                  refreshing={activeMode === "check_versions"}
                  lastVerifiedAt={livenessByNode[node.gatewayNodeId]?.lastVerifiedAt}
                  preparing={userState.preparing} ready={Boolean(stagedPublishedRelease || candidateTrial)}
                  switching={userState.switching || userState.waiting} complete={userState.complete}
                  failed={userState.failed} canUpdate={Boolean(publishedRelease && node.onlineUpdate && node.targetProjectId && (updateActionAvailable || runtime.status?.phase === "committed" && runtime.status.currentBuildId !== publishedRelease.buildId))}
                  onUpdate={() => onStart(node, "when_idle")}
                  onInstall={() => candidateTrial ? onPromote(node, "when_idle") : onStart(node, "when_idle")}
                  onRefresh={onCheckVersions ? () => onCheckVersions(node) : undefined}
                  onOpen={id => onOpenSession(node.targetProjectId!, id)} onDelete={id => onArchiveSession(node, id)}
                  onSelect={onSelectVersion ? (id, generation) => onSelectVersion(node, id, generation) : undefined}
                  onExport={onExportDiagnostics} />}
                {!embedded && <details className="computer-update-advanced" open
                  onToggle={event => { const open = event.currentTarget.open; setAdvancedNodes(current => {
                    if (current.has(node.gatewayNodeId) === open) return current;
                    const next = new Set(current); if (open) next.add(node.gatewayNodeId); else next.delete(node.gatewayNodeId); return next;
                  }); }}>
                <summary>{runtimeNeedsAttention ? "Recovery options & details" : "Versions & advanced options"}</summary>
                <div className="gateway-update-node-heading">
                  <span className="gateway-update-node-icon" aria-hidden="true">G</span>
                  <span>
                    <strong>{owner.label}</strong>
                    <small>Node {owner.shortId}</small>
                  </span>
                  <b>{publishedRelease ? planStateLabel(node.state) : "Latest version not confirmed"}</b>
                </div>

                {runtime.status?.executionTracks && (
                  <section className="computer-execution-tracks" aria-label="Gateway versions">
                    <h3>Execution tracks</h3>
                    <p>Currently selected · {runtime.status.executionTracks.activeRelease}</p>
                    {runtime.status.executionTracks.standbyRelease && <p>Retained version · {runtime.status.executionTracks.standbyRelease}</p>}
                    <p>Switch back for normal work or to repair a faulty version. Compatibility is checked before switching.</p>
                    {!runtime.status.executionTracks.standbyRelease && <p>No retained version is reported. Dual-track protection is not confirmed.</p>}
                    {runtime.status.executionTracks.phase === "steady" && runtime.status.executionTracks.error &&
                      <p role="status">{runtime.status.executionTracks.error}</p>}
                    {runtime.status.executionTracks.phase !== "steady" && <p role="status">
                      {runtime.status.executionTracks.phase === "attention"
                        ? runtime.status.executionTracks.error ?? "Version selection needs attention."
                        : `Transferring execution to ${runtime.status.executionTracks.targetRelease}. Conversations remain in the same Workspace.`}
                    </p>}
                    {onSelectVersion && gatewayVersionChoices(runtime.status.executionTracks, runtime.status.activationMode).map(({ id, label }) => (
                          <button key={id} type="button" className="secondary-button gateway-version-button" disabled={!connected || activeGatewayNodeIds.has(node.gatewayNodeId)}
                            onClick={() => setVersionSelection({ nodeId: node.gatewayNodeId, releaseId: id, generation: runtime.status!.executionTracks!.generation })}>
                            {label} · {id}
                          </button>
                        ))}
                  </section>
                )}
                {runtime.versionSwitchError && <p role="alert">Version switch could not be confirmed: {runtime.versionSwitchError}. Refresh status before trying again.</p>}
                {versionSelection?.nodeId === node.gatewayNodeId && <div className="gateway-update-force-confirmation" role="group" aria-label="Confirm version switch">
                  {runtime.status?.activationMode === "forward-only" && <p role="alert">This update changes stored data and cannot switch back to an older version. Continue only if you can access this computer for recovery.</p>}
                  <strong>Switch {owner.label} to {versionSelection.releaseId}?</strong>
                  <p>Running tasks will drain before the selected version takes over. Conversations and current data stay on this computer. You can select the other retained version again after repair, subject to compatibility checks.</p>
                  <button type="button" className="secondary-button" onClick={() => setVersionSelection(null)}>Cancel</button>
                  <button type="button" className="primary-button"
                    disabled={!connected || active || runtime.status?.executionTracks?.generation !== versionSelection.generation}
                    onClick={() => {
                      onSelectVersion?.(node, versionSelection.releaseId, versionSelection.generation);
                      setVersionSelection(null);
                    }}>Confirm switch</button>
                  {runtime.status?.executionTracks?.generation !== versionSelection.generation && <p role="status">The version state changed. Cancel and select a version again.</p>}
                </div>}

                {!runtime.status?.executionTracks && runtime.versionCheckedAt && !runtime.versionCheckError && <p role="status">This computer has not reported dual-track protection. Its existing update controls remain available.</p>}
                <h3 className="computer-update-heading">Update session & progress</h3>
                {showUpdateProgress && signedUpdateStatus && (
                  <GatewayUpdateProgress status={updateCompleted
                    ? { ...signedUpdateStatus, phase: "committed" }
                    : signedUpdateStatus} />
                )}

                <div className="gateway-update-builds">
                  <span>
                    <small>Current build</small>
                    <code>{runtime.status?.currentBuildId ?? node.currentBuildId ?? "unknown"}</code>
                  </span>
                  <span aria-hidden="true">→</span>
                  <span>
                    <small>Target build</small>
                    <code>{publishedRelease ? release.buildId : "Release channel not available"}</code>
                  </span>
                </div>

                <div
                  className={
                    `gateway-update-live gateway-update-live-${runtime.state}` +
                    (runtimeNeedsAttention
                      ? " gateway-update-live-attention"
                      : "")
                  }
                  role={runtimeNeedsAttention ? "alert" : "status"}
                >
                  <span aria-hidden="true" />
                  <span>
                    <strong>{updateCompleted ? "Update complete · Latest version installed" : deploymentInProgress && activeMode !== "discard"
                      ? deployment.phase === "trial" ? "New version ready · Recovery available"
                        : deployment.phase === "preparing" ? "Preparing the new version"
                        : "Completing update"
                      : gatewayUpdateRuntimeStateTitle(runtime, node, release, activeMode)}</strong>
                    <small>{updateCompleted && runtime.status?.executionTracks
                      ? `Current version confirmed. ${runtime.status.executionTracks.standbyRelease ? "The retained version remains available for normal work and repair." : "No retained version is reported."}`
                      : updateCompleted && deployment
                      ? `Completed ${new Date(deployment.updatedAt).toLocaleString()}. ${deployment.recovery ? "The previous version remains available for repair." : "All conversations use this version; the previous version's recovery window is closed."}`
                      : deploymentInProgress && activeMode !== "discard"
                      ? deployment.detail ?? "The signed deployment state controls this computer's candidate and switch actions."
                      : gatewayUpdateRuntimeStateDetail(
                      runtime,
                      node,
                      release,
                      connected,
                      activeMode,
                    )}</small>
                  </span>
                </div>

                <div className="computer-status-refresh">
                  <small role="status">{activeMode === "check_versions" ? "Refreshing computer status…"
                    : runtime.versionCheckError ? `Status refresh failed: ${runtime.versionCheckError}`
                    : runtime.versionCheckedAt ? `Computer status checked ${new Date(runtime.versionCheckedAt).toLocaleString()}`
                    : "Computer status has not been confirmed yet."}</small>
                  {onCheckVersions && <details>
                    <summary>{runtime.versionCheckError ? "Retry status refresh" : "Status options"}</summary>
                    <button type="button" className="secondary-button gateway-version-button"
                      disabled={!connected || active} aria-busy={activeMode === "check_versions"}
                      onClick={() => onCheckVersions(node)}>
                      {activeMode === "check_versions" ? "Refreshing…" : "Refresh computer status"}
                    </button>
                  </details>}
                </div>
                {deploymentOwner && deployment.recovery && !runtime.status?.executionTracks && (
                  <p className="gateway-update-action-status">
                    Recovery version · {deployment.recovery.releaseId ?? deployment.recovery.buildId}
                    <br />Kept for repair until the next update. Normal conversations use the current version.
                  </p>
                )}

                {signedUpdateStatus && knownUpdateFailure && (
                  <GatewayUpdateFailureHelp
                    gatewayLabel={owner.label}
                    status={signedUpdateStatus}
                    recovery={recovery}
                    onExportDiagnostics={onExportDiagnostics}
                    diagnosticExportBusy={diagnosticExportBusy}
                  />
                )}
                {runtime.state === "error" && !signedUpdateStatus &&
                  runtime.commandFailureCode && (
                  <GatewayUpdateRequestFailureHelp
                    recovery={recovery}
                    onExportDiagnostics={onExportDiagnostics}
                    diagnosticExportBusy={diagnosticExportBusy}
                  />
                )}
                {forwardOnlyConfirmation && (
                  <div className="gateway-no-reply-help gateway-update-failure-help" role="alert">
                    <strong>Extra confirmation required</strong>
                    <p>
                      This update changes protected local data and cannot automatically
                      return to the previous Gateway version.
                    </p>
                    <p>
                      Continue only when you can access this computer directly if recovery is needed.
                    </p>
                  </div>
                )}

                <div className="gateway-update-node-actions">
                  {deploymentOwner && !runtime.status?.executionTracks && (deployment.phase !== "steady" || deployment.recovery) && onRecover && (
                    <button type="button" className="secondary-button"
                      disabled={!connected || recoveryBusy}
                      aria-busy={recoveryBusy}
                      onClick={() => onRecover(node)}>
                      {recoveryBusy ? "Opening repair session…" : "Repair using previous Gateway"}
                    </button>
                  )}
                  {deploymentOwner && deployment.phase !== "steady" && (
                    <p className="gateway-update-action-status" role="status">
                      {deployment.phase === "trial"
                        ? `New Gateway ${deployment.candidate?.buildId ?? "unknown"} is ready for new work. The previous Gateway is available for repair. Compatible releases retain its dedicated repair conversation after completion, until the next update.`
                        : deployment.detail ?? `Gateway deployment is ${deployment.phase}.`}
                    </p>
                  )}
                  {candidateTrial && (
                    <>
                      {candidateNode?.targetProjectId ? (
                        <button
                          type="button"
                          className="secondary-button"
                          disabled={!connected}
                          onClick={() => onOpenProject(candidateNode.targetProjectId!)}
                        >
                          Open new Gateway
                        </button>
                      ) : (
                        <p className="gateway-update-action-status" role="status">
                          The new Gateway project is still synchronizing to this device.
                        </p>
                      )}
                      <button
                        type="button"
                        className="primary-button"
                        disabled={!connected || active}
                        aria-busy={active && activeMode === "when_idle"}
                        onClick={() => setCompletionConfirmationNodeId(node.gatewayNodeId)}
                      >
                        {active && activeMode === "when_idle"
                          ? "Waiting for running conversations to finish…"
                          : "Complete update"}
                      </button>
                      {completionConfirmationNodeId === node.gatewayNodeId && (
                        <div className="gateway-update-force-confirmation">
                          <strong>Complete the update?</strong>
                          <p>Normal work will move to the new Gateway when idle. A compatible previous version keeps its dedicated repair conversation until the next update replaces it.</p>
                          <button type="button" className="secondary-button" disabled={active}
                            onClick={() => setCompletionConfirmationNodeId(null)}>Not now</button>
                          <button type="button" className="primary-button" disabled={!connected || active}
                            onClick={() => { setCompletionConfirmationNodeId(null); onPromote(node, "when_idle"); }}>
                            Confirm completion
                          </button>
                        </div>
                      )}
                      <button
                        type="button"
                        className="secondary-button"
                        disabled={!connected || active}
                        aria-busy={active && activeMode === "force" ? true : undefined}
                        onClick={() => setForceConfirmationNodeId(node.gatewayNodeId)}
                      >
                        {active && activeMode === "force"
                          ? "Switching all work now…"
                          : "Switch all work now…"}
                      </button>
                      <button
                        type="button"
                        className="secondary-button"
                        disabled={!connected || active}
                        aria-busy={active && activeMode === "discard" ? true : undefined}
                        onClick={() => onDiscard(node)}
                      >
                        {active && activeMode === "discard"
                          ? "Discarding candidate…"
                          : "Discard candidate"}
                      </button>
                    </>
                  )}
                  {!statusWasSuperseded && runtime.maintenanceSessionId &&
                    node.targetProjectId && (
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={() => onOpenSession(
                        node.targetProjectId!,
                        runtime.maintenanceSessionId!,
                      )}
                    >
                      {runtime.status?.executionTracks?.phase === "steady" && runtime.status.currentBuildId !== release.buildId
                        && ["committed", "failed", "repair_required"].includes(runtime.status.phase)
                        ? "Open update session to repair" : "View update session"}
                    </button>
                  )}
                  {!targetInstalled && !statusWasSuperseded && runtime.maintenanceSessionId &&
                    !runtime.maintenanceSessionAmbiguous &&
                    maintenanceCleanupAllowed && runtime.maintenanceSessionArchiveAvailable && (
                    <button
                      type="button"
                      className="secondary-button"
                      disabled={
                        !connected ||
                        runtime.maintenanceSessionArchiveBusy
                      }
                      aria-busy={runtime.maintenanceSessionArchiveBusy}
                      onClick={() => onArchiveSession(
                        node,
                        runtime.maintenanceSessionId!,
                      )}
                    >
                      {runtime.maintenanceSessionArchiveBusy
                          ? "Archiving failed update session…"
                          : "Delete failed update session"}
                    </button>
                  )}
                  {!targetInstalled && runtime.maintenanceSessionAmbiguous && (
                    <>
                      <p className="gateway-update-session-warning" role="status">
                        {runtime.maintenanceSessionArchiveAvailable ||
                          runtime.maintenanceSessionArchived
                          ? "This Gateway has an update session left by an older Malink version. Its project-qualified route is preserved and cleanup is safe."
                          : "This older session is still owned by the Gateway update supervisor. Malink now opens it through this Gateway's exact project instead of guessing by session ID."}
                      </p>
                      {runtime.maintenanceSessionArchived ? (
                        <span className="gateway-update-session-warning" role="status">
                          Old update session deleted on this Gateway.
                        </span>
                      ) : maintenanceCleanupAllowed && runtime.maintenanceSessionArchiveAvailable ? (
                        <button
                          type="button"
                          className="secondary-button"
                          disabled={
                            !connected ||
                            runtime.maintenanceSessionArchiveBusy
                          }
                          aria-busy={runtime.maintenanceSessionArchiveBusy}
                          onClick={() => onArchiveSession(node, runtime.maintenanceSessionId!)}
                        >
                          {runtime.maintenanceSessionArchiveBusy
                            ? "Archiving old update session…"
                            : "Delete old update session"}
                        </button>
                      ) : null}
                    </>
                  )}
                  {!targetInstalled && runtime.legacyMaintenanceSessionId && (
                    <>
                      <p className="gateway-update-session-warning" role="status">
                        {runtime.legacyMaintenanceSessionArchiveAvailable ||
                          runtime.legacyMaintenanceSessionArchived
                          ? "This Gateway also has an update session left by an older Malink version. Cleanup is safe now; only this Gateway is affected."
                          : "This older update session remains attached to the active update transaction and will be deleted after it reaches a safe terminal state."}
                      </p>
                      {runtime.legacyMaintenanceSessionArchived ? (
                        <span className="gateway-update-session-warning" role="status">
                          Old update session deleted on this Gateway.
                        </span>
                      ) : maintenanceCleanupAllowed && runtime.legacyMaintenanceSessionArchiveAvailable ? (
                        <button
                          type="button"
                          className="secondary-button"
                          disabled={
                            !connected ||
                            runtime.legacyMaintenanceSessionArchiveBusy
                          }
                          aria-busy={runtime.legacyMaintenanceSessionArchiveBusy}
                          onClick={() => onArchiveSession(
                            node,
                            runtime.legacyMaintenanceSessionId!,
                          )}
                        >
                          {runtime.legacyMaintenanceSessionArchiveBusy
                            ? "Archiving old update session…"
                            : "Delete old update session"}
                        </button>
                      ) : null}
                    </>
                  )}
                  {publishedRelease && node.state === "available" && updateActionAvailable && !deploymentInProgress && (
                    <>
                      <button
                        type="button"
                        className="primary-button"
                        disabled={!connected || active}
                        aria-busy={active && activeMode === "when_idle"}
                        onClick={() => onStart(node, "when_idle")}
                      >
                        {active && activeMode === "when_idle"
                          ? node.blueGreenUpdate
                            ? "Preparing candidate Gateway…"
                            : stagedPublishedRelease
                            ? "Scheduling when idle…"
                            : recovery.kind === "start" ||
                                recovery.kind === "continue" ||
                                recovery.kind === "retry"
                              ? recovery.busyLabel
                              : "Preparing update…"
                          : node.blueGreenUpdate
                            ? "Start update session"
                          : stagedPublishedRelease
                            ? forwardOnlyConfirmation
                              ? "Review and switch to new version"
                              : "Switch to new version"
                            : recovery.kind === "start" ||
                                recovery.kind === "continue" ||
                                recovery.kind === "retry"
                              ? recovery.kind === "start" ? "Start update session" : recovery.label
                              : "Start update session"}
                      </button>
                      {!node.blueGreenUpdate && stagedPublishedRelease && (
                        <button
                          type="button"
                          className="secondary-button"
                          disabled={!connected || active}
                          aria-busy={active && activeMode === "force" ? true : undefined}
                          onClick={() => setForceConfirmationNodeId(node.gatewayNodeId)}
                        >
                          {active && activeMode === "force"
                            ? stagedPublishedRelease
                              ? "Scheduling restart now…"
                              : "Preparing restart…"
                            : recovery.kind === "retry"
                              ? "Try again and restart now…"
                              : recovery.kind === "start" &&
                                  recovery.label === "Prepare latest update"
                                ? "Prepare latest and restart now…"
                                : "Install and restart now…"}
                        </button>
                      )}
                      {!connected && (
                        <p className="gateway-update-action-status" role="status">
                          Reconnect this Malink client before installing the update.
                        </p>
                      )}
                    </>
                  )}
                </div>
                </details>}
                {embedded && forceConfirming && <ComputerActionDialog title="Install and restart now?" onClose={() => setForceConfirmationNodeId(null)}>
                  <p>Active Agent turns on this computer will stop. Malink will install the prepared version and reconnect. Queued commands stay saved.</p>
                  <div className="computer-panel-buttons"><button type="button" className="secondary-button" onClick={() => setForceConfirmationNodeId(null)}>Keep working</button><button type="button" className="danger-button" disabled={!connected || active || (!candidateTrial && !canRequestUpdate)} onClick={() => { setForceConfirmationNodeId(null); if (candidateTrial) onPromote(node, "force"); else onStart(node, "force"); }}>Stop work and restart</button></div>
                </ComputerActionDialog>}
                {!embedded && forceConfirming && (
                  <div
                    ref={forceConfirmationRef}
                    className="gateway-update-force-confirmation"
                    role="alert"
                    tabIndex={-1}
                  >
                    <strong>{candidateTrial ? "Switch all work now?" : `Restart ${owner.label} now?`}</strong>
                    <p>
                      {candidateTrial
                        ? "Malink will stop active Agent turns, merge every old and trial session into the verified candidate, and commit all project routes together. The old Gateway stops only after takeover validation."
                        : "Malink will stop active Agent turns on this computer, finish preparing the verified update, restart the Gateway, and check that it reconnects. Queued commands remain saved."}
                    </p>
                    <span>
                      <button
                        type="button"
                        className="secondary-button"
                        onClick={() => setForceConfirmationNodeId(null)}
                      >
                        Keep current work running
                      </button>
                      <button
                        type="button"
                        className="danger-button"
                        disabled={!canRequestUpdate}
                        onClick={() => {
                          setForceConfirmationNodeId(null);
                          if (candidateTrial) onPromote(node, "force");
                          else onStart(node, "force");
                        }}
                      >
                        {candidateTrial ? "Stop work and switch" : "Stop work and restart"}
                      </button>
                    </span>
                  </div>
                )}
              </article>
            );
          })}
        </div>

        {!embedded && <footer>
          <small>
            {activeGatewayNodeIds.size > 0
              ? `${activeGatewayNodeIds.size} ${activeGatewayNodeIds.size === 1 ? "computer continues" : "computers continue"} updating when this panel closes.`
              : "You choose the restart timing; each computer performs and verifies its own update."}
          </small>
          <button
            type="button"
            className="secondary-button"
            onClick={onClose}
          >
            Close
          </button>
        </footer>}
      </section>
    </div>
  );
}

const GATEWAY_UPDATE_STEPS = [
  "Preparing",
  "Ready",
  "Switching",
  "Complete",
] as const;

function GatewayUpdateProgress({ status }: { status: GatewayUpdateStatus }) {
  const activeStep = gatewayUpdateProgressStep(status.phase);
  const stopped = status.phase === "failed" ||
    status.phase === "rolled_back" ||
    status.phase === "repair_required";
  return (
    <ol className={`gateway-update-progress ${stopped ? "is-stopped" : ""}`}>
      {GATEWAY_UPDATE_STEPS.map((label, index) => (
        <li
          key={label}
          className={index < activeStep
            ? "is-complete"
            : index === activeStep
              ? "is-active"
              : "is-upcoming"}
        >
          <span aria-hidden="true">{index < activeStep ? "✓" : index + 1}</span>
          <small>{label}</small>
        </li>
      ))}
    </ol>
  );
}

function gatewayUpdateProgressStep(phase: GatewayUpdateStatus["phase"]): number {
  switch (phase) {
    case "idle":
    case "staging":
    case "agent_required":
    case "agent_running":
    case "agent_validating":
      return 0;
    case "staged":
    case "waiting_for_idle":
      return 1;
    case "scheduled":
    case "activating":
    case "probation":
      return 2;
    case "committed":
      return GATEWAY_UPDATE_STEPS.length;
    case "rolled_back":
    case "failed":
    case "repair_required":
      return 2;
  }
}

function updateStateOrder(state: GatewayUpdatePlanNode["state"]): number {
  switch (state) {
    case "available": return 0;
    case "unknown": return 1;
    case "manual": return 2;
    case "unrouted": return 3;
    case "current": return 4;
  }
}

function planStateLabel(state: GatewayUpdatePlanNode["state"]): string {
  switch (state) {
    case "available": return "Update available";
    case "current": return "Up to date";
    case "manual": return "Manual update";
    case "unrouted": return "Route unavailable";
    case "unknown": return "Version unknown";
  }
}

export function gatewayUpdateRuntimeStateTitle(
  runtime: GatewayUpdateNodeRuntime,
  node: GatewayUpdatePlanNode,
  release: GatewayReleaseBuild,
  activeMode?: GatewayUpdateActiveAction,
): string {
  if (activeMode === "check_versions") return "Checking available versions";
  if (activeMode === "select_version") return "Selecting Gateway version";
  const status = gatewayUpdateStatusForPresentation(runtime.status, release, node);
  if (status?.executionTracks && ["releasing", "activating"].includes(status.executionTracks.phase)) return "Switching Gateway version";
  if (status?.executionTracks?.phase === "steady" && status.currentBuildId !== release.buildId && status.phase === "committed") return "Previous version selected";
  const stagedPublishedRelease = gatewayUpdateCanContinuePublishedRelease({
    status,
    release,
  });
  if (status?.phase === "repair_required") return "Gateway repair required";
  if (status?.phase === "failed") return "Gateway update failed";
  if (status?.phase === "rolled_back") return "Gateway update rolled back";
  if (status?.currentBuildId === release.buildId) return "Gateway update complete";
  if (node.blueGreenUpdate && status?.phase === "staged" && stagedPublishedRelease && activeMode !== "discard") {
    return activeMode ? "Preparing candidate Gateway" : "Ready to prepare candidate Gateway";
  }
  if (status?.phase === "staged" && !stagedPublishedRelease) {
    return "Newer Gateway update available";
  }
  if (gatewayUpdateRequiresForwardOnlyConfirmation(status)) {
    return "Ready · confirmation required";
  }
  if (status?.phase === "staged" && activeMode === "discard") {
    return "Discarding candidate";
  }
  if (status?.phase === "staged" && activeMode) {
    return "Applying selected restart time";
  }
  switch (status?.phase) {
    case "staging":
    case "agent_required":
    case "agent_running":
    case "agent_validating":
      return "Preparing Gateway update";
    case "staged": return "New version ready · waiting for your switch";
    case "waiting_for_idle": return "Waiting for current Agent work";
    case "scheduled": return "Restart queued";
    case "activating": return "Restarting Gateway";
    case "probation": return "Gateway is online; finishing optional stability check";
    case "committed": return "Gateway update complete";
    case "idle":
    case undefined:
      break;
  }
  if (runtime.state === "starting") return "Update request saved";
  if (runtime.state === "error") return "Update needs attention";
  if (node.state === "manual") return "Online update is not installed";
  if (node.state === "unrouted") return "No synchronized project route";
  if (node.state === "unknown") return "Cannot compare this build";
  if (node.state === "current") return "Gateway is up to date";
  return "Update available";
}

export function gatewayUpdateRuntimeStateDetail(
  runtime: GatewayUpdateNodeRuntime,
  node: GatewayUpdatePlanNode,
  release: GatewayReleaseBuild,
  connected: boolean,
  activeMode?: GatewayUpdateActiveAction,
): string {
  if (activeMode === "check_versions") return "Reading signed version status. This check does not install or restart anything.";
  if (activeMode === "select_version") return "Waiting for the signed version selection. The same conversations and history will remain available.";
  const status = gatewayUpdateStatusForPresentation(runtime.status, release, node);
  if (status?.executionTracks && ["releasing", "activating"].includes(status.executionTracks.phase)) return "The selected version is taking over the same Workspace. You can close this panel while the handoff finishes.";
  if (status?.executionTracks?.phase === "steady" && status.currentBuildId !== release.buildId && status.phase === "committed") return "This computer is using the version you selected. Use the retained version controls to switch again; conversations and history are unchanged.";
  if (status?.phase === "failed" || status?.phase === "repair_required") {
    const failure = status.detail ?? gatewayUpdatePhaseText(status);
    return failure;
  }
  if (status?.currentBuildId === release.buildId) {
    return "The signed supervisor state confirms this build is installed. A delayed live-status check does not undo the completed update.";
  }
  if (node.blueGreenUpdate && status?.phase === "staged" &&
    status.targetBuildId === release.buildId && activeMode !== "discard") {
    return "The release is verified. Preparing a candidate keeps the current Gateway and its sessions online; switching all work is a separate explicit action.";
  }
  if (gatewayUpdateRequiresForwardOnlyConfirmation(status)) {
    const detail = "The update is prepared. Confirm the protected-data warning and choose when this computer may restart.";
    return detail;
  }
  if (status?.phase === "staged" && activeMode === "discard") {
    return "Malink is removing the candidate. The current Gateway stays online and keeps its work.";
  }
  if (status?.phase === "staged" && activeMode) {
    return activeMode === "force"
      ? "Preparation is complete. Malink is submitting your choice to stop current Agent work and restart this computer now."
      : "Preparation is complete. Malink is submitting your choice to restart after current Agent work finishes.";
  }
  if (status) {
    const phaseDetail = status.phase === "staged" &&
      status.targetBuildId !== release.buildId
      ? `An older prepared build (${status.targetBuildId ?? "unknown build"}) remains on this computer. Preparing the published update replaces that checkpoint; it will not install the older build`
      : gatewayUpdatePhaseText(status);
    return phaseDetail;
  }
  if (runtime.state === "starting") {
    return runtime.maintenanceSessionId
      ? "This Gateway accepted the request and its local maintenance Agent is running. You can close this panel."
      : "The request is saved for this named Gateway. Signed progress appears after it receives the command; you can close this panel while it waits.";
  }
  if (runtime.state === "error") {
    return runtime.detail ?? "The current Gateway build remains unchanged.";
  }
  if (!connected) return "Reconnect this Malink client to submit an update request.";
  switch (node.state) {
    case "manual":
      return "This node does not advertise the supervised online-update capability.";
    case "unrouted":
      return "This client has no known project room through which to address this node.";
    case "unknown":
      return "The signed directory did not include a current build ID.";
    case "current":
      return "The signed Gateway directory reports the published build on this computer.";
    case "available":
      return "Start an update session on this computer to prepare the release. Preparation does not switch versions; you choose when to switch after it is ready.";
  }
}

function gatewayUpdatePhaseText(status: GatewayUpdateStatus): string {
  switch (status.phase) {
    case "idle": return "Ready to update";
    case "staging": return "Checking the signed release and preparing local update work";
    case "agent_required": return "Creating the local maintenance Agent session";
    case "agent_running": return "The local maintenance Agent is preparing the release";
    case "agent_validating": return "Validating the prepared build before restart";
    case "staged": return "New version prepared. Nothing switches until you choose to switch.";
    case "waiting_for_idle":
      return status.activeTurns
        ? `Waiting for ${status.activeTurns} active Agent ${status.activeTurns === 1 ? "turn" : "turns"} to finish`
        : "Waiting for current Agent work to finish";
    case "scheduled":
      return "The restart is queued and begins automatically after a short handoff; no further action is needed";
    case "activating":
      return "The old process is stopping and the new build is starting. A brief connection gap is normal";
    case "probation":
      return "Required startup checks passed. This Gateway enabled an additional stability trial; it does not require user action";
    case "committed": return "Signed update complete";
    case "rolled_back": return "Previous Gateway version restored";
    case "failed": return "Update stopped safely";
    case "repair_required": return "Local Gateway repair required";
  }
}

function gatewayUpdateStatusForPresentation(
  status: GatewayUpdateStatus | undefined,
  release: GatewayReleaseBuild,
  node: GatewayUpdatePlanNode,
): GatewayUpdateStatus | undefined {
  if (!status) return undefined;
  if (status.executionTracks) return status;
  if (status.phase === "idle") return undefined;
  if (gatewayUpdateStatusSupersededByDirectory(node, status)) return undefined;
  if (
    status.phase === "committed" &&
    status.currentBuildId !== release.buildId &&
    status.targetBuildId !== release.buildId
  ) return undefined;
  return status;
}
