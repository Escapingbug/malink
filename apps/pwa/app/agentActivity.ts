import type { MessageDeliveryMode } from "@malink/native-bridge";
import { isLiveMessageDelivery } from "./messageDelivery";

export type AgentActivityPhase =
  | "sending"
  | "waiting"
  | "starting"
  | "working"
  | "stopping";

export type AgentActivity = Readonly<{
  phase: AgentActivityPhase;
  label: string;
  detail?: string;
}>;

/**
 * Monotonic position of the authoritative session state that activity was
 * derived from. New clients provide a per-session state version; timestamps
 * keep the ordering safe while an older native host is still installed.
 */
export type AgentActivityWatermark = Readonly<{
  stateVersion?: number;
  updatedAt: number;
}>;

const ACTIVITY_LABELS: Readonly<Record<AgentActivityPhase, string>> = {
  sending: "Sending…",
  waiting: "Message sent · Waiting for agent…",
  starting: "Starting agent…",
  working: "Agent is working…",
  stopping: "Stopping agent…",
};

export const SENDING_AGENT_ACTIVITY = agentActivityForPhase("sending");
export const WAITING_AGENT_ACTIVITY = agentActivityForPhase("waiting");
export const STARTING_AGENT_ACTIVITY = agentActivityForPhase("starting");
export const WORKING_AGENT_ACTIVITY = agentActivityForPhase("working");
export const STOPPING_AGENT_ACTIVITY = agentActivityForPhase("stopping");

/** Compact elapsed time for the activity indicator's live last-update clock. */
export function formatAgentActivityAge(
  updatedAt: number,
  now: number,
): string {
  const elapsed = Math.max(0, now - updatedAt);
  if (elapsed < 5_000) return "just now";
  if (elapsed < 60_000) return `${Math.floor(elapsed / 1_000)}s ago`;
  if (elapsed < 60 * 60_000) return `${Math.floor(elapsed / 60_000)}m ago`;
  if (elapsed < 24 * 60 * 60_000) {
    return `${Math.floor(elapsed / (60 * 60_000))}h ago`;
  }
  return `${Math.floor(elapsed / (24 * 60 * 60_000))}d ago`;
}

export type AgentExecutionSignal =
  | "running"
  | "stopping"
  | "stopped"
  | null;

export function shouldApplyAgentActivity(
  currentSessionId: string | null,
  event: {
    sessionId?: string;
    deliveryMode?: MessageDeliveryMode;
    historical?: boolean;
  },
): boolean {
  return (
    isLiveMessageDelivery(event) &&
    Boolean(currentSessionId) &&
    event.sessionId === currentSessionId
  );
}

export function isAgentActivityEvent(raw: unknown): boolean {
  const event = asRecord(raw);
  if (!event) return false;
  if (event.kind === "status") {
    return [
      "starting",
      "querying",
      "running",
      "working",
      "stopping",
      "canceling",
      "idle",
      "failed",
    ].includes(String(event.activity_phase ?? event.state));
  }
  if (
    event.type === "turn.queued" ||
    event.type === "turn.started" ||
    event.type === "turn.completed" ||
    event.type === "turn.failed" ||
    event.type === "assistant.message" ||
    event.type === "tool.activity"
  ) {
    return true;
  }
  return event.kind === "message" || event.kind === "decision_request";
}

export function agentActivityWatermarkForEvent(event: {
  timestamp: number;
  raw: unknown;
}): AgentActivityWatermark {
  const raw = asRecord(event.raw);
  const projection = asRecord(raw?.projection);
  const stateVersion = positiveInteger(projection?.stateVersion);
  const projectedAt = nonnegativeInteger(projection?.updatedAt);
  return Object.freeze({
    ...(stateVersion === undefined ? {} : { stateVersion }),
    updatedAt: projectedAt ?? Math.max(0, event.timestamp),
  });
}

export function agentActivityWatermarkForSession(session: {
  stateVersion?: number;
  updatedAt: number;
}): AgentActivityWatermark {
  return Object.freeze({
    ...(positiveInteger(session.stateVersion) === undefined
      ? {}
      : { stateVersion: session.stateVersion }),
    updatedAt: Math.max(0, session.updatedAt),
  });
}

/** A delayed Matrix callback must never move transient activity behind a terminal snapshot. */
export function isStaleAgentActivityWatermark(
  current: AgentActivityWatermark | undefined,
  incoming: AgentActivityWatermark,
): boolean {
  if (!current) return false;
  if (
    current.stateVersion !== undefined &&
    incoming.stateVersion !== undefined
  ) {
    if (incoming.stateVersion < current.stateVersion) return true;
    if (incoming.stateVersion > current.stateVersion) return false;
  }
  return incoming.updatedAt < current.updatedAt;
}

