export const ALL_GATEWAYS_FILTER = "";

const GATEWAY_FILTER_STORAGE_PREFIX = "malink.ui.gateway-filter.v1";
const MAX_GATEWAY_NODE_ID_LENGTH = 512;

export type GatewayFilterStorageReader = Pick<Storage, "getItem">;
export type GatewayFilterStorageWriter = Pick<Storage, "removeItem" | "setItem">;

type ProjectGatewayOwner = {
  gatewayNodeId: string;
};

export function readGatewayFilter(
  storage: GatewayFilterStorageReader | null | undefined,
  workspaceId: string,
): string {
  if (!storage || !workspaceId.trim()) return ALL_GATEWAYS_FILTER;
  try {
    const value = storage.getItem(gatewayFilterStorageKey(workspaceId));
    return value && value.length <= MAX_GATEWAY_NODE_ID_LENGTH
      ? value
      : ALL_GATEWAYS_FILTER;
  } catch {
    return ALL_GATEWAYS_FILTER;
  }
}

export function writeGatewayFilter(
  storage: GatewayFilterStorageWriter,
  workspaceId: string,
  gatewayNodeId: string,
): void {
  if (!workspaceId.trim()) return;
  const key = gatewayFilterStorageKey(workspaceId);
  if (gatewayNodeId === ALL_GATEWAYS_FILTER) {
    storage.removeItem(key);
    return;
  }
  if (gatewayNodeId.length > MAX_GATEWAY_NODE_ID_LENGTH) {
    throw new Error("Gateway filter identity is too long.");
  }
  storage.setItem(key, gatewayNodeId);
}

export function normalizeGatewayFilter(
  gatewayNodeId: string,
  availableGatewayNodeIds: readonly string[],
): string {
  return gatewayNodeId !== ALL_GATEWAYS_FILTER &&
      availableGatewayNodeIds.includes(gatewayNodeId)
    ? gatewayNodeId
    : ALL_GATEWAYS_FILTER;
}

export function projectMatchesGatewayFilter(
  gatewayNodeId: string,
  projectId: string,
  projectOwners: ReadonlyMap<string, ProjectGatewayOwner>,
  fallbackGatewayNodeId: string,
): boolean {
  if (gatewayNodeId === ALL_GATEWAYS_FILTER) return true;
  return (projectOwners.get(projectId)?.gatewayNodeId ?? fallbackGatewayNodeId) ===
    gatewayNodeId;
}

function gatewayFilterStorageKey(workspaceId: string): string {
  return `${GATEWAY_FILTER_STORAGE_PREFIX}:${encodeURIComponent(workspaceId)}`;
}
