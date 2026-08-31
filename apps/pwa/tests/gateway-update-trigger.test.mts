import assert from "node:assert/strict";
import test from "node:test";
import type { SignedWorkspaceGatewayDirectory } from "@malink/protocol";
import {
  collidingGatewayMaintenanceSessionIds,
  gatewayMaintenanceSessionCanBeArchived,
  gatewayMaintenanceSessionShouldAutoArchive,
  gatewayUpdateCanApplyStaged,
  gatewayUpdatePlan,
  gatewayUpdatePlanNodeWithLiveStatus,
  gatewayUpdateStatusNeedsPolling,
  gatewayUpdateTarget,
  legacyGatewayMaintenanceSessionsByNode,
  recoverAmbiguousGatewayUpdateCompletion,
  triggerGatewayUpdate,
} from "../app/gatewayUpdateTrigger.ts";
import { gatewayUpdateRecoveryAction } from "../app/gatewayUpdateRecovery.ts";

const release = { releaseId: "2026.08.26.2", buildId: "gateway-next-arm64" };

test("classifies every Gateway without starting an update", () => {
  const directory = {
    directory: {
      gateways: [
        gateway("node-old", "Office Mac", "gateway-old-arm64", true, "project-old"),
        gateway("node-current", "Server", release.buildId, true, "project-current"),
        gateway("node-manual", "Legacy Mac", "gateway-legacy", false, "project-manual"),
        gateway("node-unrouted", "Other Mac", "gateway-other", true, "project-other"),
        gateway("node-unknown", "Unknown Mac", undefined, true, "project-unknown"),
      ],
    },
  } as unknown as SignedWorkspaceGatewayDirectory;

  assert.deepEqual(gatewayUpdatePlan({
    directory,
    knownProjectIds: new Set([
      "project-old",
      "project-current",
      "project-manual",
      "project-unknown",
    ]),
    release,
  }).map(node => ({ id: node.gatewayNodeId, state: node.state })), [
    { id: "node-old", state: "available" },
    { id: "node-current", state: "current" },
    { id: "node-manual", state: "manual" },
    { id: "node-unrouted", state: "unrouted" },
    { id: "node-unknown", state: "unknown" },
  ]);
});

test("returns an exact routed target only for an online-update node", () => {
  const [available, manual] = gatewayUpdatePlan({
    directory: {
      directory: {
        gateways: [
          gateway("node-old", "Office Mac", "gateway-old-arm64", true, "project-old"),
          gateway("node-manual", "Legacy Mac", "gateway-legacy", false, "project-manual"),
        ],
      },
    } as unknown as SignedWorkspaceGatewayDirectory,
    knownProjectIds: new Set(["project-old", "project-manual"]),
    release,
  });
  assert.deepEqual(gatewayUpdateTarget(available!), {
    gatewayNodeId: "node-old",
    gatewayName: "Office Mac",
    currentBuildId: "gateway-old-arm64",
    targetProjectId: "project-old",
  });
  assert.equal(gatewayUpdateTarget(manual!), null);
});

test("creates the maintenance session and schedules the confirmed Gateway", async () => {
  const commands: Array<{ operation: string; projectId: string }> = [];
  const result = await triggerGatewayUpdate({
    release,
    target: {
      gatewayNodeId: "node-1",
      gatewayName: "Office Mac",
      currentBuildId: "gateway-old-arm64",
      targetProjectId: "project-1",
    },
    send: async (command, projectId) => {
      commands.push({ operation: command.operation, projectId });
      return command.operation === "gateway.update.stage"
        ? status("staged")
        : status("scheduled");
    },
  });

  assert.equal(result.phase, "scheduled");
  assert.deepEqual(commands, [
    { operation: "gateway.update.stage", projectId: "project-1" },
    { operation: "gateway.update.apply", projectId: "project-1" },
  ]);
});

test("treats a duplicate already-scheduled release as successful", async () => {
  let calls = 0;
  const result = await triggerGatewayUpdate({
    release,
    target: {
      gatewayNodeId: "node-1",
      gatewayName: "Office Mac",
      currentBuildId: "gateway-old-arm64",
      targetProjectId: "project-1",
    },
    send: async () => {
      calls += 1;
      return status("scheduled");
    },
  });

  assert.equal(result.phase, "scheduled");
  assert.equal(calls, 1);
});

test("offers retry only after a transient failure exhausted automatic retries", () => {
  assert.equal(gatewayUpdateRecoveryAction({
    release,
    status: {
      ...status("failed"),
      detail: "Gateway Agent update Prompt returned HTTP 503",
    },
  }).kind, "retry");
  assert.equal(gatewayUpdateRecoveryAction({
    release,
    status: {
      ...status("failed"),
      detail: "Gateway Agent update Prompt returned HTTP 404",
    },
  }).kind, "report");
  assert.equal(gatewayUpdateRecoveryAction({
    release,
    status: {
      ...status("failed"),
      detail: "Gateway Agent update Prompt signature is invalid",
    },
  }).kind, "report");
});

