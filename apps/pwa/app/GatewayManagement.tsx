"use client";
import React, { useState } from "react";
import type { GatewayUpdateNodeRuntime } from "./GatewayUpdateDialog";
import type { GatewayUpdatePlanNode } from "./gatewayUpdateTrigger";
import { ComputerActionDialog } from "./ComputerActionPanel";

export function GatewayManagement({ node, runtime, latestBuild, connected, busy, preparing, ready, switching,
  complete, failed, canUpdate, onUpdate, onInstall, onRefresh, onOpen, onDelete, onSelect, onExport }: {
  node: GatewayUpdatePlanNode; runtime: GatewayUpdateNodeRuntime; latestBuild?: string;
  connected: boolean; busy: boolean; preparing: boolean; ready: boolean; switching: boolean;
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
  return <section className="gateway-management-flat" aria-label="Gateway management">
    <div className="gateway-management-heading"><h3>{title}</h3>
      <button className="secondary-button" type="button" disabled={!connected || busy || !onRefresh} onClick={onRefresh} aria-label="Refresh Gateway status">↻ Refresh</button>
    </div>
    <p className="gateway-management-version">Current version <span>{current ?? "Not yet confirmed"}</span></p>
    {temporary && <p role="status">Using an older version temporarily. Update soon to avoid compatibility problems.</p>}
    {runtime.versionCheckError && <p role="status">No reply to the last check. Check that this computer is running, then refresh.</p>}
    {runtime.versionSwitchError && <p role="alert">{runtime.versionSwitchError}</p>}
    {failed && <p role="status">{runtime.status?.executionTracks?.error ?? runtime.status?.detail ?? "The update did not finish. Open its session to review the result."}</p>}
    {switching && <p role="status">This computer is installing and reconnecting. You can leave this page.</p>}
    <div className="gateway-management-actions">
      {!switching && !preparing && !ready && !complete && canUpdate && <button className="primary-button" type="button" disabled={disabled} onClick={onUpdate}>{busy ? "Starting…" : failed ? "Retry update" : "Update"}</button>}
      {retryTarget && onSelect && <button className="primary-button" type="button" disabled={disabled} onClick={() => setConfirm({ id: retryTarget, generation: tracks!.generation })}>Retry prepared update</button>}
      {ready && !switching && <button className="primary-button" type="button" disabled={disabled} onClick={() => setConfirm("install")}>Restart and install update</button>}
      {session && <button className={preparing ? "primary-button" : "secondary-button"} type="button" disabled={!node.targetProjectId} onClick={() => onOpen(session)}>Open update session</button>}
      {complete && session && <button className="secondary-button" type="button" disabled={disabled || runtime.maintenanceSessionArchiveBusy || !runtime.maintenanceSessionArchiveAvailable} onClick={() => setConfirm("delete")}>{runtime.maintenanceSessionArchiveBusy ? "Deleting…" : "Delete update session"}</button>}
    </div>
    {complete && session && !runtime.maintenanceSessionArchiveBusy && <p className="gateway-management-caption">{runtime.maintenanceSessionArchiveAvailable ? "Update installed. You can delete its session." : "Confirming the session can be deleted. Refresh if this persists."}</p>}
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
