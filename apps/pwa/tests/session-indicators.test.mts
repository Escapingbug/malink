import assert from "node:assert/strict";
import test from "node:test";
import type { GatewaySessionSummary } from "../app/gatewayState.ts";
import {
  EMPTY_SESSION_READ_STATE,
  SESSION_READ_STATE_STORAGE_KEY,
  countSessionIndicators,
  initializeSessionReadState,
  markSessionRead,
  markSessionReadAt,
  readSessionReadState,
  sessionIndicator,
  writeSessionReadState,
} from "../app/sessionIndicators.ts";

function session(
  id: string,
  status: GatewaySessionSummary["status"],
  updatedAt: number,
): GatewaySessionSummary {
  return {
    id,
    title: id,
    updatedAt,
    status,
    projectId: "project-a",
    projectName: "Project A",
    cwd: "/projects/a",
    provider: "codex",
  };
}

test("first snapshot is a read baseline instead of fabricating historical unread work", () => {
  const sessions = [session("idle", "idle", 10), session("failed", "failed", 20)];
  const state = initializeSessionReadState(EMPTY_SESSION_READ_STATE, sessions);

  assert.equal(state.initialized, true);
  assert.equal(sessionIndicator(sessions[0], state).unread, false);
  assert.deepEqual(sessionIndicator(sessions[0], state), {
    activity: "idle",
    unread: false,
    needsAttention: false,
  });
  assert.equal(sessionIndicator(sessions[1], state).needsAttention, false);
});

test("newer stable updatedAt values create unread and failed-attention indicators", () => {
  const baseline = initializeSessionReadState(
    EMPTY_SESSION_READ_STATE,
    [session("work", "running", 10), session("failure", "idle", 10)],
  );
  const sessions = [
    session("work", "stopping", 11),
    session("failure", "failed", 12),
    session("new", "idle", 1),
    session("archived", "archived", 9),
  ];

  assert.deepEqual(sessionIndicator(sessions[0], baseline), {
    activity: "stopping",
    unread: true,
    needsAttention: false,
  });
  assert.deepEqual(sessionIndicator(sessions[1], baseline), {
    activity: "failed",
    unread: true,
    needsAttention: true,
  });
  assert.equal(sessionIndicator(sessions[2], baseline).unread, true);
  assert.equal(sessionIndicator(sessions[3], baseline).unread, false);
  assert.deepEqual(countSessionIndicators(sessions, baseline), {
    total: 4,
    running: 0,
    stopping: 1,
    failed: 1,
    unread: 3,
    needsAttention: 1,
  });
});

test("viewing a session clears current attention but later selected updates stay unread", () => {
  const failed = session("failure", "failed", 30);
  const initial = {
    initialized: true,
    readUpdatedAt: { failure: 20 },
  } as const;
  const read = markSessionRead(initial, failed);
  assert.equal(sessionIndicator(failed, read).needsAttention, false);

  const refreshed = session("failure", "failed", 31);
  assert.equal(sessionIndicator(refreshed, read).unread, true);
  assert.equal(sessionIndicator(refreshed, read).needsAttention, true);
  assert.equal(
    sessionIndicator(refreshed, markSessionRead(read, refreshed)).unread,
    false,
  );
});

test("a synchronized Matrix receipt advances but never regresses the local marker", () => {
  const initial = {
    initialized: true,
    readUpdatedAt: { shared: 20 },
  } as const;
  const advanced = markSessionReadAt(initial, "shared", 30);
  assert.equal(advanced.readUpdatedAt.shared, 30);
  assert.equal(markSessionReadAt(advanced, "shared", 25), advanced);
});

test("read markers persist safely across partial reconnect snapshots", () => {
  let stored: string | null = null;
  const storage = {
    getItem(key: string) {
      assert.equal(key, SESSION_READ_STATE_STORAGE_KEY);
      return stored;
    },
    setItem(key: string, value: string) {
      assert.equal(key, SESSION_READ_STATE_STORAGE_KEY);
      stored = value;
    },
  };
  const state = {
    initialized: true,
    readUpdatedAt: { removed: 2, current: 4 },
  } as const;

  assert.equal(writeSessionReadState(storage, state), true);
  assert.deepEqual(readSessionReadState(storage), state);
  assert.equal(
    initializeSessionReadState(state, [session("current", "idle", 4)]),
    state,
  );

  stored = '{"version":1,"initialized":true,"read_updated_at":{"x":-1}}';
  assert.equal(readSessionReadState(storage), EMPTY_SESSION_READ_STATE);
  assert.equal(writeSessionReadState(storage, EMPTY_SESSION_READ_STATE), false);
});

test("read marker storage failures are non-fatal", () => {
  assert.equal(
    readSessionReadState({ getItem() { throw new Error("blocked"); } }),
    EMPTY_SESSION_READ_STATE,
  );
  assert.equal(
    writeSessionReadState(
      { setItem() { throw new Error("full"); } },
      { initialized: true, readUpdatedAt: { a: 1 } },
    ),
    false,
  );
});
