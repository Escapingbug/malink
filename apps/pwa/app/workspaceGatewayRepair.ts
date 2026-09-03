import type { SignedWorkspaceGatewayDirectory } from "@malink/protocol";

export type WorkspaceGatewayRepairNode = {
  gatewayNodeId: string;
  projectIds: readonly string[];
  availableProjectIds: readonly string[];
  unavailableProjectIds: readonly string[];
  retirementAuthorityProjectId: string | null;
  retirementBlocker: "gateway_update_required" | "gateway_online_required" | null;
};

export type WorkspaceGatewayRepairPlan = {
  availableProjects: number;
  totalProjects: number;
  unavailableProjects: number;
  nodes: readonly WorkspaceGatewayRepairNode[];
};

// gateway.retire first shipped in this signed Gateway release. Older Gateways
// reject the unknown command before journaling, so they cannot return a signed
// failure. Keep this compatibility floor client-side instead of changing the
// MLP version: the wire operation remains additive, while mixed-version clients
// fail closed before creating an action that the selected authority cannot end.
export const GATEWAY_RETIRE_MINIMUM_BUILD =
  "gateway-2026.09.03-081840Z-44d8e8a";

const TIMESTAMPED_GATEWAY_BUILD =
  /^gateway-(\d{4}\.\d{2}\.\d{2}-\d{6}Z)-[0-9a-f]{7,64}$/u;

export function gatewayBuildSupportsWorkspaceRetirement(
  buildId: string | undefined,
): boolean {
  if (!buildId) return false;
  if (buildId === GATEWAY_RETIRE_MINIMUM_BUILD) return true;
  const candidate = TIMESTAMPED_GATEWAY_BUILD.exec(buildId)?.[1];
  const minimum = TIMESTAMPED_GATEWAY_BUILD.exec(
    GATEWAY_RETIRE_MINIMUM_BUILD,
  )?.[1];
  return candidate !== undefined && minimum !== undefined && candidate > minimum;
}

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
    const onlineAuthorities = directory.directory.gateways
      .filter(candidate =>
        candidate.gatewayNodeId !== gateway.gatewayNodeId &&
        onlineGatewayNodeIds.has(candidate.gatewayNodeId)
      )
      .filter(candidate => (candidate.projects ?? []).some(project =>
        availableProjectIds.has(project.projectId)
      ));
    const authority = onlineAuthorities
      .filter(candidate => gatewayBuildSupportsWorkspaceRetirement(candidate.buildId))
      .flatMap(candidate => candidate.projects ?? [])
      .find(project => availableProjectIds.has(project.projectId))?.projectId ?? null;
    return {
      gatewayNodeId: gateway.gatewayNodeId,
      projectIds,
      availableProjectIds: available,
      unavailableProjectIds: unavailable,
      retirementAuthorityProjectId: authority,
      retirementBlocker: authority
        ? null
        : onlineAuthorities.length > 0
          ? "gateway_update_required" as const
          : "gateway_online_required" as const,
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
