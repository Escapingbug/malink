import type { CommandCompletion } from "./commandLifecycle";

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
