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
  /** Signed descriptor time for the advertised build on this exact node. */
  buildObservedAt?: number;
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
      mode: "when_idle" | "force";
      allowForwardOnly?: true;
    };

/**
 * A signed supervisor transition is sufficient to advance the client-side
 * update chain even when the command-result copy is delayed in Matrix or the
 * native outbox. The command itself remains durable and is still released
 * when its terminal result arrives; this boundary only prevents presentation
 * and the next idempotent update step from being held behind duplicate
 * delivery of the same authenticated state.
 */
export function gatewayUpdateCommandReachedSignedBoundary(input: {
  command: GatewayUpdateCommand;
  status: GatewayUpdateStatus | undefined;
  baseline: GatewayUpdateStatus | undefined;
}): boolean {
  const { command, status, baseline } = input;
  if (!status || status.releaseId !== command.releaseId) return false;
  if (sameGatewayUpdateStatus(status, baseline)) return false;
  const phases: ReadonlySet<GatewayUpdateStatus["phase"]> =
    command.operation === "gateway.update.stage"
      ? STAGE_SIGNED_BOUNDARY_PHASES
      : APPLY_SIGNED_BOUNDARY_PHASES;
  return phases.has(status.phase);
}

const STAGE_SIGNED_BOUNDARY_PHASES = new Set<GatewayUpdateStatus["phase"]>([
  "staged",
  "waiting_for_idle",
  "scheduled",
  "activating",
  "probation",
  "committed",
  "rolled_back",
  "failed",
  "repair_required",
]);

const APPLY_SIGNED_BOUNDARY_PHASES = new Set<GatewayUpdateStatus["phase"]>([
  "waiting_for_idle",
  "scheduled",
  "activating",
  "probation",
  "committed",
  "rolled_back",
  "failed",
  "repair_required",
]);

function sameGatewayUpdateStatus(
  left: GatewayUpdateStatus,
  right: GatewayUpdateStatus | undefined,
): boolean {
  return right !== undefined &&
    left.phase === right.phase &&
    left.updateId === right.updateId &&
    left.releaseId === right.releaseId &&
    left.targetBuildId === right.targetBuildId &&
    left.currentBuildId === right.currentBuildId &&
    left.updatedAt === right.updatedAt;
}

const FORWARD_ONLY_STAGED = /Forward-only update staged\./u;

export class GatewayUpdateCommandFailure extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "GatewayUpdateCommandFailure";
  }
}

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
      ...(gateway.buildId ? { buildObservedAt: gateway.issuedAt } : {}),
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
 * A directory build is a durable discovery hint. Once the named Gateway has
 * answered a signed live-status command, its supervisor-observed installed
 * build is authoritative for that checked point in time.
 */
export function gatewayUpdatePlanNodeWithLiveStatus(input: {
  node: GatewayUpdatePlanNode;
  release: GatewayReleaseBuild;
  status: GatewayUpdateStatus | undefined;
}): GatewayUpdatePlanNode {
  if (
    input.node.buildObservedAt !== undefined &&
    input.status !== undefined &&
    input.node.buildObservedAt > input.status.updatedAt
  ) {
    return input.node;
  }
  const currentBuildId = input.status?.currentBuildId;
  if (!currentBuildId) return input.node;
  const state = currentBuildId === input.release.buildId
    ? "current"
    : !input.node.onlineUpdate
      ? "manual"
      : !input.node.targetProjectId
        ? "unrouted"
        : "available";
  return {
    ...input.node,
    currentBuildId,
    state,
  };
}

/**
 * Merge supervisor observations for one physical Gateway without allowing a
 * delayed Matrix command result to roll a newer pushed transition backwards.
 * `updatedAt` is produced by the same node-local supervisor; phase order is a
 * deterministic tie-breaker for transitions written in the same millisecond.
 */
export function latestGatewayUpdateStatus(
  current: GatewayUpdateStatus | undefined,
  incoming: GatewayUpdateStatus,
): GatewayUpdateStatus {
  if (!current) return incoming;
  if (incoming.updatedAt > current.updatedAt) return incoming;
  if (incoming.updatedAt < current.updatedAt) return current;
  if (
    incoming.updateId !== current.updateId ||
    incoming.releaseId !== current.releaseId
  ) {
    return incoming;
  }
  return gatewayUpdatePhaseOrder(incoming.phase) >= gatewayUpdatePhaseOrder(current.phase)
    ? incoming
    : current;
}

