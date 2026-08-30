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
    onExportDiagnostics() {},
  }));

  assert.match(html, /Review Gateway update/);
  assert.match(html, /Office Mac · studio\.local/);
  assert.match(html, /Update available/);
  assert.match(html, /Online now/);
  assert.match(html, /Create update session/);
  assert.match(html, /Server/);
  assert.match(html, /Up to date/);
  assert.match(html, /Live check timed out/);
  assert.match(html, /temporary Matrix delay/);
  assert.match(html, /Check again/);
  assert.match(html, /What should I do\?/);
  assert.match(html, /Export client diagnostics/);
  assert.doesNotMatch(html, /Recovering the signed reply/);
  assert.match(html, /Legacy Mac/);
  assert.match(html, /Manual update/);
  assert.match(html, /Requested by this Malink device; executed by the named Gateway/);
});

test("turns repeated missing replies into actionable Gateway attention", () => {
  const html = renderToStaticMarkup(createElement(GatewayUpdateDialog, {
    open: true,
    connected: true,
    release,
    nodes: [nodes[0]!],
    runtimeByNode: {
      "node-office": {
        state: "unreachable",
        consecutiveNoReplies: 2,
      },
    },
    activeGatewayNodeId: null,
    onClose() {},
    onProbe() {},
    onStart() {},
    onOpenSession() {},
    onArchiveSession() {},
    onExportDiagnostics() {},
  }));

  assert.match(html, /Gateway needs attention/);
  assert.match(html, /missed 2 consecutive signed checks/);
  assert.match(html, /repeating the check alone will not repair/i);
  assert.match(html, /Diagnose this Gateway/);
  assert.match(html, /launchctl kickstart/);
  assert.match(html, /gateway\.error\.log/);
  assert.match(html, /update-supervisor\.error\.log/);
});

test("presents a signed supervisor repair failure as an actionable error", () => {
  const html = renderToStaticMarkup(createElement(GatewayUpdateDialog, {
    open: true,
    connected: true,
    release,
    nodes: [nodes[0]!],
    runtimeByNode: {
      "node-office": {
        state: "online",
        checkedAt: 1,
        maintenanceSessionId: "gateway-update-node-interrupted",
        status: {
          version: 1,
          phase: "repair_required",
          releaseId: release.releaseId,
          currentBuildId: "gateway-old-arm64",
          targetBuildId: release.buildId,
          detail: "Activation and rollback health checks both failed",
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
    onExportDiagnostics() {},
  }));

  assert.match(html, /Gateway repair required/);
  assert.match(html, /Activation and rollback health checks both failed/);
  assert.match(html, /Repair this Gateway/);
  assert.match(html, /is answering again/);
  assert.match(html, /Retry with published release/);
  assert.doesNotMatch(html, /Repeating the update request will not repair this state/);
  const retryControl = html.match(
    /<button[^>]*class="primary-button"[^>]*>Retry with published release<\/button>/,
  )?.[0];
  assert.ok(retryControl);
  assert.doesNotMatch(retryControl, /disabled/);
  assert.match(html, /role="alert"/);
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
    onExportDiagnostics() {},
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
    onExportDiagnostics() {},
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
    onExportDiagnostics() {},
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
    onExportDiagnostics() {},
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
    onExportDiagnostics() {},
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
    onExportDiagnostics() {},
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
    onExportDiagnostics() {},
  }));

  assert.match(html, /Installed build verified/);
  assert.doesNotMatch(html, /left by an older Malink version/);
  assert.doesNotMatch(html, /Archive old update session/);
  assert.doesNotMatch(html, /Maintenance Agent running/);
});
