import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import type { GatewayDeploymentStatus } from "@malink/protocol";
import type { GatewayStateSnapshot } from "../app/gatewayState";
import { gatewayRecoveryTarget, gatewayRecoveryTitle, gatewayRecoveryReport, preferredGatewayCreationWorkspace } from "../app/gatewayRecovery";
import { toLegacyCompletion, isMatrixMlp3ProjectionEventType } from "../app/matrixMlp3Connection";

const deployment = {
  version: 1, strategy: "blue-green-v1", maxDeployments: 2,
  computerId: "computer", generation: 1, phase: "trial", updateId: "update-1", updatedAt: 1,
  active: { gatewayNodeId: "old", buildId: "old-build", projectCount: 1, sessionCount: 1 },
  candidate: { gatewayNodeId: "new", buildId: "new-build", projectCount: 1, sessionCount: 1 },
} as GatewayDeploymentStatus;

function state(archived = false): GatewayStateSnapshot {
  return {
    workspace: { projectId: "new-project", provider: "agent" },
    projects: [{ projectId: "old-project", provider: "agent" }],
    gatewayDirectory: { directory: { gateways: [
      { gatewayNodeId: "old", projects: [{ projectId: "old-project" }] },
      { gatewayNodeId: "new", projects: [{ projectId: "new-project" }] },
    ] } },
    gatewayNodeStatuses: { old: { update: { maintenanceSessionId: "maintenance" } } },
    sessions: [
      { id: "maintenance", projectId: "new-project", status: "idle" },
      { id: "maintenance", projectId: "old-project", status: archived ? "archived" : "idle" },
    ],
  } as unknown as GatewayStateSnapshot;
}

test("deployment commands retain their signed result and cold state is ingested", () => {
  const completion = toLegacyCompletion({ commandId: "deploy", outcome: "succeeded",
    event: { payload: { type: "gateway.deployment.status", status: deployment } },
  } as Parameters<typeof toLegacyCompletion>[0]);
  assert.deepEqual(completion.result, deployment);
  assert.equal(isMatrixMlp3ProjectionEventType("io.malink.gateway_deployment.v1"), true);
});

test("recovery stays on old Gateway even with a colliding candidate session ID", () => {
  const target = gatewayRecoveryTarget(state(), deployment)!;
  assert.equal(target.gatewayNodeId, "old");
  assert.equal(target.session?.projectId, "old-project");
});
test("archived maintenance yields an old-Gateway creation route, not provider history", () => {
  const target = gatewayRecoveryTarget(state(true), deployment)!;
  assert.equal(target.workspace.projectId, "old-project");
  assert.equal(target.session, undefined);
});
test("reuses a replacement repair session for the same deployment", () => {
  const snapshot = state(true);
  snapshot.sessions.push({ id: "repair", projectId: "old-project", status: "idle",
    title: gatewayRecoveryTitle(deployment) } as never);
  assert.equal(gatewayRecoveryTarget(snapshot, deployment)?.session?.id, "repair");
});
test("missing old route never falls back to the visible new Gateway", () => {
  const snapshot = state();
  snapshot.gatewayDirectory!.directory.gateways.shift();
  assert.equal(gatewayRecoveryTarget(snapshot, deployment), null);
});
test("committed deployment closes the recovery window", () => {
  assert.equal(gatewayRecoveryTarget(state(), { ...deployment, phase: "steady", candidate: undefined }), null);
});
test("retained recovery opens the old repair session even when the new Gateway is unavailable", () => {
  const committed = { ...deployment, phase: "steady", candidate: undefined, updateId: undefined,
    active: deployment.candidate!, recovery: { ...deployment.active, projectId: "old-project",
      sessionId: "maintenance", retainedAt: 2 } } as GatewayDeploymentStatus;
  const snapshot = state();
  snapshot.gatewayNodeStatuses = {};
  const target = gatewayRecoveryTarget(snapshot, committed)!;
  assert.equal(target.gatewayNodeId, "old");
  assert.equal(target.session?.id, "maintenance");
  assert.equal(target.workspace.projectId, "old-project");
  const report = JSON.parse(gatewayRecoveryReport(committed, "unreachable"));
  assert.equal(report.previous.gatewayNodeId, "old");
  assert.equal(report.candidate.gatewayNodeId, "new");
});
test("diagnostic draft identifies builds without credentials or auto-execution", () => {
  const report = JSON.parse(gatewayRecoveryReport(deployment, "unreachable"));
  assert.equal(report.previous.gatewayNodeId, "old");
  assert.equal(report.candidateConnection, "unreachable");
  assert.match(report.instruction, /user confirmation/);
  assert.equal(report.accessToken, undefined);
});

test("new sessions prefer the healthy candidate only for the same working directory", () => {
  const snapshot = state();
  const old = { projectId: "old-project", cwd: "/repo" } as typeof snapshot.workspace;
  const next = { projectId: "new-project", cwd: "/repo" } as typeof snapshot.workspace;
  snapshot.projects = [old, next];
  snapshot.gatewayDeployments = { computer: { version: 1, computerId: "computer", observedAt: 1, deployment } };
  assert.equal(preferredGatewayCreationWorkspace(snapshot, old), next);
  snapshot.gatewayDeployments!.computer!.deployment = { ...deployment, phase: "preparing" };
  assert.equal(preferredGatewayCreationWorkspace(snapshot, old), old);
  snapshot.gatewayDeployments!.computer!.deployment = deployment;
  next.cwd = "/unrelated";
  assert.equal(preferredGatewayCreationWorkspace(snapshot, old), old);
});

test("repair creation is old-project scoped and never starts an automatic Agent turn", async () => {
  const app = await readFile(new URL("../app/MalinkApp.tsx", import.meta.url), "utf8");
  const recovery = app.slice(app.indexOf("async function recoverWithPreviousGateway"),
    app.indexOf("function openGatewayTrialProject"));
  assert.match(recovery, /operation: "session.create"/);
  assert.match(recovery, /target\.workspace\.projectId, \{ propagateFailure: true \}/);
  assert.doesNotMatch(recovery, /operation: "prompt.submit"|initialPrompt:|providerSessionId:/);
  assert.match(recovery, /sharedDraftFilesRef\.current\.add\(file\)/);
  assert.match(recovery, /setPendingFiles\(\[\.\.\.existing, file\]\)/);
});
