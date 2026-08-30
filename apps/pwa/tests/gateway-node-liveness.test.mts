import assert from "node:assert/strict";
import test from "node:test";
import {
  GATEWAY_AUTOMATIC_RECHECK_AFTER_MS,
  GATEWAY_ONLINE_PROOF_WINDOW_MS,
  gatewayNodeLivenessPresentation,
  gatewayNodeLivenessSummary,
  gatewayNodeLivenessTargets,
  shouldAutomaticallyCheckGatewayNode,
} from "../app/gatewayNodeLiveness.ts";

const now = 10_000_000;

test("builds one signed probe route for every compatible Gateway node", () => {
  const targets = gatewayNodeLivenessTargets({
    directory: {
      directory: {
        kind: "malink.workspace.gateway-directory",
        version: 1,
        directoryId: "directory-1",
        workspaceId: "workspace-1",
        revision: 2,
        issuedAt: 1,
        gateways: [
          {
            gatewayNodeId: "node-online",
            workspaceId: "workspace-1",
            gatewayName: "Office Gateway",
            buildId: "gateway-current",
            onlineUpdate: true,
            publicKey: {
              version: 1,
              algorithm: "ES256",
              keyId: "key",
              publicKey: { kty: "EC", crv: "P-256", x: "AQ", y: "Ag" },
            },
            transport: {
              homeserver: "https://matrix.example",
              roomId: "!office:example",
              userId: "@gateway:example",
              deviceId: "OFFICE",
              ed25519: "office-key",
            },
            projects: [{
              projectId: "project-office",
              roomId: "!office:example",
              conversationId: "!office:example",
            }],
            issuedAt: 1,
          },
          {
            gatewayNodeId: "node-unrouted",
            workspaceId: "workspace-1",
            gatewayName: "Remote Gateway",
            onlineUpdate: true,
            publicKey: {
              version: 1,
              algorithm: "ES256",
              keyId: "key",
              publicKey: { kty: "EC", crv: "P-256", x: "AQ", y: "Ag" },
            },
            transport: {
              homeserver: "https://matrix.example",
              roomId: "!remote:example",
              userId: "@gateway:example",
              deviceId: "REMOTE",
              ed25519: "remote-key",
            },
            projects: [{
              projectId: "project-remote",
              roomId: "!remote:example",
              conversationId: "!remote:example",
            }],
            issuedAt: 1,
          },
          {
            gatewayNodeId: "node-legacy",
            workspaceId: "workspace-1",
            gatewayName: "Legacy Gateway",
            onlineUpdate: false,
            publicKey: {
              version: 1,
              algorithm: "ES256",
              keyId: "key",
              publicKey: { kty: "EC", crv: "P-256", x: "AQ", y: "Ag" },
            },
            transport: {
              homeserver: "https://matrix.example",
              roomId: "!legacy:example",
              userId: "@gateway:example",
              deviceId: "LEGACY",
              ed25519: "legacy-key",
            },
            projects: [{
              projectId: "project-legacy",
              roomId: "!legacy:example",
              conversationId: "!legacy:example",
            }],
            issuedAt: 1,
          },
        ],
      },
      signature: { algorithm: "ES256", keyId: "key", value: "signature" },
    },
    knownProjectIds: new Set(["project-office", "project-legacy"]),
  });

  assert.deepEqual(targets.map((target) => ({
    gatewayNodeId: target.gatewayNodeId,
    targetProjectId: target.targetProjectId,
    canProbe: target.canProbe,
    unavailableReason: target.unavailableReason,
  })), [
    {
      gatewayNodeId: "node-online",
      targetProjectId: "project-office",
      canProbe: true,
      unavailableReason: undefined,
    },
    {
      gatewayNodeId: "node-unrouted",
      targetProjectId: undefined,
      canProbe: false,
      unavailableReason: "route",
    },
    {
      gatewayNodeId: "node-legacy",
      targetProjectId: "project-legacy",
      canProbe: false,
      unavailableReason: "capability",
    },
  ]);
});

test("online proof expires instead of presenting cached registration as liveness", () => {
  assert.equal(gatewayNodeLivenessPresentation({
    state: "online",
    checkedAt: now,
    lastVerifiedAt: now,
  }, now + GATEWAY_ONLINE_PROOF_WINDOW_MS).state, "online");
  assert.equal(gatewayNodeLivenessPresentation({
    state: "online",
    checkedAt: now,
    lastVerifiedAt: now,
  }, now + GATEWAY_ONLINE_PROOF_WINDOW_MS + 1).state, "stale");
  assert.equal(gatewayNodeLivenessPresentation({
    state: "unreachable",
    checkedAt: now,
    consecutiveNoReplies: 1,
  }, now).label, "Live check timed out");
  const repeated = gatewayNodeLivenessPresentation({
    state: "unreachable",
    checkedAt: now,
    consecutiveNoReplies: 2,
  }, now);
  assert.equal(repeated.label, "Gateway needs attention");
  assert.match(repeated.detail, /missed 2 consecutive signed checks/);
});

test("automatic checks are bounded while manual status remains explicit", () => {
  assert.equal(shouldAutomaticallyCheckGatewayNode(undefined, now), true);
  assert.equal(shouldAutomaticallyCheckGatewayNode({
    state: "online",
    checkedAt: now,
    lastVerifiedAt: now,
  }, now + GATEWAY_AUTOMATIC_RECHECK_AFTER_MS - 1), false);
  assert.equal(shouldAutomaticallyCheckGatewayNode({
    state: "online",
    checkedAt: now,
    lastVerifiedAt: now,
  }, now + GATEWAY_AUTOMATIC_RECHECK_AFTER_MS), true);
  assert.equal(shouldAutomaticallyCheckGatewayNode({
    state: "checking",
    checkedAt: now,
  }, now + GATEWAY_AUTOMATIC_RECHECK_AFTER_MS), false);
});

test("summarizes independently verified nodes without hiding failures", () => {
  assert.equal(gatewayNodeLivenessSummary({
    gatewayNodeIds: ["online", "offline", "unknown"],
    values: {
      online: { state: "online", checkedAt: now, lastVerifiedAt: now },
      offline: { state: "unreachable", checkedAt: now, consecutiveNoReplies: 2 },
    },
    now,
  }), "1 online · 1 needs attention · 1 unverified");
});
