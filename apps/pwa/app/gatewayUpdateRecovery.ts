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
      kind: "report" | "repair" | "wait";
      explanation: string;
    };

const TRANSIENT_FAILURE = /(?:\bHTTP (?:408|425|429|5\d\d)\b|fetch failed|network(?:error| request)?|timed out|timeout|socket hang up|connection (?:reset|refused)|temporar(?:y|ily)|rate.?limit|too many requests|service unavailable)/iu;

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
  if (!status || status.phase === "idle") {
    return {
      kind: "start",
      label: "Update Gateway",
      busyLabel: "Starting update…",
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
    ["committed", "rolled_back", "failed"].includes(status.phase)
  ) {
    return {
      kind: "start",
      label: "Update to new release",
      busyLabel: "Starting new release…",
      explanation: "A different signed release is now available, so this is a new attempt rather than a repeat of the earlier result.",
    };
  }
  if (status.phase === "staged") {
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
