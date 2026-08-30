export type UiNoticeScope =
  | "connection"
  | "pairing"
  | "background"
  | "history"
  | "session"
  | "composer"
  | "attachment"
  | "update";

export type UiNoticeSeverity = "info" | "success" | "warning" | "error";

export type UiNotice = {
  /** Stable identity such as `session:create` or `attachment:upload`. */
  key: string;
  scope: UiNoticeScope;
  severity: UiNoticeSeverity;
  message: string;
  createdAt: number;
  expiresAt: number | null;
  /** Hidden inline but retained until resolved or cleared from the notice center. */
  hidden: boolean;
};

export type UiNoticeState = Readonly<Record<string, UiNotice>>;

export type UiNoticeEvent =
  | {
      type: "show";
      key: string;
      scope: UiNoticeScope;
      severity: UiNoticeSeverity;
      message: string;
      now: number;
      autoDismissMs?: number | null;
    }
  | { type: "dismiss"; key: string }
  | { type: "clear"; key: string }
  | { type: "scope-recovered"; scope: UiNoticeScope }
  | { type: "operation-recovered"; key: string }
  | { type: "tick"; now: number };

export const EMPTY_UI_NOTICE_STATE: UiNoticeState = Object.freeze({});

/**
 * Notice state is keyed by operation, so an attachment error cannot overwrite
 * a connection problem. Informational and success notices hide inline by default;
 * warnings/errors stay until an explicit recovery or center-clear event.
 * Dismissal only hides their inline surface.
 */
export function reduceUiNotices(
  state: UiNoticeState,
  event: UiNoticeEvent,
): UiNoticeState {
  switch (event.type) {
    case "show": {
      const duration = event.autoDismissMs === undefined
        ? defaultAutoDismissMs(event.severity)
        : event.autoDismissMs;
      return {
        ...state,
        [event.key]: {
          key: event.key,
          scope: event.scope,
          severity: event.severity,
          message: event.message.trim(),
          createdAt: event.now,
          expiresAt: duration === null ? null : event.now + Math.max(0, duration),
          hidden: false,
        },
      };
    }
    case "dismiss": {
      const notice = state[event.key];
      if (!notice || notice.hidden) return state;
      return {
        ...state,
        [event.key]: { ...notice, hidden: true },
      };
    }
    case "clear":
    case "operation-recovered":
      return omitNotices(state, (notice) => notice.key === event.key);
    case "scope-recovered":
      return omitNotices(state, (notice) => notice.scope === event.scope);
    case "tick": {
      let changed = false;
      const entries = Object.entries(state).map(([key, notice]) => {
        if (notice.expiresAt === null || notice.expiresAt > event.now) {
          return [key, notice] as const;
        }
        changed = true;
        return [key, {
          ...notice,
          expiresAt: null,
          hidden: true,
        }] as const;
      });
      return changed ? Object.fromEntries(entries) : state;
    }
  }
}

export function noticesForScope(
  state: UiNoticeState,
  scope: UiNoticeScope,
): UiNotice[] {
  return Object.values(state)
    .filter((notice) => notice.scope === scope && !notice.hidden)
    .sort((left, right) => left.createdAt - right.createdAt);
}

export function shouldShowGlobalNotice(notice: UiNotice): boolean {
  return notice.scope === "connection" ||
    notice.scope === "pairing" ||
    notice.scope === "background" ||
    notice.scope === "update";
}

/**
 * Notices owned by a dialog or another temporary surface must remain visible
 * after that surface closes. Keeping this selection beside the reducer makes
 * it difficult to add a new global operation without also rendering it.
 */
export function globalUiNotices(state: UiNoticeState): UiNotice[] {
  return Object.values(state)
    .filter((notice) => !notice.hidden && shouldShowGlobalNotice(notice))
    .sort((left, right) => left.createdAt - right.createdAt);
}

/** Hidden notices remain available here as the user's recovery path. */
export function allUiNotices(state: UiNoticeState): UiNotice[] {
  return Object.values(state)
    .sort((left, right) => right.createdAt - left.createdAt);
}

function defaultAutoDismissMs(severity: UiNoticeSeverity): number | null {
  if (severity === "success") return 4_000;
  if (severity === "info") return 6_000;
  return null;
}

function omitNotices(
  state: UiNoticeState,
  predicate: (notice: UiNotice) => boolean,
): UiNoticeState {
  const entries = Object.entries(state).filter(([, notice]) => !predicate(notice));
  return entries.length === Object.keys(state).length
    ? state
    : Object.fromEntries(entries);
}
