import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { GatewayUpdateDialog } from "../app/GatewayUpdateDialog";

const node = { gatewayNodeId: "mac", gatewayName: "Tokyo", onlineUpdate: true, state: "current" as const, currentBuildId: "new", targetProjectId: "project" };
const tracks = { generation: 3, activeRelease: "new", standbyRelease: "old", phase: "steady" as const };
const base = { open: true, embedded: true, connected: true, release: { releaseId: "new", buildId: "new" }, nodes: [node], activeGatewayNodeIds: new Set<string>(),
  livenessByNode: { mac: { state: "online" as const, lastVerifiedAt: Date.now() } },
  onClose() {}, onStart() {}, onPromote() {}, onDiscard() {}, onOpenProject() {}, onOpenSession() {}, onArchiveSession() {}, onExportDiagnostics() {}, onSelectVersion() {}, onCheckVersions() {} };

test("completed dual-track update renders without a legacy deployment and keeps the update session", () => {
  const html = renderToStaticMarkup(createElement(GatewayUpdateDialog, { ...base, runtimeByNode: { mac: { state: "online", maintenanceSessionId: "update-session", status: { version: 1, updatedAt: 1, currentBuildId: "new", phase: "committed", executionTracks: tracks } } } }));
  assert.match(html, /Switch to retained version old/);
  assert.match(html, /View update session/);
  assert.match(html, /No action needed/);
  assert.doesNotMatch(html, /role="dialog"|Check available versions|Start update session<\/button>/);
});

test("release discovery failure cannot hide independent retained-version controls", () => {
  const html = renderToStaticMarkup(createElement(GatewayUpdateDialog, { ...base, release: null, runtimeByNode: { mac: { state: "online", status: { version: 1, updatedAt: 1, currentBuildId: "new", phase: "idle", executionTracks: tracks } } } }));
  assert.match(html, /Switch to retained version old/);
  assert.match(html, /Not confirmed/);
  assert.doesNotMatch(html, /Start update session<\/button>/);
});

test("embedded management keeps technical state and secondary actions collapsed", () => {
  const html = renderToStaticMarkup(createElement(GatewayUpdateDialog, { ...base, runtimeByNode: {mac:{state:"online",status:{version:1,updatedAt:1,phase:"committed",currentBuildId:"new",executionTracks:tracks}}} }));
  const visible = html.slice(0, html.indexOf('<details class="computer-update-advanced"'));
  assert.match(visible, /Available/);
  assert.doesNotMatch(visible, /Execution tracks|Current build|Target build|View update session|Available release/);
  assert.match(html, /<details class="computer-update-advanced">/);
  assert.match(html, /Switch to retained version old/);
});

test("embedded preparation is calm progress without a second update action", () => {
  const html = renderToStaticMarkup(createElement(GatewayUpdateDialog, { ...base, nodes: [{ ...node, state: "available", currentBuildId: "old" }], runtimeByNode: { mac: { state: "online", status: { version: 1, updatedAt: 1, phase: "agent_running", currentBuildId: "old", targetBuildId: "new", releaseId: "new" } } } }));
  const visible = html.slice(0, html.indexOf('<details class="computer-update-advanced"'));
  assert.match(visible, /Preparing update/);
  assert.match(visible, /no action is needed now/);
  assert.doesNotMatch(visible, /role="alert"|>Update<\/button>|Retry update/);
});

test("embedded signed completion does not become a failed install after status check timeout", () => {
  const html = renderToStaticMarkup(createElement(GatewayUpdateDialog, { ...base, runtimeByNode: { mac: { state: "online", versionCheckError: "No reply", status: { version: 1, updatedAt: 1, currentBuildId: "new", phase: "committed", executionTracks: tracks } } } }));
  const visible = html.slice(0, html.indexOf('<details class="computer-update-advanced"'));
  assert.match(visible, /Available/);
  assert.doesNotMatch(visible, /No reply|failed|Retry update/);
  assert.match(html, /Last check did not succeed/);
});
