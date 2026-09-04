"use client";

import React, { useRef, useState } from "react";
import type { GatewayUpdateStatus } from "@malink/protocol";
import type { GatewayReleaseBuild } from "./buildInfo";
import { useDialogFocus } from "./dialogFocus";
import {
  gatewayUpdateRequiresForwardOnlyConfirmation,
  type GatewayUpdatePlanNode,
} from "./gatewayUpdateTrigger";
import {
  GatewayNoReplyHelp,
  GatewayUpdateFailureHelp,
} from "./GatewayNoReplyHelp";
import {
  GATEWAY_LIVE_STATUS_TIMEOUT_MS,
  gatewayNoReplyPresentation,
} from "./gatewayNodeLiveness";
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
  activeGatewayNodeIds: ReadonlySet<string>;
  onClose(): void;
  onProbe(node: GatewayUpdatePlanNode): void;
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
  activeGatewayNodeIds,
  onClose,
  onProbe,
  onStart,
  onOpenSession,
  onArchiveSession,
  onExportDiagnostics,
  diagnosticExportBusy = false,
}: Props) {
  const [forceConfirmationNodeId, setForceConfirmationNodeId] = useState<string | null>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  useDialogFocus({
    open,
    containerRef: dialogRef,
    initialFocusRef: closeRef,
    onEscape: onClose,
  });
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
          Choose when each computer may restart. Malink prepares the release,
          waits for current Agent work when requested, restarts the Gateway,
          and verifies that the Workspace reconnects successfully.
        </p>

        <div className="gateway-update-node-list">
          {ordered.map(node => {
            const owner = gatewayProjectOwner(
              node.gatewayNodeId,
              node.gatewayName,
              node.computerName,
            );
            const runtime = runtimeByNode[node.gatewayNodeId] ?? { state: "unchecked" };
            const noReply = gatewayNoReplyPresentation({
              gatewayLabel: owner.label,
              consecutiveNoReplies: runtime.consecutiveNoReplies,
            });
            const knownUpdateFailure = runtime.status?.phase === "failed" ||
              runtime.status?.phase === "repair_required" ||
              runtime.status?.phase === "rolled_back";
            const recovery = gatewayUpdateRecoveryAction({
              status: runtime.status,
              release,
              commandFailure: {
                code: runtime.commandFailureCode,
                retryable: runtime.commandFailureRetryable,
              },
            });
            const forwardOnlyConfirmation =
              gatewayUpdateRequiresForwardOnlyConfirmation(runtime.status);
            const updateActionAvailable = recovery.kind === "start" ||
              recovery.kind === "continue" || recovery.kind === "retry";
            const runtimeNeedsAttention = runtime.state === "error" ||
              (runtime.state === "unreachable" && noReply.persistent) ||
              knownUpdateFailure;
            const targetInstalled = runtime.status?.currentBuildId === release.buildId;
            const canProbe = connected && node.onlineUpdate && Boolean(node.targetProjectId);
            const canStart =
              node.state === "available" &&
              runtime.state === "online" &&
              Boolean(runtime.status) &&
              updateActionAvailable &&
              !activeGatewayNodeIds.has(node.gatewayNodeId);
            const active = activeGatewayNodeIds.has(node.gatewayNodeId);
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

                {runtime.status && runtime.status.phase !== "idle" && (
                  <GatewayUpdateProgress status={runtime.status} />
                )}

                <div className="gateway-update-builds">
                  <span>
                    <small>Current build</small>
                    <code>{node.currentBuildId ?? "unknown"}</code>
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
                    <strong>{runtimeStateTitle(runtime, node)}</strong>
                    <small>{runtimeStateDetail(runtime, node, release, connected)}</small>
                  </span>
                </div>

                {runtime.state === "unreachable" && (
                  <GatewayNoReplyHelp
                    gatewayLabel={owner.label}
                    consecutiveNoReplies={runtime.consecutiveNoReplies}
                    onExportDiagnostics={onExportDiagnostics}
                    diagnosticExportBusy={diagnosticExportBusy}
                  />
                )}
                {runtime.status && knownUpdateFailure && (
                  <GatewayUpdateFailureHelp
                    gatewayLabel={owner.label}
                    status={runtime.status}
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
                  {!targetInstalled && runtime.maintenanceSessionId &&
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
                  {!targetInstalled && runtime.maintenanceSessionId &&
                    !runtime.maintenanceSessionAmbiguous &&
                    runtime.maintenanceSessionArchiveAvailable && (
                    <button
                      type="button"
                      className="secondary-button"
                      disabled={
                        !connected ||
                        runtime.state === "checking" ||
                        runtime.maintenanceSessionArchiveBusy
                      }
                      aria-busy={runtime.maintenanceSessionArchiveBusy}
                      onClick={() => onArchiveSession(
                        node,
                        runtime.maintenanceSessionId!,
                      )}
                    >
                      {runtime.maintenanceSessionArchiveChecking
                        ? "Checking before archive…"
                        : runtime.maintenanceSessionArchiveBusy
                          ? "Archiving failed update session…"
                          : "Archive failed update session"}
                    </button>
                  )}
                  {!targetInstalled && runtime.maintenanceSessionAmbiguous && (
                    <>
                      <p className="gateway-update-session-warning" role="alert">
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
                            runtime.state === "checking" ||
                            runtime.maintenanceSessionArchiveBusy
                          }
                          aria-busy={runtime.maintenanceSessionArchiveBusy}
                          onClick={() => onArchiveSession(node, runtime.maintenanceSessionId!)}
                        >
                          {runtime.maintenanceSessionArchiveChecking
                            ? "Checking before archive…"
                            : runtime.maintenanceSessionArchiveBusy
                            ? "Archiving old update session…"
                            : "Archive old update session"}
                        </button>
                      ) : null}
                    </>
                  )}
                  {!targetInstalled && runtime.legacyMaintenanceSessionId && (
                    <>
                      <p className="gateway-update-session-warning" role="alert">
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
                            runtime.state === "checking" ||
                            runtime.legacyMaintenanceSessionArchiveBusy
                          }
                          aria-busy={runtime.legacyMaintenanceSessionArchiveBusy}
                          onClick={() => onArchiveSession(
                            node,
                            runtime.legacyMaintenanceSessionId!,
                          )}
                        >
                          {runtime.legacyMaintenanceSessionArchiveChecking
                            ? "Checking before archive…"
                            : runtime.legacyMaintenanceSessionArchiveBusy
                            ? "Archiving old update session…"
                            : "Archive old update session"}
                        </button>
                      ) : null}
                    </>
                  )}
                  {canProbe && !active && (
                    <button
                      type="button"
                      className="secondary-button"
                      disabled={
                        runtime.state === "checking" || active
                      }
                      onClick={() => onProbe(node)}
                    >
                      {runtime.state === "checking"
                        ? "Checking…"
                        : runtime.state === "unreachable"
                          ? noReply.retryLabel
                          : "Check live status"}
                    </button>
                  )}
                  {node.state === "available" && updateActionAvailable && (
                    <>
                      <button
                        type="button"
                        className="primary-button"
                        disabled={!canStart}
                        onClick={() => onStart(node, "when_idle")}
                      >
                        {active
                          ? "Updating…"
                          : runtime.status?.phase === "staged"
                            ? forwardOnlyConfirmation
                              ? "Confirm and install when idle"
                              : "Install when idle"
                            : recovery.kind === "retry"
                              ? "Try update again"
                              : "Update when idle"}
                      </button>
                      <button
                        type="button"
                        className="secondary-button"
                        disabled={!canStart}
                        onClick={() => setForceConfirmationNodeId(node.gatewayNodeId)}
                      >
                        Install and restart now…
                      </button>
                    </>
                  )}
                </div>
                {forceConfirming && (
                  <div className="gateway-update-force-confirmation" role="alert">
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
                        disabled={!canStart}
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
  "Waiting for work",
  "Restarting",
  "Verifying",
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
      return 1;
    case "waiting_for_idle":
      return 2;
    case "scheduled":
    case "activating":
      return 3;
    case "probation":
      return 4;
    case "committed":
      return 5;
    case "rolled_back":
    case "failed":
    case "repair_required":
      return 4;
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

function runtimeStateTitle(
  runtime: GatewayUpdateNodeRuntime,
  node: GatewayUpdatePlanNode,
): string {
  if (runtime.state === "checking") return "Checking this Gateway…";
  if (runtime.state === "unreachable") {
    return gatewayNoReplyPresentation({
      gatewayLabel: node.computerName ?? node.gatewayName,
      consecutiveNoReplies: runtime.consecutiveNoReplies,
    }).title;
  }
  if (runtime.state === "starting") return "Update requested by this device";
  if (runtime.state === "error") return "Update needs attention";
  if (runtime.state === "online") {
    if (runtime.status?.phase === "repair_required") return "Gateway repair required";
    if (runtime.status?.phase === "failed") return "Gateway update failed";
    if (runtime.status?.phase === "rolled_back") return "Gateway update rolled back";
    if (gatewayUpdateRequiresForwardOnlyConfirmation(runtime.status)) {
      return "Ready · confirmation required";
    }
    switch (runtime.status?.phase) {
      case "staging":
      case "agent_required":
      case "agent_running":
      case "agent_validating":
        return "Preparing Gateway update";
      case "staged": return "Ready to choose restart time";
      case "waiting_for_idle": return "Waiting for current Agent work";
      case "scheduled": return "Gateway restart scheduled";
      case "activating": return "Restarting Gateway for update";
      case "probation": return "Verifying updated Gateway";
      case "committed": return "Gateway update complete";
      case "idle":
      case undefined:
        return "Online now";
    }
  }
  if (node.state === "manual") return "Online update is not installed";
  if (node.state === "unrouted") return "No synchronized project route";
  if (node.state === "unknown") return "Cannot compare this build";
  return "Live status not checked";
}

function runtimeStateDetail(
  runtime: GatewayUpdateNodeRuntime,
  node: GatewayUpdatePlanNode,
  release: GatewayReleaseBuild,
  connected: boolean,
): string {
  if (runtime.state === "checking") {
    return "Waiting for a signed terminal reply from this node.";
  }
  if (runtime.state === "unreachable") {
    if (
      runtime.maintenanceSessionId ||
      (runtime.status?.releaseId === release.releaseId &&
        runtime.status.targetBuildId === release.buildId)
    ) {
      return (
        `No signed status reply arrived from ${node.computerName ?? node.gatewayName} within ${GATEWAY_LIVE_STATUS_TIMEOUT_MS / 1_000} seconds. ` +
        "This Gateway already has a supervised update transaction; the timed-out check did not start it again or cancel it. " +
        "Open the update session to review progress, or wait a moment and check live status again."
      );
    }
    return runtime.detail ?? gatewayNoReplyPresentation({
      gatewayLabel: node.computerName ?? node.gatewayName,
      consecutiveNoReplies: runtime.consecutiveNoReplies,
    }).detail;
  }
  if (runtime.state === "starting") {
    return runtime.maintenanceSessionId
      ? "The local Agent maintenance session is visible and running. You can close this panel."
      : "The Gateway is creating its local Agent maintenance session. You can close this panel; the update continues in the background.";
  }
  if (runtime.state === "error") {
    return runtime.detail ?? "The current Gateway build remains unchanged.";
  }
  if (runtime.state === "online") {
    if (
      runtime.status?.phase === "failed" ||
      runtime.status?.phase === "repair_required"
    ) {
      const failure = runtime.status.detail ?? gatewayUpdatePhaseText(runtime.status);
      return runtime.checkedAt
        ? `${failure} · replied ${formatCheckedTime(runtime.checkedAt)}`
        : failure;
    }
    if (gatewayUpdateRequiresForwardOnlyConfirmation(runtime.status)) {
      const detail = "The update is prepared. Confirm the protected-data warning and choose when this computer may restart.";
      return runtime.checkedAt
        ? `${detail} · checked ${formatCheckedTime(runtime.checkedAt)}`
        : detail;
    }
    const supervisor = runtime.status?.phase === "staged" &&
      runtime.status.targetBuildId !== release.buildId
      ? `Another prepared release (${runtime.status.targetBuildId ?? "unknown build"}) is ready to install on this computer`
      : runtime.status?.currentBuildId === release.buildId &&
      !["activating", "probation"].includes(runtime.status.phase)
      ? "Installed build verified"
      : runtime.status
        ? gatewayUpdatePhaseText(runtime.status)
      : runtime.detail ?? "The node returned a signed response.";
    return runtime.checkedAt
      ? `${supervisor} · replied ${formatCheckedTime(runtime.checkedAt)}`
      : supervisor;
  }
  if (!connected) return "Connect to Matrix before checking the Gateway process.";
  switch (node.state) {
    case "manual":
      return "This node does not advertise the supervised online-update capability.";
    case "unrouted":
      return "This client has no known project room through which to address this node.";
    case "unknown":
      return "The signed directory did not include a current build ID.";
    case "current":
    case "available":
      return "Run a live check before starting any update.";
  }
}

function gatewayUpdatePhaseText(status: GatewayUpdateStatus): string {
  switch (status.phase) {
    case "idle": return "Ready to update";
    case "staging":
    case "agent_required":
    case "agent_running":
    case "agent_validating":
      return "Preparing the update in its maintenance session";
    case "staged": return "Update prepared; choose when to install and restart";
    case "waiting_for_idle":
      return status.activeTurns
        ? `Waiting for ${status.activeTurns} active Agent ${status.activeTurns === 1 ? "turn" : "turns"} to finish`
        : "Waiting for current Agent work to finish";
    case "scheduled": return "Update prepared; installation is scheduled";
    case "activating":
    case "probation":
      return "Installing and verifying the updated Gateway";
    case "committed": return "Update complete";
    case "rolled_back": return "Previous Gateway version restored";
    case "failed": return "Update stopped safely";
    case "repair_required": return "Local Gateway repair required";
  }
}

function formatCheckedTime(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(timestamp));
}
