import assert from "node:assert/strict";
import test from "node:test";
import type { V3ProjectedSession } from "../app/matrixMlp3Projection.ts";
import { matrixActiveSessionTailRecoveryTargets } from "../app/matrixMlp3Connection.ts";

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
