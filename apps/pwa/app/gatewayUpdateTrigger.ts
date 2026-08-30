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

type GatewayMaintenanceSessionReference = {
  gatewayNodeId: string;
  maintenanceSessionId?: string;
};

type ProjectedGatewayMaintenanceSession = {
  id: string;
  projectId: string;
};

type LegacyGatewayMaintenanceSession = ProjectedGatewayMaintenanceSession & {
  status: string;
  updatedAt: number;
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

/**
 * Detect maintenance IDs that cannot safely identify one Gateway session.
 *
 * Gateways released before node-scoped update identities derived this value
 * from the shared Workspace ID. Keep their updates running, but never let the
 * client open an arbitrary same-ID session from another project.
 */
export function collidingGatewayMaintenanceSessionIds(input: {
  nodeSessions: readonly GatewayMaintenanceSessionReference[];
  projectedSessions: readonly ProjectedGatewayMaintenanceSession[];
}): ReadonlySet<string> {
  const collisions = new Set<string>();
  const workspaceHasMultipleNodes = new Set(
    input.nodeSessions.map(reference => reference.gatewayNodeId),
  ).size > 1;
  const nodesBySession = new Map<string, Set<string>>();
  for (const reference of input.nodeSessions) {
    if (!reference.maintenanceSessionId) continue;
    if (
      workspaceHasMultipleNodes &&
      reference.maintenanceSessionId.startsWith("gateway-update-") &&
      !reference.maintenanceSessionId.startsWith("gateway-update-node-")
    ) {
      collisions.add(reference.maintenanceSessionId);
    }
    const nodes = nodesBySession.get(reference.maintenanceSessionId) ?? new Set<string>();
    nodes.add(reference.gatewayNodeId);
    nodesBySession.set(reference.maintenanceSessionId, nodes);
  }
  const projectsBySession = new Map<string, Set<string>>();
  for (const session of input.projectedSessions) {
    const projects = projectsBySession.get(session.id) ?? new Set<string>();
    projects.add(session.projectId);
    projectsBySession.set(session.id, projects);
  }
  for (const [sessionId, nodes] of nodesBySession) {
    if (nodes.size > 1) collisions.add(sessionId);
  }
  for (const [sessionId, projects] of projectsBySession) {
    if (projects.size > 1) collisions.add(sessionId);
  }
  return collisions;
}

/**
 * Select one legacy, Workspace-scoped maintenance session per Gateway.
 *
 * These sessions belong to an older release than the one currently offered by
 * the static channel, so they must not occupy `maintenanceSessionId` or hide
 * the new release action. Active sessions are offered for cleanup first; once
 * one converges to archived, the next legacy collision becomes visible.
 */
export function legacyGatewayMaintenanceSessionsByNode(input: {
  nodes: readonly {
    gatewayNodeId: string;
    targetProjectId?: string;
  }[];
  projectedSessions: readonly LegacyGatewayMaintenanceSession[];
}): ReadonlyMap<string, LegacyGatewayMaintenanceSession> {
  const collisions = collidingGatewayMaintenanceSessionIds({
    nodeSessions: [],
    projectedSessions: input.projectedSessions,
  });
  const selected = new Map<string, LegacyGatewayMaintenanceSession>();
  for (const node of input.nodes) {
    if (!node.targetProjectId) continue;
    const candidate = input.projectedSessions
      .filter(session =>
        session.projectId === node.targetProjectId &&
        session.id.startsWith("gateway-update-") &&
        !session.id.startsWith("gateway-update-node-") &&
        collisions.has(session.id),
      )
      .sort((left, right) =>
        Number(left.status === "archived") - Number(right.status === "archived") ||
        right.updatedAt - left.updatedAt,
      )[0];
    if (candidate) selected.set(node.gatewayNodeId, candidate);
  }
  return selected;
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
