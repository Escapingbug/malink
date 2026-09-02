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
