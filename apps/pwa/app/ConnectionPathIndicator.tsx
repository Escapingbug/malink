import type { ReactNode } from "react";
import type {
  ConnectionPathPresentation,
  ConnectionPathTone,
} from "./connectionPathPresentation";

function DeviceIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <rect x="6.5" y="3.5" width="11" height="17" rx="2.2" />
      <path d="M10 17.5h4" />
    </svg>
  );
}

function MatrixIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d="M7.5 17.5h9.2a3.8 3.8 0 0 0 .5-7.6 5.5 5.5 0 0 0-10.4-1.4 4.5 4.5 0 0 0 .7 9Z" />
    </svg>
  );
}

function GatewayIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <rect x="3.5" y="5" width="17" height="12" rx="2" />
      <path d="M8.5 20h7M12 17v3" />
    </svg>
  );
}

function PathNode({
  caption,
  children,
  tone,
}: {
  caption: string;
  children: ReactNode;
  tone: ConnectionPathTone;
}) {
  return (
    <span className="connection-path-node-wrap">
      <span className={"connection-path-node connection-path-tone-" + tone}>
        {children}
        <i aria-hidden="true" />
      </span>
      <span className="connection-path-node-caption">{caption}</span>
    </span>
  );
}

function PathSegment({
  tone,
}: {
  tone: ConnectionPathTone;
}) {
  return (
    <span className="connection-path-segment-wrap">
      <i
        className={"connection-path-segment connection-path-tone-" + tone}
        aria-hidden="true"
      />
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
      <span className="connection-path-route">
        <PathNode caption="This device" tone={presentation.deviceToMatrix.tone}>
          <DeviceIcon />
        </PathNode>
        <PathSegment {...presentation.deviceToMatrix} />
        <PathNode caption="Matrix" tone={presentation.deviceToMatrix.tone}>
          <MatrixIcon />
        </PathNode>
        <PathSegment {...presentation.matrixToGateway} />
        <PathNode caption={gatewayLabel} tone={presentation.matrixToGateway.tone}>
          <GatewayIcon />
        </PathNode>
      </span>
      {variant === "full" && presentation.summaryTone !== "ready" && (
        <span
          className={
            "connection-path-full-label connection-path-tone-" +
            presentation.summaryTone
          }
        >
          {presentation.summary}
        </span>
      )}
      {variant === "compact" && presentation.summaryTone !== "ready" && (
        <span
          className={
            "connection-path-compact-label connection-path-tone-" +
            presentation.summaryTone
          }
        >
          {presentation.summary}
        </span>
      )}
    </span>
  );
}
