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

test("shows node identity and stable update actions before consent", () => {
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
    activeGatewayNodeIds: new Set(),
    onClose() {},
    onProbe() {},
    onStart() {},
    onOpenSession() {},
    onArchiveSession() {},
    onExportDiagnostics() {},
  }));

  assert.match(html, /Install Gateway updates/);
  assert.match(html, /Office Mac · studio\.local/);
  assert.match(html, /Update available/);
  assert.match(html, /Choose when this computer may restart/);
  assert.match(html, /Update when idle/);
  assert.match(html, /Install and restart now/);
  assert.match(html, /Server/);
  assert.match(html, /Up to date/);
  assert.doesNotMatch(html, /Check live status|Check and update|Check again/);
  assert.doesNotMatch(html, /Recovering the signed reply/);
  assert.match(html, /Legacy Mac/);
  assert.match(html, /Manual update/);
  assert.match(html, /You choose the restart timing/);
});

test("starts the durable update directly without a live-status preflight", () => {
  const html = renderToStaticMarkup(createElement(GatewayUpdateDialog, {
    open: true,
    connected: true,
    release,
    nodes: [nodes[0]!],
    runtimeByNode: {
      "node-office": { state: "unchecked" },
    },
    activeGatewayNodeIds: new Set(),
    onClose() {},
    onProbe() {},
    onStart() {},
    onOpenSession() {},
    onArchiveSession() {},
    onExportDiagnostics() {},
  }));

  assert.match(
    html,
    /<button type="button" class="primary-button" aria-busy="false">Update when idle<\/button>/,
  );
  assert.match(
    html,
    /<button type="button" class="secondary-button">Install and restart now…<\/button>/,
  );
  assert.doesNotMatch(html, /primary-button" disabled/);
});

test("explains why install actions are unavailable while disconnected", () => {
  const html = renderToStaticMarkup(createElement(GatewayUpdateDialog, {
    open: true,
    connected: false,
    release,
    nodes: [nodes[0]!],
    runtimeByNode: {
      "node-office": { state: "unchecked" },
    },
    activeGatewayNodeIds: new Set(),
    onClose() {},
    onProbe() {},
    onStart() {},
    onOpenSession() {},
    onArchiveSession() {},
    onExportDiagnostics() {},
  }));

  assert.match(html, /Reconnect this Malink client before installing the update/);
  assert.match(html, /primary-button" disabled/);
});

test("keeps a delayed connection check advisory and leaves update actions usable", () => {
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
    livenessByNode: {
      "node-office": {
        state: "unreachable",
        consecutiveNoReplies: 2,
      },
    },
    activeGatewayNodeIds: new Set(),
    onClose() {},
    onProbe() {},
    onStart() {},
    onOpenSession() {},
    onArchiveSession() {},
    onExportDiagnostics() {},
  }));

  assert.match(html, /recent connection check did not receive its reply/i);
  assert.match(html, /Update when idle/);
  assert.match(html, /Install and restart now/);
  assert.doesNotMatch(html, /Gateway needs attention|Diagnose this Gateway/);
});

test("presents scheduled restart silence as part of the signed update", () => {
  const html = renderToStaticMarkup(createElement(GatewayUpdateDialog, {
    open: true,
    connected: true,
    release,
    nodes: [nodes[0]!],
    runtimeByNode: {
      "node-office": {
        state: "unreachable",
        maintenanceSessionId: "gateway-update-node-specific-hash",
        status: {
          version: 1,
          phase: "scheduled",
          releaseId: release.releaseId,
          currentBuildId: "gateway-old-arm64",
          targetBuildId: release.buildId,
          updatedAt: 1,
        },
      },
    },
    activeGatewayNodeIds: new Set(),
    onClose() {},
    onProbe() {},
    onStart() {},
    onOpenSession() {},
    onArchiveSession() {},
    onExportDiagnostics() {},
  }));

  assert.match(html, /Restart queued/);
  assert.match(html, /restart is queued and begins automatically after a short handoff/i);
  assert.match(html, /Open update session/);
  assert.doesNotMatch(html, /Gateway reply delayed/);
  assert.doesNotMatch(html, /What should I do\?/);
  assert.doesNotMatch(html, /Refresh update status|Check live status/);
  assert.doesNotMatch(html, /No update was started/);
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
    activeGatewayNodeIds: new Set(),
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
  assert.match(html, /Repeating the update request will not repair this state/);
  assert.doesNotMatch(html, /Retry with published release/);
  assert.doesNotMatch(html, /class="primary-button"/);
  assert.match(html, /role="alert"/);
});

