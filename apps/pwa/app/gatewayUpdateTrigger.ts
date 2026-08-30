import type {
  GatewayUpdateStatus,
  SignedWorkspaceGatewayDirectory,
} from "@malink/protocol";
import type { GatewayReleaseBuild } from "./buildInfo";

export type GatewayUpdatePlanNode = {
  gatewayNodeId: string;
  gatewayName: string;
  computerName?: string;
  currentBuildId?: string;
  targetProjectId?: string;
  onlineUpdate: boolean;
  state: "current" | "available" | "manual" | "unrouted" | "unknown";
};

export type GatewayUpdateTarget = {
  gatewayNodeId: string;
  gatewayName: string;
  computerName?: string;
  currentBuildId: string;
  targetProjectId: string;
};

export type GatewayUpdateCommand =
  | { operation: "gateway.update.stage"; releaseId: string }
  | {
      operation: "gateway.update.apply";
      releaseId: string;
      mode: "when_idle";
    };

const AMBIGUOUS_STAGE_RECHECK_DELAYS_MS = [0, 500, 1_000, 2_000, 4_000, 8_000] as const;
const STAGE_IN_PROGRESS_PHASES = new Set<GatewayUpdateStatus["phase"]>([
  "idle",
  "staging",
  "agent_required",
  "agent_running",
  "agent_validating",
]);

/**
 * Build a node-level update plan from the signed Gateway Directory. This is
 * intentionally presentation-only: discovering a release must never mutate a
 * Gateway until the user confirms one exact node.
 */
export function gatewayUpdatePlan(input: {
  directory: SignedWorkspaceGatewayDirectory | undefined;
  knownProjectIds: ReadonlySet<string>;
  release: GatewayReleaseBuild | null;
}): GatewayUpdatePlanNode[] {
  if (!input.directory || !input.release) return [];
  const release = input.release;
  return input.directory.directory.gateways.map((gateway) => {
    const route = (gateway.projects ?? []).find((candidate) =>
      input.knownProjectIds.has(candidate.projectId),
    );
    const base = {
      gatewayNodeId: gateway.gatewayNodeId,
      gatewayName: gateway.gatewayName,
      ...(gateway.computerName ? { computerName: gateway.computerName } : {}),
      ...(gateway.buildId ? { currentBuildId: gateway.buildId } : {}),
      ...(route ? { targetProjectId: route.projectId } : {}),
      onlineUpdate: gateway.onlineUpdate === true,
    };
    if (gateway.buildId === release.buildId) {
      return { ...base, state: "current" as const };
    }
    if (!gateway.buildId) return { ...base, state: "unknown" as const };
    if (gateway.onlineUpdate !== true) {
      return { ...base, state: "manual" as const };
    }
    if (!route) return { ...base, state: "unrouted" as const };
    return { ...base, state: "available" as const };
  });
}

export function gatewayUpdateTarget(
  node: GatewayUpdatePlanNode,
): GatewayUpdateTarget | null {
  if (
    !node.onlineUpdate ||
    !node.currentBuildId ||
    !node.targetProjectId
  ) return null;
  return {
    gatewayNodeId: node.gatewayNodeId,
    gatewayName: node.gatewayName,
    ...(node.computerName ? { computerName: node.computerName } : {}),
    currentBuildId: node.currentBuildId,
    targetProjectId: node.targetProjectId,
  };
}

export async function triggerGatewayUpdate(input: {
  release: GatewayReleaseBuild;
  target: GatewayUpdateTarget;
  send(
    command: GatewayUpdateCommand,
    targetProjectId: string,
  ): Promise<GatewayUpdateStatus>;
}): Promise<GatewayUpdateStatus> {
  const staged = await input.send({
    operation: "gateway.update.stage",
    releaseId: input.release.releaseId,
  }, input.target.targetProjectId);
  if (staged.phase !== "staged") {
    if (updateAlreadyScheduled(staged, input.release)) return staged;
    throw new Error(
      `Gateway ${input.target.gatewayName} did not stage release ${input.release.releaseId} ` +
        `(reported ${staged.phase})${staged.detail ? `: ${staged.detail}` : "."}`,
    );
  }
  if (
    staged.releaseId !== input.release.releaseId ||
    staged.targetBuildId !== input.release.buildId
  ) {
    throw new Error(
      `Gateway ${input.target.gatewayName} staged a different signed release.`,
    );
  }
  return input.send({
    operation: "gateway.update.apply",
    releaseId: input.release.releaseId,
    // `when_idle` is the stable wire name. The Gateway closes its execution
    // gate immediately, drains only work that was already running, and leaves
    // later commands durably queued for the replacement process.
    mode: "when_idle",
  }, input.target.targetProjectId);
}

/**
 * Older Gateways exposed the maintenance Agent's child turn.completed under
 * the parent gateway.update.stage command ID. A client could therefore see a
 * successful completion without the update-status result just before the real
 * terminal arrived. Recover only by issuing signed, read-only status checks;
 * never submit the stage operation a second time from this compatibility path.
 */
export async function recoverAmbiguousGatewayUpdateCompletion(input: {
  operation: GatewayUpdateCommand["operation"];
  releaseId: string;
  readStatus(): Promise<GatewayUpdateStatus>;
  wait?: (milliseconds: number) => Promise<void>;
  delaysMs?: readonly number[];
}): Promise<GatewayUpdateStatus> {
  const wait = input.wait ?? ((milliseconds: number) =>
    new Promise(resolve => globalThis.setTimeout(resolve, milliseconds)));
  const delays = input.delaysMs ?? AMBIGUOUS_STAGE_RECHECK_DELAYS_MS;
  let latest: GatewayUpdateStatus | null = null;
  for (const delayMs of delays) {
    if (delayMs > 0) await wait(delayMs);
    latest = await input.readStatus();
    if (input.operation !== "gateway.update.stage") return latest;
    const sameRelease = latest.releaseId === input.releaseId;
    if (!STAGE_IN_PROGRESS_PHASES.has(latest.phase)) return latest;
    if (latest.phase !== "idle" && !sameRelease) return latest;
  }
  throw new Error(
    latest?.detail ??
      "The maintenance Agent finished, but the Gateway update status has not settled yet. " +
        "Malink checked the signed status without repeating the update command. Try Update again shortly.",
  );
}

function updateAlreadyScheduled(
  status: GatewayUpdateStatus,
  release: GatewayReleaseBuild,
): boolean {
  return (
    status.releaseId === release.releaseId &&
    status.targetBuildId === release.buildId &&
    ["scheduled", "activating", "probation", "committed"].includes(status.phase)
  );
}
