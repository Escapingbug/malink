import type { ObservedCommandCompletion } from "./turnPresentation";

// Presentation metadata only. Never used to authorize or reconcile commands.
const key = (scope: string) => `malink.turn-completions.v1:${scope}`;
export function readTurnCompletionCache(
  storage: Pick<Storage, "getItem">, scope: string,
): ObservedCommandCompletion[] {
  if (!scope) return [];
  const raw = storage.getItem(key(scope));
  if (!raw) return [];
  const entries: unknown = JSON.parse(raw);
  if (!Array.isArray(entries)) return [];
  return entries.flatMap((entry, index) => {
    if (!entry || typeof entry !== "object"
      || typeof entry.commandId !== "string" || typeof entry.sessionId !== "string"
      || !["succeeded", "failed", "cancelled"].includes(entry.outcome)) return [];
    return [{ commandId: entry.commandId, sessionId: entry.sessionId,
      outcome: entry.outcome, sequence: 0, revision: 0, observedOrder: index }];
  }).slice(-2_000);
}

export function writeTurnCompletionCache(
  storage: Pick<Storage, "getItem" | "setItem">, scope: string,
  completions: readonly ObservedCommandCompletion[],
): void {
  if (!scope || completions.length === 0) return;
  const entries = new Map(readTurnCompletionCache(storage, scope)
    .map(entry => [entry.commandId, entry]));
  for (const completion of completions) {
    if (completion.sessionId) entries.set(completion.commandId, completion);
  }
  storage.setItem(key(scope), JSON.stringify([...entries.values()].slice(-2_000).map(
    ({ commandId, sessionId, outcome }) => ({ commandId, sessionId, outcome }),
  )));
}
