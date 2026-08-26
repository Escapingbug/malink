import assert from "node:assert/strict";
import test from "node:test";
import type { SignedWorkspaceGatewayDirectory } from "@malink/protocol";
import {
  automaticGatewayUpdateTargets,
  hasAttemptedAutomaticGatewayUpdate,
  recordAutomaticGatewayUpdateAttempt,
  triggerAutomaticGatewayUpdate,
} from "../app/gatewayUpdateTrigger.ts";

const release = { releaseId: "2026.08.26.2", buildId: "gateway-next-arm64" };

test("selects each update-capable old Gateway through one of its known projects", () => {
  const directory = {
    directory: {
      gateways: [
        gateway("node-old", "Office Mac", "gateway-old-arm64", true, "project-old"),
        gateway("node-current", "Server", release.buildId, true, "project-current"),
        gateway("node-manual", "Legacy Mac", "gateway-legacy", false, "project-manual"),
        gateway("node-unrouted", "Other Mac", "gateway-other", true, "project-other"),
      ],
    },
  } as unknown as SignedWorkspaceGatewayDirectory;

  assert.deepEqual(automaticGatewayUpdateTargets({
    directory,
    knownProjectIds: new Set(["project-old", "project-current", "project-manual"]),
    release,
  }), [{
    gatewayNodeId: "node-old",
    gatewayName: "Office Mac",
    currentBuildId: "gateway-old-arm64",
    targetProjectId: "project-old",
  }]);
});

test("records one automatic attempt per Gateway and paired release", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
  assert.equal(hasAttemptedAutomaticGatewayUpdate(storage, "node-1", release), false);
  recordAutomaticGatewayUpdateAttempt(storage, "node-1", release);
  assert.equal(hasAttemptedAutomaticGatewayUpdate(storage, "node-1", release), true);
  assert.equal(hasAttemptedAutomaticGatewayUpdate(storage, "node-1", {
    ...release,
    buildId: "gateway-later-arm64",
  }), false);
});

test("stages and schedules the PWA-paired release on the target Gateway", async () => {
  const commands: Array<{ operation: string; projectId: string }> = [];
  const result = await triggerAutomaticGatewayUpdate({
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
  const result = await triggerAutomaticGatewayUpdate({
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

function gateway(
  gatewayNodeId: string,
  gatewayName: string,
  buildId: string,
  onlineUpdate: boolean,
  projectId: string,
) {
  return {
    gatewayNodeId,
    gatewayName,
    buildId,
    ...(onlineUpdate ? { onlineUpdate: true } : {}),
    projects: [{ projectId }],
  };
}

function status(phase: "staged" | "scheduled") {
  return {
    version: 1 as const,
    phase,
    releaseId: release.releaseId,
    targetBuildId: release.buildId,
    currentBuildId: "gateway-old-arm64",
    updatedAt: 1,
  };
}
