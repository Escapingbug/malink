import type { GatewayCapabilities, GatewayWorkspaceState } from "./gatewayState";
import type { GatewayProjectOwner } from "./projectCatalog";

export type ProviderHistoryRouteIdentity = {
  gatewayNodeId: string;
  projectId: string;
};

export type ProviderHistorySource = ProviderHistoryRouteIdentity & {
  key: string;
  gatewayLabel: string;
  projectName: string;
  cwd: string;
};

export type ProviderHistoryRequestIdentity = ProviderHistoryRouteIdentity & {
  provider: string;
  kind: "sessions" | "session";
  providerSessionId?: string;
};

export function providerHistorySourceKey(
  source: ProviderHistoryRouteIdentity,
): string {
  return JSON.stringify([source.gatewayNodeId, source.projectId]);
}

export function providerHistoryRequestKey(
  source: ProviderHistoryRouteIdentity,
  provider: string,
): string {
  return `${providerHistorySourceKey(source)}\u0000${provider}`;
}

export function buildProviderHistorySources(input: {
  workspaces: readonly GatewayWorkspaceState[];
  projectOwners: ReadonlyMap<string, GatewayProjectOwner>;
  fallbackOwner: GatewayProjectOwner;
  fallbackCapabilities: GatewayCapabilities;
  directoryAvailable: boolean;
}): ProviderHistorySource[] {
  return input.workspaces
    .flatMap((workspace): ProviderHistorySource[] => {
      const supportsHistory = (workspace.capabilities ?? input.fallbackCapabilities)
        .providers.some(provider =>
          provider.canListSessions && provider.canInspectSessions
        );
      if (!supportsHistory) return [];
      const explicitOwner = input.projectOwners.get(workspace.projectId);
      if (input.directoryAvailable && !explicitOwner) return [];
      const owner = explicitOwner ?? input.fallbackOwner;
      const identity = {
        gatewayNodeId: owner.gatewayNodeId,
        projectId: workspace.projectId,
      };
      return [{
        ...identity,
        key: providerHistorySourceKey(identity),
        gatewayLabel: owner.label,
        projectName: workspace.projectName,
        cwd: workspace.cwd,
      }];
    })
    .sort((left, right) =>
      left.gatewayLabel.localeCompare(right.gatewayLabel)
      || left.projectName.localeCompare(right.projectName)
      || left.cwd.localeCompare(right.cwd)
      || left.projectId.localeCompare(right.projectId)
    );
}

export function findProviderHistorySource(
  sources: readonly ProviderHistorySource[],
  identity: ProviderHistoryRouteIdentity | null | undefined,
): ProviderHistorySource | null {
  if (!identity) return null;
  return sources.find(source =>
    source.gatewayNodeId === identity.gatewayNodeId
    && source.projectId === identity.projectId
  ) ?? null;
}

export function findProviderHistorySourceByKey(
  sources: readonly ProviderHistorySource[],
  key: string | null | undefined,
): ProviderHistorySource | null {
  if (!key) return null;
  return sources.find(source => source.key === key) ?? null;
}

export function firstMatchingProviderHistorySource(
  sources: readonly ProviderHistorySource[],
  candidates: readonly (ProviderHistoryRouteIdentity | null | undefined)[],
): ProviderHistorySource | null {
  for (const candidate of candidates) {
    const source = findProviderHistorySource(sources, candidate);
    if (source) return source;
  }
  return sources[0] ?? null;
}

export function providerHistoryRequestMatches(
  left: ProviderHistoryRequestIdentity,
  right: ProviderHistoryRequestIdentity,
): boolean {
  return left.gatewayNodeId === right.gatewayNodeId
    && left.projectId === right.projectId
    && left.provider === right.provider
    && left.kind === right.kind
    && left.providerSessionId === right.providerSessionId;
}
