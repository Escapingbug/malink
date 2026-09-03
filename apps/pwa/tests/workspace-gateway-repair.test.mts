import assert from "node:assert/strict";
import test from "node:test";
import type { SignedWorkspaceGatewayDirectory } from "@malink/protocol";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { GatewayRecoveryCard } from "../app/MatrixSettings.tsx";
import { workspaceGatewayRepairPlan } from "../app/workspaceGatewayRepair.ts";

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
  });
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
    busy: false,
    retiring: false,
    error: null,
    onAdd() {},
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
    busy: false,
    retiring: false,
    error: null,
    onAdd() {},
    async onRetire() {},
  }));

  assert.match(html, /Another connected computer is required/);
  assert.match(html, /Continue without this computer[^<]*<\/button>/);
  assert.match(html, /disabled=""/);
});
