import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentActivityIndicator } from "../app/AgentActivityIndicator.tsx";
import {
  SENDING_AGENT_ACTIVITY,
  STARTING_AGENT_ACTIVITY,
  STOPPING_AGENT_ACTIVITY,
  WAITING_AGENT_ACTIVITY,
  WORKING_AGENT_ACTIVITY,
  agentExecutionSignal,
  agentActivityForPhase,
  formatAgentActivityAge,
  agentActivityWatermarkForEvent,
  agentActivityWatermarkForSession,
  isAgentActivityEvent,
  isStaleAgentActivityWatermark,
  mergeAgentActivityWatermark,
  reduceAgentActivity,
  shouldApplyAgentActivity,
} from "../app/agentActivity.ts";

test("renders the exact and relative Agent activity time without a live-region timer", () => {
  const updatedAt = Date.now() - 5_000;
  const active = renderToStaticMarkup(createElement(AgentActivityIndicator, {
    activity: WORKING_AGENT_ACTIVITY,
    updatedAt,
  }));
  const waiting = renderToStaticMarkup(createElement(AgentActivityIndicator, {
    activity: WAITING_AGENT_ACTIVITY,
  }));

  assert.match(active, /Last Agent activity/);
  assert.match(active, /<time dateTime=/);
  assert.match(active, /5s ago/);
  assert.match(waiting, /No Agent activity received yet/);
  assert.doesNotMatch(active, /activity-last-update[^>]*aria-live/);
});

test("formats a live, compact age for the last session activity", () => {
  const updatedAt = 1_000_000;
  assert.equal(formatAgentActivityAge(updatedAt, updatedAt), "just now");
  assert.equal(formatAgentActivityAge(updatedAt, updatedAt + 4_999), "just now");
  assert.equal(formatAgentActivityAge(updatedAt, updatedAt + 5_000), "5s ago");
  assert.equal(formatAgentActivityAge(updatedAt, updatedAt + 59_999), "59s ago");
  assert.equal(formatAgentActivityAge(updatedAt, updatedAt + 60_000), "1m ago");
  assert.equal(formatAgentActivityAge(updatedAt, updatedAt + 3_600_000), "1h ago");
  assert.equal(formatAgentActivityAge(updatedAt, updatedAt + 86_400_000), "1d ago");
  assert.equal(formatAgentActivityAge(updatedAt, updatedAt - 1_000), "just now");
});

test("only semantic Agent events may advance a session activity watermark", () => {
  assert.equal(isAgentActivityEvent({ type: "assistant.message" }), true);
  assert.equal(isAgentActivityEvent({ type: "turn.completed" }), true);
  assert.equal(isAgentActivityEvent({ kind: "status", state: "idle" }), true);
  assert.equal(isAgentActivityEvent({ kind: "decision_request" }), true);
  assert.equal(isAgentActivityEvent({ kind: "collaboration_command" }), false);
  assert.equal(isAgentActivityEvent({ kind: "status", state: "unknown" }), false);
});

test("rejects activity callbacks older than an authoritative terminal state", () => {
  const terminal = agentActivityWatermarkForSession({
    stateVersion: 17,
    updatedAt: 1_000,
  });
  const delayedAssistant = agentActivityWatermarkForEvent({
    timestamp: 990,
    raw: {
      type: "assistant.message",
      projection: { stateVersion: 16, updatedAt: 900 },
    },
  });
  const sameTerminal = agentActivityWatermarkForEvent({
    timestamp: 1_010,
    raw: {
      type: "turn.completed",
      projection: { stateVersion: 17, updatedAt: 1_000 },
    },
  });

  assert.equal(isStaleAgentActivityWatermark(terminal, delayedAssistant), true);
  assert.equal(isStaleAgentActivityWatermark(terminal, sameTerminal), false);
});

test("uses timestamps for old native hosts and preserves the version fence", () => {
  const terminal = { stateVersion: 17, updatedAt: 1_000 };
  const delayedUser = agentActivityWatermarkForEvent({ timestamp: 999, raw: {} });
  const nextUser = agentActivityWatermarkForEvent({ timestamp: 1_001, raw: {} });

  assert.equal(isStaleAgentActivityWatermark(terminal, delayedUser), true);
  assert.equal(isStaleAgentActivityWatermark(terminal, nextUser), false);
  assert.deepEqual(mergeAgentActivityWatermark(terminal, nextUser), {
    stateVersion: 17,
    updatedAt: 1_001,
  });

  const nextTurn = { stateVersion: 18, updatedAt: 1_000 };
  assert.equal(isStaleAgentActivityWatermark(terminal, nextTurn), false);
  assert.deepEqual(mergeAgentActivityWatermark(
    mergeAgentActivityWatermark(terminal, nextUser),
    nextTurn,
  ), nextTurn);
});

test("exports stable, human-readable activity for local transitions", () => {
  assert.deepEqual(SENDING_AGENT_ACTIVITY, {
    phase: "sending",
    label: "Sending…",
  });
  assert.deepEqual(STARTING_AGENT_ACTIVITY, {
    phase: "starting",
    label: "Starting agent…",
  });
  assert.deepEqual(WAITING_AGENT_ACTIVITY, {
    phase: "waiting",
    label: "Message sent · Waiting for agent…",
  });
  assert.deepEqual(WORKING_AGENT_ACTIVITY, {
    phase: "working",
    label: "Agent is working…",
  });
  assert.deepEqual(STOPPING_AGENT_ACTIVITY, {
    phase: "stopping",
    label: "Stopping agent…",
  });
  assert.deepEqual(agentActivityForPhase("working", "  Reading files  "), {
    phase: "working",
    label: "Agent is working…",
    detail: "Reading files",
  });
});

