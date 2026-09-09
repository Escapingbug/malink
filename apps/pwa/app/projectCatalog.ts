export type GatewayProjectSource = {
  projectId: string;
  projectName: string;
  cwd: string;
};

export type GatewayProjectOwner = {
  gatewayNodeId: string;
  gatewayName: string;
  computerName: string;
  shortId: string;
  label: string;
  deploymentLabel?: string;
};

type GatewayDirectorySource = {
  gatewayNodeId: string;
  gatewayName: string;
  computerName?: string;
  projects?: readonly { projectId: string }[];
};

export function gatewayProjectOwners(
  gateways: readonly GatewayDirectorySource[],
  observations: Record<string, { deployment: { active: { gatewayNodeId: string; buildId: string }; candidate?: { gatewayNodeId: string; buildId: string } } }> = {},
): Map<string, GatewayProjectOwner> {
  const owners = new Map<string, GatewayProjectOwner>();
  for (const gateway of gateways) {
    const owner = gatewayProjectOwner(
      gateway.gatewayNodeId,
      gateway.gatewayName,
      gateway.computerName,
    );
    for (const { deployment } of Object.values(observations)) {
      const candidate = deployment.candidate?.gatewayNodeId === gateway.gatewayNodeId;
      const slot = candidate ? deployment.candidate
        : deployment.active.gatewayNodeId === gateway.gatewayNodeId ? deployment.active : undefined;
      if (!slot) continue;
      owner.deploymentLabel = `${candidate ? "New Gateway" : deployment.candidate ? "Previous Gateway · recovery" : "Current Gateway"} · ${slot.buildId.replace(/^gateway-/, "")}`;
      owner.label += ` · ${owner.deploymentLabel}`;
      break;
    }
    for (const project of gateway.projects ?? []) owners.set(project.projectId, owner);
  }
  return owners;
}

export function gatewayProjectOwner(
  gatewayNodeId: string,
  gatewayName: string,
  computerNameInput?: string,
): GatewayProjectOwner {
  const shortId = gatewayNodeShortId(gatewayNodeId);
  const computerName = computerNameInput?.trim() || gatewayName;
  const label = gatewayName === computerName
    ? computerName
    : `${gatewayName} · ${computerName}`;
  return {
    gatewayNodeId,
    gatewayName,
    computerName,
    shortId,
    label,
  };
}

export function gatewayNodeShortId(gatewayNodeId: string): string {
  const compact = gatewayNodeId.replace(/[^A-Za-z0-9]/gu, "");
  return (compact || gatewayNodeId || "gateway").slice(-8).toUpperCase();
}

/**
 * A project is identified by its Gateway project ID (which is derived from
 * the working directory), not by a freely-entered display name. Build one
 * deterministic label per identity so session ordering and process restarts
 * cannot rename a project group on screen.
 */
export function canonicalGatewayProjects(
  workspace: GatewayProjectSource | null | undefined,
  sessions: readonly GatewayProjectSource[],
  knownProjects: readonly GatewayProjectSource[] = [],
): GatewayProjectSource[] {
  const projects = new Map<string, GatewayProjectSource>();
  for (const project of [...knownProjects].sort(compareProjectSources)) {
    projects.set(project.projectId, copyProject(project));
  }
  const orderedSessions = [...sessions].sort(compareProjectSources);
  for (const session of orderedSessions) {
    if (!projects.has(session.projectId)) {
      projects.set(session.projectId, copyProject(session));
    }
  }

  if (workspace) {
    // The authenticated Gateway workspace is the canonical source for its
    // own project, even when older sessions carry a historical alias.
    projects.set(workspace.projectId, copyProject(workspace));
  }

  const current = workspace ? projects.get(workspace.projectId) : undefined;
  const remaining = [...projects.values()]
    .filter((project) => project.projectId !== current?.projectId)
    .sort(compareProjectSources);
  return current ? [current, ...remaining] : remaining;
}

function compareProjectSources(
  left: GatewayProjectSource,
  right: GatewayProjectSource,
): number {
  return (
    left.projectName.localeCompare(right.projectName) ||
    left.cwd.localeCompare(right.cwd) ||
    left.projectId.localeCompare(right.projectId)
  );
}

function copyProject(project: GatewayProjectSource): GatewayProjectSource {
  return {
    projectId: project.projectId,
    projectName: project.projectName,
    cwd: project.cwd,
  };
}
