import type { SignedWorkspaceGatewayDirectory } from "@malink/protocol";

// A Gateway publishes one shared heartbeat every 60 seconds. Allow one missed
// delivery under Matrix backpressure before presenting the proof as stale.
export const GATEWAY_ONLINE_PROOF_WINDOW_MS = 150_000;
// Matrix delivery, Gateway journal execution, and the signed reply are each
// asynchronous. Keep the UI deadline above the native HTTP send timeout so a
// healthy but delayed round trip is not reported as a Gateway fault.
export const GATEWAY_LIVE_STATUS_TIMEOUT_MS = 30_000;

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
  consecutiveNoReplies?: number;
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

export type GatewayNoReplyPresentation = {
  title: string;
  detail: string;
  persistent: boolean;
  retryLabel: string;
};

export function gatewayNoReplyPresentation(input: {
  gatewayLabel: string;
  consecutiveNoReplies: number | undefined;
}): GatewayNoReplyPresentation {
  const attempts = Math.max(1, input.consecutiveNoReplies ?? 1);
  if (attempts === 1) {
    return {
      title: "Gateway reply delayed",
      detail:
        `No signed reply arrived from ${input.gatewayLabel} within 30 seconds. ` +
        "The request remains attached to its durable command and can still complete in the background. This can be a temporary Matrix delay or a Gateway waking up. No update was started.",
      persistent: false,
      retryLabel: "Check again",
    };
  }
  return {
    title: "Gateway needs attention",
    detail:
      `${input.gatewayLabel} missed ${attempts} consecutive signed checks. ` +
      "Matrix accepted the requests, but Malink cannot verify that the Gateway process is healthy. Repeating the check alone will not repair a startup failure.",
    persistent: true,
    retryLabel: "Check again",
  };
}

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
        detail: "This Gateway returned a recent signed reply or activity event.",
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
    const noReply = gatewayNoReplyPresentation({
      gatewayLabel: "This Gateway",
      consecutiveNoReplies: current.consecutiveNoReplies,
    });
    return {
      state: "unreachable",
      label: noReply.title,
      detail: current.detail ?? noReply.detail,
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

/**
 * A timed-out status command cannot overrule newer signed activity from the
 * same Gateway. This prevents an active Agent reply from being followed by an
 * incorrect offline banner merely because the separate supervisor reply was
 * delayed in Matrix.
 */
export function gatewayNodeLivenessAfterProbeTimeout(input: {
  current: GatewayNodeLiveness;
  probeStartedAt: number;
  checkedAt: number;
  gatewayLabel: string;
}): GatewayNodeLiveness {
  if (
    input.current.lastVerifiedAt !== undefined &&
    input.current.lastVerifiedAt >= input.probeStartedAt
  ) {
    return {
      ...input.current,
      state: "online",
      consecutiveNoReplies: 0,
      detail: "Recent signed Gateway activity was received while the status check was pending.",
    };
  }
  const consecutiveNoReplies = (input.current.consecutiveNoReplies ?? 0) + 1;
  return {
    ...input.current,
    state: "unreachable",
    checkedAt: input.checkedAt,
    consecutiveNoReplies,
    detail: gatewayNoReplyPresentation({
      gatewayLabel: input.gatewayLabel,
      consecutiveNoReplies,
    }).detail,
  };
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
  const attention = input.gatewayNodeIds.filter((gatewayNodeId) => {
    const value = input.values[gatewayNodeId];
    return value?.state === "unreachable" && (value.consecutiveNoReplies ?? 1) >= 2;
  }).length;
  const timedOut = unreachable - attention;
  const checking = presentations.filter((value) => value.state === "checking").length;
  const unverified = presentations.length - online - unreachable - checking;
  const parts: string[] = [];
  if (online > 0) parts.push(`${online} online`);
  if (attention > 0) parts.push(`${attention} ${attention === 1 ? "needs" : "need"} attention`);
  if (timedOut > 0) parts.push(`${timedOut} ${timedOut === 1 ? "reply" : "replies"} delayed`);
  if (checking > 0) parts.push(`${checking} checking`);
  if (unverified > 0) parts.push(`${unverified} unverified`);
  return parts.join(" · ");
}
