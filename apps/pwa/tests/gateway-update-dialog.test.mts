import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { GatewayUpdateDialog } from "../app/GatewayUpdateDialog.tsx";

const release = { releaseId: "2026.08.28.1", buildId: "gateway-next-arm64" };
const nodes = [
  {
    gatewayNodeId: "node-office",
    gatewayName: "Office Mac",
    computerName: "studio.local",
    currentBuildId: "gateway-old-arm64",
    targetProjectId: "project-office",
    onlineUpdate: true,
    state: "available" as const,
  },
  {
    gatewayNodeId: "node-server",
    gatewayName: "Server",
    currentBuildId: release.buildId,
    targetProjectId: "project-server",
    onlineUpdate: true,
    state: "current" as const,
  },
  {
    gatewayNodeId: "node-legacy",
    gatewayName: "Legacy Mac",
    currentBuildId: "gateway-legacy",
    targetProjectId: "project-legacy",
    onlineUpdate: false,
    state: "manual" as const,
  },
];

test("shows node identity, version need, and signed live status before consent", () => {
  const html = renderToStaticMarkup(createElement(GatewayUpdateDialog, {
    open: true,
    connected: true,
    release,
    nodes,
    runtimeByNode: {
      "node-office": {
        state: "online",
        checkedAt: Date.UTC(2026, 7, 28, 8, 0, 0),
        status: {
          version: 1,
          phase: "idle",
          currentBuildId: "gateway-old-arm64",
          updatedAt: 1,
        },
      },
      "node-server": {
        state: "failed",
        detail: "No signed reply arrived within 12 seconds.",
      },
    },
    activeGatewayNodeId: null,
    onClose() {},
    onProbe() {},
    onStart() {},
    onOpenSession() {},
  }));

  assert.match(html, /Review Gateway update/);
  assert.match(html, /Office Mac · studio\.local/);
  assert.match(html, /Update available/);
  assert.match(html, /Online now/);
  assert.match(html, /Create update session/);
  assert.match(html, /Server/);
  assert.match(html, /Up to date/);
  assert.match(html, /No live reply/);
  assert.match(html, /Legacy Mac/);
  assert.match(html, /Manual update/);
  assert.match(html, /Requested by this Malink device; executed by the named Gateway/);
});

test("does not render the review panel while closed", () => {
  const html = renderToStaticMarkup(createElement(GatewayUpdateDialog, {
    open: false,
    connected: false,
    release,
    nodes,
    runtimeByNode: {},
    activeGatewayNodeId: null,
    onClose() {},
    onProbe() {},
    onStart() {},
    onOpenSession() {},
  }));
  assert.equal(html, "");
});
