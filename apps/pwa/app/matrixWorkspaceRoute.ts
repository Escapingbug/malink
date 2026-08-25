export interface MatrixWorkspaceRouteRoom {
  getMyMembership(): string | null;
}

/** An invited Matrix room already has a Room object, but is not usable until joined. */
export function workspaceRouteNeedsJoin(
  room: MatrixWorkspaceRouteRoom | null,
): boolean {
  return room?.getMyMembership() !== "join";
}
