"use client";

import React, { useEffect, useRef, useState } from "react";
import type { GatewayUpdateStatus } from "@malink/protocol";
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

export type GatewayUpdateNodeRuntime = {
  state: "unchecked" | "checking" | "unreachable" | "online" | "starting" | "error";
  releaseKey?: string;
  checkedAt?: number;
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

type Props = {
  open: boolean;
  connected: boolean;
  release: GatewayReleaseBuild;
  nodes: GatewayUpdatePlanNode[];
  runtimeByNode: Readonly<Record<string, GatewayUpdateNodeRuntime>>;
  livenessByNode?: Readonly<Record<string, GatewayNodeLiveness>>;
  activeGatewayNodeIds: ReadonlySet<string>;
  activeGatewayModesByNode?: Readonly<Record<string, "when_idle" | "force">>;
  onClose(): void;
  onStart(node: GatewayUpdatePlanNode, mode: "when_idle" | "force"): void;
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
  release,
  nodes,
  runtimeByNode,
  livenessByNode = {},
  activeGatewayNodeIds,
  activeGatewayModesByNode = {},
  onClose,
  onStart,
  onOpenSession,
  onArchiveSession,
  onExportDiagnostics,
  diagnosticExportBusy = false,
}: Props) {
  const [forceConfirmationNodeId, setForceConfirmationNodeId] = useState<string | null>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const forceConfirmationRef = useRef<HTMLDivElement>(null);
  useDialogFocus({
    open,
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
      className="gateway-update-backdrop"
      role="presentation"
      onMouseDown={onClose}
    >
      <section
        ref={dialogRef}
        className="gateway-update-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="gateway-update-title"
        tabIndex={-1}
        onMouseDown={event => event.stopPropagation()}
      >
        <header>
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
        </header>

        <div className="gateway-update-release">
          <span aria-hidden="true">↻</span>
          <span>
            <small>Available release</small>
            <strong>{release.releaseId}</strong>
            <code>{release.buildId}</code>
          </span>
        </div>

        <p className="gateway-update-explanation">
          Choose when each computer may restart. Every request is saved for one
          named Gateway, and its signed supervisor state is the source of truth.
          You may close this panel while preparation or restart continues.
        </p>

        <div className="gateway-update-node-list">
          {ordered.map(node => {
            const owner = gatewayProjectOwner(
              node.gatewayNodeId,
              node.gatewayName,
              node.computerName,
            );
            const runtime = runtimeByNode[node.gatewayNodeId] ?? { state: "unchecked" };
            const liveness = livenessByNode[node.gatewayNodeId];
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
            return (
              <article
                key={node.gatewayNodeId}
                className={`gateway-update-node gateway-update-node-${node.state}`}
              >
                <div className="gateway-update-node-heading">
                  <span className="gateway-update-node-icon" aria-hidden="true">G</span>
                  <span>
                    <strong>{owner.label}</strong>
                    <small>Node {owner.shortId}</small>
                  </span>
                  <b>{planStateLabel(node.state)}</b>
                </div>

                {showUpdateProgress && signedUpdateStatus && (
                  <GatewayUpdateProgress status={signedUpdateStatus} />
                )}

                <div className="gateway-update-builds">
                  <span>
                    <small>Current build</small>
                    <code>{node.currentBuildId ?? runtime.status?.currentBuildId ?? "unknown"}</code>
                  </span>
                  <span aria-hidden="true">→</span>
                  <span>
                    <small>Target build</small>
                    <code>{release.buildId}</code>
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
                    <strong>{gatewayUpdateRuntimeStateTitle(runtime, node, release, activeMode)}</strong>
                    <small>{gatewayUpdateRuntimeStateDetail(
                      runtime,
                      node,
                      release,
                      connected,
                      activeMode,
                    )}</small>
                  </span>
                </div>

                {(liveness?.state === "checking" || liveness?.state === "unreachable") && (
                  <p className="gateway-update-action-status" role="status">
                    {liveness.state === "checking"
                      ? "A separate connection check is still waiting. It does not block this update."
                      : "A recent connection check did not receive its reply. Update requests remain durable and the signed supervisor phase above stays authoritative."}
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
                  {!targetInstalled && !statusWasSuperseded && runtime.maintenanceSessionId &&
                    node.targetProjectId && (
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={() => onOpenSession(
                        node.targetProjectId!,
                        runtime.maintenanceSessionId!,
                      )}
                    >
                      Open update session
                    </button>
                  )}
                  {!targetInstalled && !statusWasSuperseded && runtime.maintenanceSessionId &&
                    !runtime.maintenanceSessionAmbiguous &&
                    runtime.maintenanceSessionArchiveAvailable && (
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
                          : "Archive failed update session"}
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
                          Old update session archived on this Gateway.
                        </span>
                      ) : runtime.maintenanceSessionArchiveAvailable ? (
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
                            : "Archive old update session"}
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
                          : "This older update session remains attached to the active update transaction and will be archived after it reaches a safe terminal state."}
                      </p>
                      {runtime.legacyMaintenanceSessionArchived ? (
                        <span className="gateway-update-session-warning" role="status">
                          Old update session archived on this Gateway.
                        </span>
                      ) : runtime.legacyMaintenanceSessionArchiveAvailable ? (
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
                            : "Archive old update session"}
                        </button>
                      ) : null}
                    </>
                  )}
                  {node.state === "available" && updateActionAvailable && (
                    <>
                      <button
                        type="button"
                        className="primary-button"
                        disabled={!connected || active}
                        aria-busy={active && activeMode !== "force"}
                        onClick={() => onStart(node, "when_idle")}
                      >
                        {active && activeMode !== "force"
                          ? stagedPublishedRelease
                            ? "Scheduling when idle…"
                            : recovery.kind === "start" ||
                                recovery.kind === "continue" ||
                                recovery.kind === "retry"
                              ? recovery.busyLabel
                              : "Preparing update…"
                          : stagedPublishedRelease
                            ? forwardOnlyConfirmation
                              ? "Confirm and install when idle"
                              : "Install when idle"
                            : recovery.kind === "start" ||
                                recovery.kind === "continue" ||
                                recovery.kind === "retry"
                              ? recovery.label
                              : "Update when idle"}
                      </button>
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
                      {!connected && (
                        <p className="gateway-update-action-status" role="status">
                          Reconnect this Malink client before installing the update.
                        </p>
                      )}
                    </>
                  )}
                </div>
                {forceConfirming && (
                  <div
                    ref={forceConfirmationRef}
                    className="gateway-update-force-confirmation"
                    role="alert"
                    tabIndex={-1}
                  >
                    <strong>Restart {owner.label} now?</strong>
                    <p>
                      Malink will stop active Agent turns on this computer, finish preparing
                      the verified update, restart the Gateway, and check that it reconnects.
                      Queued commands remain saved.
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
                          onStart(node, "force");
                        }}
                      >
                        Stop work and restart
                      </button>
                    </span>
                  </div>
                )}
              </article>
            );
          })}
        </div>

        <footer>
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
        </footer>
      </section>
    </div>
  );
}

