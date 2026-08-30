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
        state: "unreachable",
      },
    },
    activeGatewayNodeId: null,
    onClose() {},
    onProbe() {},
    onStart() {},
    onOpenSession() {},
    onArchiveSession() {},
  }));

  assert.match(html, /Review Gateway update/);
  assert.match(html, /Office Mac · studio\.local/);
  assert.match(html, /Update available/);
  assert.match(html, /Online now/);
  assert.match(html, /Create update session/);
  assert.match(html, /Server/);
  assert.match(html, /Up to date/);
  assert.match(html, /No live reply/);
  assert.match(html, /did not return a signed reply/);
  assert.match(html, /Retry live check/);
  assert.doesNotMatch(html, /Recovering the signed reply/);
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
    onArchiveSession() {},
  }));
  assert.equal(html, "");
});

test("keeps the panel dismissible while a Gateway maintenance Agent starts", () => {
  const html = renderToStaticMarkup(createElement(GatewayUpdateDialog, {
    open: true,
    connected: true,
    release,
    nodes,
    runtimeByNode: {
      "node-office": {
        state: "starting",
        startedAt: 1,
      },
    },
    activeGatewayNodeId: "node-office",
    onClose() {},
    onProbe() {},
    onStart() {},
    onOpenSession() {},
    onArchiveSession() {},
  }));

  const closeControl = html.match(
    /<button[^>]*aria-label="Close Gateway update"[^>]*>/,
  )?.[0];
  assert.ok(closeControl);
  assert.doesNotMatch(closeControl, /disabled/);
  assert.match(html, /You can close this panel/);
  assert.match(html, /continues this update in the background/);
  assert.match(html, />Close<\/button>/);
});

test("does not open a legacy maintenance session shared by multiple nodes", () => {
  const html = renderToStaticMarkup(createElement(GatewayUpdateDialog, {
    open: true,
    connected: true,
    release,
    nodes,
    runtimeByNode: {
      "node-office": {
        state: "online",
        maintenanceSessionId: "legacy-shared-session",
        maintenanceSessionAmbiguous: true,
        maintenanceSessionArchiveAvailable: true,
      },
    },
    activeGatewayNodeId: null,
    onClose() {},
    onProbe() {},
    onStart() {},
    onOpenSession() {},
    onArchiveSession() {},
  }));

  assert.match(html, /update session left by an older Malink version/);
  assert.match(html, /only this Gateway is affected/);
  assert.doesNotMatch(html, /maintenance session ID|node-specific session IDs/);
  assert.doesNotMatch(html, /Open update session/);
  assert.match(html, /Archive old update session/);
});

test("shows exact-node archival progress for a legacy maintenance session", () => {
  const html = renderToStaticMarkup(createElement(GatewayUpdateDialog, {
    open: true,
    connected: true,
    release,
    nodes,
    runtimeByNode: {
      "node-office": {
        state: "online",
        maintenanceSessionId: "legacy-shared-session",
        maintenanceSessionAmbiguous: true,
        maintenanceSessionArchiveAvailable: true,
        maintenanceSessionArchiveBusy: true,
      },
      "node-server": {
        state: "online",
        maintenanceSessionId: "legacy-shared-session",
        maintenanceSessionAmbiguous: true,
        maintenanceSessionArchived: true,
      },
    },
    activeGatewayNodeId: null,
    onClose() {},
    onProbe() {},
    onStart() {},
    onOpenSession() {},
    onArchiveSession() {},
  }));

  assert.match(html, /Archiving old update session…/);
  assert.match(html, /Old update session archived on this Gateway/);
});

test("keeps a new release actionable while offering cleanup for an older collision", () => {
  const html = renderToStaticMarkup(createElement(GatewayUpdateDialog, {
    open: true,
    connected: true,
    release,
    nodes,
    runtimeByNode: {
      "node-office": {
        state: "online",
        status: {
          version: 1,
          phase: "committed",
          releaseId: "older-release",
          targetBuildId: "gateway-older",
          currentBuildId: "gateway-old-arm64",
          updatedAt: 1,
        },
        legacyMaintenanceSessionId: "gateway-update-shared-old",
        legacyMaintenanceSessionArchiveAvailable: true,
      },
    },
    activeGatewayNodeId: null,
    onClose() {},
    onProbe() {},
    onStart() {},
    onOpenSession() {},
    onArchiveSession() {},
  }));

  assert.match(html, /Archive old update session/);
  assert.match(html, /only this Gateway is affected/);
  assert.match(html, /Create update session/);
});

test("offers installation when the maintenance Agent already staged the target", () => {
  const html = renderToStaticMarkup(createElement(GatewayUpdateDialog, {
    open: true,
    connected: true,
    release,
    nodes: [nodes[0]!],
    runtimeByNode: {
      "node-office": {
        state: "online",
        maintenanceSessionId: "gateway-update-existing",
        status: {
          version: 1,
          phase: "staged",
          releaseId: "older-staged-release",
          targetBuildId: "gateway-staged-arm64",
          currentBuildId: "gateway-old-arm64",
          updatedAt: 1,
        },
      },
    },
    activeGatewayNodeId: null,
    onClose() {},
    onProbe() {},
    onStart() {},
    onOpenSession() {},
    onArchiveSession() {},
  }));

  assert.match(html, /gateway-staged-arm64.*staged locally and ready to install/);
  assert.match(html, /Install staged update/);
});

test("treats a verified installed build as complete without cleanup warnings", () => {
  const html = renderToStaticMarkup(createElement(GatewayUpdateDialog, {
    open: true,
    connected: true,
    release,
    nodes: [nodes[1]!],
    runtimeByNode: {
      "node-server": {
        state: "online",
        maintenanceSessionId: "gateway-update-shared-old",
        maintenanceSessionAmbiguous: true,
        maintenanceSessionArchiveAvailable: true,
        legacyMaintenanceSessionId: "gateway-update-even-older",
        legacyMaintenanceSessionArchiveAvailable: true,
        status: {
          version: 1,
          phase: "agent_running",
          releaseId: release.releaseId,
          targetBuildId: release.buildId,
          currentBuildId: release.buildId,
          updatedAt: 1,
        },
      },
    },
    activeGatewayNodeId: null,
    onClose() {},
    onProbe() {},
    onStart() {},
    onOpenSession() {},
    onArchiveSession() {},
  }));

  assert.match(html, /Installed build verified/);
  assert.doesNotMatch(html, /left by an older Malink version/);
  assert.doesNotMatch(html, /Archive old update session/);
  assert.doesNotMatch(html, /Maintenance Agent running/);
});