test("keeps signed completion authoritative and removes stale progress", () => {
  const html = renderToStaticMarkup(createElement(GatewayUpdateDialog, {
    open: true,
    connected: true,
    release,
    nodes: [nodes[1]!],
    runtimeByNode: {
      "node-server": {
        state: "unreachable",
        consecutiveNoReplies: 2,
        status: {
          version: 1,
          phase: "committed",
          currentBuildId: release.buildId,
          targetBuildId: release.buildId,
          updatedAt: 20,
        },
      },
    },
    activeGatewayNodeIds: new Set(),
    onClose() {},
    onProbe() {},
    onStart() {},
    onOpenSession() {},
    onArchiveSession() {},
    onExportDiagnostics() {},
  }));

  assert.doesNotMatch(html, /gateway-update-progress/);
  assert.match(html, /Gateway update complete/);
  assert.match(html, /delayed live-status check does not undo/);
  assert.doesNotMatch(html, /Gateway needs attention/);
  assert.doesNotMatch(html, /Check again/);
});

test("does not offer a useless retry for an unpublished 404 release", () => {
  const html = renderToStaticMarkup(createElement(GatewayUpdateDialog, {
    open: true,
    connected: true,
    release,
    nodes: [nodes[0]!],
    runtimeByNode: {
      "node-office": {
        state: "online",
        status: {
          version: 1,
          phase: "failed",
          releaseId: release.releaseId,
          currentBuildId: "gateway-old-arm64",
          detail: "Gateway Agent update Prompt returned HTTP 404",
          updatedAt: 1,
        },
        commandFailureCode: "gateway_update_release_unavailable",
        commandFailureRetryable: false,
      },
    },
    activeGatewayNodeIds: new Set(),
    onClose() {},
    onProbe() {},
    onStart() {},
    onOpenSession() {},
    onArchiveSession() {},
    onExportDiagnostics() {},
  }));

  assert.match(html, /Gateway Agent update Prompt returned HTTP 404/);
  assert.match(html, /Repeating the same release would reproduce this failure/);
  assert.match(html, /Export client diagnostics/);
  assert.match(html, /Report update issue/);
  assert.doesNotMatch(html, /Try update again/);
  assert.doesNotMatch(html, /class="primary-button"/);
});

test("explains the external maintenance path for a protected-state release", () => {
  const html = renderToStaticMarkup(createElement(GatewayUpdateDialog, {
    open: true,
    connected: true,
    release,
    nodes: [nodes[0]!],
    runtimeByNode: {
      "node-office": {
        state: "online",
        status: {
          version: 1,
          phase: "failed",
          releaseId: release.releaseId,
          currentBuildId: "gateway-old-arm64",
          detail: "Gateway release introduces protected state matrix-mlp3-command-journal; automatic rollback is unsafe",
          updatedAt: 1,
        },
        commandFailureCode: "gateway_update_invalid_release",
        commandFailureRetryable: false,
      },
    },
    activeGatewayNodeIds: new Set(),
    onClose() {},
    onProbe() {},
    onStart() {},
    onOpenSession() {},
    onArchiveSession() {},
    onExportDiagnostics() {},
  }));

  assert.match(html, /Complete update on Gateway Mac/);
  assert.match(html, /<details[^>]*open=""/);
  assert.match(html, /stopped before staging or migration/);
  assert.match(html, /Let every active Agent task finish/);
  assert.match(html, /make and verify an offline backup/);
  assert.match(html, /forward-update:matrix-gateway:macos/);
  assert.match(html, /Open exact bootstrap procedure/);
  assert.match(html, /Retrying cannot succeed/);
  assert.doesNotMatch(html, /Try update again/);
  assert.doesNotMatch(html, /class="primary-button"/);
});

