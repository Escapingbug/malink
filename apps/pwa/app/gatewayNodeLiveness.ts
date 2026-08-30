import type { SignedWorkspaceGatewayDirectory } from "@malink/protocol";

export const GATEWAY_ONLINE_PROOF_WINDOW_MS = 90_000;
export const GATEWAY_AUTOMATIC_RECHECK_AFTER_MS = 2 * 60_000;

export type GatewayNodeLivenessState =
  | "unknown"
  | "checking"
  | "online"
  | "unreachable"
  | "unavailable";

export type GatewayNodeLiveness = {
  state: GatewayNodeLivenessState;
  checkedAt?: number;
  lastVerifiedAt?: number;
  detail?: string;
};

export type GatewayNodeLivenessTarget = {
  gatewayNodeId: string;
  gatewayName: string;
  computerName?: string;
  currentBuildId?: string;
  targetProjectId?: string;
  canProbe: boolean;
  unavailableReason?: "route" | "capability";
};

export type GatewayNodeLivenessPresentation = {
  state: "unknown" | "checking" | "online" | "stale" | "unreachable" | "unavailable";
  label: string;
  detail: string;
  canCheck: boolean;
};

export function gatewayNodeLivenessTargets(input: {
  directory: SignedWorkspaceGatewayDirectory | null | undefined;
  knownProjectIds: ReadonlySet<string>;
}): GatewayNodeLivenessTarget[] {
  return (input.directory?.directory.gateways ?? []).map((gateway) => {
    const route = (gateway.projects ?? []).find((candidate) =>
      input.knownProjectIds.has(candidate.projectId),
    );
    const canProbe = gateway.onlineUpdate === true && route !== undefined;
    return {
      gatewayNodeId: gateway.gatewayNodeId,
      gatewayName: gateway.gatewayName,
      ...(gateway.computerName ? { computerName: gateway.computerName } : {}),
      ...(gateway.buildId ? { currentBuildId: gateway.buildId } : {}),
      ...(route ? { targetProjectId: route.projectId } : {}),
      canProbe,
      ...(canProbe
        ? {}
        : { unavailableReason: route ? "capability" as const : "route" as const }),
    };
  });
}

export function gatewayNodeLivenessPresentation(
  value: GatewayNodeLiveness | undefined,
  now: number,
): GatewayNodeLivenessPresentation {
  const current = value ?? { state: "unknown" as const };
  if (current.state === "checking") {
    return {
      state: "checking",
      label: "Checking…",
      detail: "Waiting for this Gateway's signed reply.",
      canCheck: false,
    };
  }
  if (current.state === "online" && current.lastVerifiedAt !== undefined) {
    if (now - current.lastVerifiedAt <= GATEWAY_ONLINE_PROOF_WINDOW_MS) {
      return {
        state: "online",
        label: "Online now",
        detail: "This Gateway returned a recent signed reply.",
        canCheck: true,
      };
    }
    return {
      state: "stale",
      label: "Online status expired",
      detail: "The last signed reply is no longer recent enough to prove this Gateway is online now.",
      canCheck: true,
    };
  }
  if (current.state === "unreachable") {
    return {
      state: "unreachable",
      label: "Not responding",
      detail: current.detail ??
        "Matrix accepted the check, but this Gateway did not return a signed reply.",
      canCheck: true,
    };
  }
  if (current.state === "unavailable") {
    return {
      state: "unavailable",
      label: "Live check unavailable",
      detail: current.detail ??
        "This Gateway has no compatible signed status route from this client.",
      canCheck: false,
    };
  }
  return {
    state: "unknown",
    label: "Status not verified",
    detail: current.detail ?? "Run a signed live check to verify this Gateway.",
    canCheck: true,
  };
}

export function shouldAutomaticallyCheckGatewayNode(
  value: GatewayNodeLiveness | undefined,
  now: number,
): boolean {
  if (!value || value.state === "unknown") return true;
  if (value.state === "checking" || value.state === "unavailable") return false;
  return value.checkedAt === undefined ||
    now - value.checkedAt >= GATEWAY_AUTOMATIC_RECHECK_AFTER_MS;
}

export function gatewayNodeLivenessSummary(input: {
  gatewayNodeIds: readonly string[];
  values: Readonly<Record<string, GatewayNodeLiveness>>;
  now: number;
}): string {
  if (input.gatewayNodeIds.length === 0) return "No Gateway status available";
  const presentations = input.gatewayNodeIds.map((gatewayNodeId) =>
    gatewayNodeLivenessPresentation(input.values[gatewayNodeId], input.now),
  );
  const online = presentations.filter((value) => value.state === "online").length;
  const unreachable = presentations.filter((value) => value.state === "unreachable").length;
  const checking = presentations.filter((value) => value.state === "checking").length;
  const unverified = presentations.length - online - unreachable - checking;
  const parts: string[] = [];
  if (online > 0) parts.push(`${online} online`);
  if (unreachable > 0) parts.push(`${unreachable} not responding`);
  if (checking > 0) parts.push(`${checking} checking`);
  if (unverified > 0) parts.push(`${unverified} unverified`);
  return parts.join(" · ");
}
