import type { MatrixConnectionStatus } from "./matrix";

export type GatewayUpdateSettingsPresentation = {
  detail: string;
  action: "review" | "retry-discovery" | "reconnect" | null;
  actionLabel?: string;
  attention: boolean;
};

export function gatewayUpdateSettingsPresentation(input: {
  trusted: boolean;
  releaseId?: string;
  discoveryBusy: boolean;
  discoveryError?: string | null;
  directoryState: "missing" | "empty" | "ready";
  connectionStatus: MatrixConnectionStatus;
  availableCount: number;
  nodeCount: number;
}): GatewayUpdateSettingsPresentation {
  if (!input.trusted) {
    return {
      detail: "Authorize this device for a Workspace before managing Gateway software.",
      action: null,
      attention: true,
    };
  }
  if (input.discoveryBusy) {
    return {
      detail: "Checking the selected static service for a signed Gateway release…",
      action: null,
      attention: false,
    };
  }
  if (input.discoveryError) {
    return {
      detail: `The selected static service could not provide the Gateway release: ${input.discoveryError}`,
      action: "retry-discovery",
      actionLabel: "Retry release check",
      attention: true,
    };
  }
  if (!input.releaseId) {
    return {
      detail: "No signed Gateway release has been loaded from the selected static service.",
      action: "retry-discovery",
      actionLabel: "Check release channel",
      attention: true,
    };
  }
  if (input.directoryState === "missing") {
    if (input.connectionStatus === "connected") {
      return {
        detail:
          `Release ${input.releaseId} is available and Matrix is connected, but no signed Gateway Directory has arrived. ` +
          "Bring a Gateway computer online; Malink will restore it automatically. If a Gateway is already online, export diagnostics.",
        action: null,
        attention: true,
      };
    }
    return {
      detail:
        `Release ${input.releaseId} is available, but the Workspace connection is not ready to restore the signed Gateway Directory. ` +
        "Reconnect the Workspace to request its verified state again.",
      action: "reconnect",
      actionLabel: "Reconnect Workspace",
      attention: true,
    };
  }
  if (input.directoryState === "empty") {
    return {
      detail:
        `Release ${input.releaseId} is available, but the signed Workspace directory contains no Gateways. ` +
        "Add a Gateway before attempting an update.",
      action: null,
      attention: true,
    };
  }
  return {
    detail: input.availableCount > 0
      ? `${input.availableCount} ${input.availableCount === 1 ? "Gateway needs" : "Gateways need"} release ${input.releaseId}.`
      : `Review ${input.nodeCount} ${input.nodeCount === 1 ? "Gateway" : "Gateways"} and their live status.`,
    action: "review",
    actionLabel: input.availableCount > 0
      ? `Review ${input.availableCount} update${input.availableCount === 1 ? "" : "s"}`
      : "View versions",
    attention: false,
  };
}
