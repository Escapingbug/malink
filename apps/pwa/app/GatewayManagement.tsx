"use client";
import React, { useState } from "react";
import type { GatewayUpdateNodeRuntime } from "./GatewayUpdateDialog";
import type { GatewayUpdatePlanNode } from "./gatewayUpdateTrigger";
import { ComputerActionDialog } from "./ComputerActionPanel";
import { GATEWAY_ONLINE_PROOF_WINDOW_MS } from "./gatewayNodeLiveness";
import { SettingsIcon } from "./SettingsIcon";

export function GatewayManagement({ node, runtime, latestBuild, connected, lastVerifiedAt, busy, refreshing, preparing, ready, switching,
  complete, failed, canUpdate, onUpdate, onInstall, onRefresh, onOpen, onDelete, onSelect, onExport }: {
  node: GatewayUpdatePlanNode; runtime: GatewayUpdateNodeRuntime; latestBuild?: string;
  connected: boolean; lastVerifiedAt?: number; busy: boolean; refreshing?: boolean; preparing: boolean; ready: boolean; switching: boolean;
  complete: boolean; failed: boolean; canUpdate: boolean;
  onUpdate(): void; onInstall(): void; onRefresh?(): void; onOpen(id: string): void;
  onDelete(id: string): void; onSelect?(id: string, generation: number): void; onExport(): void;
}) {
  const [confirm, setConfirm] = useState<"install" | "delete" | { id: string; generation: number } | null>(null);
  const tracks = runtime.status?.executionTracks;
  const current = runtime.status?.currentBuildId ?? node.currentBuildId;
  const session = runtime.maintenanceSessionArchived ? undefined : runtime.maintenanceSessionId;
  const previous = runtime.status?.activationMode !== "forward-only" && tracks?.standbyRelease;
  const temporary = tracks?.phase === "steady" && Boolean(latestBuild && current !== latestBuild) && runtime.status?.phase === "committed";
  const canSwitch = Boolean(!temporary && previous && tracks && ["steady", "attention"].includes(tracks.phase) && onSelect);
  const retryTarget = failed && tracks?.phase === "attention" ? tracks.targetRelease : undefined;
  const disabled = !connected || busy;
  const title = switching ? "Restarting for update…" : complete ? "Update complete" : ready ? "Ready to install"
    : preparing ? "Preparing update…" : failed ? "Update needs attention" : latestBuild && current !== latestBuild ? "Update available" : latestBuild ? "Up to date" : "Checking for updates";
  const tone = switching || preparing ? "progress" : failed ? "attention" : complete || current === latestBuild ? "success" : "available";
  const proof = Math.max(lastVerifiedAt ?? 0, !runtime.versionCheckError ? runtime.versionCheckedAt ?? 0 : 0);
  const now = Date.now();
  const online = connected && proof > 0 && proof <= now && now - proof <= GATEWAY_ONLINE_PROOF_WINDOW_MS;
  return <section className={"gateway-management-flat gateway-management-" + tone} aria-label="Gateway management">
    <div className="gateway-connection-row settings-compact-row">
      <span className="gateway-connection-copy">
      <span className={"gateway-connection-state" + (online ? " is-online" : "")}><i aria-hidden="true"/>{!connected ? "Client disconnected" : refreshing ? "Checking…" : online ? "Online" : "Status not confirmed"}</span>
      {(refreshing || runtime.versionCheckedAt) && <small className="gateway-check-result" role="status">{refreshing ? "Checking this computer…" : (runtime.versionCheckError ? "No new reply" : "Status refreshed") + " · " + new Date(runtime.versionCheckedAt!).toLocaleTimeString()}</small>}
      {runtime.versionCheckError && <small className="gateway-check-result" role="status">No reply to the last check. Check that this computer is running, then refresh.</small>}
      </span>
      <button className="secondary-button gateway-management-refresh" type="button" disabled={!connected || busy || !onRefresh} onClick={onRefresh} aria-label="Refresh Gateway status" aria-busy={refreshing} title={refreshing ? "Checking this computer…" : "Refresh Gateway status"}>
        <SettingsIcon name="refresh"/><span>{refreshing ? "Checking…" : "Refresh"}</span>
      </button>
    </div>
    <div className="gateway-software-task settings-compact-row">
    <div className="gateway-software-summary">
    <div className="gateway-management-heading">
      <div className="gateway-management-heading-copy"><span className="gateway-management-eyebrow">Software update</span><h3>{title}</h3></div>
      {tone === "success" && <span className="gateway-success-mark" aria-label="Update successful"><SettingsIcon name="check"/></span>}
    </div>
    <p className="gateway-management-version">Installed <span title={current}>{current ?? "Not yet confirmed"}</span></p>
    </div>
    {temporary && <p role="status">Using an older version temporarily. Update soon to avoid compatibility problems.</p>}
    {runtime.versionSwitchError && <p role="alert">{runtime.versionSwitchError}</p>}
    {failed && <p role="status">{runtime.status?.executionTracks?.error ?? runtime.status?.detail ?? "The update did not finish. Open its session to review the result."}</p>}
    {switching && <p role="status">This computer is installing and reconnecting. You can leave this page.</p>}
    <div className="gateway-management-actions">
      {!switching && !preparing && !ready && !complete && !retryTarget && canUpdate && <button className="primary-button" type="button" disabled={disabled} onClick={onUpdate}>{busy ? "Starting…" : failed ? "Retry update" : "Update"}</button>}
      {retryTarget && onSelect && <button className="primary-button" type="button" disabled={disabled} onClick={() => setConfirm({ id: retryTarget, generation: tracks!.generation })}>Retry prepared update</button>}
      {ready && !switching && <button className="primary-button" type="button" disabled={disabled} onClick={() => setConfirm("install")}>Restart and install update</button>}
      {session && <button className={preparing ? "primary-button" : "secondary-button"} type="button" disabled={!node.targetProjectId} onClick={() => onOpen(session)}>Open update session</button>}
      {complete && session && <button className="secondary-button" type="button" disabled={disabled || runtime.maintenanceSessionArchiveBusy || !runtime.maintenanceSessionArchiveAvailable} onClick={() => setConfirm("delete")}>{runtime.maintenanceSessionArchiveBusy ? "Deleting…" : "Delete update session"}</button>}
    </div>
    {complete && session && !runtime.maintenanceSessionArchiveBusy && <p className="gateway-management-caption">{runtime.maintenanceSessionArchiveAvailable ? "Ready to use. Session cleanup is optional." : "Confirming the session can be deleted. Refresh if this persists."}</p>}
    </div>
    <div className="gateway-management-actions gateway-management-secondary">
      {canSwitch && <button className="secondary-button" type="button" disabled={disabled} onClick={() => setConfirm({ id: String(previous), generation: tracks!.generation })}>Temporarily use previous version</button>}
      {(failed || runtime.versionCheckError) && <button className="secondary-button" type="button" onClick={onExport}>Export diagnostics</button>}
    </div>
    {confirm && <ComputerActionDialog title={confirm === "delete" ? "Delete update session?" : confirm === "install" ? "Restart and install update?" : confirm.id === previous ? "Temporarily use previous version?" : "Retry prepared update?"} onClose={() => setConfirm(null)}>
      <p>{confirm === "delete" ? "Only the update session is deleted. Installed software and your work sessions stay unchanged."
        : typeof confirm === "object" && confirm.id === previous ? "This is temporary recovery. Update again as soon as possible to avoid incompatibility with newer client features. Running tasks finish first."
        : "Running tasks finish first, then this computer restarts to activate the update."}</p>
      {confirm !== "delete" && runtime.status?.activationMode === "forward-only" && <p role="alert">This update changes stored data. You cannot switch back to an older version; keep access to this computer for recovery.</p>}
      <div className="gateway-management-actions">
        <button type="button" className="secondary-button" onClick={() => setConfirm(null)}>Cancel</button>
        <button type="button" className="primary-button" disabled={disabled || typeof confirm === "object" && tracks?.generation !== confirm.generation} onClick={() => {
          if (confirm === "install") onInstall();
          else if (confirm === "delete" && session) onDelete(session);
          else if (typeof confirm === "object") onSelect?.(confirm.id, confirm.generation);
          setConfirm(null);
        }}>Confirm</button>
      </div>
    </ComputerActionDialog>}
  </section>;
}
