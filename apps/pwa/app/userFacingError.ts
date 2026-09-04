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

/**
 * Pairing spans account sign-in, encrypted transport startup, Gateway
 * authorization, and Workspace hydration. Preserve that user-facing boundary
 * instead of collapsing every bounded wait into one generic timeout.
 */
export function formatPairingFailure(
  error: unknown,
  gatewayName = "the Workspace computer",
): string {
  const raw = errorMessage(error).replace(/\s+/gu, " ").trim();
  const safeGatewayName = gatewayName.trim() || "the Workspace computer";

  if (/pairing request expired|signed response.*(?:did not|not).*arriv/iu.test(raw)) {
    return (
      `${safeGatewayName} did not return the device authorization before the invitation expired. ` +
      "Make sure Malink Gateway is running on that computer, then create a new invitation."
    );
  }
  if (/secure Matrix transport did not become ready|device keys.*(?:time|timeout)|encryption keys/iu.test(raw)) {
    return (
      "This device could not finish starting its protected connection. " +
      "Check the network and keep Malink open, then retry this same invitation."
    );
  }
  if (/conversation authorization did not arrive|Gateway state could not be recovered|authorization.*(?:time|timeout)/iu.test(raw)) {
    return (
      `${safeGatewayName} approved this device, but the Workspace did not finish syncing. ` +
      "Keep the saved setup and retry; do not create another device unless Malink says the invitation expired."
    );
  }
  if (/native bridge.*did not answer.*(?:in time|timed out)/iu.test(raw)) {
    return (
      "The Android background connection did not answer. Keep Malink open, restart the app if needed, " +
      "then retry this same invitation."
    );
  }
  if (/failed to fetch|network request failed|networkerror|load failed/iu.test(raw)) {
    return (
      "The account service could not be reached. The Gateway authorization was not replaced; " +
      "check the network and retry this same invitation."
    );
  }
  if (/\b(?:timed out|timeout|took too long)\b/iu.test(raw)) {
    return (
      `${safeGatewayName} did not finish the secure connection in time. ` +
      "The pending request is kept for safe recovery; check that the computer is online and retry."
    );
  }
  return formatUserFacingError(error);
}

export { GENERIC_ERROR_DETAIL };
