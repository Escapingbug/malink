const GENERIC_ERROR_DETAIL = "The operation could not be completed.";
const COMMAND_RECOVERY_PENDING =
  /(?:command\s+[0-9a-f-]+\s+must be acknowledged, recovered, or discarded first|malink is restoring the previous queued action)/iu;

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : "";
}

export function isCommandRecoveryPendingError(error: unknown): boolean {
  return COMMAND_RECOVERY_PENDING.test(errorMessage(error).replace(/\s+/gu, " ").trim());
}

/**
 * Keeps actionable product copy while preventing transport names, machine
 * codes, URLs, and JavaScript exception types from leaking into the UI.
 * Call sites may still retain the original error for diagnostics.
 */
export function formatUserFacingError(error: unknown): string {
  const raw = errorMessage(error);
  const message = raw.replace(/\s+/gu, " ").trim();
  if (!message) return GENERIC_ERROR_DETAIL;

  if (/\b(?:429|too many requests)\b/iu.test(message)) {
    return "Too many requests. Wait a moment and try again.";
  }
  if (COMMAND_RECOVERY_PENDING.test(message)) {
    return "Malink is restoring your previous action. Try again in a moment.";
  }
  if (/native bridge.*did not answer.*(?:in time|timed out)/iu.test(message)) {
    return "The connected device did not respond in time.";
  }
  if (
    /failed to fetch|network request failed|networkerror|load failed/iu.test(
      message,
    )
  ) {
    return "The network request did not complete.";
  }
  if (/\b(?:timed out|timeout)\b/iu.test(message)) {
    return "The operation took too long.";
  }
  if (/\b(?:aborterror|operation was aborted)\b/iu.test(message)) {
    return "The operation was interrupted. Please try again.";
  }
  if (
    /^(?:matrix|native|network)_[a-z0-9_]+$/u.test(message) ||
    (error instanceof Error &&
      /^(?:Type|Reference|Syntax|Range)Error$/u.test(error.name)) ||
    /^(?:type|reference|syntax|range)error\b/iu.test(message) ||
    /(?:https?|wss?):\/\//iu.test(message)
  ) {
    return GENERIC_ERROR_DETAIL;
  }

  return message.length <= 180 ? message : `${message.slice(0, 179)}…`;
}

function nativeBridgeUserAction(error: unknown): unknown {
  if (!error || typeof error !== "object") return undefined;
  const data = "data" in error ? error.data : undefined;
  if (!data || typeof data !== "object") return undefined;
  return "userAction" in data ? data.userAction : undefined;
}

/**
 * A native startup gate fails before Matrix receives the one-time login token.
 * Keep the still-valid authorization file recoverable instead of telling the
 * user to replace it. Other failures can happen after submission, so they must
 * not claim that the token is definitely reusable.
 */
export function formatDeviceInvitationSignInFailure(error: unknown): string {
  const detail = formatUserFacingError(error);
  const localStartupFailure =
    nativeBridgeUserAction(error) === "open_app" ||
    /(?:persistent native runtime is not active|visible persistent notification|allow malink to stay active)/iu.test(
      error instanceof Error ? error.message : typeof error === "string" ? error : "",
    );
  if (localStartupFailure) {
    return (
      `The one-time sign-in was not submitted: ${detail} ` +
      "Complete the Android requirement, then open this same authorization file again."
    );
  }
  return (
    `The one-time sign-in could not be completed: ${detail} ` +
    "Open this authorization file again to retry. Create a new invitation only if Malink says this one expired or was already used."
  );
}

export { GENERIC_ERROR_DETAIL };