test("does not render the review panel while closed", () => {
  const html = renderToStaticMarkup(createElement(GatewayUpdateDialog, {
    open: false,
    connected: false,
    release,
    nodes,
    runtimeByNode: {},
    activeGatewayNodeIds: new Set(),
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
    activeGatewayNodeIds: new Set(["node-office"]),
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
  assert.match(html, /Update request saved/);
  assert.match(html, /request is saved for this named Gateway/);
  assert.match(html, /you can close this panel while it waits/);
  assert.match(html, />Close<\/button>/);
});

test("one active Gateway update does not disable another Gateway", () => {
  const secondAvailable = {
    ...nodes[0]!,
    gatewayNodeId: "node-second",
    gatewayName: "Second Gateway",
    currentBuildId: "gateway-old-second",
    targetProjectId: "project-second",
  };
  const html = renderToStaticMarkup(createElement(GatewayUpdateDialog, {
    open: true,
    connected: true,
    release,
    nodes: [nodes[0]!, secondAvailable],
    runtimeByNode: {
      "node-office": {
        state: "starting",
        status: { version: 1, phase: "idle", updatedAt: 1 },
      },
      "node-second": {
        state: "online",
        status: { version: 1, phase: "idle", updatedAt: 1 },
      },
    },
    activeGatewayNodeIds: new Set(["node-office"]),
    onClose() {},
    onProbe() {},
    onStart() {},
    onOpenSession() {},
    onArchiveSession() {},
    onExportDiagnostics() {},
  }));

  const primaryButtons = html.match(/<button type="button" class="primary-button"[^>]*>/g) ?? [];
  assert.equal(primaryButtons.length, 2);
  assert.match(primaryButtons[0]!, /disabled/);
  assert.doesNotMatch(primaryButtons[1]!, /disabled/);
  assert.match(html, /1 computer continues updating/);
});

test("keeps a signed staged phase consistent with the selected busy action", () => {
  const html = renderToStaticMarkup(createElement(GatewayUpdateDialog, {
    open: true,
    connected: true,
    release,
    nodes: [nodes[0]!],
    runtimeByNode: {
      "node-office": {
        state: "online",
        checkedAt: 1,
        status: {
          version: 1,
          phase: "staged",
          releaseId: release.releaseId,
          targetBuildId: release.buildId,
          currentBuildId: "gateway-old-arm64",
          updatedAt: 2,
        },
      },
    },
    activeGatewayNodeIds: new Set(["node-office"]),
    activeGatewayModesByNode: { "node-office": "when_idle" },
    onClose() {},
    onProbe() {},
    onStart() {},
    onOpenSession() {},
    onArchiveSession() {},
    onExportDiagnostics() {},
  }));

  assert.match(html, /Applying selected restart time/);
  assert.match(html, /restart after current Agent work finishes/);
  assert.match(html, /Scheduling when idle…/);
  assert.match(html, /Install and restart now…/);
  assert.equal(html.match(/aria-busy="true"/g)?.length, 1);
  assert.doesNotMatch(html, /Ready to choose restart time/);
});

test("opens a legacy maintenance session through its exact project route", () => {
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
    activeGatewayNodeIds: new Set(),
    onClose() {},
    onProbe() {},
    onStart() {},
    onOpenSession() {},
    onArchiveSession() {},
    onExportDiagnostics() {},
  }));

  assert.match(html, /update session left by an older Malink version/);
  assert.match(html, /project-qualified route is preserved/);
  assert.doesNotMatch(html, /maintenance session ID|node-specific session IDs/);
  assert.match(html, /Open update session/);
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
    activeGatewayNodeIds: new Set(),
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

test("locks archive actions while the signed lifecycle command is running", () => {
  const html = renderToStaticMarkup(createElement(GatewayUpdateDialog, {
    open: true,
    connected: true,
    release,
    nodes: [nodes[0]!, nodes[1]!],
    runtimeByNode: {
      "node-office": {
        state: "checking",
        maintenanceSessionId: "legacy-shared-session",
        maintenanceSessionAmbiguous: true,
        maintenanceSessionArchiveAvailable: true,
        maintenanceSessionArchiveBusy: true,
        maintenanceSessionArchiveChecking: true,
      },
      "node-server": {
        state: "unreachable",
        consecutiveNoReplies: 2,
      },
    },
    activeGatewayNodeIds: new Set(),
    diagnosticExportBusy: true,
    onClose() {},
    onProbe() {},
    onStart() {},
    onOpenSession() {},
    onArchiveSession() {},
    onExportDiagnostics() {},
  }));

  assert.match(
    html,
    /<button type="button" class="secondary-button" disabled="" aria-busy="true">Archiving old update session…<\/button>/,
  );
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
    activeGatewayNodeIds: new Set(),
    onClose() {},
    onProbe() {},
    onStart() {},
    onOpenSession() {},
    onArchiveSession() {},
    onExportDiagnostics() {},
  }));

  assert.match(html, /Archive old update session/);
  assert.match(html, /only this Gateway is affected/);
  assert.match(html, /Update when idle/);
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
          releaseId: release.releaseId,
          targetBuildId: release.buildId,
          currentBuildId: "gateway-old-arm64",
          updatedAt: 1,
        },
      },
    },
    activeGatewayNodeIds: new Set(),
    onClose() {},
    onProbe() {},
    onStart() {},
    onOpenSession() {},
    onArchiveSession() {},
    onExportDiagnostics() {},
  }));

  assert.match(html, /Ready to choose restart time/);
  assert.match(html, /Install when idle/);
  assert.match(html, /Install and restart now/);
});