const GATEWAY_UPDATE_STEPS = [
  "Preparing",
  "Ready",
  "Restarting",
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
  activeMode?: "when_idle" | "force",
): string {
  const status = gatewayUpdateStatusForPresentation(runtime.status, release, node);
  const stagedPublishedRelease = gatewayUpdateCanContinuePublishedRelease({
    status,
    release,
  });
  if (status?.phase === "repair_required") return "Gateway repair required";
  if (status?.phase === "failed") return "Gateway update failed";
  if (status?.phase === "rolled_back") return "Gateway update rolled back";
  if (status?.currentBuildId === release.buildId) return "Gateway update complete";
  if (status?.phase === "staged" && !stagedPublishedRelease) {
    return "Newer Gateway update available";
  }
  if (gatewayUpdateRequiresForwardOnlyConfirmation(status)) {
    return "Ready · confirmation required";
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
    case "staged": return "Ready to choose restart time";
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
  activeMode?: "when_idle" | "force",
): string {
  const status = gatewayUpdateStatusForPresentation(runtime.status, release, node);
  if (status?.phase === "failed" || status?.phase === "repair_required") {
    const failure = status.detail ?? gatewayUpdatePhaseText(status);
    return failure;
  }
  if (status?.currentBuildId === release.buildId) {
    return "The signed supervisor state confirms this build is installed. A delayed live-status check does not undo the completed update.";
  }
  if (gatewayUpdateRequiresForwardOnlyConfirmation(status)) {
    const detail = "The update is prepared. Confirm the protected-data warning and choose when this computer may restart.";
    return detail;
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
      return "Choose when this computer may restart. Malink will route the durable request to this named Gateway.";
  }
}

function gatewayUpdatePhaseText(status: GatewayUpdateStatus): string {
  switch (status.phase) {
    case "idle": return "Ready to update";
    case "staging": return "Checking the signed release and preparing local update work";
    case "agent_required": return "Creating the local maintenance Agent session";
    case "agent_running": return "The local maintenance Agent is preparing the release";
    case "agent_validating": return "Validating the prepared build before restart";
    case "staged": return "Update prepared; choose when to install and restart";
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
  if (!status || status.phase === "idle") return undefined;
  if (gatewayUpdateStatusSupersededByDirectory(node, status)) return undefined;
  if (
    status.phase === "committed" &&
    status.currentBuildId !== release.buildId &&
    status.targetBuildId !== release.buildId
  ) return undefined;
  return status;
}
