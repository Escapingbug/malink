import assert from "node:assert/strict";
import test from "node:test";
import { bulkGroupSessions, bulkArchiveEligible } from "../app/bulkArchivePolicy.ts";

const sessions = [
  { id: "a", projectId: "real-a", scope: "scratch", node: "one", status: "idle" },
  { id: "b", projectId: "real-b", scope: "scratch", node: "one", status: "idle" },
  { id: "c", projectId: "real-c", scope: "scratch", node: "two", status: "idle" },
  { id: "d", projectId: "real-a", scope: "project", node: "one", status: "idle" },
  { id: "e", projectId: "real-a", scope: "project", node: "one", status: "running" },
];
test("Temporary selects real session routes only from its owning Gateway", () => {
  const selected = bulkGroupSessions(sessions, { projectId: "scratch:one", temporary: true, gatewayNodeId: "one" }, s => s.node);
  assert.deepEqual(selected.map(s => s.id), ["a", "b"]);
  assert.deepEqual(selected.map(s => s.projectId), ["real-a", "real-b"]);
});
test("project selection includes all loaded members, excludes scratch and ineligible sessions", () => {
  const selected = bulkGroupSessions(sessions, { projectId: "real-a", temporary: false, gatewayNodeId: "one" }, s => s.node);
  assert.deepEqual(selected.map(s => s.id), ["d", "e"]);
  assert.deepEqual(selected.filter(s => bulkArchiveEligible(s.status, false, false)).map(s => s.id), ["d"]);
});
test("empty groups have no selectable sessions", () => {
  assert.deepEqual(bulkGroupSessions(sessions, { projectId: "missing", temporary: false, gatewayNodeId: "one" }, s => s.node), []);
});
