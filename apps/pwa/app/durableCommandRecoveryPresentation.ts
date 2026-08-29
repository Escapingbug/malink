import type { CommandState } from "@malink/native-bridge";
import type { MatrixConnectionStatus } from "./matrix";

export type DurableCommandRecoveryPresentation = {
  title: string;
  detail: string;
  stateLabel: string;
  primaryAction: "check" | "reconnect";
  primaryLabel: string;
};

/**
 * Explains a native durable command using product concepts. The exact command
 * remains in the Android outbox; this presentation never implies that the UI
 * can decide whether it executed.
 */
export function durableCommandRecoveryPresentation(input: {
  state: CommandState;
  connectionStatus: MatrixConnectionStatus;
  gatewayAvailable: boolean;
  journalReconciliationAvailable?: boolean;
  lastError?: string | null;
}): DurableCommandRecoveryPresentation {
  const stateLabel = commandStateLabel(input.state);
  const accepted = input.state === "accepted" || input.state === "running";
  const localOnly = input.state === "queued" ||
    input.state === "transmitting" ||
    input.state === "recovery_required";

  if (input.connectionStatus !== "connected") {
    return {
      title: "Previous action is waiting for recovery",
      detail: input.connectionStatus === "offline"
        ? "This device is offline. The original action remains saved locally; reconnect to check whether your computer accepted it. Malink will keep the same command identity, so reconnecting cannot submit it twice."
        : input.connectionStatus === "error"
          ? "The Matrix connection needs attention before Malink can verify the previous action. Reconnect, then Malink will check the same saved command instead of creating another one."
          : "The Matrix connection is still being restored. The original action remains saved locally and will be checked with the same command identity after the connection is ready.",
      stateLabel,
      primaryAction: "reconnect",
      primaryLabel: input.connectionStatus === "error" || input.connectionStatus === "offline"
        ? "Reconnect"
        : "Open connection",
    };
  }

  if (!input.gatewayAvailable) {
    return {
      title: "Waiting for your computer",
      detail: input.journalReconciliationAvailable === false
        ? "Matrix is connected, but the Gateway has not published a recent signed state. This installed Android version can only check Matrix history. Update the Android app, bring the Gateway online, then check the same saved command again; Malink will not execute a duplicate."
        : "Matrix is connected, but the Gateway has not published a recent signed state. The original action remains saved. Bring the Gateway online, then check again; Malink will ask its command journal about the same command and will not execute a duplicate.",
      stateLabel,
      primaryAction: "check",
      primaryLabel: "Check again",
    };
  }

  const detail = accepted
    ? input.journalReconciliationAvailable === false
      ? "Your computer accepted this action, but this client did not receive its signed final result. This installed Android version can only check Matrix history and cannot ask the Gateway journal. Update the Android app, then check this same command again; the action will not run twice."
      : "Your computer accepted this action, but this client did not receive its signed final result—usually because the app or Matrix sync was interrupted. Malink is checking Matrix history and asking the Gateway journal about the same command; the action will not run twice."
    : localOnly
      ? "The app was interrupted before it confirmed that Matrix accepted this action. The exact signed command remains in the local outbox. Malink is retrying that same identity and will not create a second action."
      : "The action has a durable local result, but its recovery record has not been released yet. Malink is verifying the result before removing the record.";
  return {
    title: accepted ? "Waiting for a verified result" : "Recovering a previous action",
    detail: input.lastError
      ? `${detail} Last check: ${input.lastError}`
      : detail,
    stateLabel,
    primaryAction: "check",
    primaryLabel: accepted && input.journalReconciliationAvailable === false
      ? "Check Matrix again"
      : "Check now",
  };
}

function commandStateLabel(state: CommandState): string {
  switch (state) {
    case "queued":
      return "Saved on this device";
    case "transmitting":
      return "Sending to Matrix";
    case "accepted":
      return "Accepted by your computer";
    case "running":
      return "Running on your computer";
    case "needs_review":
      return "Needs review";
    case "recovery_required":
      return "Recovery required";
    case "succeeded":
      return "Completed";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
  }
}
