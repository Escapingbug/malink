import type { MatrixConnectionStatus } from "./matrix";
import {
  gatewayNodeLivenessPresentation,
  type GatewayNodeLiveness,
} from "./gatewayNodeLiveness";

export type ConnectionPathTone =
  | "ready"
  | "progress"
  | "delayed"
  | "offline"
  | "attention"
  | "unknown"
  | "setup";

export type ConnectionPathSegment = {
  tone: ConnectionPathTone;
  label: string;
  detail: string;
};

export type ConnectionPathPresentation = {
  deviceToMatrix: ConnectionPathSegment;
  matrixToGateway: ConnectionPathSegment;
  summary: string;
  summaryTone: ConnectionPathTone;
  accessibleLabel: string;
};

export function deriveConnectionPathPresentation(input: {
  trusted: boolean;
  matrixStatus: MatrixConnectionStatus;
  gatewayLabel: string;
  gatewayLiveness?: GatewayNodeLiveness;
  gatewaySnapshotAvailable: boolean;
  now: number;
}): ConnectionPathPresentation {
  const deviceToMatrix = deviceMatrixSegment(input.trusted, input.matrixStatus);
  const matrixToGateway = gatewaySegment(input);
  const primary = primaryIssue(deviceToMatrix, matrixToGateway);
  return {
    deviceToMatrix,
    matrixToGateway,
    summary: primary?.label ?? "Connected",
    summaryTone: primary?.tone ?? "ready",
    accessibleLabel:
      "This device to Matrix: " + deviceToMatrix.detail + ". " +
      "Matrix to " + input.gatewayLabel + ": " + matrixToGateway.detail + ".",
  };
}

function deviceMatrixSegment(
  trusted: boolean,
  status: MatrixConnectionStatus,
): ConnectionPathSegment {
  if (!trusted) {
    return {
      tone: "setup",
      label: "Connect device",
      detail: "setup is required",
    };
  }
  if (status === "connected") {
    return {
      tone: "ready",
      label: "Connected",
      detail: "connected to Matrix and receiving updates",
    };
  }
  if (status === "offline") {
    return {
      tone: "offline",
      label: "Not connected",
      detail: "not connected to Matrix",
    };
  }
  if (status === "error") {
    return {
      tone: "attention",
      label: "Not connected",
      detail: "the Matrix connection needs attention before it can reconnect",
    };
  }
  return {
    tone: "progress",
    label: status === "reconnecting" ? "Reconnecting" : "Connecting",
    detail: status === "reconnecting"
      ? "reconnecting to Matrix"
      : "establishing the Matrix connection",
  };
}

function gatewaySegment(input: {
  trusted: boolean;
  matrixStatus: MatrixConnectionStatus;
  gatewayLiveness?: GatewayNodeLiveness;
  gatewaySnapshotAvailable: boolean;
  now: number;
}): ConnectionPathSegment {
  if (!input.trusted) {
    return {
      tone: "unknown",
      label: "Unable to verify",
      detail: "Gateway availability cannot be verified until this device is connected",
    };
  }
  if (input.matrixStatus !== "connected") {
    return {
      tone: "unknown",
      label: "Unable to verify",
      detail: "Gateway availability cannot be verified until Matrix reconnects",
    };
  }

  const raw = input.gatewayLiveness;
  const presentation = gatewayNodeLivenessPresentation(raw, input.now);
  if (presentation.state === "online") {
    return {
      tone: "ready",
      label: "Available",
      detail: "recent signed activity was received",
    };
  }
  if (presentation.state === "checking") {
    if (raw?.lastVerifiedAt !== undefined) {
      return {
        tone: "ready",
        label: "Available",
        detail: "last known available; Malink is checking again automatically",
      };
    }
    return {
      tone: "unknown",
      label: "Unable to verify",
      detail: "Malink is checking Gateway availability automatically",
    };
  }
  if (presentation.state === "stale") {
    return {
      tone: "ready",
      label: "Available",
      detail: "last known available; Malink is checking again automatically",
    };
  }
  if (presentation.state === "unreachable") {
    const confirmed = (raw?.consecutiveNoReplies ?? 1) >= 2;
    if (!confirmed) {
      return raw?.lastVerifiedAt !== undefined
        ? {
            tone: "ready",
            label: "Available",
            detail: "last known available; Malink is retrying automatically",
          }
        : {
            tone: "unknown",
            label: "Unable to verify",
            detail: "Gateway availability is not confirmed yet; Malink is retrying automatically",
          };
    }
    return {
      tone: "attention",
      label: "Not responding",
      detail: "Gateway did not answer repeated checks; check the Gateway computer",
    };
  }
  if (presentation.state === "unavailable") {
    return {
      tone: "unknown",
      label: "Unable to verify",
      detail: "this Gateway cannot report its current availability to this device",
    };
  }
  return {
    tone: "unknown",
    label: "Unable to verify",
    detail: input.gatewaySnapshotAvailable
      ? "current Gateway availability has not been confirmed"
      : "waiting for the first confirmed Gateway status",
  };
}

function primaryIssue(
  deviceToMatrix: ConnectionPathSegment,
  matrixToGateway: ConnectionPathSegment,
): ConnectionPathSegment | null {
  const severity: Record<ConnectionPathTone, number> = {
    ready: 0,
    unknown: 1,
    progress: 2,
    delayed: 3,
    setup: 4,
    offline: 5,
    attention: 6,
  };
  const candidates = [deviceToMatrix, matrixToGateway]
    .filter(segment => segment.tone !== "ready")
    .sort((left, right) => severity[right.tone] - severity[left.tone]);
  return candidates[0] ?? null;
}
