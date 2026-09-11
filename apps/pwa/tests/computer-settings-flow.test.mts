import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { GatewayUpdateDialog } from "../app/GatewayUpdateDialog";
import { computerUpdateSummary } from "../app/computerUpdateSummary";

const node = { gatewayNodeId: "mac", gatewayName: "Tokyo", onlineUpdate: true, state: "current" as const, currentBuildId: "new", targetProjectId: "project" };
const tracks = { generation: 3, activeRelease: "new", standbyRelease: "old", phase: "steady" as const };
const base = { open: true, embedded: true, connected: true, release: { releaseId: "new", buildId: "new" }, nodes: [node], activeGatewayNodeIds: new Set<string>(),
  onClose() {}, onStart() {}, onPromote() {}, onDiscard() {}, onOpenProject() {}, onOpenSession() {}, onArchiveSession() {}, onExportDiagnostics() {}, onSelectVersion() {}, onCheckVersions() {} };

test("completed dual-track update renders without a legacy deployment and keeps the update session", () => {
  const html = renderToStaticMarkup(createElement(GatewayUpdateDialog, { ...base, runtimeByNode: { mac: { state: "online", maintenanceSessionId: "update-session", status: { version: 1, updatedAt: 1, currentBuildId: "new", phase: "committed", executionTracks: tracks } } } }));
  assert.match(html, /Switch to retained version old/);
  assert.match(html, /View update session/);
  assert.match(html, /Current version confirmed/);
  assert.doesNotMatch(html, /role="dialog"|Check available versions|Start update session<\/button>/);
});

test("release discovery failure cannot hide independent retained-version controls", () => {
  const html = renderToStaticMarkup(createElement(GatewayUpdateDialog, { ...base, release: null, runtimeByNode: { mac: { state: "online", status: { version: 1, updatedAt: 1, currentBuildId: "new", phase: "idle", executionTracks: tracks } } } }));
  assert.match(html, /Switch to retained version old/);
  assert.match(html, /Release channel not available/);
  assert.doesNotMatch(html, /Start update session<\/button>/);
});

test("handoff and failure take priority over a completed install in the computer list", () => {
  const runtime = { state: "online" as const, status: { version: 1 as const, updatedAt: 1, phase: "committed" as const, executionTracks: { ...tracks, phase: "attention" as const } } };
  assert.equal(computerUpdateSummary(runtime), "Version needs attention · review retained version");
  assert.equal(computerUpdateSummary(runtime, "select_version"), "Switching version");
  assert.equal(computerUpdateSummary({ ...runtime, status: { ...runtime.status, phase: "staged", executionTracks: tracks } }), "New version prepared · waiting for your switch");
});
