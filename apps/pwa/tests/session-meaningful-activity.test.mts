import assert from "node:assert/strict";
import test from "node:test";
import {
  EMPTY_SESSION_MEANINGFUL_ACTIVITY,
  SESSION_MEANINGFUL_ACTIVITY_STORAGE_KEY,
  isMeaningfulSessionMessage,
  readSessionMeaningfulActivity,
  recordSessionMeaningfulActivity,
  writeSessionMeaningfulActivity,
} from "../app/sessionMeaningfulActivity.ts";

test("only visible message results advance meaningful activity", () => {
  assert.equal(isMeaningfulSessionMessage({
    kind: "agent",
    raw: { type: "assistant.message", final: false },
  }), true);
  assert.equal(isMeaningfulSessionMessage({
    kind: "user",
    raw: { type: "turn.queued" },
  }), true);
  assert.equal(isMeaningfulSessionMessage({
    kind: "permission",
    raw: { type: "decision.requested" },
  }), true);
  assert.equal(isMeaningfulSessionMessage({
    kind: "error",
    raw: { type: "turn.failed" },
  }), true);
  assert.equal(isMeaningfulSessionMessage({
    kind: "tool",
    raw: { type: "tool.activity", phase: "completed" },
  }), true);
  assert.equal(isMeaningfulSessionMessage({
    kind: "tool",
    raw: { type: "tool.activity", phase: "failed" },
  }), true);

  assert.equal(isMeaningfulSessionMessage({
    kind: "tool",
    raw: { type: "tool.activity", phase: "started" },
  }), false);
  assert.equal(isMeaningfulSessionMessage({
    kind: "tool",
    raw: { type: "tool.activity", phase: "updated" },
  }), false);
  assert.equal(isMeaningfulSessionMessage({
    kind: "notice",
    raw: { kind: "status", state: "working" },
  }), false);
});

test("meaningful activity timestamps are monotonic and persist safely", () => {
  const first = recordSessionMeaningfulActivity(
    EMPTY_SESSION_MEANINGFUL_ACTIVITY,
    "project-a\0session-a",
    100,
  );
  assert.equal(first["project-a\0session-a"], 100);
  assert.equal(
    recordSessionMeaningfulActivity(first, "project-a\0session-a", 90),
    first,
  );

  const values = new Map<string, string>();
  const storage = {
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
  };
  assert.equal(writeSessionMeaningfulActivity(storage, first), true);
  assert.deepEqual(readSessionMeaningfulActivity(storage), first);

  values.set(SESSION_MEANINGFUL_ACTIVITY_STORAGE_KEY, "{broken");
  assert.equal(
    readSessionMeaningfulActivity(storage),
    EMPTY_SESSION_MEANINGFUL_ACTIVITY,
  );
});
