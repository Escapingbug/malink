interface GatewayRouteOwner {
  gatewayNodeId: string
  projects?: readonly { roomId: string }[]
}

/** Selects only the replaced Gateway node's rooms for candidate shadow input. */
export function deploymentSourceShadowRoomIds(
  gateways: readonly GatewayRouteOwner[],
  sourceGatewayNodeId: string,
  locallyOwnedRoomIds: readonly string[],
): string[] {
  if (!sourceGatewayNodeId.trim()) throw new TypeError('Source Gateway node ID is required')
  const source = gateways.find(gateway => gateway.gatewayNodeId === sourceGatewayNodeId)
  if (!source) throw new Error(`Source Gateway ${sourceGatewayNodeId} is unavailable`)
  const local = new Set(locallyOwnedRoomIds)
  const rooms = (source.projects ?? [])
    .map(project => project.roomId)
    .filter(roomId => !local.has(roomId))
  if (rooms.some(roomId => !roomId.trim()) || new Set(rooms).size !== rooms.length) {
    throw new Error('Source Gateway shadow rooms are invalid')
  }
  return rooms
}
