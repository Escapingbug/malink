import type { MatrixConnectionStatus } from "./matrix";

export type UncertainCommandRecoveryPresentation = {
  detail: string;
  primaryAction:
    | "check"
    | "reconnect"
    | "update-native-app"
    | "open-apk-releases"
    | null;
  primaryLabel?: string;
};

export function uncertainCommandRecoveryPresentation(input: {
  subject: "conversation" | "project";
  connectionStatus: MatrixConnectionStatus;
  gatewayAvailable: boolean;
  journalReconciliationAvailable: boolean;
  manualAndroidUpdateRequired?: boolean;
}): UncertainCommandRecoveryPresentation {
  const subject = input.subject === "conversation"
    ? "conversation creation"
    : "project creation";
  if (input.connectionStatus !== "connected") {
    return {
      detail:
        `The original ${subject} command remains saved. Restore the Matrix connection; ` +
        "Malink will resume the same identity automatically and will not create a duplicate.",
      primaryAction: "reconnect",
      primaryLabel: "Reconnect Workspace",
    };
  }
  if (!input.journalReconciliationAvailable) {
    return {
      detail:
        `The Gateway accepted this ${subject} command, but this Android version cannot ask ` +
        "the Gateway journal for its final result. Update Android to verify the same command without creating a duplicate.",
      primaryAction: input.manualAndroidUpdateRequired
        ? "open-apk-releases"
        : "update-native-app",
      primaryLabel: input.manualAndroidUpdateRequired
        ? "Open APK releases"
        : "Update Android app",
    };
  }
  if (!input.gatewayAvailable) {
    return {
      detail:
        `The original ${subject} command remains saved, but the Gateway computer is offline. ` +
        "Bring it online; Malink will check the same command automatically and will not create a duplicate.",
      primaryAction: null,
    };
  }
  return {
    detail:
      `Ask the online Gateway journal for the final result of this ${subject} command. ` +
      "Malink will check the same identity and will not create a duplicate.",
    primaryAction: "check",
    primaryLabel: "Check Gateway journal",
  };
}
