import type { GatewayDeploymentStatus } from "@malink/protocol";
import type { GatewayStateSnapshot, GatewayWorkspaceState } from "./gatewayState";

export function preferredGatewayCreationWorkspace(state: GatewayStateSnapshot | null,
  current: GatewayWorkspaceState | undefined): GatewayWorkspaceState | undefined {
  if (!state || !current) return current;
  const nodes = state.gatewayDirectory?.directory.gateways ?? [];
  const owner = nodes.find(node => node.projects?.some(project => project.projectId === current.projectId));
  const deployment = Object.values(state.gatewayDeployments ?? {}).map(item => item.deployment)
    .find(item => item.phase === "trial" && item.active.gatewayNodeId === owner?.gatewayNodeId);
  const candidate = nodes.find(node => node.gatewayNodeId === deployment?.candidate?.gatewayNodeId);
  return state.projects?.find(project => project.cwd === current.cwd &&
    candidate?.projects?.some(route => route.projectId === project.projectId)) ?? current;
}

/** Never recover through the candidate, even when it owns the visible page. */
export function gatewayRecoveryTarget(state: GatewayStateSnapshot, deployment: GatewayDeploymentStatus) {
  if (deployment.phase === "steady") return null;
  const node = state.gatewayDirectory?.directory.gateways.find(
    node => node.gatewayNodeId === deployment.active.gatewayNodeId,
  );
  if (!node) return null;
  const projectIds = new Set(node.projects?.map(project => project.projectId));
  const maintenanceId = state.gatewayNodeStatuses?.[node.gatewayNodeId]?.update.maintenanceSessionId;
  const session = state.sessions.find(session => projectIds.has(session.projectId) &&
    session.id === maintenanceId && session.status !== "archived") ??
    state.sessions.find(session => projectIds.has(session.projectId) &&
      session.title === gatewayRecoveryTitle(deployment) && session.status !== "archived");
  const workspace = [state.workspace, ...(state.projects ?? [])].find(project =>
    projectIds.has(project.projectId) && (!session || project.projectId === session.projectId));
  return workspace ? { gatewayNodeId: node.gatewayNodeId, workspace, session } : null;
}

export function gatewayRecoveryTitle(deployment: GatewayDeploymentStatus) {
  return `Gateway update repair · ${deployment.updateId ?? deployment.generation}`;
}

export function gatewayRecoveryReport(deployment: GatewayDeploymentStatus, state: string) {
  return JSON.stringify({
    kind: "gateway-update-recovery", version: 1,
    updateId: deployment.updateId, generation: deployment.generation, phase: deployment.phase,
    previous: deployment.active, candidate: deployment.candidate,
    candidateConnection: state, detail: deployment.detail,
    instruction: "Inspect the candidate while keeping this previous Gateway available. Do not promote or stop this Gateway without user confirmation.",
  }, null, 2);
}
