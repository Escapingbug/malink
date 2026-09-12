import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { GatewayUpdateDialog } from "../app/GatewayUpdateDialog";
import { GatewayManagement } from "../app/GatewayManagement";

const node = { gatewayNodeId: "mac", gatewayName: "Tokyo", onlineUpdate: true, state: "current" as const, currentBuildId: "new", targetProjectId: "project" };
const tracks = { generation: 3, activeRelease: "new", standbyRelease: "old", phase: "steady" as const };
const base = { open: true, embedded: true, connected: true, release: { releaseId: "new", buildId: "new" }, nodes: [node], activeGatewayNodeIds: new Set<string>(),
  livenessByNode: { mac: { state: "online" as const, lastVerifiedAt: Date.now() } },
  onClose() {}, onStart() {}, onPromote() {}, onDiscard() {}, onOpenProject() {}, onOpenSession() {}, onArchiveSession() {}, onExportDiagnostics() {}, onSelectVersion() {}, onCheckVersions() {} };

test("version comparison stays visible independently of an earlier completed update", () => {
  const props = { node, runtime: { state: "online" as const }, connected: true, busy: false, preparing: false,
    ready: false, switching: false, complete: true, failed: false, canUpdate: true,
    onUpdate() {}, onInstall() {}, onOpen() {}, onDelete() {}, onExport() {} };
  const newer = renderToStaticMarkup(createElement(GatewayManagement, { ...props, latestBuild: "newer" }));
  assert.match(newer, /Update available/);
  assert.match(newer, /Latest <span>newer/);
  assert.match(newer, />Update<\/button>/);
  const unknown = renderToStaticMarkup(createElement(GatewayManagement, props));
  assert.match(unknown, /Latest version not confirmed/);
  assert.doesNotMatch(unknown, /Update successful/);
});

test("confirmed deletion removes session controls, not temporary recovery", () => {
  const html = renderToStaticMarkup(createElement(GatewayUpdateDialog, { ...base, runtimeByNode: { mac: { state: "online", maintenanceSessionId: "session", maintenanceSessionArchived: true,
    status: { version: 1, phase: "committed", currentBuildId: "new", updatedAt: Date.now(), executionTracks: tracks } } } }));
  assert.doesNotMatch(html, /Open update session|Delete update session/);
  assert.match(html, /Temporarily use previous version/);
});
test("forward-only recovery never exposes an old reader", () => {
  const html = renderToStaticMarkup(createElement(GatewayUpdateDialog, { ...base, runtimeByNode: { mac: { state: "online",
    status: { version: 1, phase: "repair_required", currentBuildId: "old", activationMode: "forward-only", updatedAt: Date.now(), executionTracks: { ...tracks, phase: "attention", targetRelease: "new" } } } } }));
  assert.match(html, /Retry prepared update/);
  assert.doesNotMatch(html, /Temporarily use previous version/);
});
test("signed rollback offers update even before the directory changes", () => {
  const html = renderToStaticMarkup(createElement(GatewayUpdateDialog, { ...base, runtimeByNode: { mac: { state: "online",
    status: { version: 1, phase: "committed", currentBuildId: "old", targetBuildId: "new", releaseId: "new", updatedAt: Date.now(), executionTracks: { ...tracks, activeRelease: "old", standbyRelease: "new" } } } } }));
  assert.match(html, />Update<\/button>/);
  assert.match(html, /Using an older version temporarily/);
});

test("completed update directly exposes its session and temporary recovery", () => {
  const html = renderToStaticMarkup(createElement(GatewayUpdateDialog, { ...base, runtimeByNode: { mac: { state: "online", maintenanceSessionId: "update-session", status: { version: 1, updatedAt: 1, currentBuildId: "new", phase: "committed", executionTracks: tracks } } } }));
  assert.doesNotMatch(html, /Versions|Update activity|Connection &amp; recovery/);
  assert.match(html, /Update complete/);
  assert.match(html, /Open update session/);
  assert.doesNotMatch(html, /class="primary-button"/);
  assert.match(html, /gateway-connection-row/);
  assert.match(html, /gateway-software-task/);
  assert.match(html, /Temporarily use previous version/);
  assert.doesNotMatch(html, /role="dialog"|Check available versions|Start update session<\/button>/);
});

test("release discovery failure cannot hide independent retained-version controls", () => {
  const html = renderToStaticMarkup(createElement(GatewayUpdateDialog, { ...base, release: null, runtimeByNode: { mac: { state: "online", status: { version: 1, updatedAt: 1, currentBuildId: "new", phase: "idle", executionTracks: tracks } } } }));
  assert.match(html, /Temporarily use previous version/);
  assert.match(html, /Refresh Gateway status/);
  assert.doesNotMatch(html, /Start update session<\/button>/);
});

test("embedded management uses task destinations instead of hidden legacy disclosures", () => {
  const html = renderToStaticMarkup(createElement(GatewayUpdateDialog, { ...base, runtimeByNode: {mac:{state:"online",status:{version:1,updatedAt:1,phase:"committed",currentBuildId:"new",executionTracks:tracks}}} }));
  const visible = html.slice(0, html.indexOf('<details class="computer-update-advanced"'));
  assert.match(visible, /Update complete/);
  assert.doesNotMatch(visible, /Execution tracks|Current build|Target build|View update session|Available release/);
  assert.doesNotMatch(html, /<details|Switch to retained version old/);
  assert.doesNotMatch(html, /aria-haspopup="dialog"/);
});

test("embedded preparation is calm progress without a second update action", () => {
  const html = renderToStaticMarkup(createElement(GatewayUpdateDialog, { ...base, nodes: [{ ...node, state: "available", currentBuildId: "old" }], runtimeByNode: { mac: { state: "online", status: { version: 1, updatedAt: 1, phase: "agent_running", currentBuildId: "old", targetBuildId: "new", releaseId: "new" } } } }));
  const visible = html.slice(0, html.indexOf('<details class="computer-update-advanced"'));
  assert.match(visible, /Preparing update/);
  assert.doesNotMatch(visible, /Restart and install update/);
  assert.doesNotMatch(visible, /role="alert"|>Update<\/button>|Retry update/);
});

test("embedded signed completion does not become a failed install after status check timeout", () => {
  const html = renderToStaticMarkup(createElement(GatewayUpdateDialog, { ...base, runtimeByNode: { mac: { state: "online", versionCheckError: "No reply", status: { version: 1, updatedAt: 1, currentBuildId: "new", phase: "committed", executionTracks: tracks } } } }));
  const visible = html.slice(0, html.indexOf('<details class="computer-update-advanced"'));
  assert.match(visible, /Update complete/);
  assert.doesNotMatch(visible, /Update needs attention|Retry update/);
  assert.match(html, /Status not confirmed/);
  assert.doesNotMatch(html, /gateway-connection-state is-online/);
  assert.doesNotMatch(html, /Connection &amp; recovery/);
});
