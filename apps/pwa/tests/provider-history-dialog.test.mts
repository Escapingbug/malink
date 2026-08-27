import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ProviderHistoryDialog } from "../app/ProviderHistoryDialog.tsx";
import { findRecentlyArchivedProviderSession } from "../app/providerHistorySessions.ts";

const defaultSource = {
  key: '["gateway-office","project-api"]',
  gatewayNodeId: "gateway-office",
  gatewayLabel: "Office Mac",
  projectId: "project-api",
  projectName: "API",
  cwd: "/work/api",
};

test("keeps provider history dismissible while sessions load", () => {
  const html = renderToStaticMarkup(createElement(ProviderHistoryDialog, {
    open: true,
    sourceKey: defaultSource.key,
    sources: [defaultSource],
    provider: "codex",
    providers: [{
      id: "codex",
      name: "Codex",
      canListSessions: true,
      canInspectSessions: true,
    }],
    sessions: [],
    selected: null,
    messages: [],
    loading: "sessions",
    error: null,
    onClose() {},
    onSourceChange() {},
    onProviderChange() {},
    onInspect() {},
    onRetry() {},
    onOpenManaged() {},
    onContinue() {},
  }));

  const closeButton = html.match(
    /<button(?=[^>]*aria-label="Close provider history")[^>]*>/,
  )?.[0];
  assert.ok(closeButton);
  assert.doesNotMatch(closeButton, /disabled/);
  assert.match(html, /Loading provider sessions in the background/);
  assert.match(html, /You can close this window while sessions load/);
});

test("keeps the provider history retry action after a background failure", () => {
  const html = renderToStaticMarkup(createElement(ProviderHistoryDialog, {
    open: true,
    sourceKey: defaultSource.key,
    sources: [defaultSource],
    provider: "codex",
    providers: [],
    sessions: [],
    selected: null,
    messages: [],
    loading: null,
    error: "Provider history could not be loaded.",
    onClose() {},
    onSourceChange() {},
    onProviderChange() {},
    onInspect() {},
    onRetry() {},
    onOpenManaged() {},
    onContinue() {},
  }));

  assert.match(html, /Provider history could not be loaded/);
  assert.match(html, /<button type="button">Retry<\/button>/);
});

test("groups archived sessions first and sorts them by Malink archive time", () => {
  const sessions = [
    {
      sessionId: "current-session",
      title: "Current work",
      updatedAt: 900,
      managedSessionId: "malink-current",
    },
    {
      sessionId: "provider-session",
      title: "Provider-only work",
      updatedAt: 800,
    },
    {
      sessionId: "older-archived-session",
      title: "Older archive",
      updatedAt: 9_999,
      latestArchivedSessionId: "malink-older",
      lastArchivedAt: 100,
    },
    {
      sessionId: "newest-archived-session",
      title: "Newest archive",
      updatedAt: 1,
      latestArchivedSessionId: "malink-newest",
      lastArchivedAt: 500,
    },
  ];
  const html = renderToStaticMarkup(createElement(ProviderHistoryDialog, {
    open: true,
    sourceKey: defaultSource.key,
    sources: [defaultSource],
    provider: "codex",
    providers: [{
      id: "codex",
      name: "Codex",
      canListSessions: true,
      canInspectSessions: true,
    }],
    sessions,
    selected: sessions[3],
    messages: [],
    loading: null,
    error: null,
    onClose() {},
    onSourceChange() {},
    onProviderChange() {},
    onInspect() {},
    onRetry() {},
    onOpenManaged() {},
    onContinue() {},
  }));

  const archivedGroup = html.indexOf("Archived from Malink");
  const newestArchive = html.indexOf("Newest archive");
  const olderArchive = html.indexOf("Older archive");
  const providerGroup = html.indexOf("Provider-only");
  const providerSession = html.indexOf("Provider-only work");
  const currentGroup = html.indexOf("Current in Malink");
  const currentSession = html.indexOf("Current work");
  assert.ok(archivedGroup < newestArchive);
  assert.ok(newestArchive < olderArchive);
  assert.ok(olderArchive < providerGroup);
  assert.ok(providerGroup < providerSession);
  assert.ok(providerSession < currentGroup);
  assert.ok(currentGroup < currentSession);
  assert.match(html, /Continue as new Malink session/);
});

test("finds the provider session that was just archived", () => {
  const session = findRecentlyArchivedProviderSession([{
    sessionId: "provider-session",
    title: "Archived work",
    updatedAt: 1,
    latestArchivedSessionId: "malink-session",
    lastArchivedAt: 2,
  }], "malink-session");

  assert.equal(session?.sessionId, "provider-session");
});

test("shows every Project under its owning Gateway", () => {
  const sources = [defaultSource, {
    key: '["gateway-office","project-web"]',
    gatewayNodeId: "gateway-office",
    gatewayLabel: "Office Mac",
    projectId: "project-web",
    projectName: "Web",
    cwd: "/work/web",
  }, {
    key: '["gateway-home","project-personal"]',
    gatewayNodeId: "gateway-home",
    gatewayLabel: "Home NAS",
    projectId: "project-personal",
    projectName: "Personal",
    cwd: "/srv/personal",
  }];
  const html = renderToStaticMarkup(createElement(ProviderHistoryDialog, {
    open: true,
    sourceKey: defaultSource.key,
    sources,
    provider: "codex",
    providers: [{
      id: "codex",
      name: "Codex",
      canListSessions: true,
      canInspectSessions: true,
    }],
    sessions: [],
    selected: null,
    messages: [],
    loading: null,
    error: null,
    onClose() {},
    onSourceChange() {},
    onProviderChange() {},
    onInspect() {},
    onRetry() {},
    onOpenManaged() {},
    onContinue() {},
  }));

  assert.match(html, /<optgroup label="Office Mac">/);
  assert.match(html, /API — \/work\/api/);
  assert.match(html, /Web — \/work\/web/);
  assert.match(html, /<optgroup label="Home NAS">/);
  assert.match(html, /Personal — \/srv\/personal/);
  assert.match(html, /Office Mac · API/);
});
