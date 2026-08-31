import assert from "node:assert/strict";
import test from "node:test";
import type { GatewaySessionSummary } from "../app/gatewayState.ts";
import {
  compareSessionsForDisplay,
  projectSessionSummaryLabel,
  reconcileSessionDisplayOrder,
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

test("keeps session rows stable when activity, recency, or read state changes", () => {
  const initial = [
    session("first", "idle", 100),
    session("second", "idle", 90),
  ];
  const order = reconcileSessionDisplayOrder(new Map(), initial);
  const updated = [
    session("first", "idle", 100),
    session("second", "running", 110),
  ];
  updated.sort((left, right) => compareSessionsForDisplay(left, right, order));
  assert.deepEqual(updated.map((item) => item.id), ["first", "second"]);

  const read = {
    initialized: true,
    readUpdatedAt: { first: 100, second: 110 },
  } as const;
  assert.equal(sessionListSignal(updated[1]!, read), "working");
  updated.sort((left, right) => compareSessionsForDisplay(left, right, order));
  assert.deepEqual(updated.map((item) => item.id), ["first", "second"]);
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
  restored.sort((left, right) => compareSessionsForDisplay(left, right, next));
  assert.deepEqual(restored.map((item) => item.id), ["new", "first", "second"]);
});

test("summarizes project urgency into distinct compact signals", () => {
  const summary = summarizeProjectSessions(
    [
      session("failed", "failed", 20),
      session("ready", "idle", 11),
      session("working", "stopping", 30),
      session("idle", "idle", 40),
    ],
    readState,
  );
  assert.deepEqual(summary, { failed: 1, ready: 1, working: 1, total: 4 });
  assert.equal(
    projectSessionSummaryLabel("Project A", summary),
    "Project A, 1 conversation failed, 1 new result, 1 conversation is working, 4 conversations",
  );
});
