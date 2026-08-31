import type { GatewaySessionSummary } from "./gatewayState";
import type { AgentActivityPhase } from "./agentActivity";
import {
  sessionIndicator,
  type SessionReadState,
} from "./sessionIndicators";
import type { SessionMeaningfulActivityState } from "./sessionMeaningfulActivity";

export type SessionListSignal = "failed" | "ready" | "working" | "idle";

export type SessionStatusTone =
  | SessionListSignal
  | AgentActivityPhase
  | "paused";

export function sessionStatusTone({
  signal,
  activityPhase,
  lifecycleBusy,
  gatewayConnected,
}: {
  signal: SessionListSignal;
  activityPhase?: AgentActivityPhase;
  lifecycleBusy: boolean;
  gatewayConnected: boolean;
}): SessionStatusTone {
  if (
    !gatewayConnected &&
    (lifecycleBusy || activityPhase !== undefined || signal === "working")
  ) {
    return "paused";
  }
  if (lifecycleBusy) return "stopping";
  return activityPhase ?? signal;
}

export type ProjectSessionSummary = Readonly<{
  failed: number;
  ready: number;
  working: number;
  total: number;
}>;

/**
 * Ephemeral ranks keep rows still while activity and unread signals change.
 * Missing sessions remain ranked because a reconnect can expose only a
 * partial project set before the full workspace converges again.
 */
export type SessionDisplayOrder = ReadonlyMap<string, number>;

export function sessionListSignal(
  session: GatewaySessionSummary,
  readState: SessionReadState,
): SessionListSignal {
  const indicator = sessionIndicator(session, readState);
  if (indicator.activity === "failed") return "failed";
  if (indicator.activity === "idle" && indicator.unread) return "ready";
  if (
    indicator.activity === "running" ||
    indicator.activity === "stopping"
  ) {
    return "working";
  }
  return "idle";
}

export function reconcileSessionDisplayOrder(
  current: SessionDisplayOrder,
  sessions: readonly GatewaySessionSummary[],
  meaningfulActivity: SessionMeaningfulActivityState = {},
): SessionDisplayOrder {
  const unseen = sessions
    .filter((session) => !current.has(sessionDisplayKey(session)))
    .sort((left, right) =>
      compareSessionsByRecency(left, right, meaningfulActivity),
    );
  if (unseen.length === 0) return current;

  const next = new Map(current);
  const currentFirstRank = Math.min(0, ...current.values());
  const firstNewRank = currentFirstRank - unseen.length;
  unseen.forEach((session, index) => {
    next.set(sessionDisplayKey(session), firstNewRank + index);
  });
  return next;
}

export function compareSessionsForDisplay(
  left: GatewaySessionSummary,
  right: GatewaySessionSummary,
  order: SessionDisplayOrder,
): number {
  const leftRank = order.get(sessionDisplayKey(left));
  const rightRank = order.get(sessionDisplayKey(right));
  if (leftRank !== undefined && rightRank !== undefined && leftRank !== rightRank) {
    return leftRank - rightRank;
  }
  if (leftRank !== undefined) return -1;
  if (rightRank !== undefined) return 1;
  return compareSessionsByRecency(left, right, {});
}

/** Rebuilds every rank after the user explicitly asks to show latest activity. */
export function rebuildSessionDisplayOrder(
  sessions: readonly GatewaySessionSummary[],
  meaningfulActivity: SessionMeaningfulActivityState,
): SessionDisplayOrder {
  return new Map(
    [...sessions]
      .sort((left, right) =>
        compareSessionsByRecency(left, right, meaningfulActivity),
      )
      .map((session, rank) => [sessionDisplayKey(session), rank]),
  );
}

export function sessionMeaningfulActivityAt(
  session: Pick<GatewaySessionSummary, "id" | "projectId" | "updatedAt">,
  meaningfulActivity: SessionMeaningfulActivityState,
): number {
  return meaningfulActivity[sessionDisplayKey(session)] ?? session.updatedAt;
}

export function sessionHasKnownMeaningfulActivity(
  session: Pick<GatewaySessionSummary, "id" | "projectId">,
  meaningfulActivity: SessionMeaningfulActivityState,
): boolean {
  return meaningfulActivity[sessionDisplayKey(session)] !== undefined;
}

export function sessionDisplayOrderWouldChange(
  current: SessionDisplayOrder,
  sessions: readonly GatewaySessionSummary[],
  meaningfulActivity: SessionMeaningfulActivityState,
): boolean {
  const displayed = [...sessions].sort((left, right) =>
    compareSessionsForDisplay(left, right, current),
  );
  const refreshed = [...sessions].sort((left, right) =>
    compareSessionsByRecency(left, right, meaningfulActivity),
  );
  return displayed.some(
    (session, index) =>
      sessionDisplayKey(session) !== sessionDisplayKey(refreshed[index]!),
  );
}

export function summarizeProjectSessions(
  sessions: readonly GatewaySessionSummary[],
  readState: SessionReadState,
): ProjectSessionSummary {
  let failed = 0;
  let ready = 0;
  let working = 0;
  for (const session of sessions) {
    const signal = sessionListSignal(session, readState);
    if (signal === "failed") failed += 1;
    if (signal === "ready") ready += 1;
    if (signal === "working") working += 1;
  }
  return { failed, ready, working, total: sessions.length };
}

export function projectSessionSummaryLabel(
  projectName: string,
  summary: ProjectSessionSummary,
): string {
  const parts = [projectName];
  if (summary.failed > 0) {
    parts.push(
      `${summary.failed} ${summary.failed === 1 ? "conversation failed" : "conversations failed"}`,
    );
  }
  if (summary.ready > 0) {
    parts.push(
      `${summary.ready} new ${summary.ready === 1 ? "result" : "results"}`,
    );
  }
  if (summary.working > 0) {
    parts.push(
      `${summary.working} ${summary.working === 1 ? "conversation is" : "conversations are"} working`,
    );
  }
  parts.push(`${summary.total} ${summary.total === 1 ? "conversation" : "conversations"}`);
  return parts.join(", ");
}

export function sessionSignalLabel(signal: SessionListSignal): string | null {
  switch (signal) {
    case "failed":
      return "The agent stopped with an error";
    case "ready":
      return "New result ready to review";
    case "working":
      return "Agent is working";
    case "idle":
      return null;
  }
}

function compareSessionsByRecency(
  left: GatewaySessionSummary,
  right: GatewaySessionSummary,
  meaningfulActivity: SessionMeaningfulActivityState,
): number {
  const leftActivityAt = sessionMeaningfulActivityAt(left, meaningfulActivity);
  const rightActivityAt = sessionMeaningfulActivityAt(right, meaningfulActivity);
  if (rightActivityAt !== leftActivityAt) return rightActivityAt - leftActivityAt;
  const title = left.title.localeCompare(right.title);
  return title || sessionDisplayKey(left).localeCompare(sessionDisplayKey(right));
}

export function sessionDisplayKey(
  session: Pick<GatewaySessionSummary, "id" | "projectId">,
): string {
  return `${session.projectId}\0${session.id}`;
}
