import assert from "node:assert/strict";
import test from "node:test";
import { readTurnCompletionCache, writeTurnCompletionCache } from "../app/turnCompletionCache";
import { completedTurnPresentation } from "../app/turnPresentation";

function storage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); } };
}
test("refresh preserves folded steps before network completion replay", () => {
  const cache = storage();
  writeTurnCompletionCache(cache, "account-room", [{ commandId: "turn", sessionId: "session",
    outcome: "succeeded", observedOrder: 1, sequence: 2, revision: 3 }]);
  const restored = completedTurnPresentation([
    { id: "tool", kind: "tool", commandId: "turn" },
    { id: "result", kind: "agent", commandId: "turn", text: "Done" },
  ], readTurnCompletionCache(cache, "account-room"), "session");
  assert.equal(restored.processByMessageId.get("tool")?.stepCount, 1);
  assert.equal(restored.resultByMessageId.has("result"), true);
  assert.deepEqual(readTurnCompletionCache(cache, "another-account"), []);
});
test("cache stores only terminal presentation metadata and deduplicates replay", () => {
  const cache = storage();
  for (let i = 0; i < 2; i++) writeTurnCompletionCache(cache, "scope", [{
    commandId: "turn", sessionId: "session", outcome: "cancelled", observedOrder: i,
    sequence: 2, revision: 3, result: "must not cache business payload",
  }]);
  const entries = readTurnCompletionCache(cache, "scope");
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.outcome, "cancelled");
  assert.equal(entries[0]?.result, undefined);
});
test("malformed or nonterminal entries do not collapse running turns", () => {
  const entries = readTurnCompletionCache({ getItem: () => JSON.stringify([
    { commandId: "running", sessionId: "session", outcome: "running" }, null,
  ]) }, "scope");
  assert.deepEqual(entries, []);
});
