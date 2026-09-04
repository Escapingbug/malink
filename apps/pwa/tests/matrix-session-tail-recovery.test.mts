import assert from "node:assert/strict";
import test from "node:test";
import type { V3ProjectedSession } from "../app/matrixMlp3Projection.ts";
import {
  matrixActiveSessionTailRecoveryTargets,
  matrixSessionReadReceiptRetryDelayMs,
  workspaceRouteRecoveryDelayMs,
} from "../app/matrixMlp3Connection.ts";

test("repairs only active session projections from recent Matrix thread tails", () => {
  const sessions = [
    session("working-old", "working", "active", 10),
    session("idle", "idle", "active", 20),
    session("working-new", "attention", "active", 30),
    session("archived", "working", "archived", 5),
  ];

  assert.deepEqual(matrixActiveSessionTailRecoveryTargets(sessions), [
    { sessionId: "working-old", threadRootEventId: "$working-old" },
    { sessionId: "working-new", threadRootEventId: "$working-new" },
  ]);
});

test("retries incomplete Workspace routes with bounded backoff", () => {
  assert.deepEqual(
    [0, 1, 2, 3, 4, 5, 100].map(workspaceRouteRecoveryDelayMs),
    [1_000, 2_000, 5_000, 10_000, 30_000, 60_000, 60_000],
  );
  assert.throws(() => workspaceRouteRecoveryDelayMs(-1), TypeError);
});

test("retries private session read receipts with bounded backoff", () => {
  assert.deepEqual(
    [0, 1, 2, 3, 4, 5, 100].map(matrixSessionReadReceiptRetryDelayMs),
    [1_000, 2_000, 5_000, 10_000, 30_000, 60_000, 60_000],
  );
  assert.throws(() => matrixSessionReadReceiptRetryDelayMs(-1), TypeError);
});

function session(
  sessionId: string,
  activity: V3ProjectedSession["activity"],
  lifecycle: V3ProjectedSession["lifecycle"],
  updatedAt: number,
): V3ProjectedSession {
  return {
    sessionId,
    projectId: "project-1",
    threadRootEventId: `$${sessionId}`,
    title: sessionId,
    lifecycle,
    activity,
    updatedAt,
    stateVersion: updatedAt,
  };
}
