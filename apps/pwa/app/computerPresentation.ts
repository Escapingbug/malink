type Node = { gatewayNodeId: string };
type Deployment = { active: Node; candidate?: Node; recovery?: Node };

/** Presentation only. Never use this map to retarget an authenticated command. */
export function computerRepresentatives<T extends Node>(
  nodes: readonly T[], deployments: readonly Deployment[],
): T[] {
  const aliases = computerNodeAliases(nodes, deployments);
  return nodes.filter(node => aliases.get(node.gatewayNodeId) === node.gatewayNodeId);
}

export function computerNodeAliases(nodes: readonly Node[], deployments: readonly Deployment[]): Map<string, string> {
  const present = new Set(nodes.map(node => node.gatewayNodeId));
  const aliases = new Map(nodes.map(node => [node.gatewayNodeId, node.gatewayNodeId]));
  for (const deployment of deployments) {
    const members = [deployment.active, deployment.candidate, deployment.recovery].filter((node): node is Node => Boolean(node));
    const representative = members.find(node => present.has(node.gatewayNodeId));
    if (!representative) continue;
    for (const node of members) aliases.set(node.gatewayNodeId, representative.gatewayNodeId);
  }
  return aliases;
}
