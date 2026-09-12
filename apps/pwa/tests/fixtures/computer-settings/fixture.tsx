import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { MatrixSettings } from "../../../app/MatrixSettings";
import { GatewayUpdateDialog } from "../../../app/GatewayUpdateDialog";
import "../../../app/globals.css";
const noop = () => {};
const node = { gatewayNodeId: "tokyo", gatewayName: "Tokyo server", computerName: "Tokyo", computerId: "tokyo-host", onlineUpdate: true, targetProjectId: "project", state: "available" as const, currentBuildId: "v1" };
const second = { ...node, gatewayNodeId: "mac", gatewayName: "Mac mini", computerName: "Office", computerId: "mac-host", targetProjectId: "mac-project" };
const release = { releaseId: "v2", buildId: "v2" };
function Fixture() {
  const [phase, setPhase] = useState("idle");
  const [active, setActive] = useState("v1");
  const [checked, setChecked] = useState<number>();
  const [requested, setRequested] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [sessionOpen, setSessionOpen] = useState(false);
  const [secondPhase, setSecondPhase] = useState("idle");
  const [secondChecked, setSecondChecked] = useState<number>();
  const [name, setName] = useState(node.gatewayName);
  const [restart, setRestart] = useState<Record<string, any>>({});
  const [offline, setOffline] = useState(false);
  const [canRemove, setCanRemove] = useState(false);
  const [retiring, setRetiring] = useState<string | null>(null);
  const [checkError, setCheckError] = useState<string>();
  const [checkActive, setCheckActive] = useState(false);
  const [statusTime, setStatusTime] = useState(Date.now());
  const [forwardOnly, setForwardOnly] = useState(false);
  const [archived, setArchived] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [verifiedAt, setVerifiedAt] = useState(Date.now());
  const runtime = { mac: { state: "online" as const, versionCheckedAt: secondChecked, status: { version: 1 as const, updatedAt: 1, currentBuildId: "v1", targetBuildId: "v2", releaseId: "v2", phase: secondPhase as any } }, tokyo: { state: "online" as const, versionCheckedAt: checked, versionCheckError: checkError,
    maintenanceSessionId: phase === "idle" ? undefined : "session",
    maintenanceSessionArchived: archived, maintenanceSessionArchiveAvailable: phase === "committed",
    maintenanceSessionArchiveBusy: deleting,
    status: { version: 1 as const, updatedAt: statusTime, currentBuildId: active, targetBuildId: "v2", releaseId: "v2", phase: phase as any,
      activationMode: forwardOnly ? "forward-only" as const : "rollback-safe" as const,
      executionTracks: { generation: 1, activeRelease: active, standbyRelease: active === "v1" ? "v2" : "v1", targetRelease: forwardOnly ? "v3" : undefined, phase: forwardOnly ? "attention" as const : "steady" as const } } } };
  const props: any = {
    initialComputerId: expanded, onExpandComputer: setExpanded, open: !sessionOpen, computersRequested: requested, onComputersRequestHandled: () => setRequested(false),
    config: { homeserver: "https://example.test", userId: "user", accessToken: "fixture", roomId: "room", gatewayId: "workspace" },
    status: "connected", connectionDetail: null, repairReason: null, error: null, pairingPreview: null, pairingCompletion: null,
    trustedGateway: { gatewayName: "Workspace", gatewayId: "workspace" }, savedGateways: [], activeDeviceCount: 1,
    gatewayDirectory: { directory: { gateways: [{ ...node, gatewayName: name, workspaceId: "workspace", buildId: active, projects: [{ projectId: "project" }] }, { ...second, workspaceId: "workspace", buildId: canRemove ? "gateway-2026.09.12-081840Z-44d8e8a" : "v1", projects: [{ projectId: "mac-project" }] }] } },
    availableProjectIds: ["project", "mac-project"], pendingGatewayEnrollments: [], approvedGatewayEnrollmentIds: new Set(),
    gatewayEnrollmentBusy: null, gatewayProfileBusy: null, gatewayRetirementBusy: retiring,
    gatewayNodeLivenessById: { tokyo: { state: offline ? "unreachable" : "online", lastVerifiedAt: verifiedAt }, mac: { state: "online", lastVerifiedAt: verifiedAt } }, gatewayRestartRuntimeByNode: restart, gatewayLivenessNow: Date.now(),
    gatewayRelease: release, gatewayUpdateAvailableCount: active === "v1" ? 2 : 1, gatewayUpdateNodeCount: 2,
    gatewayUpdateDiscoveryBusy: false, gatewayUpdateDiscoveryError: null, gatewayUpdateRuntimeByNode: runtime,
    updateState: { phase: "idle" }, nativeUpdateState: null, nativeRuntime: null, webPushState: { phase: "idle" },
    onClose: noop, onReviewGatewayUpdates: noop,
    onRenameGateway: async (_: string, value: string) => setName(value),
    onRetireGateway: (id: string, authority: string) => { (window as any).retirement = {id, authority}; setRetiring(id); return new Promise<void>(resolve => { (window as any).finishRetirement = () => { setRetiring(null); resolve(); }; }); },
    onRestartGateway: (id: string, project: string, mode: string) => { (window as any).restart = { id, project, mode }; setRestart({ [id]: { state: "waiting" } }); },
    onCheckGatewayLiveness: async (id: string) => { (window as any).liveChecked = id; setOffline(false);
      return new Promise<boolean>(resolve => { (window as any).finishLiveCheck = resolve; }); },
    onExportDiagnostics: () => { (window as any).exported = true; },
    renderGatewayDetails: (id: string, managementOnly?: boolean) => <GatewayUpdateDialog key={id} open embedded managementOnly={managementOnly} connected release={release} livenessByNode={{ tokyo: { state: offline ? "unreachable" : "online", lastVerifiedAt: offline ? 1 : Date.now() }, mac: { state: "online", lastVerifiedAt: Date.now() } }} nodes={[id === "mac" ? second : { ...node, state: active === "v2" ? "current" : "available" }]} runtimeByNode={runtime} activeGatewayNodeIds={new Set(checkActive ? ["tokyo"] : [])} activeGatewayModesByNode={checkActive ? { tokyo: "check_versions" } : {}}
      onClose={noop} onStart={(target) => { (window as any).updatedNode = target.gatewayNodeId; if (target.gatewayNodeId === "mac") setSecondPhase("agent_running"); else { if (phase === "staged") setActive("v2"); else setArchived(false); setPhase(phase === "staged" ? "committed" : "agent_running"); } }}
      onCheckVersions={(target) => { if (target.gatewayNodeId === "mac") { setSecondChecked(Date.now()); return; } (window as any).checks = ((window as any).checks ?? 0) + 1; if (offline) { setCheckActive(true); (window as any).finishCheck = (success: boolean) => { setCheckActive(false); setCheckError(success ? undefined : "No reply"); if (success) { setOffline(false); setStatusTime(Date.now()); setChecked(Date.now()); } }; } else { setChecked(Date.now()); setCheckError(undefined); } }}
      onSelectVersion={(_, id) => { (window as any).selectedVersion = id; setActive(id); setPhase("committed"); }}
      onPromote={noop} onDiscard={noop} onOpenProject={noop} onOpenSession={() => setSessionOpen(true)}
      onArchiveSession={() => { setDeleting(true); (window as any).finishDelete = () => { setDeleting(false); setArchived(true); }; }}
      onExportDiagnostics={() => { (window as any).exported = true; }} />,
  };
  (window as any).setFixturePhase = (value: string) => { setPhase(value); if (value === "committed") setActive("v2"); };
  (window as any).setFixtureOffline = setOffline;
  (window as any).receiveSignedActivity = () => setVerifiedAt(Date.now());
  (window as any).setFixtureActiveBuild = setActive;
  (window as any).setFixtureForwardFailure = () => { setForwardOnly(true); setPhase("repair_required"); setStatusTime(Date.now()); setChecked(Date.now()); };
  (window as any).setFixtureCanRemove = setCanRemove;
  (window as any).setFixtureSessionOpen = setSessionOpen;
  (window as any).setFixtureOldFailure = () => { setPhase("repair_required"); setStatusTime(1); setChecked(undefined); setOffline(true); setCheckError(undefined); };
  return <>{sessionOpen ? <main><h1>Update session</h1><p>Preparing version v2</p><button onClick={() => { setRequested(true); setSessionOpen(false); }}>Back to computer settings</button></main> : <MatrixSettings {...props} />}</>;
}
const container = document.getElementById("root")! as HTMLElement & { fixtureRoot?: ReturnType<typeof createRoot> };
const root = container.fixtureRoot ??= createRoot(container);
root.render(<Fixture />);
if (import.meta.hot) import.meta.hot.accept();
