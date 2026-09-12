"use client";
import React, { useState } from "react";
import type { GatewayUpdateNodeRuntime } from "./GatewayUpdateDialog";
import type { GatewayUpdatePlanNode } from "./gatewayUpdateTrigger";
import { ComputerActionDialog } from "./ComputerActionPanel";

export function GatewayManagement({ node, runtime, latestBuild, connected, busy, refreshing, preparing, ready, switching,
  complete, failed, canUpdate, onUpdate, onInstall, onRefresh, onOpen, onDelete, onSelect, onExport }: {
  node: GatewayUpdatePlanNode; runtime: GatewayUpdateNodeRuntime; latestBuild?: string;
  connected: boolean; busy: boolean; refreshing?: boolean; preparing: boolean; ready: boolean; switching: boolean;
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
  return <section className={"gateway-management-flat gateway-management-" + tone} aria-label="Gateway management">
    <div className="gateway-management-heading">
      <span className="gateway-management-mark" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
        {tone === "success" ? <path d="m6 12 4 4 8-8"/> : tone === "attention" ? <><path d="M12 5v9"/><path d="M12 18h.01"/></> : <><path d="M12 16V4m-4 4 4-4 4 4"/><path d="M5 14v5h14v-5"/></>}
      </svg></span>
      <div className="gateway-management-heading-copy"><span className="gateway-management-eyebrow">Gateway software</span><h3>{title}</h3></div>
      <button className="secondary-button gateway-management-refresh" type="button" disabled={!connected || busy || !onRefresh} onClick={onRefresh} aria-label="Refresh Gateway status" aria-busy={refreshing} title={refreshing ? "Checking this computer…" : "Refresh Gateway status"}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5"/><path d="M6 7a7 7 0 0 1 12-1l2 6M4 12l2 6a7 7 0 0 0 12-1"/></svg>
      </button>
    </div>
    {(refreshing || runtime.versionCheckedAt) && <p className="gateway-check-result" role="status">{refreshing ? "Checking this computer…" : (runtime.versionCheckError ? "No new reply" : "Status refreshed") + " · " + new Date(runtime.versionCheckedAt!).toLocaleTimeString()}</p>}
    <p className="gateway-management-version">Installed <span title={current}>{current ?? "Not yet confirmed"}</span></p>
    {temporary && <p role="status">Using an older version temporarily. Update soon to avoid compatibility problems.</p>}
    {runtime.versionCheckError && <p role="status">No reply to the last check. Check that this computer is running, then refresh.</p>}
    {runtime.versionSwitchError && <p role="alert">{runtime.versionSwitchError}</p>}
    {failed && <p role="status">{runtime.status?.executionTracks?.error ?? runtime.status?.detail ?? "The update did not finish. Open its session to review the result."}</p>}
    {switching && <p role="status">This computer is installing and reconnecting. You can leave this page.</p>}
    <div className="gateway-management-actions">
      {!switching && !preparing && !ready && !complete && !retryTarget && canUpdate && <button className="primary-button" type="button" disabled={disabled} onClick={onUpdate}>{busy ? "Starting…" : failed ? "Retry update" : "Update"}</button>}
      {retryTarget && onSelect && <button className="primary-button" type="button" disabled={disabled} onClick={() => setConfirm({ id: retryTarget, generation: tracks!.generation })}>Retry prepared update</button>}
      {ready && !switching && <button className="primary-button" type="button" disabled={disabled} onClick={() => setConfirm("install")}>Restart and install update</button>}
      {session && <button className={preparing ? "primary-button" : "secondary-button"} type="button" disabled={!node.targetProjectId} onClick={() => onOpen(session)}>Open update session</button>}
      {complete && session && <button className="primary-button" type="button" disabled={disabled || runtime.maintenanceSessionArchiveBusy || !runtime.maintenanceSessionArchiveAvailable} onClick={() => setConfirm("delete")}>{runtime.maintenanceSessionArchiveBusy ? "Deleting…" : "Delete update session"}</button>}
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
