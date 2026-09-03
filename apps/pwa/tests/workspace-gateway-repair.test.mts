import assert from "node:assert/strict";
import test from "node:test";
import type { SignedWorkspaceGatewayDirectory } from "@malink/protocol";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { GatewayRecoveryCard } from "../app/MatrixSettings.tsx";
import {
  GATEWAY_RETIRE_MINIMUM_BUILD,
  gatewayBuildSupportsWorkspaceRetirement,
  workspaceGatewayRepairPlan,
} from "../app/workspaceGatewayRepair.ts";

function directory(): SignedWorkspaceGatewayDirectory {
  const key = {
    version: 1 as const,
    algorithm: "ES256" as const,
    keyId: "a".repeat(43),
    publicKey: {
      kty: "EC" as const,
      crv: "P-256" as const,
      x: "b".repeat(43),
      y: "c".repeat(43),
    },
  };
  return {
    directory: {
      kind: "malink.workspace.gateway-directory",
      version: 1,
      directoryId: "directory-1",
      workspaceId: "workspace-1",
      revision: 7,
      issuedAt: 10,
      gateways: [
        {
          gatewayNodeId: "gateway-a",
          workspaceId: "workspace-1",
          gatewayName: "Laptop",
          buildId: GATEWAY_RETIRE_MINIMUM_BUILD,
          transport: {
            homeserver: "https://matrix.example",
            roomId: "!a:example",
            userId: "@gateway:example",
            deviceId: "A",
            ed25519: "ed25519-laptop",
          },
          publicKey: key,
          projects: [
            { projectId: "project-a", roomId: "!a:example", conversationId: "!a:example" },
            { projectId: "project-b", roomId: "!b:example", conversationId: "!b:example" },
          ],
          issuedAt: 10,
        },
        {
          gatewayNodeId: "gateway-b",
          workspaceId: "workspace-1",
          gatewayName: "Desktop",
          buildId: "gateway-2026.09.03-061645Z-8b2afef",
          transport: {
            homeserver: "https://matrix.example",
            roomId: "!c:example",
            userId: "@gateway:example",
            deviceId: "B",
            ed25519: "ed25519-desktop",
          },
          publicKey: key,
          projects: [
            { projectId: "project-c", roomId: "!c:example", conversationId: "!c:example" },
          ],
          issuedAt: 10,
        },
      ],
    },
    signature: {
      algorithm: "ES256",
      keyId: "a".repeat(43),
      value: "signature",
    },
  };
}

test("routes retirement through another Gateway with a verified project", () => {
  const plan = workspaceGatewayRepairPlan(
    directory(),
    new Set(["project-a", "project-b"]),
    new Set(["gateway-a"]),
  );
  assert.ok(plan);
  assert.equal(plan.availableProjects, 2);
  assert.equal(plan.totalProjects, 3);
  assert.equal(plan.unavailableProjects, 1);
  assert.deepEqual(plan.nodes.find(node => node.gatewayNodeId === "gateway-b"), {
    gatewayNodeId: "gateway-b",
    projectIds: ["project-c"],
    availableProjectIds: [],
    unavailableProjectIds: ["project-c"],
    retirementAuthorityProjectId: "project-a",
    retirementBlocker: null,
  });
});

test("recognizes only the first compatible or a later timestamped Gateway build", () => {
  assert.equal(gatewayBuildSupportsWorkspaceRetirement(undefined), false);
  assert.equal(gatewayBuildSupportsWorkspaceRetirement("development"), false);
  assert.equal(
    gatewayBuildSupportsWorkspaceRetirement("gateway-2026.09.03-061645Z-8b2afef"),
    false,
  );
  assert.equal(
    gatewayBuildSupportsWorkspaceRetirement(GATEWAY_RETIRE_MINIMUM_BUILD),
    true,
  );
  assert.equal(
    gatewayBuildSupportsWorkspaceRetirement("gateway-2026.09.04-000001Z-abcdef0"),
    true,
  );
});

