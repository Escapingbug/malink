export function bulkGroupSessions<T extends { projectId: string; scope?: string }>(
  sessions: readonly T[],
  group: { projectId: string; temporary: boolean; gatewayNodeId: string },
  ownerNode: (session: T) => string,
): T[] {
  return sessions.filter(session => group.temporary
    ? session.scope === "scratch" && ownerNode(session) === group.gatewayNodeId
    : session.scope !== "scratch" && session.projectId === group.projectId);
}

export function bulkArchiveEligible(status: string, protectedRepair: boolean, lifecycleBusy: boolean): boolean {
  return status !== "running" && status !== "stopping" && status !== "archived" &&
    !protectedRepair && !lifecycleBusy;
}
