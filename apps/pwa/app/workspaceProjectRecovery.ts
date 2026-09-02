import type {
  GatewaySessionSummary,
  GatewayStateSnapshot,
  GatewayWorkspaceState,
} from "./gatewayState";

export type WorkspaceProjectRecovery = {
  loaded: number;
  total: number;
  missingProjectIds: readonly string[];
};

/**
 * A connected primary Matrix room does not imply that every project room in
 * the signed Workspace directory has restored its local projection yet.
 */
export function workspaceProjectRecovery(
  state: GatewayStateSnapshot,
): WorkspaceProjectRecovery | null {
  const expectedProjectIds = workspaceDirectoryProjectIds(state);
  if (expectedProjectIds.size === 0) return null;

  const loadedProjectIds = new Set([
    state.workspace.projectId,
    ...(state.projects ?? []).map(project => project.projectId),
  ]);
  const missingProjectIds = [...expectedProjectIds]
    .filter(projectId => !loadedProjectIds.has(projectId))
    .sort();
  if (missingProjectIds.length === 0) return null;

  return {
    loaded: expectedProjectIds.size - missingProjectIds.length,
    total: expectedProjectIds.size,
    missingProjectIds,
  };
}

/**
 * Keep authenticated project/session rows from the last complete UI snapshot
 * while the current transport is still restoring those signed project routes.
 * Projects removed from the latest directory are never retained.
 */
export function preserveProjectsDuringRecovery(
  previous: GatewayStateSnapshot | null,
  incoming: GatewayStateSnapshot,
): GatewayStateSnapshot {
  const recovery = workspaceProjectRecovery(incoming);
  if (!previous || !recovery) return incoming;

  const missing = new Set(recovery.missingProjectIds);
  const preservedProjects = allProjects(previous).filter(project =>
    missing.has(project.projectId)
  );
  const preservedSessions = previous.sessions.filter(session =>
    missing.has(session.projectId)
  );
  if (preservedProjects.length === 0 && preservedSessions.length === 0) {
    return incoming;
  }

  return {
    ...incoming,
    projects: mergeProjects(allProjects(incoming), preservedProjects),
    sessions: mergeSessions(incoming.sessions, preservedSessions),
  };
}

function workspaceDirectoryProjectIds(
  state: GatewayStateSnapshot,
): Set<string> {
  return new Set(
    state.gatewayDirectory?.directory.gateways.flatMap(gateway =>
      (gateway.projects ?? []).map(project => project.projectId)
    ) ?? [],
  );
}

function allProjects(state: GatewayStateSnapshot): GatewayWorkspaceState[] {
  const projects = state.projects ?? [];
  return mergeProjects([state.workspace], projects);
}

function mergeProjects(
  primary: readonly GatewayWorkspaceState[],
  fallback: readonly GatewayWorkspaceState[],
): GatewayWorkspaceState[] {
  const merged = new Map<string, GatewayWorkspaceState>();
  for (const project of fallback) merged.set(project.projectId, project);
  for (const project of primary) merged.set(project.projectId, project);
  return [...merged.values()];
}

function mergeSessions(
  primary: readonly GatewaySessionSummary[],
  fallback: readonly GatewaySessionSummary[],
): GatewaySessionSummary[] {
  const merged = new Map<string, GatewaySessionSummary>();
  for (const session of fallback) merged.set(sessionKey(session), session);
  for (const session of primary) merged.set(sessionKey(session), session);
  return [...merged.values()];
}

function sessionKey(session: GatewaySessionSummary): string {
  return `${session.projectId}\u0000${session.id}`;
}