test("continues an old staged checkpoint and never retries repair state", () => {
  assert.equal(gatewayUpdateRecoveryAction({
    release,
    status: status("staged"),
  }).kind, "continue");
  assert.equal(gatewayUpdateRecoveryAction({
    release,
    status: status("repair_required"),
  }).kind, "repair");
});

test("allows a genuinely new signed release after an old deterministic failure", () => {
  assert.equal(gatewayUpdateRecoveryAction({
    release,
    status: {
      ...status("failed"),
      releaseId: "2026.08.20.1",
      targetBuildId: "gateway-older-arm64",
      detail: "Gateway Agent update Prompt returned HTTP 404",
    },
  }).kind, "start");
});

test("recovers an old Gateway child-turn completion through read-only status checks", async () => {
  const phases = ["agent_running", "staged"] as const;
  const waits: number[] = [];
  let reads = 0;
  const result = await recoverAmbiguousGatewayUpdateCompletion({
    operation: "gateway.update.stage",
    releaseId: release.releaseId,
    readStatus: async () => status(phases[reads++]!),
    wait: async milliseconds => { waits.push(milliseconds); },
    delaysMs: [0, 10],
  });

  assert.equal(result.phase, "staged");
  assert.equal(reads, 2);
  assert.deepEqual(waits, [10]);
});

test("does not repeat an ambiguous apply operation", async () => {
  let reads = 0;
  const result = await recoverAmbiguousGatewayUpdateCompletion({
    operation: "gateway.update.apply",
    releaseId: release.releaseId,
    readStatus: async () => { reads += 1; return status("scheduled"); },
    delaysMs: [0],
  });

  assert.equal(result.phase, "scheduled");
  assert.equal(reads, 1);
});

test("blocks legacy maintenance IDs shared by multiple Gateway nodes", () => {
  const collisions = collidingGatewayMaintenanceSessionIds({
    nodeSessions: [
      { gatewayNodeId: "node-a", maintenanceSessionId: "legacy-session" },
      { gatewayNodeId: "node-b", maintenanceSessionId: "legacy-session" },
      { gatewayNodeId: "node-c", maintenanceSessionId: "node-c-session" },
    ],
    projectedSessions: [],
  });

  assert.deepEqual([...collisions], ["legacy-session"]);
});

test("blocks a maintenance ID projected in multiple projects", () => {
  const collisions = collidingGatewayMaintenanceSessionIds({
    nodeSessions: [
      { gatewayNodeId: "node-a", maintenanceSessionId: "legacy-session" },
    ],
    projectedSessions: [
      { id: "legacy-session", projectId: "project-a" },
      { id: "legacy-session", projectId: "project-b" },
    ],
  });

  assert.deepEqual([...collisions], ["legacy-session"]);
});

test("does not guess a collision from the maintenance ID spelling", () => {
  const collisions = collidingGatewayMaintenanceSessionIds({
    nodeSessions: [
      {
        gatewayNodeId: "node-a",
        maintenanceSessionId: "gateway-update-legacy-workspace-hash",
      },
      { gatewayNodeId: "node-b" },
    ],
    projectedSessions: [
      { id: "gateway-update-legacy-workspace-hash", projectId: "project-a" },
    ],
  });

  assert.deepEqual([...collisions], []);
});

test("allows one node-scoped maintenance ID in a multi-Gateway workspace", () => {
  const collisions = collidingGatewayMaintenanceSessionIds({
    nodeSessions: [
      {
        gatewayNodeId: "node-a",
        maintenanceSessionId: "gateway-update-node-node-specific-hash",
      },
      { gatewayNodeId: "node-b" },
    ],
    projectedSessions: [
      { id: "gateway-update-node-node-specific-hash", projectId: "project-a" },
    ],
  });

  assert.deepEqual([...collisions], []);
});

test("routes the newest active legacy maintenance collision to each exact node", () => {
  const sessions = legacyGatewayMaintenanceSessionsByNode({
    nodes: [
      { gatewayNodeId: "node-a", targetProjectId: "project-a" },
      { gatewayNodeId: "node-b", targetProjectId: "project-b" },
    ],
    projectedSessions: [
      {
        id: "gateway-update-shared-new",
        projectId: "project-a",
        status: "archived",
        updatedAt: 30,
      },
      {
        id: "gateway-update-shared-new",
        projectId: "project-b",
        status: "idle",
        updatedAt: 30,
      },
      {
        id: "gateway-update-shared-old",
        projectId: "project-a",
        status: "idle",
        updatedAt: 20,
      },
      {
        id: "gateway-update-shared-old",
        projectId: "project-b",
        status: "idle",
        updatedAt: 20,
      },
      {
        id: "gateway-update-node-current",
        projectId: "project-a",
        status: "idle",
        updatedAt: 40,
      },
    ],
  });

  assert.equal(sessions.get("node-a")?.id, "gateway-update-shared-old");
  assert.equal(sessions.get("node-b")?.id, "gateway-update-shared-new");
});

