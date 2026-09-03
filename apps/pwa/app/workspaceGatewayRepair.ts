import type { SignedWorkspaceGatewayDirectory } from "@malink/protocol";

export type WorkspaceGatewayRepairNode = {
  gatewayNodeId: string;
  projectIds: readonly string[];
  availableProjectIds: readonly string[];
  unavailableProjectIds: readonly string[];
  retirementAuthorityProjectId: string | null;
};

export type WorkspaceGatewayRepairPlan = {
  availableProjects: number;
  totalProjects: number;
  unavailableProjects: number;
  nodes: readonly WorkspaceGatewayRepairNode[];
};

/**
 * Derives repair choices only from the signed Gateway directory, locally
 * verified project projections, and fresh signed liveness evidence. Liveness
 * selects a viable route but never authorizes retirement; the signed client
 * command and the receiving Gateway's Workspace identity remain the authority.
 */
export function workspaceGatewayRepairPlan(
  directory: SignedWorkspaceGatewayDirectory | null,
  availableProjectIds: ReadonlySet<string>,
  onlineGatewayNodeIds: ReadonlySet<string>,
): WorkspaceGatewayRepairPlan | null {
  if (!directory) return null;
  const nodes = directory.directory.gateways.map(gateway => {
    const projectIds = (gateway.projects ?? []).map(project => project.projectId);
    const available = projectIds.filter(projectId => availableProjectIds.has(projectId));
    const unavailable = projectIds.filter(projectId => !availableProjectIds.has(projectId));
    const authority = directory.directory.gateways
      .filter(candidate =>
        candidate.gatewayNodeId !== gateway.gatewayNodeId &&
        onlineGatewayNodeIds.has(candidate.gatewayNodeId)
      )
      .flatMap(candidate => (candidate.projects ?? []).map(project => project.projectId))
      .find(projectId => availableProjectIds.has(projectId)) ?? null;
    return {
      gatewayNodeId: gateway.gatewayNodeId,
      projectIds,
      availableProjectIds: available,
      unavailableProjectIds: unavailable,
      retirementAuthorityProjectId: authority,
    };
  });
  const totalProjects = nodes.reduce((total, node) => total + node.projectIds.length, 0);
  const availableProjects = nodes.reduce(
    (total, node) => total + node.availableProjectIds.length,
    0,
  );
  return {
    availableProjects,
    totalProjects,
    unavailableProjects: totalProjects - availableProjects,
    nodes,
  };
}
