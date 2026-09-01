import assert from "node:assert/strict";
import test from "node:test";
import type { GatewaySessionSummary } from "../app/gatewayState.ts";
import {
  compareSessionsForDisplay,
  projectSessionSummaryLabel,
  reconcileSessionDisplayOrder,
  sessionDisplayKey,
  sessionDisplayPriority,
  sessionMeaningfulActivityAt,
  sessionListSignal,
  sessionSignalLabel,
  sessionStatusTone,
  summarizeProjectSessions,
} from "../app/sessionListOrder.ts";
import type { SessionReadState } from "../app/sessionIndicators.ts";

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
    extensions: [],
  };
}

const readState: SessionReadState = {
  initialized: true,
  readUpdatedAt: {
    failed: 20,
    ready: 10,
    working: 30,
    idle: 100,
  },
};

test("derives quiet visual signals from lifecycle and read state", () => {
  assert.equal(sessionListSignal(session("failed", "failed", 20), readState), "failed");
  assert.equal(sessionListSignal(session("ready", "idle", 11), readState), "ready");
  assert.equal(sessionListSignal(session("working", "running", 30), readState), "working");
  assert.equal(sessionListSignal(session("idle", "idle", 40), readState), "idle");
  assert.equal(sessionSignalLabel("idle"), null);
  assert.equal(sessionSignalLabel("ready"), "Reply needed");
  assert.equal(sessionSignalLabel("failed"), "Review agent error");
});

test("assigns distinct tones to live session status text", () => {
  assert.equal(sessionStatusTone({
    signal: "idle",
    activityPhase: "sending",
    lifecycleBusy: false,
    gatewayConnected: true,
  }), "sending");
  assert.equal(sessionStatusTone({
    signal: "working",
    activityPhase: "waiting",
    lifecycleBusy: false,
    gatewayConnected: true,
  }), "waiting");
  assert.equal(sessionStatusTone({
    signal: "working",
    activityPhase: "working",
    lifecycleBusy: false,
    gatewayConnected: false,
  }), "paused");
  assert.equal(sessionStatusTone({
    signal: "ready",
    lifecycleBusy: false,
    gatewayConnected: true,
  }), "ready");
  assert.equal(sessionStatusTone({
    signal: "failed",
    lifecycleBusy: false,
    gatewayConnected: true,
  }), "failed");
  assert.equal(sessionStatusTone({
    signal: "idle",
    lifecycleBusy: true,
    gatewayConnected: true,
  }), "stopping");
});

test("moves actionable activity ahead of quiet conversations", () => {
  const initial = [
    session("first", "idle", 100),
    session("second", "idle", 90),
  ];
  const order = reconcileSessionDisplayOrder(new Map(), initial);
  const updated = [
    session("first", "idle", 100),
    session("second", "running", 110),
  ];
  const read = {
    initialized: true,
    readUpdatedAt: { first: 100, second: 110 },
  } as const;
  assert.equal(sessionListSignal(updated[1]!, read), "working");
  updated.sort((left, right) =>
    compareSessionsForDisplay(left, right, order, read)
  );
  assert.deepEqual(updated.map((item) => item.id), ["second", "first"]);
});

test("keeps rows stable within an attention lane", () => {
  const initial = [
    session("first", "idle", 100),
    session("second", "idle", 90),
  ];
  const order = reconcileSessionDisplayOrder(new Map(), initial);
  const meaningfulActivity = {
    [sessionDisplayKey(initial[0]!)]: 100,
    [sessionDisplayKey(initial[1]!)]: 120,
  };
  const unread = {
    initialized: true,
    readUpdatedAt: { first: 0, second: 0 },
  } as const;

  const stable = [...initial].sort((left, right) =>
    compareSessionsForDisplay(left, right, order, unread),
  );
  assert.deepEqual(stable.map((item) => item.id), ["first", "second"]);
  assert.equal(
    sessionMeaningfulActivityAt(initial[1]!, meaningfulActivity),
    120,
  );
});

test("orders error review, replies, work, then quiet rows", () => {
  const sessions = [
    session("idle", "idle", 40),
    session("working", "running", 30),
    session("ready", "idle", 11),
    session("failed", "failed", 20),
  ];
  const attentionState = {
    initialized: true,
    readUpdatedAt: { idle: 40, working: 30, ready: 10, failed: 19 },
  } as const;
  const order = reconcileSessionDisplayOrder(new Map(), sessions);

  sessions.sort((left, right) =>
    compareSessionsForDisplay(left, right, order, attentionState)
  );

  assert.deepEqual(
    sessions.map((item) => item.id),
    ["failed", "ready", "working", "idle"],
  );
  assert.deepEqual(
    sessions.map((item) => sessionDisplayPriority(item, attentionState)),
    [0, 1, 2, 3],
  );
});

test("reviewed failures keep their status without occupying attention", () => {
  const failed = session("failed", "failed", 20);

  assert.equal(sessionListSignal(failed, readState), "failed");
  assert.equal(sessionDisplayPriority(failed, readState), 3);
  assert.deepEqual(
    summarizeProjectSessions([failed], readState),
    { failed: 0, ready: 0, working: 0, total: 1 },
  );
});

test("places genuinely new sessions first without forgetting temporarily absent rows", () => {
  const initial = [
    session("first", "idle", 100),
    session("second", "idle", 90),
  ];
  const order = reconcileSessionDisplayOrder(new Map(), initial);
  const partial = reconcileSessionDisplayOrder(order, [initial[0]!]);
  assert.equal(partial, order);

  const restored = [
    session("second", "idle", 200),
    session("new", "idle", 120),
    session("first", "idle", 100),
  ];
  const next = reconcileSessionDisplayOrder(partial, restored);
  const unread = {
    initialized: true,
    readUpdatedAt: { second: 0, new: 0, first: 0 },
  } as const;
  restored.sort((left, right) =>
    compareSessionsForDisplay(left, right, next, unread)
  );
  assert.deepEqual(restored.map((item) => item.id), ["new", "first", "second"]);
});

test("summarizes project urgency into distinct compact signals", () => {
  const attentionState = {
    initialized: true,
    readUpdatedAt: { failed: 19, ready: 10, working: 30, idle: 40 },
  } as const;
  const summary = summarizeProjectSessions(
    [
      session("failed", "failed", 20),
      session("ready", "idle", 11),
      session("working", "stopping", 30),
      session("idle", "idle", 40),
    ],
    attentionState,
  );
  assert.deepEqual(summary, { failed: 1, ready: 1, working: 1, total: 4 });
  assert.equal(
    projectSessionSummaryLabel("Project A", summary),
    "Project A, 1 error to review, 1 reply needed, 1 conversation working, 4 conversations",
  );
});