export function mergeAgentActivityWatermark(
  current: AgentActivityWatermark | undefined,
  incoming: AgentActivityWatermark,
): AgentActivityWatermark {
  if (!current) return incoming;
  if (
    incoming.stateVersion !== undefined &&
    (current.stateVersion === undefined ||
      incoming.stateVersion > current.stateVersion)
  ) {
    // A newer projection version supersedes the timestamp-only gap between
    // turns. Keeping that unversioned timestamp could reject legitimate
    // events whose authoritative projection clock is slightly earlier.
    return incoming;
  }
  if (
    current.stateVersion !== undefined &&
    incoming.stateVersion !== undefined &&
    incoming.stateVersion < current.stateVersion
  ) {
    return current;
  }
  return Object.freeze({
    ...(current.stateVersion === undefined && incoming.stateVersion === undefined
      ? {}
      : {
          stateVersion: Math.max(
            current.stateVersion ?? 0,
            incoming.stateVersion ?? 0,
          ),
        }),
    updatedAt: Math.max(current.updatedAt, incoming.updatedAt),
  });
}

/**
 * Builds activity for local UI transitions such as optimistic sending or
 * stopping. Remote Agent lifecycle should be derived with
 * `reduceAgentActivity` so activity is shared across every connected device.
 */
export function agentActivityForPhase(
  phase: AgentActivityPhase,
  detail?: string,
): AgentActivity {
  return createActivity(phase, ACTIVITY_LABELS[phase], detail);
}

/**
 * Reduces an authenticated `IncomingMalinkMessage.raw` value into the
 * transient Agent activity shown by the conversation UI.
 *
 * Unknown events preserve the current activity. Visible Agent output promotes
 * the activity to working, but only a terminal lifecycle event clears it: a
 * reply or tool result can arrive while the same turn is still executing.
 */
export function reduceAgentActivity(
  current: AgentActivity | null,
  raw: unknown,
): AgentActivity | null {
  const event = asRecord(raw);
  if (!event) return current;

  if (event.kind === "status") {
    switch (event.activity_phase ?? event.state) {
      case "starting":
      case "querying":
        // A delayed querying notice must not make an already-visible tool or
        // running state appear to move backwards to "starting".
        return current?.phase === "working" || current?.phase === "stopping"
          ? current
          : STARTING_AGENT_ACTIVITY;
      case "running":
      case "working":
        return WORKING_AGENT_ACTIVITY;
      case "stopping":
      case "canceling":
        return STOPPING_AGENT_ACTIVITY;
      case "idle":
      case "failed":
        return null;
      default:
        return current;
    }
  }

  if (event.type === "turn.queued") {
    return current?.phase === "working" || current?.phase === "stopping"
      ? current
      : STARTING_AGENT_ACTIVITY;
  }
  if (event.type === "turn.started") {
    return current?.phase === "stopping" ? current : WORKING_AGENT_ACTIVITY;
  }
  if (event.type === "turn.completed" || event.type === "turn.failed") {
    return null;
  }
  if (
    event.type === "assistant.message" ||
    event.type === "tool.activity"
  ) {
    return current?.phase === "stopping" ? current : WORKING_AGENT_ACTIVITY;
  }

  if (event.kind === "message") {
    return current?.phase === "stopping" ? current : WORKING_AGENT_ACTIVITY;
  }
  if (event.kind === "decision_request") {
    return createActivity(
      "working",
      "Waiting for permission…",
      optionalNonemptyString(event.title),
    );
  }
  return current;
}

/**
 * Derives whether the full Agent turn is still interruptible.
 *
 * Individual text or tool completions are not terminal because a turn may
 * continue with more text, tools, or permission requests afterwards. Only an
 * explicit session lifecycle transition or fatal Agent error ends the turn.
 */
export function agentExecutionSignal(raw: unknown): AgentExecutionSignal {
  const event = asRecord(raw);
  if (!event) return null;
  const statusPhase =
    event.kind === "status" ? event.activity_phase ?? event.state : undefined;
  if (
    event.kind === "status" &&
      (statusPhase === "starting" ||
        statusPhase === "querying" ||
        statusPhase === "running" ||
        statusPhase === "working")
  ) {
    return "running";
  }
  if (
    event.kind === "status" &&
      (statusPhase === "canceling" || statusPhase === "stopping")
  ) {
    return "stopping";
  }
  if (
    event.kind === "status" &&
      (statusPhase === "idle" || statusPhase === "failed")
  ) {
    return "stopped";
  }
  return null;
}

function createActivity(
  phase: AgentActivityPhase,
  label: string,
  detail?: string,
): AgentActivity {
  const normalizedDetail = optionalNonemptyString(detail);
  return Object.freeze({
    phase,
    label,
    ...(normalizedDetail ? { detail: normalizedDetail } : {}),
  });
}

function optionalNonemptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

function nonnegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}
