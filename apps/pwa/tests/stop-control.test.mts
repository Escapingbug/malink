import assert from "node:assert/strict";
import test from "node:test";
import {
  latestPendingPromptCommandId,
  reconcileStoppingSessionIds,
  selectStopControlTarget,
  stopRequestAccepted,
} from "../app/stopControl.ts";

test("accepts both cancel-command terminal shapes as a successful stop", () => {
  assert.equal(stopRequestAccepted({ outcome: "succeeded" }), true);
  assert.equal(stopRequestAccepted({ outcome: "cancelled" }), true);
  assert.equal(stopRequestAccepted({ outcome: "failed" }), false);
});

test("keeps Stop disabled while a pre-cancel running snapshot races the command", () => {
  const current = new Set(["session-a"]);

  assert.deepEqual(
    [...reconcileStoppingSessionIds(current, [
      { id: "session-a", status: "running" },
    ])],
    ["session-a"],
  );
  assert.deepEqual(
    [...reconcileStoppingSessionIds(current, [
      { id: "session-a", status: "idle" },
    ])],
    [],
  );
});

test("keeps a queued-message stop disabled until its command settles", () => {
  const current = new Set(["session-a"]);
  const idle = [{ id: "session-a", status: "idle" }];

  assert.deepEqual(
    [...reconcileStoppingSessionIds(current, idle, new Set(["session-a"]))],
    ["session-a"],
  );
  assert.deepEqual([...reconcileStoppingSessionIds(current, idle)], []);
});

test("lets a local submission be stopped before older queued or active work", () => {
  assert.deepEqual(
    selectStopControlTarget({
      promptSubmitting: true,
      pendingPromptCommandId: "queued-new",
      activeTurnId: "active-old",
    }),
    { kind: "local-submission" },
  );
  assert.deepEqual(
    selectStopControlTarget({
      promptSubmitting: false,
      pendingPromptCommandId: "queued-new",
      activeTurnId: "active-old",
    }),
    { kind: "queued-prompt", commandId: "queued-new" },
  );
});

test("stops the newest prompt that has not reached the Agent before the active turn", () => {
  const commands = new Map([
    ["active-turn", "session-a"],
    ["queued-follow-up", "session-a"],
    ["other-session", "session-b"],
  ]);

  assert.equal(
    latestPendingPromptCommandId(
      commands,
      "session-a",
      new Set(["active-turn"]),
    ),
    "queued-follow-up",
  );
  assert.equal(
    latestPendingPromptCommandId(
      commands,
      "session-a",
      new Set(["active-turn", "queued-follow-up"]),
    ),
    null,
  );
});
