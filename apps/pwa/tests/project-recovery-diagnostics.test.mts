import assert from "node:assert/strict";
import test from "node:test";
import { ProjectRecoveryDiagnostics, readProjectRecoveryDiagnostics } from "../app/projectRecoveryDiagnostics";
import { waitForProjectTransport } from "../app/projectSendReadiness";
import { createConnectionDiagnostics } from "../app/connectionDiagnostics";
const route = { projectId: "project-1", gatewayNodeId: "gateway-1", roomId: "room-1" };

test("send timeout exports the exact project, recovery phase and safe server error", async () => {
  const trace = new ProjectRecoveryDiagnostics();
  trace.directory([route], 403);
  const started = Date.now();
  await assert.rejects(waitForProjectTransport({
    lookup: () => null, isAuthorized: () => true, signal: new AbortController().signal,
    timeoutMs: 5, intervalMs: 1,
    recover() {
      trace.begin(route.projectId);
      trace.stage(route.projectId, "fetch_grant");
      trace.fail(route.projectId, { errcode: "M_FORBIDDEN", httpStatus: 403, message: "access_token=secret", body: "private message" });
      trace.retry(1000);
    },
    onFailure: reason => trace.sendFailed(reason, route.projectId, "session-1", started),
  }), /still recovering/);
  const report = JSON.parse(createConnectionDiagnostics({ buildVersion: "test", status: "connected", online: true, visibility: "visible", userAgent: "test" }));
  const current = report.projectRecovery.at(-1);
  assert.equal(current.directoryRevision, 403);
  assert.equal(current.sendFailures[0].reason, "transport_timeout");
  assert.equal(current.sendFailures[0].sessionId, "session-1");
  assert.equal(current.sendFailures[0].project.lastFailure.stage, "fetch_grant");
  assert.equal(current.sendFailures[0].project.lastFailure.code, "M_FORBIDDEN");
  assert.equal(current.sendFailures[0].project.lastFailure.httpStatus, 403);
  assert.ok(current.sendFailures[0].project.nextRetryAt);
  assert.equal(JSON.stringify(report).includes("secret"), false);
  assert.equal(JSON.stringify(report).includes("private message"), false);
  trace.stage(route.projectId, "ready");
  trace.stop();
  assert.equal((trace.snapshot().sendFailures[0] as any).project.stage, "fetch_grant");
});

test("route changes retain the old room and expose absent transport and queued projects", () => {
  let now = 100;
  const trace = new ProjectRecoveryDiagnostics(() => now);
  trace.directory([route], 1);
  trace.transport(route.projectId, route.roomId);
  trace.directory([{ ...route, roomId: "room-2", gatewayNodeId: "gateway-2" }], 2);
  now = 200;
  let row = trace.snapshot().projects[0];
  assert.equal(row.previousRoomId, "room-1");
  assert.equal(row.transportRoomId, "room-1");
  assert.equal(row.roomId, "room-2");
  assert.equal(row.stageElapsedMs, 100);
  trace.transport(route.projectId, null);
  trace.directory([], 3);
  row = trace.snapshot().projects[0];
  assert.equal(row.stage, "removed");
  assert.equal(row.transportRoomId, null);
});

test("untrusted errors are redacted, records bounded, snapshots isolated", () => {
  const trace = new ProjectRecoveryDiagnostics();
  trace.directory([route]);
  trace.fail(route.projectId, { errcode: "token-secret", httpStatus: 900, stack: "secret" });
  assert.deepEqual(trace.snapshot().projects[0].lastFailure?.code, "unclassified_error");
  for (let i = 0; i < 30; i++) trace.sendFailed("transport_timeout", route.projectId, undefined, Date.now());
  assert.equal(trace.snapshot().sendFailures.length, 20);
  trace.snapshot().projects[0].stage = "ready";
  assert.equal(trace.snapshot().projects[0].stage, "queued");
  for (let i = 0; i < 5; i++) new ProjectRecoveryDiagnostics().stop();
  assert.equal(readProjectRecoveryDiagnostics().length, 3);
});

test("authorization loss and cancellation are distinguished from timeout", async () => {
  for (const reason of ["unauthorized", "connection_changed"] as const) {
    const controller = new AbortController();
    if (reason === "connection_changed") controller.abort();
    let recorded: string | undefined;
    await assert.rejects(waitForProjectTransport({ lookup: () => null, isAuthorized: () => false,
      recover: () => {}, signal: controller.signal, onFailure: value => { recorded = value; } }));
    assert.equal(recorded, reason);
  }
});

test("a retry retains the prior error until a new failure and keeps the first underlying cause", () => {
  const trace = new ProjectRecoveryDiagnostics();
  trace.directory([route]);
  trace.begin(route.projectId);
  trace.stage(route.projectId, "fetch_grant");
  trace.fail(route.projectId, { errcode: "M_NOT_FOUND" });
  trace.begin(route.projectId);
  assert.equal(trace.snapshot().projects[0].lastFailure?.code, "M_NOT_FOUND");
  trace.stage(route.projectId, "workspace_snapshot");
  trace.failIfUnrecorded(route.projectId, { errcode: "M_FORBIDDEN" });
  trace.stage(route.projectId, "retry_commands");
  trace.failIfUnrecorded(route.projectId, new Error("aggregate failure"));
  assert.equal(trace.snapshot().projects[0].lastFailure?.stage, "workspace_snapshot");
  assert.equal(trace.snapshot().projects[0].lastFailure?.code, "M_FORBIDDEN");
});