test("lets a signed live status correct a stale directory build", () => {
  const node = gatewayUpdatePlanNodeWithLiveStatus({
    node: {
      gatewayNodeId: "node-a",
      gatewayName: "Gateway A",
      currentBuildId: "gateway-new",
      targetProjectId: "project-a",
      onlineUpdate: true,
      state: "current",
    },
    release: {
      releaseId: "release-new",
      buildId: "gateway-new",
    },
    status: {
      version: 1,
      phase: "staged",
      releaseId: "release-new",
      targetBuildId: "gateway-new",
      currentBuildId: "gateway-old",
      updatedAt: 10,
    },
  });

  assert.equal(node.currentBuildId, "gateway-old");
  assert.equal(node.state, "available");
});

test("recognizes phases that need automatic progress checks", () => {
  const status = (phase: "agent_running" | "staged" | "probation") => ({
    version: 1 as const,
    phase,
    updatedAt: 10,
  });
  assert.equal(gatewayUpdateStatusNeedsPolling(status("agent_running")), true);
  assert.equal(gatewayUpdateStatusNeedsPolling(status("probation")), true);
  assert.equal(gatewayUpdateStatusNeedsPolling(status("staged")), false);
});

test("archives terminal or deterministic failures but preserves useful retry checkpoints", () => {
  const status = (phase: "idle" | "agent_running" | "failed" | "repair_required" | "committed" | "rolled_back") => ({
    version: 1 as const,
    phase,
    updatedAt: 10,
  });
  assert.equal(gatewayMaintenanceSessionCanBeArchived(undefined), false);
  assert.equal(gatewayMaintenanceSessionCanBeArchived(status("agent_running")), false);
  assert.equal(gatewayMaintenanceSessionCanBeArchived(status("failed")), true);
  assert.equal(gatewayMaintenanceSessionCanBeArchived({
    ...status("failed"),
    detail: "Gateway Agent update Prompt returned HTTP 503",
  }), false);
  assert.equal(gatewayMaintenanceSessionCanBeArchived(status("repair_required")), false);
  assert.equal(gatewayMaintenanceSessionCanBeArchived(status("idle")), true);
  assert.equal(gatewayMaintenanceSessionCanBeArchived(status("committed")), true);
  assert.equal(gatewayMaintenanceSessionCanBeArchived(status("rolled_back")), true);
});

test("automatically archives inactive terminal maintenance sessions", () => {
  const status = (phase: "idle" | "committed" | "rolled_back" | "failed") => ({
    version: 1 as const,
    phase,
    updatedAt: 10,
  });
  assert.equal(gatewayMaintenanceSessionShouldAutoArchive(status("idle")), true);
  assert.equal(gatewayMaintenanceSessionShouldAutoArchive(status("committed")), true);
  assert.equal(gatewayMaintenanceSessionShouldAutoArchive(status("rolled_back")), true);
  assert.equal(gatewayMaintenanceSessionShouldAutoArchive(status("failed")), false);
});

test("offers activation for any complete staged release identity", () => {
  assert.equal(gatewayUpdateCanApplyStaged({
    status: {
      version: 1,
      phase: "staged",
      releaseId: "release-older-than-channel",
      targetBuildId: "gateway-staged",
      currentBuildId: "gateway-older",
      updatedAt: 10,
    },
  }), true);
  assert.equal(gatewayUpdateCanApplyStaged({
    status: {
      version: 1,
      phase: "agent_running",
      releaseId: "release-new",
      targetBuildId: "gateway-new",
      currentBuildId: "gateway-old",
      updatedAt: 10,
    },
  }), false);
  assert.equal(gatewayUpdateCanApplyStaged({
    status: {
      version: 1,
      phase: "staged",
      currentBuildId: "gateway-old",
      updatedAt: 10,
    },
  }), false);
});

function gateway(
  gatewayNodeId: string,
  gatewayName: string,
  buildId: string | undefined,
  onlineUpdate: boolean,
  projectId: string,
) {
  return {
    gatewayNodeId,
    gatewayName,
    ...(buildId ? { buildId } : {}),
    ...(onlineUpdate ? { onlineUpdate: true } : {}),
    projects: [{ projectId }],
  };
}

function status(
  phase:
    | "agent_running"
    | "staged"
    | "scheduled"
    | "failed"
    | "repair_required",
) {
  return {
    version: 1 as const,
    phase,
    releaseId: release.releaseId,
    targetBuildId: release.buildId,
    currentBuildId: "gateway-old-arm64",
    updatedAt: 1,
  };
}
