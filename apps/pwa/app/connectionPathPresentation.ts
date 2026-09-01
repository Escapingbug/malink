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
      label: "Synced",
      detail: "receiving Matrix updates",
    };
  }
  if (status === "offline") {
    return {
      tone: "offline",
      label: "Matrix offline",
      detail: "not connected to Matrix",
    };
  }
  if (status === "error") {
    return {
      tone: "attention",
      label: "Matrix needs attention",
      detail: "the Matrix connection needs attention",
    };
  }
  return {
    tone: "progress",
    label: status === "reconnecting" ? "Reconnecting" : "Syncing",
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
      label: "Gateway unknown",
      detail: "not available until this device is connected",
    };
  }
  if (input.matrixStatus !== "connected") {
    return {
      tone: "unknown",
      label: "Gateway unknown",
      detail: "cannot be verified until Matrix sync resumes",
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
    return {
      tone: "progress",
      label: "Checking Gateway",
      detail: "waiting for a signed Gateway reply",
    };
  }
  if (presentation.state === "stale") {
    return {
      tone: "delayed",
      label: "Gateway check delayed",
      detail: "the last signed activity is no longer recent",
    };
  }
  if (presentation.state === "unreachable") {
    const confirmed = (raw?.consecutiveNoReplies ?? 1) >= 2;
    return {
      tone: confirmed ? "attention" : "delayed",
      label: confirmed ? "Gateway not responding" : "Gateway reply delayed",
      detail: confirmed
        ? "multiple signed checks received no reply"
        : "one signed check received no reply yet",
    };
  }
  if (presentation.state === "unavailable") {
    return {
      tone: "unknown",
      label: "Live check unavailable",
      detail: "this Gateway does not expose a compatible signed live check",
    };
  }
  return {
    tone: "unknown",
    label: input.gatewaySnapshotAvailable
      ? "Gateway not verified"
      : "Waiting for Gateway",
    detail: input.gatewaySnapshotAvailable
      ? "workspace data is available, but current Gateway activity is not verified"
      : "no verified Gateway state has arrived yet",
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
