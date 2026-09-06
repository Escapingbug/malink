import type { CommandCompletion } from "./commandLifecycle";

export type StopControlTarget =
  | { kind: "local-submission" }
  | { kind: "queued-prompt"; commandId: string }
  | { kind: "active-turn"; commandId: string }
  | { kind: "unavailable" };

export function selectStopControlTarget(input: {
  promptSubmitting: boolean;
  pendingPromptCommandId: string | null;
  activeTurnId: string | null;
}): StopControlTarget {
  if (input.promptSubmitting) return { kind: "local-submission" };
  if (input.pendingPromptCommandId) {
    return { kind: "queued-prompt", commandId: input.pendingPromptCommandId };
  }
  if (input.activeTurnId) {
    return { kind: "active-turn", commandId: input.activeTurnId };
  }
  return { kind: "unavailable" };
}

export function stopRequestAccepted(
  completion: Pick<CommandCompletion, "outcome">,
): boolean {
  return completion.outcome === "succeeded" || completion.outcome === "cancelled";
}

export function latestPendingPromptCommandId(
  commands: ReadonlyMap<string, string>,
  sessionId: string,
  agentReceivedCommandIds: ReadonlySet<string>,
): string | null {
  let latest: string | null = null;
  for (const [commandId, commandSessionId] of commands) {
    if (
      commandSessionId === sessionId &&
      !agentReceivedCommandIds.has(commandId)
    ) {
      latest = commandId;
    }
  }
  return latest;
}

/**
 * A Gateway snapshot can still describe the pre-cancel running state while
 * the signed cancel command is in flight. Preserve that local stop request so
 * the button stays disabled until a terminal result or idle state arrives.
 */
export function reconcileStoppingSessionIds(
  current: ReadonlySet<string>,
  sessions: readonly { id: string; status: string }[],
  pendingPromptSessionIds: ReadonlySet<string> = new Set(),
): Set<string> {
  const sessionsById = new Map(sessions.map(session => [session.id, session]));
  const next = new Set(
    sessions
      .filter(session => session.status === "stopping")
      .map(session => session.id),
  );
  for (const sessionId of current) {
    const session = sessionsById.get(sessionId);
    if (
      session &&
      (session.status === "running" || pendingPromptSessionIds.has(sessionId))
    ) {
      next.add(sessionId);
    }
  }
  return next;
}
