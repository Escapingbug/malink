import type { GatewayUpdateStatus } from "@malink/protocol";
import type { GatewayReleaseBuild } from "./buildInfo";

export type GatewayUpdateRecoveryAction =
  | {
      kind: "start" | "continue" | "retry";
      label: string;
      busyLabel: string;
      explanation: string;
    }
  | {
      kind: "external" | "report" | "repair" | "wait";
      explanation: string;
    };

const TRANSIENT_FAILURE = /(?:\bHTTP (?:408|425|429|5\d\d)\b|fetch failed|network(?:error| request)?|timed out|timeout|socket hang up|connection (?:reset|refused)|temporar(?:y|ily)|rate.?limit|too many requests|service unavailable)/iu;
const EXTERNAL_MAINTENANCE_REQUIRED = /(?:introduces protected state|changes protected state).*automatic rollback is unsafe/iu;
const FORWARD_ONLY_STAGED = /Forward-only update staged\./u;

/**
 * Decides whether repeating an update can change the result. Deterministic
 * publication, signature, compatibility, and local integrity failures never
 * expose a retry action; transient transport failures do, after the
 * supervisor's bounded automatic retries have already been exhausted.
 */
export function gatewayUpdateRecoveryAction(input: {
  status: GatewayUpdateStatus | undefined;
  release: GatewayReleaseBuild;
  commandFailure?: { code?: string; retryable?: boolean };
}): GatewayUpdateRecoveryAction {
  const { status, release, commandFailure } = input;
  if (!status && commandFailure?.code) {
    if (commandFailure.retryable === true) {
      return {
        kind: "retry",
        label: "Try update again",
        busyLabel: "Trying update again…",
        explanation: "The update request ended with a temporary failure. Trying later can succeed.",
      };
    }
    return {
      kind: "report",
      explanation: "The Gateway rejected this update request as non-retryable. Repeating it cannot change the result; export diagnostics and report the failure.",
    };
  }
  if (!status || status.phase === "idle") {
    return {
      kind: "start",
      label: "Update when idle",
      busyLabel: "Preparing update…",
      explanation: "Create one maintenance session and complete the update in the background.",
    };
  }
  const publishedReleaseChanged = Boolean(
    status.releaseId && status.releaseId !== release.releaseId,
  ) || Boolean(
    status.targetBuildId && status.targetBuildId !== release.buildId,
  );
  if (
    publishedReleaseChanged &&
    ["staged", "committed", "rolled_back", "failed"].includes(status.phase)
  ) {
    return {
      kind: "start",
      label: "Prepare latest update",
      busyLabel: "Preparing latest update…",
      explanation: "A newer signed release is available. Preparing it replaces the older checkpoint without installing the older build.",
    };
  }
  if (status.phase === "staged") {
    if (
      status.activationMode === "forward-only" ||
      FORWARD_ONLY_STAGED.test(status.detail ?? "")
    ) {
      return {
        kind: "continue",
        label: "Confirm forward-only update",
        busyLabel: "Confirming forward-only update…",
        explanation: "This protected-state update will stop the Gateway, create and verify a local backup, and start the new release without automatic binary rollback. Continue only when local recovery access to the Gateway Mac is available.",
      };
    }
    return {
      kind: "continue",
      label: "Continue update",
      busyLabel: "Continuing update…",
      explanation: "This older Gateway already prepared the release; continue from that safe checkpoint.",
    };
  }
  if (status.phase === "repair_required") {
    return {
      kind: "repair",
      explanation: "The supervisor cannot prove activation or rollback healthy. Repeating the update cannot repair that local state.",
    };
  }
  if (status.phase === "rolled_back") {
    return {
      kind: "report",
      explanation: "The target build failed health verification and the previous build was restored. Repeating the same release is unsafe; report the release failure.",
    };
  }
  if (status.phase === "failed") {
    if (EXTERNAL_MAINTENANCE_REQUIRED.test(status.detail ?? "")) {
      return {
        kind: "external",
        explanation: "This release changes protected Gateway data. The current build is still running and its data was not migrated, but this supervisor cannot install the release safely. Retrying cannot succeed; finish active work, then perform the release from the Gateway Mac with a verified backup and local recovery access.",
      };
    }
    const transient = commandFailure?.retryable === true ||
      (commandFailure?.retryable !== false && TRANSIENT_FAILURE.test(status.detail ?? ""));
    if (transient) {
      return {
        kind: "retry",
        label: "Try update again",
        busyLabel: "Trying update again…",
        explanation: "The supervisor exhausted its automatic retries on a temporary network or service failure. Trying later can succeed.",
      };
    }
    return {
      kind: "report",
      explanation: "Repeating the same release would reproduce this failure. Export diagnostics and report the release or Gateway bug.",
    };
  }
  if ([
    "staging",
    "agent_required",
    "agent_running",
    "agent_validating",
    "waiting_for_idle",
    "scheduled",
    "activating",
    "probation",
  ].includes(status.phase)) {
    return {
      kind: "wait",
      explanation: "This update is already running and will continue without another command.",
    };
  }
  return {
    kind: "wait",
    explanation: status.phase === "committed"
      ? "The update is complete. Its maintenance session will be archived automatically."
      : "No update action is needed.",
  };
}
