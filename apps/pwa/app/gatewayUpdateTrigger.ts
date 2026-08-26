import type {
  GatewayUpdateStatus,
  SignedWorkspaceGatewayDirectory,
} from "@malink/protocol";
import type { GatewayReleaseBuild } from "./buildInfo";

export type AutomaticGatewayUpdateTarget = {
  gatewayNodeId: string;
  gatewayName: string;
  currentBuildId: string;
  targetProjectId: string;
};

export type AutomaticGatewayUpdateCommand =
  | { operation: "gateway.update.stage"; releaseId: string }
  | {
      operation: "gateway.update.apply";
      releaseId: string;
      mode: "when_idle";
    };

type AttemptStorage = Pick<Storage, "getItem" | "setItem">;

const ATTEMPT_KEY_PREFIX = "malink:gateway-update-attempt:v1:";

export function automaticGatewayUpdateTargets(input: {
  directory: SignedWorkspaceGatewayDirectory | undefined;
  knownProjectIds: ReadonlySet<string>;
  release: GatewayReleaseBuild | null;
}): AutomaticGatewayUpdateTarget[] {
  if (!input.directory || !input.release) return [];
  return input.directory.directory.gateways.flatMap((gateway) => {
    if (
      gateway.onlineUpdate !== true ||
      !gateway.buildId ||
      gateway.buildId === input.release?.buildId
    ) return [];
    const route = (gateway.projects ?? []).find((candidate) =>
      input.knownProjectIds.has(candidate.projectId),
    );
    if (!route) return [];
    return [{
      gatewayNodeId: gateway.gatewayNodeId,
      gatewayName: gateway.gatewayName,
      currentBuildId: gateway.buildId,
      targetProjectId: route.projectId,
    }];
  });
}

export function hasAttemptedAutomaticGatewayUpdate(
  storage: AttemptStorage,
  gatewayNodeId: string,
  release: GatewayReleaseBuild,
): boolean {
  try {
    return storage.getItem(attemptStorageKey(gatewayNodeId)) === attemptValue(release);
  } catch {
    return false;
  }
}

export function recordAutomaticGatewayUpdateAttempt(
  storage: AttemptStorage,
  gatewayNodeId: string,
  release: GatewayReleaseBuild,
): void {
  try {
    storage.setItem(attemptStorageKey(gatewayNodeId), attemptValue(release));
  } catch {
    // The caller retains a page-lifetime attempt guard when storage is unavailable.
  }
}

export async function triggerAutomaticGatewayUpdate(input: {
  release: GatewayReleaseBuild;
  target: AutomaticGatewayUpdateTarget;
  send(
    command: AutomaticGatewayUpdateCommand,
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
        `(reported ${staged.phase}).`,
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

function attemptStorageKey(gatewayNodeId: string): string {
  return `${ATTEMPT_KEY_PREFIX}${gatewayNodeId}`;
}

function attemptValue(release: GatewayReleaseBuild): string {
  return JSON.stringify(release);
}