function gatewayUpdatePhaseOrder(phase: GatewayUpdateStatus["phase"]): number {
  switch (phase) {
    case "idle": return 0;
    case "staging": return 1;
    case "agent_required": return 2;
    case "agent_running": return 3;
    case "agent_validating": return 4;
    case "staged": return 5;
    case "waiting_for_idle": return 6;
    case "scheduled": return 7;
    case "activating": return 8;
    case "probation": return 9;
    case "committed":
    case "rolled_back":
    case "failed":
    case "repair_required":
      return 10;
  }
}

/**
 * Maintenance sessions remain part of the signed update transaction until the
 * supervisor has reached a terminal, non-retryable state. Archiving one while
 * an Agent is running cancels its prompt; archiving a failed attempt prevents
 * a same-release retry from reopening the deterministic session identity.
 */
export function gatewayMaintenanceSessionCanBeArchived(
  status: GatewayUpdateStatus | undefined,
): boolean {
  if (!status) return false;
  if ([
    "idle",
    "committed",
    "rolled_back",
  ].includes(status.phase)) return true;
  return status.phase === "failed" && !/(?:\bHTTP (?:408|425|429|5\d\d)\b|fetch failed|network(?:error| request)?|timed out|timeout|socket hang up|connection (?:reset|refused)|temporar(?:y|ily)|rate.?limit|too many requests|service unavailable)/iu
    .test(status.detail ?? "");
}

export function gatewayMaintenanceSessionShouldAutoArchive(input: {
  status: GatewayUpdateStatus | undefined;
  maintenanceSessionId: string;
}): boolean {
  const status = input.status;
  return status !== undefined &&
    status.maintenanceSessionId === input.maintenanceSessionId &&
    ["committed", "rolled_back"].includes(status.phase);
}

/**
 * Bind one automatic cleanup attempt to one signed supervisor snapshot.
 *
 * The key is intentionally stable across React projection changes. A failed
 * lifecycle command must not turn a stale terminal snapshot into an unbounded
 * Matrix command loop; a newer signed status produces a different key and may
 * make one fresh best-effort attempt.
 */
export function gatewayMaintenanceAutoArchiveAttemptKey(input: {
  gatewayNodeId: string;
  projectId: string;
  maintenanceSessionId: string;
  status: GatewayUpdateStatus | undefined;
}): string | null {
  if (!gatewayMaintenanceSessionShouldAutoArchive({
    status: input.status,
    maintenanceSessionId: input.maintenanceSessionId,
  })) return null;
  const status = input.status!;
  return [
    input.gatewayNodeId,
    input.projectId,
    input.maintenanceSessionId,
    status.updateId ?? "",
    status.releaseId ?? "",
    status.updatedAt.toString(),
  ].join("\0");
}

export function gatewayUpdateCanApplyStaged(input: {
  status: GatewayUpdateStatus | undefined;
}): boolean {
  return input.status?.phase === "staged" &&
    Boolean(input.status.releaseId) &&
    Boolean(input.status.targetBuildId) &&
    !gatewayUpdateRequiresForwardOnlyConfirmation(input.status);
}

export function gatewayUpdateRequiresForwardOnlyConfirmation(
  status: GatewayUpdateStatus | undefined,
): boolean {
  return status?.phase === "staged" && (
    status.activationMode === "forward-only" || FORWARD_ONLY_STAGED.test(status.detail ?? "")
  );
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
  const nodesBySession = new Map<string, Set<string>>();
  for (const reference of input.nodeSessions) {
    if (!reference.maintenanceSessionId) continue;
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
  allowForwardOnly?: boolean;
  mode?: "when_idle" | "force";
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
  if (gatewayUpdateRequiresForwardOnlyConfirmation(staged) && !input.allowForwardOnly) {
    return staged;
  }
  return input.send({
    operation: "gateway.update.apply",
    releaseId: input.release.releaseId,
    // `when_idle` is the stable wire name. The Gateway closes its execution
    // gate immediately, drains only work that was already running, and leaves
    // later commands durably queued for the replacement process.
    mode: input.mode ?? "when_idle",
    ...(input.allowForwardOnly ? { allowForwardOnly: true as const } : {}),
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
