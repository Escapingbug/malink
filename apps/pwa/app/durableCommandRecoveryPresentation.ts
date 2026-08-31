import type { CommandState } from "@malink/native-bridge";
import type { MatrixConnectionStatus } from "./matrix";

export type DurableCommandRecoveryPresentation = {
  title: string;
  detail: string;
  stateLabel: string;
  primaryAction:
    | "check"
    | "reconnect"
    | "update-native-app"
    | "open-apk-releases"
    | null;
  primaryLabel?: string;
};

export type DurableCommandRecoveryCheckResult = {
  status: "no-response" | "failed";
  checkedAt: number;
  detail?: string;
};

export function durableCommandRecoveryNeedsAttention(
  lastCheck?: DurableCommandRecoveryCheckResult | null,
  backgrounded = false,
): boolean {
  if (lastCheck?.status === "no-response") return false;
  return !backgrounded || lastCheck?.status === "failed";
}

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
  manualAndroidUpdateRequired?: boolean;
  lastCheck?: DurableCommandRecoveryCheckResult | null;
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
    if (accepted && input.journalReconciliationAvailable === false) {
      return {
        title: "Update Android before verifying this action",
        detail:
          "This installed Android version cannot ask the Gateway journal for the signed final result. Update Android first, then bring the Gateway computer online. Malink will check the same command identity and will not execute it twice.",
        stateLabel,
        ...androidUpdateAction(input.manualAndroidUpdateRequired === true),
      };
    }
    return {
      title: "Waiting for your computer",
      detail:
        "Matrix is connected, but the Gateway has not published a recent signed state. Bring the Gateway computer online; Malink will retry this saved command automatically and will not execute a duplicate. There is nothing this client can verify until that computer is reachable.",
      stateLabel,
      primaryAction: null,
    };
  }

  if (accepted && input.journalReconciliationAvailable === false) {
    return {
      title: "Android update required to verify this action",
      detail:
        "Your computer accepted this action, but this installed Android version can only scan Matrix history and cannot ask the Gateway journal for its signed final result. Update Android, then Malink will verify this same command without executing it twice.",
      stateLabel,
      ...androidUpdateAction(input.manualAndroidUpdateRequired === true),
    };
  }

  if (accepted && input.lastCheck?.status === "no-response") {
    return {
      title: "Recovery continues in the background",
      detail:
        "The target Gateway did not return a signed result during the last check. No action is required: Malink has moved this notice out of the way and will keep checking the same saved command identity in the background, so it cannot submit the action twice.",
      stateLabel,
      primaryAction: null,
    };
  }

  const detail = accepted
    ? "Your computer accepted this action, but this client did not receive its signed final result—usually because the app or Matrix sync was interrupted. Malink is checking Matrix history and asking the Gateway journal about the same command; the action will not run twice."
    : localOnly
      ? "The app was interrupted before it confirmed that Matrix accepted this action. The exact signed command remains in the local outbox. Malink is retrying that same identity and will not create a second action."
      : "The action has a durable local result, but its recovery record has not been released yet. Malink is verifying the result before removing the record.";
  return {
    title: accepted ? "Waiting for a verified result" : "Recovering a previous action",
    detail: input.lastCheck?.status === "failed" && input.lastCheck.detail
      ? `${detail} Last check failed: ${input.lastCheck.detail}`
      : detail,
    stateLabel,
    primaryAction: "check",
    primaryLabel: accepted ? "Check Gateway journal" : "Check now",
  };
}

function androidUpdateAction(manual: boolean): Pick<
  DurableCommandRecoveryPresentation,
  "primaryAction" | "primaryLabel"
> {
  return manual
    ? {
        primaryAction: "open-apk-releases",
        primaryLabel: "Open APK releases",
      }
    : {
        primaryAction: "update-native-app",
        primaryLabel: "Update Android app",
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