test("derives activity from explicit Matrix status phases", () => {
  assert.equal(
    reduceAgentActivity(SENDING_AGENT_ACTIVITY, {
      version: 1,
      kind: "status",
      state: "running",
      activity_phase: "starting",
      provider: "codex",
    }),
    STARTING_AGENT_ACTIVITY,
  );

  assert.equal(
    reduceAgentActivity(WORKING_AGENT_ACTIVITY, {
      kind: "status",
      state: "running",
      activity_phase: "starting",
    }),
    WORKING_AGENT_ACTIVITY,
  );

  assert.equal(
    reduceAgentActivity(STARTING_AGENT_ACTIVITY, {
      kind: "status",
      state: "running",
      activity_phase: "working",
    }),
    WORKING_AGENT_ACTIVITY,
  );
});

test("maps queued and started MLP/3 turns to their actual execution phases", () => {
  assert.equal(
    reduceAgentActivity(SENDING_AGENT_ACTIVITY, {
      type: "turn.queued",
      turnId: "turn-1",
    }),
    STARTING_AGENT_ACTIVITY,
  );
  assert.equal(
    reduceAgentActivity(STARTING_AGENT_ACTIVITY, {
      type: "turn.started",
      turnId: "turn-1",
    }),
    WORKING_AGENT_ACTIVITY,
  );
  assert.equal(
    reduceAgentActivity(STARTING_AGENT_ACTIVITY, {
      type: "assistant.message",
    }),
    WORKING_AGENT_ACTIVITY,
  );
  assert.equal(
    reduceAgentActivity(WORKING_AGENT_ACTIVITY, {
      type: "turn.queued",
      turnId: "turn-2",
    }),
    WORKING_AGENT_ACTIVITY,
    "a queued follow-up must not make an active turn look idle",
  );
});

test("authenticated status drives every connected device", () => {
  assert.equal(
    reduceAgentActivity(null, {
      kind: "status",
      state: "running",
      activity_phase: "working",
    }),
    WORKING_AGENT_ACTIVITY,
  );
  assert.equal(
    reduceAgentActivity(WORKING_AGENT_ACTIVITY, {
      kind: "status",
      state: "stopping",
    }),
    STOPPING_AGENT_ACTIVITY,
  );
  assert.equal(
    reduceAgentActivity(STOPPING_AGENT_ACTIVITY, {
      kind: "status",
      state: "idle",
    }),
    null,
  );
  assert.equal(
    reduceAgentActivity(WORKING_AGENT_ACTIVITY, {
      kind: "status",
      state: "failed",
    }),
    null,
  );
});

test("only authenticated status changes the interruptible execution state", () => {
  assert.equal(
    agentExecutionSignal({ kind: "status", state: "running" }),
    "running",
  );
  assert.equal(
    agentExecutionSignal({ kind: "status", state: "stopping" }),
    "stopping",
  );
  assert.equal(
    agentExecutionSignal({ kind: "message", operation_id: "message-1" }),
    null,
  );
  assert.equal(
    agentExecutionSignal({ kind: "decision_request", decision_id: "decision-1" }),
    null,
  );
  assert.equal(
    agentExecutionSignal({ kind: "status", state: "idle" }),
    "stopped",
  );
});

test("only live events for the selected session may drive activity", () => {
  assert.equal(
    shouldApplyAgentActivity("session-a", { sessionId: "session-a" }),
    true,
  );
  assert.equal(
    shouldApplyAgentActivity("session-a", { sessionId: "session-b" }),
    false,
  );
  assert.equal(
    shouldApplyAgentActivity("session-a", {
      sessionId: "session-a",
      historical: true,
    }),
    false,
  );
  assert.equal(
    shouldApplyAgentActivity("session-a", {
      sessionId: "session-a",
      deliveryMode: "catchup",
    }),
    false,
  );
  assert.equal(
    shouldApplyAgentActivity(null, { sessionId: "session-a" }),
    false,
  );
});

test("visible tools keep the active turn visible while permissions provide useful detail", () => {
  assert.equal(
    reduceAgentActivity(STARTING_AGENT_ACTIVITY, {
      kind: "message",
      operation_id: "tool-message-1",
      ui: { kind: "tool_group" },
    }),
    WORKING_AGENT_ACTIVITY,
  );
  assert.equal(
    reduceAgentActivity(WAITING_AGENT_ACTIVITY, {
      type: "tool.activity",
    }),
    WORKING_AGENT_ACTIVITY,
  );
  assert.deepEqual(
    reduceAgentActivity(WORKING_AGENT_ACTIVITY, {
      kind: "decision_request",
      decision_id: "permission-1",
      title: "Allow shell access?",
    }),
    {
      phase: "working",
      label: "Waiting for permission…",
      detail: "Allow shell access?",
    },
  );
});

test("a visible reply stays working until the turn terminates", () => {
  assert.equal(
    reduceAgentActivity(WORKING_AGENT_ACTIVITY, {
      kind: "message",
      operation_id: "message-1",
    }),
    WORKING_AGENT_ACTIVITY,
  );
  assert.equal(
    reduceAgentActivity(WORKING_AGENT_ACTIVITY, {
      type: "turn.completed",
      turnId: "turn-1",
    }),
    null,
  );
});

test("unrelated and malformed events preserve the current activity", () => {
  assert.equal(
    reduceAgentActivity(STARTING_AGENT_ACTIVITY, { kind: "collaboration_command" }),
    STARTING_AGENT_ACTIVITY,
  );
  assert.equal(
    reduceAgentActivity(WORKING_AGENT_ACTIVITY, {
      kind: "unknown",
    }),
    WORKING_AGENT_ACTIVITY,
  );
  assert.equal(
    reduceAgentActivity(STOPPING_AGENT_ACTIVITY, null),
    STOPPING_AGENT_ACTIVITY,
  );
});
