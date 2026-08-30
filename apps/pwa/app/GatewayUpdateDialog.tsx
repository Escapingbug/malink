"use client";

import { useRef } from "react";
import type { GatewayUpdateStatus } from "@malink/protocol";
import type { GatewayReleaseBuild } from "./buildInfo";
import { useDialogFocus } from "./dialogFocus";
import type { GatewayUpdatePlanNode } from "./gatewayUpdateTrigger";
import { gatewayProjectOwner } from "./projectCatalog";

export type GatewayUpdateNodeRuntime = {
  state: "unchecked" | "checking" | "unreachable" | "online" | "starting" | "error";
  releaseKey?: string;
  checkedAt?: number;
  startedAt?: number;
  detail?: string;
  status?: GatewayUpdateStatus;
  maintenanceSessionId?: string;
};

type Props = {
  open: boolean;
  connected: boolean;
  release: GatewayReleaseBuild;
  nodes: GatewayUpdatePlanNode[];
  runtimeByNode: Readonly<Record<string, GatewayUpdateNodeRuntime>>;
  activeGatewayNodeId: string | null;
  onClose(): void;
  onProbe(node: GatewayUpdatePlanNode): void;
  onStart(node: GatewayUpdatePlanNode): void;
  onOpenSession(sessionId: string): void;
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
  activeGatewayNodeId,
  onClose,
  onProbe,
  onStart,
  onOpenSession,
}: Props) {
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  useDialogFocus({
    open,
    containerRef: dialogRef,
    initialFocusRef: closeRef,
    escapeDisabled: activeGatewayNodeId !== null,
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
      onMouseDown={() => {
        if (activeGatewayNodeId === null) onClose();
      }}
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
            <span className="eyebrow">Workspace · Gateway software</span>
            <h2 id="gateway-update-title">Review Gateway update</h2>
            <p>
              {availableCount === 0
                ? "Every reachable Gateway is already current or needs manual attention."
                : `${availableCount} ${availableCount === 1 ? "Gateway needs" : "Gateways need"} the published release.`}
            </p>
          </div>
          <button
            ref={closeRef}
            type="button"
            aria-label="Close Gateway update"
            disabled={activeGatewayNodeId !== null}
            onClick={onClose}
          >
            ×
          </button>
        </header>

        <div className="gateway-update-release">
          <span aria-hidden="true">↻</span>
          <span>
            <small>Published signed release</small>
            <strong>{release.releaseId}</strong>
            <code>{release.buildId}</code>
          </span>
        </div>

        <p className="gateway-update-explanation">
          Opening this panel checks each capable node with a signed status
          request. “Online now” means that exact Gateway replied—not merely
          that Matrix is connected. Starting an update creates a visible local
          Agent maintenance session, then activates only after current work is idle.
        </p>

        <div className="gateway-update-node-list">
          {ordered.map(node => {
            const owner = gatewayProjectOwner(
              node.gatewayNodeId,
              node.gatewayName,
              node.computerName,
            );
            const runtime = runtimeByNode[node.gatewayNodeId] ?? { state: "unchecked" };
            const canProbe = connected && node.onlineUpdate && Boolean(node.targetProjectId);
            const canStart =
              node.state === "available" &&
              runtime.state === "online" &&
              Boolean(runtime.status) &&
              activeGatewayNodeId === null;
            const active = activeGatewayNodeId === node.gatewayNodeId;
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
                  className={`gateway-update-live gateway-update-live-${runtime.state}`}
                  role={runtime.state === "error" || runtime.state === "unreachable" ? "alert" : "status"}
                >
                  <span aria-hidden="true" />
                  <span>
                    <strong>{runtimeStateTitle(runtime, node)}</strong>
                    <small>{runtimeStateDetail(runtime, node, connected)}</small>
                  </span>
                </div>

                <div className="gateway-update-node-actions">
                  {runtime.maintenanceSessionId && (
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={() => onOpenSession(runtime.maintenanceSessionId!)}
                    >
                      Open update session
                    </button>
                  )}
                  {canProbe && !active && (
                    <button
                      type="button"
                      className="secondary-button"
                      disabled={
                        runtime.state === "checking" ||
                        activeGatewayNodeId !== null
                      }
                      onClick={() => onProbe(node)}
                    >
                      {runtime.state === "checking"
                        ? "Checking…"
                        : runtime.state === "unreachable"
                          ? "Retry live check"
                          : "Check live status"}
                    </button>
                  )}
                  {node.state === "available" && !runtime.maintenanceSessionId && (
                    <button
                      type="button"
                      className="primary-button"
                      disabled={!canStart && !active}
                      onClick={() => onStart(node)}
                    >
                      {active ? "Creating update session…" : "Create update session"}
                    </button>
                  )}
                </div>
              </article>
            );
          })}
        </div>

        <footer>
          <small>Requested by this Malink device; executed by the named Gateway.</small>
          <button
            type="button"
            className="secondary-button"
            disabled={activeGatewayNodeId !== null}
            onClick={onClose}
          >
            Close
          </button>
        </footer>
      </section>
    </div>
  );
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
  if (runtime.state === "unreachable") return "No live reply";
  if (runtime.state === "starting") return "Update requested by this device";
  if (runtime.state === "error") return "Update needs attention";
  if (runtime.state === "online") return "Online now";
  if (node.state === "manual") return "Online update is not installed";
  if (node.state === "unrouted") return "No synchronized project route";
  if (node.state === "unknown") return "Cannot compare this build";
  return "Live status not checked";
}

function runtimeStateDetail(
  runtime: GatewayUpdateNodeRuntime,
  node: GatewayUpdatePlanNode,
  connected: boolean,
): string {
  if (runtime.state === "checking") {
    return "Waiting for a signed terminal reply from this node.";
  }
  if (runtime.state === "unreachable") {
    return runtime.detail ??
      "Matrix accepted the status request, but this Gateway did not return a signed reply. Check that the named computer and Malink Gateway Host are running, then retry.";
  }
  if (runtime.state === "starting") {
    return runtime.maintenanceSessionId
      ? "The local Agent maintenance session is visible and running."
      : "The Gateway is creating its local Agent maintenance session.";
  }
  if (runtime.state === "error") {
    return runtime.detail ?? "The current Gateway build remains unchanged.";
  }
  if (runtime.state === "online") {
    const supervisor = runtime.status
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
    case "idle": return "Supervisor idle";
    case "staging": return "Verifying the signed Prompt";
    case "agent_required": return "Maintenance Agent required";
    case "agent_running": return "Maintenance Agent running";
    case "agent_validating": return "Validating the Agent-built release";
    case "staged": return "Release staged";
    case "waiting_for_idle": return `Waiting for ${status.activeTurns ?? "active"} turn(s)`;
    case "scheduled": return "Activation scheduled";
    case "activating": return "Activating release";
    case "probation": return "Health-check probation";
    case "committed": return "Release committed";
    case "rolled_back": return "Release rolled back";
    case "failed": return "Last update failed";
    case "repair_required": return "Local repair required";
  }
}

function formatCheckedTime(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(timestamp));
}
