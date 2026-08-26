import type { ProviderSessionEntry } from "@malink/protocol";

export type ProviderHistorySessionKind = "archived" | "provider" | "active";

export type ProviderHistorySessionGroup = {
  id: ProviderHistorySessionKind;
  label: string;
  sessions: ProviderSessionEntry[];
};

const GROUPS: ReadonlyArray<{
  id: ProviderHistorySessionKind;
  label: string;
}> = [
  { id: "archived", label: "Archived from Malink" },
  { id: "provider", label: "Provider-only" },
  { id: "active", label: "Current in Malink" },
];

export function providerHistorySessionKind(
  session: ProviderSessionEntry,
): ProviderHistorySessionKind {
  if (session.managedSessionId) return "active";
  if (session.latestArchivedSessionId && session.lastArchivedAt !== undefined) {
    return "archived";
  }
  return "provider";
}

export function providerHistorySessionTimestamp(session: ProviderSessionEntry): number {
  return providerHistorySessionKind(session) === "archived"
    ? session.lastArchivedAt ?? 0
    : session.updatedAt;
}

export function groupProviderHistorySessions(
  sessions: readonly ProviderSessionEntry[],
): ProviderHistorySessionGroup[] {
  return GROUPS.flatMap(group => {
    const grouped = sessions
      .filter(session => providerHistorySessionKind(session) === group.id)
      .sort(compareProviderHistorySessions);
    return grouped.length > 0 ? [{ ...group, sessions: grouped }] : [];
  });
}

export function findRecentlyArchivedProviderSession(
  sessions: readonly ProviderSessionEntry[],
  malinkSessionId: string,
): ProviderSessionEntry | null {
  return sessions.find(session =>
    session.latestArchivedSessionId === malinkSessionId
    && !session.managedSessionId
  ) ?? null;
}

function compareProviderHistorySessions(
  left: ProviderSessionEntry,
  right: ProviderSessionEntry,
): number {
  const timestampDifference = providerHistorySessionTimestamp(right)
    - providerHistorySessionTimestamp(left);
  if (timestampDifference !== 0) return timestampDifference;
  if (left.title !== right.title) return left.title < right.title ? -1 : 1;
  if (left.sessionId === right.sessionId) return 0;
  return left.sessionId < right.sessionId ? -1 : 1;
}
