import type {
  ConnectionPathPresentation,
  ConnectionPathSegment,
  ConnectionPathTone,
} from "./connectionPathPresentation";

function StatusIcon({
  tone,
}: {
  tone: ConnectionPathTone;
}) {
  if (tone === "ready") {
    return (
      <svg aria-hidden="true" viewBox="0 0 24 24">
        <circle cx="12" cy="12" r="8.5" />
        <path d="m8.4 12.1 2.3 2.3 5-5.1" />
      </svg>
    );
  }
  if (tone === "progress") {
    return (
      <svg
        aria-hidden="true"
        className="connection-status-spinner"
        viewBox="0 0 24 24"
      >
        <circle className="connection-status-track" cx="12" cy="12" r="8.5" />
        <path d="M12 3.5a8.5 8.5 0 0 1 7.8 5.2" />
      </svg>
    );
  }
  if (tone === "delayed") {
    return (
      <svg aria-hidden="true" viewBox="0 0 24 24">
        <circle cx="12" cy="12" r="8.5" />
        <path d="M12 7.5v5l3.2 1.8" />
      </svg>
    );
  }
  if (tone === "attention") {
    return (
      <svg aria-hidden="true" viewBox="0 0 24 24">
        <path d="M10.4 4.5 3.5 17a2 2 0 0 0 1.8 3h13.4a2 2 0 0 0 1.8-3L13.6 4.5a1.8 1.8 0 0 0-3.2 0Z" />
        <path d="M12 9v4.5M12 17h.01" />
      </svg>
    );
  }
  if (tone === "setup") {
    return (
      <svg aria-hidden="true" viewBox="0 0 24 24">
        <circle cx="12" cy="12" r="8.5" />
        <path d="M12 8v8M8 12h8" />
      </svg>
    );
  }
  if (tone === "offline") {
    return (
      <svg aria-hidden="true" viewBox="0 0 24 24">
        <circle cx="12" cy="12" r="8.5" />
        <path d="m7 7 10 10" />
      </svg>
    );
  }
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <circle cx="12" cy="12" r="8.5" />
      <path d="M8.5 12h7" />
    </svg>
  );
}

function compactValue(
  segment: ConnectionPathSegment,
  kind: "matrix" | "gateway",
): string | null {
  if (segment.tone === "ready") return null;
  if (segment.tone === "progress") {
    return kind === "matrix" ? "Syncing" : "Checking";
  }
  if (segment.tone === "delayed") return "Delayed";
  if (segment.tone === "offline") return "Offline";
  if (segment.tone === "attention") {
    return kind === "matrix" ? "Error" : "No response";
  }
  if (segment.tone === "setup") return "Connect";
  return "Unknown";
}

function StatusItem({
  fullName,
  kind,
  segment,
  variant,
}: {
  fullName: string;
  kind: "matrix" | "gateway";
  segment: ConnectionPathSegment;
  variant: "full" | "compact";
}) {
  const name = variant === "compact"
    ? kind === "matrix" ? "Matrix" : "Gateway"
    : fullName;
  const value = variant === "compact"
    ? compactValue(segment, kind)
    : segment.label;
  return (
    <span
      className={
        "connection-status-item connection-path-tone-" + segment.tone
      }
    >
      <span className="connection-status-icon">
        <StatusIcon tone={segment.tone} />
      </span>
      <span className="connection-status-text">
        <span className="connection-status-name">{name}</span>
        {value && <span className="connection-status-value">{value}</span>}
      </span>
    </span>
  );
}

export function ConnectionPathIndicator({
  gatewayLabel,
  presentation,
  variant = "full",
}: {
  gatewayLabel: string;
  presentation: ConnectionPathPresentation;
  variant?: "full" | "compact";
}) {
  return (
    <span
      className={"connection-path-indicator connection-path-" + variant}
      aria-label={presentation.accessibleLabel}
    >
      <StatusItem
        fullName="Matrix"
        kind="matrix"
        segment={presentation.deviceToMatrix}
        variant={variant}
      />
      <i className="connection-status-divider" aria-hidden="true" />
      <StatusItem
        fullName={
          gatewayLabel === "Gateway" ? "Gateway" : "Gateway · " + gatewayLabel
        }
        kind="gateway"
        segment={presentation.matrixToGateway}
        variant={variant}
      />
    </span>
  );
}