test("requires an online legacy Gateway to update before it becomes a removal authority", () => {
  const value = directory();
  value.directory.gateways[0]!.buildId = "gateway-2026.09.03-061645Z-8b2afef";
  const plan = workspaceGatewayRepairPlan(
    value,
    new Set(["project-a", "project-b"]),
    new Set(["gateway-a"]),
  );

  assert.deepEqual(
    plan?.nodes.find(node => node.gatewayNodeId === "gateway-b"),
    {
      gatewayNodeId: "gateway-b",
      projectIds: ["project-c"],
      availableProjectIds: [],
      unavailableProjectIds: ["project-c"],
      retirementAuthorityProjectId: null,
      retirementBlocker: "gateway_update_required",
    },
  );
});

test("never routes retirement through the target Gateway itself", () => {
  const plan = workspaceGatewayRepairPlan(
    directory(),
    new Set(["project-c"]),
    new Set(["gateway-b"]),
  );
  assert.ok(plan);
  assert.equal(
    plan.nodes.find(node => node.gatewayNodeId === "gateway-b")?.retirementAuthorityProjectId,
    null,
  );
});

test("does not treat a cached project as an online removal authority", () => {
  const plan = workspaceGatewayRepairPlan(
    directory(),
    new Set(["project-a", "project-b", "project-c"]),
    new Set(),
  );

  assert.ok(plan);
  assert.equal(
    plan.nodes.find(node => node.gatewayNodeId === "gateway-b")?.retirementAuthorityProjectId,
    null,
  );
});

test("offers ordinary-user restore and removal paths for an unavailable computer", () => {
  const html = renderToStaticMarkup(createElement(GatewayRecoveryCard, {
    gatewayNodeId: "gateway-b",
    gatewayLabel: "Desktop",
    projectCount: 2,
    unavailableProjectCount: 2,
    authorityProjectId: "project-a",
    retirementBlocker: null,
    busy: false,
    retiring: false,
    error: null,
    onAdd() {},
    onReviewGatewayUpdates() {},
    async onRetire() {},
  }));

  assert.match(html, /2 projects are unavailable/);
  assert.match(html, /Start Malink on this computer to restore it automatically/);
  assert.match(html, /Add this computer again/);
  assert.match(html, /Continue without this computer/);
  assert.doesNotMatch(html, /diagnostic|command ID|directory revision/i);
});

test("explains the safety prerequisite when no other computer can sign removal", () => {
  const html = renderToStaticMarkup(createElement(GatewayRecoveryCard, {
    gatewayNodeId: "gateway-b",
    gatewayLabel: "Desktop",
    projectCount: 2,
    unavailableProjectCount: 2,
    authorityProjectId: null,
    retirementBlocker: "gateway_online_required",
    busy: false,
    retiring: false,
    error: null,
    onAdd() {},
    onReviewGatewayUpdates() {},
    async onRetire() {},
  }));

  assert.match(html, /Another connected computer is required/);
  assert.match(html, /Continue without this computer[^<]*<\/button>/);
  assert.match(html, /disabled=""/);
});

test("offers the effective Gateway update action instead of a removal that cannot finish", () => {
  const html = renderToStaticMarkup(createElement(GatewayRecoveryCard, {
    gatewayNodeId: "gateway-b",
    gatewayLabel: "Desktop",
    projectCount: 2,
    unavailableProjectCount: 2,
    authorityProjectId: null,
    retirementBlocker: "gateway_update_required",
    busy: false,
    retiring: false,
    error: null,
    onAdd() {},
    onReviewGatewayUpdates() {},
    async onRetire() {},
  }));

  assert.match(html, /Gateway version cannot safely complete this removal/);
  assert.match(html, /Review Gateway updates/);
  assert.match(html, /Continue without this computer[^<]*<\/button>/);
  assert.match(html, /disabled=""/);
});
