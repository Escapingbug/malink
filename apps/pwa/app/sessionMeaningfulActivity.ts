import type { IncomingMalinkMessage } from "./matrix";

export const SESSION_MEANINGFUL_ACTIVITY_STORAGE_KEY =
  "malink.ui.session-meaningful-activity.v1";

const MAX_PERSISTED_SESSIONS = 5_000;

export type SessionMeaningfulActivityState = Readonly<
  Record<string, number>
>;

type PersistedSessionMeaningfulActivity = {
  version: 1;
  last_meaningful_at: Record<string, number>;
};

type StorageReader = Pick<Storage, "getItem">;
type StorageWriter = Pick<Storage, "setItem">;

export const EMPTY_SESSION_MEANINGFUL_ACTIVITY: SessionMeaningfulActivityState =
  Object.freeze({});

/**
 * Returns true only for events that create or finish something visible in the
 * conversation. Lifecycle heartbeats and streaming tool progress deliberately
 * do not move a row in the conversation list.
 */
export function isMeaningfulSessionMessage(
  message: Pick<IncomingMalinkMessage, "kind" | "raw">,
): boolean {
  if (
    message.kind === "user" ||
    message.kind === "agent" ||
    message.kind === "permission" ||
    message.kind === "error"
  ) {
    return true;
  }
  if (message.kind !== "tool") return false;

  const raw = asRecord(message.raw);
  if (raw?.type === "assistant.message" || raw?.kind === "message") {
    return true;
  }
  if (raw?.type !== "tool.activity") return false;
  return raw.phase === "completed" || raw.phase === "failed";
}

export function recordSessionMeaningfulActivity(
  state: SessionMeaningfulActivityState,
  sessionKey: string,
  timestamp: number,
): SessionMeaningfulActivityState {
  if (!sessionKey || !isTimestamp(timestamp)) return state;
  const previous = state[sessionKey];
  if (previous !== undefined && previous >= timestamp) return state;
  return Object.freeze({
    ...state,
    [sessionKey]: timestamp,
  });
}

export function readSessionMeaningfulActivity(
  storage: StorageReader | null | undefined,
): SessionMeaningfulActivityState {
  if (!storage) return EMPTY_SESSION_MEANINGFUL_ACTIVITY;
  try {
    const raw = storage.getItem(SESSION_MEANINGFUL_ACTIVITY_STORAGE_KEY);
    if (!raw) return EMPTY_SESSION_MEANINGFUL_ACTIVITY;
    const parsed: unknown = JSON.parse(raw);
    if (!isPersistedSessionMeaningfulActivity(parsed)) {
      return EMPTY_SESSION_MEANINGFUL_ACTIVITY;
    }
    return Object.freeze({ ...parsed.last_meaningful_at });
  } catch {
    return EMPTY_SESSION_MEANINGFUL_ACTIVITY;
  }
}

export function writeSessionMeaningfulActivity(
  storage: StorageWriter | null | undefined,
  state: SessionMeaningfulActivityState,
): boolean {
  if (!storage) return false;
  const entries = Object.entries(state)
    .filter(([sessionKey, timestamp]) => sessionKey.length > 0 && isTimestamp(timestamp))
    .sort((left, right) => right[1] - left[1])
    .slice(0, MAX_PERSISTED_SESSIONS);
  const value: PersistedSessionMeaningfulActivity = {
    version: 1,
    last_meaningful_at: Object.fromEntries(entries),
  };
  try {
    storage.setItem(
      SESSION_MEANINGFUL_ACTIVITY_STORAGE_KEY,
      JSON.stringify(value),
    );
    return true;
  } catch {
    return false;
  }
}

function isPersistedSessionMeaningfulActivity(
  value: unknown,
): value is PersistedSessionMeaningfulActivity {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  const timestamps = candidate.last_meaningful_at;
  return (
    candidate.version === 1 &&
    Boolean(timestamps) &&
    typeof timestamps === "object" &&
    !Array.isArray(timestamps) &&
    Object.keys(timestamps as object).length <= MAX_PERSISTED_SESSIONS &&
    Object.entries(timestamps as Record<string, unknown>).every(
      ([sessionKey, timestamp]) => sessionKey.length > 0 && isTimestamp(timestamp),
    )
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