test("never labels an older staged build as the published install action", () => {
  const html = renderToStaticMarkup(createElement(GatewayUpdateDialog, {
    open: true,
    connected: true,
    release,
    nodes: [nodes[0]!],
    runtimeByNode: {
      "node-office": {
        state: "unchecked",
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
    activeGatewayNodeIds: new Set(),
    onClose() {},
    onStart() {},
    onOpenSession() {},
    onArchiveSession() {},
    onExportDiagnostics() {},
  }));

  assert.match(html, /Newer Gateway update available/);
  assert.match(html, /Prepare latest update/);
  assert.match(html, /Prepare latest and restart now/);
  assert.doesNotMatch(html, /Install when idle|Ready to choose restart time/);
});

test("renders running supervisor phases as status without update actions or alerts", () => {
  for (const phase of [
    "staging",
    "agent_required",
    "agent_running",
    "agent_validating",
    "waiting_for_idle",
    "scheduled",
    "activating",
    "probation",
  ] as const) {
    const html = renderToStaticMarkup(createElement(GatewayUpdateDialog, {
      open: true,
      connected: true,
      release,
      nodes: [nodes[0]!],
      runtimeByNode: {
        "node-office": {
          state: "unchecked",
          status: {
            version: 1,
            phase,
            releaseId: release.releaseId,
            targetBuildId: release.buildId,
            currentBuildId: "gateway-old-arm64",
            updatedAt: 1,
          },
        },
      },
      activeGatewayNodeIds: new Set(),
      onClose() {},
      onStart() {},
      onOpenSession() {},
      onArchiveSession() {},
      onExportDiagnostics() {},
    }));

    assert.match(html, /role="status"/, phase);
    assert.doesNotMatch(html, /role="alert"/, phase);
    assert.doesNotMatch(html, /class="primary-button"/, phase);
    assert.doesNotMatch(html, /Install and restart now/, phase);
  }
});

test("does not offer retry for a non-retryable command result without signed status", () => {
  const html = renderToStaticMarkup(createElement(GatewayUpdateDialog, {
    open: true,
    connected: true,
    release,
    nodes: [nodes[0]!],
    runtimeByNode: {
      "node-office": {
        state: "error",
        detail: "The signed release was rejected.",
        commandFailureCode: "gateway_update_invalid_release",
        commandFailureRetryable: false,
      },
    },
    activeGatewayNodeIds: new Set(),
    onClose() {},
    onStart() {},
    onOpenSession() {},
    onArchiveSession() {},
    onExportDiagnostics() {},
  }));

  assert.match(html, /Update needs attention/);
  assert.match(html, /rejected this update request as non-retryable/i);
  assert.match(html, /Export client diagnostics/);
  assert.match(html, /Report update issue/);
  assert.doesNotMatch(html, /Update when idle|Install and restart now|Try update again/);
});

test("requires an explicit second action for a forward-only staged release", () => {
  const html = renderToStaticMarkup(createElement(GatewayUpdateDialog, {
    open: true,
    connected: true,
    release,
    nodes: [nodes[0]!],
    runtimeByNode: {
      "node-office": {
        state: "online",
        status: {
          version: 1,
          phase: "staged",
          releaseId: release.releaseId,
          targetBuildId: release.buildId,
          currentBuildId: "gateway-old-arm64",
          activationMode: "forward-only",
          detail: "Forward-only update staged.",
          updatedAt: 1,
        },
      },
    },
    activeGatewayNodeIds: new Set(),
    onClose() {},
    onProbe() {},
    onStart() {},
    onOpenSession() {},
    onArchiveSession() {},
    onExportDiagnostics() {},
  }));

  assert.match(html, /Ready · confirmation required/);
  assert.match(html, /Extra confirmation required/);
  assert.match(html, /Confirm and install when idle/);
  assert.match(html, /cannot automatically return to the previous Gateway version/);
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
    activeGatewayNodeIds: new Set(),
    onClose() {},
    onProbe() {},
    onStart() {},
    onOpenSession() {},
    onArchiveSession() {},
    onExportDiagnostics() {},
  }));

  assert.match(html, /signed supervisor state confirms this build is installed/i);
  assert.doesNotMatch(html, /left by an older Malink version/);
  assert.doesNotMatch(html, /Archive old update session/);
  assert.doesNotMatch(html, /Maintenance Agent running/);
});

test("does not let an installed prior release block the newly published update", () => {
  const html = renderToStaticMarkup(createElement(GatewayUpdateDialog, {
    open: true,
    connected: true,
    release,
    nodes: [{
      ...nodes[0]!,
      currentBuildId: "gateway-previous-target",
      buildObservedAt: 20,
    }],
    runtimeByNode: {
      "node-office": {
        state: "online",
        maintenanceSessionId: "gateway-update-previous-release",
        status: {
          version: 1,
          phase: "scheduled",
          releaseId: "release-previous",
          targetBuildId: "gateway-previous-target",
          currentBuildId: "gateway-before-previous",
          updatedAt: 10,
        },
      },
    },
    activeGatewayNodeIds: new Set(),
    onClose() {},
    onProbe() {},
    onStart() {},
    onOpenSession() {},
    onArchiveSession() {},
    onExportDiagnostics() {},
  }));

  assert.match(html, /Update available/);
  assert.match(html, /Update when idle/);
  assert.doesNotMatch(html, /Check and update|Check live status/);
  assert.doesNotMatch(html, /Gateway restart scheduled/);
  assert.doesNotMatch(html, /Open update session/);
});
