import assert from "node:assert/strict";
import test from "node:test";
import type { GatewayStateSnapshot } from "../app/gatewayState.ts";
import {
  preserveProjectsDuringRecovery,
  workspaceProjectRecovery,
  workspaceProjectRecoveryPresentation,
} from "../app/workspaceProjectRecovery.ts";

const capabilities: GatewayStateSnapshot["capabilities"] = {
  models: [],
  providers: [],
  permissionModes: [],
  canCreateSession: true,
  canSelectSession: true,
  sessionExtensions: [],
};

function project(projectId: string): GatewayStateSnapshot["workspace"] {
  return {
    projectId,
    projectName: projectId,
    cwd: `/workspace/${projectId}`,
    provider: "agent",
    permissionMode: "default",
  };
}

function session(projectId: string): GatewayStateSnapshot["sessions"][number] {
  return {
    id: `session-${projectId}`,
    title: projectId,
    updatedAt: 1,
    status: "idle",
    projectId,
    projectName: projectId,
    cwd: `/workspace/${projectId}`,
    provider: "agent",
    extensions: [],
    availableCommands: [],
  };
}

function snapshot(
  loadedProjectIds: readonly string[],
  directoryProjectIds: readonly string[],
): GatewayStateSnapshot {
  const activeProjectId = loadedProjectIds[0] ?? "project-a";
  return {
    stateVersion: 1,
    revision: 0,
    revisionEpoch: "matrix-native-v3",
    revisionEpochGeneration: 1,
    activeDeviceCount: 1,
    updatedAt: 1,
    currentSessionId: null,
    sessions: loadedProjectIds.map(session),
    workspace: project(activeProjectId),
    projects: loadedProjectIds.map(project),
    capabilities,
    gatewayDirectory: {
      directory: {
        kind: "malink.workspace.gateway-directory",
        version: 1,
        directoryId: "directory-1",
        workspaceId: "workspace-1",
        revision: 1,
        gateways: [{
          gatewayNodeId: "gateway-1",
          workspaceId: "workspace-1",
          gatewayName: "Gateway",
          transport: {
            homeserver: "https://matrix.example.test",
            roomId: "!control:example.test",
            userId: "@gateway:example.test",
            deviceId: "GATEWAY",
            ed25519: "ed25519-key",
          },
          publicKey: {
            version: 1,
            algorithm: "ES256",
            keyId: "gateway-key",
            publicKey: {
              kty: "EC",
              crv: "P-256",
              x: "x-coordinate",
              y: "y-coordinate",
            },
          },
          projects: directoryProjectIds.map(projectId => ({
            projectId,
            roomId: `!${projectId}:example.test`,
            conversationId: `conversation-${projectId}`,
          })),
          issuedAt: 1,
        }],
        issuedAt: 1,
      },
      signature: {
        algorithm: "ES256",
        keyId: "gateway-key",
        value: "signature",
      },
    },
  };
}

test("reports progress against every project in the signed directory", () => {
  assert.deepEqual(
    workspaceProjectRecovery(snapshot(["project-a"], ["project-a", "project-b", "project-c"])),
    {
      loaded: 1,
      total: 3,
      missingProjectIds: ["project-b", "project-c"],
      waitingGateways: [{
        gatewayNodeId: "gateway-1",
        label: "Gateway",
        loaded: 1,
        total: 3,
      }],
    },
  );
  assert.equal(
    workspaceProjectRecovery(snapshot(
      ["project-a", "project-b", "project-c"],
      ["project-a", "project-b", "project-c"],
    )),
    null,
  );
});

test("explains when another Gateway must authorize the new device", () => {
  const state = snapshot(["project-a"], ["project-a"]);
  state.gatewayDirectory!.directory.gateways.push({
    ...state.gatewayDirectory!.directory.gateways[0]!,
    gatewayNodeId: "gateway-2",
    gatewayName: "Mac mini",
    projects: ["project-b", "project-c"].map(projectId => ({
      projectId,
      roomId: `!${projectId}:example.test`,
      conversationId: `conversation-${projectId}`,
    })),
  });

  const recovery = workspaceProjectRecovery(state);
  assert.ok(recovery);
  assert.deepEqual(workspaceProjectRecoveryPresentation(recovery), {
    title: "Waiting for another Workspace computer",
    detail: "1 of 3 projects available · Start Mac mini and Malink Gateway Host once to authorize this device",
    waitingForGateway: true,
  });
});

test("keeps transient rooms under a loaded Gateway in the refresh phase", () => {
  const recovery = workspaceProjectRecovery(
    snapshot(["project-a"], ["project-a", "project-b"]),
  );
  assert.ok(recovery);
  assert.deepEqual(workspaceProjectRecoveryPresentation(recovery), {
    title: "Refreshing Workspace projects",
    detail: "1 of 2 available · restoring remaining project rooms",
    waitingForGateway: false,
  });
});

test("preserves missing project rows until their fresh projections arrive", () => {
  const previous = snapshot(
    ["project-a", "project-b", "project-c"],
    ["project-a", "project-b", "project-c"],
  );
  const incoming = snapshot(
    ["project-a"],
    ["project-a", "project-b", "project-c"],
  );

  const presented = preserveProjectsDuringRecovery(previous, incoming);
  assert.deepEqual(
    presented.projects?.map(value => value.projectId).sort(),
    ["project-a", "project-b", "project-c"],
  );
  assert.deepEqual(
    presented.sessions.map(value => value.projectId).sort(),
    ["project-a", "project-b", "project-c"],
  );
});

test("does not retain a project removed from the latest signed directory", () => {
  const previous = snapshot(
    ["project-a", "project-b", "project-c"],
    ["project-a", "project-b", "project-c"],
  );
  const incoming = snapshot(
    ["project-a"],
    ["project-a", "project-b"],
  );

  const presented = preserveProjectsDuringRecovery(previous, incoming);
  assert.deepEqual(
    presented.projects?.map(value => value.projectId).sort(),
    ["project-a", "project-b"],
  );
  assert.deepEqual(
    presented.sessions.map(value => value.projectId).sort(),
    ["project-a", "project-b"],
  );
});
