import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { MatrixSettings } from "../../../app/MatrixSettings";
import { GatewayUpdateDialog } from "../../../app/GatewayUpdateDialog";
import "../../../app/globals.css";
const noop = () => {};
const node = { gatewayNodeId: "tokyo", gatewayName: "Tokyo server", computerName: "Tokyo", computerId: "tokyo-host", onlineUpdate: true, targetProjectId: "project", state: "available" as const, currentBuildId: "v1" };
const release = { releaseId: "v2", buildId: "v2" };
function Fixture() {
  const [phase, setPhase] = useState("idle");
  const [active, setActive] = useState("v1");
  const [checked, setChecked] = useState<number>();
  const [requested, setRequested] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [sessionOpen, setSessionOpen] = useState(false);
  const runtime = { tokyo: { state: "online" as const, versionCheckedAt: checked,
    maintenanceSessionId: phase === "idle" ? undefined : "session",
    status: { version: 1 as const, updatedAt: 1, currentBuildId: active, targetBuildId: "v2", releaseId: "v2", phase: phase as any,
      executionTracks: { generation: 1, activeRelease: active, standbyRelease: active === "v1" ? "v2" : "v1", phase: "steady" as const } } } };
  const props: any = {
    initialComputerId: expanded, onExpandComputer: setExpanded, open: !sessionOpen, computersRequested: requested, onComputersRequestHandled: () => setRequested(false),
    config: { homeserver: "https://example.test", userId: "user", accessToken: "fixture", roomId: "room", gatewayId: "workspace" },
    status: "connected", connectionDetail: null, repairReason: null, error: null, pairingPreview: null, pairingCompletion: null,
    trustedGateway: { gatewayName: "Workspace", gatewayId: "workspace" }, savedGateways: [], activeDeviceCount: 1,
    gatewayDirectory: { directory: { gateways: [{ ...node, workspaceId: "workspace", buildId: active, projects: [{ projectId: "project" }] }] } },
    availableProjectIds: ["project"], pendingGatewayEnrollments: [], approvedGatewayEnrollmentIds: new Set(),
    gatewayEnrollmentBusy: null, gatewayProfileBusy: null, gatewayRetirementBusy: null,
    gatewayNodeLivenessById: { tokyo: { state: "online", lastVerifiedAt: Date.now() } }, gatewayRestartRuntimeByNode: {}, gatewayLivenessNow: Date.now(),
    gatewayRelease: release, gatewayUpdateAvailableCount: active === "v1" ? 1 : 0, gatewayUpdateNodeCount: 1,
    gatewayUpdateDiscoveryBusy: false, gatewayUpdateDiscoveryError: null, gatewayUpdateRuntimeByNode: runtime,
    updateState: { phase: "idle" }, nativeUpdateState: null, nativeRuntime: null, webPushState: { phase: "idle" },
    onClose: noop, onReviewGatewayUpdates: noop,
    renderGatewayDetails: () => <GatewayUpdateDialog open embedded connected release={release} nodes={[{ ...node, state: active === "v2" ? "current" : "available" }]} runtimeByNode={runtime} activeGatewayNodeIds={new Set()}
      onClose={noop} onStart={() => setPhase(phase === "staged" ? "committed" : "agent_running")}
      onCheckVersions={() => { (window as any).checks = ((window as any).checks ?? 0) + 1; setChecked(Date.now()); }}
      onSelectVersion={(_, id) => { (window as any).selectedVersion = id; setActive(id); setPhase("committed"); }}
      onPromote={noop} onDiscard={noop} onOpenProject={noop} onOpenSession={() => setSessionOpen(true)} onArchiveSession={noop} onExportDiagnostics={noop} />,
  };
  (window as any).setFixturePhase = (value: string) => { setPhase(value); if (value === "committed") setActive("v2"); };
  return <>{sessionOpen ? <main><h1>Update session</h1><p>Preparing version v2</p><button onClick={() => { setRequested(true); setSessionOpen(false); }}>Back to computer settings</button></main> : <MatrixSettings {...props} />}</>;
}
const root = createRoot(document.getElementById("root")!);
root.render(<Fixture />);
if (import.meta.hot) import.meta.hot.dispose(() => root.unmount());
