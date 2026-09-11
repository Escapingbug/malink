import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ConnectionPathIndicator } from "../app/ConnectionPathIndicator.tsx";
import { deriveConnectionPathPresentation } from "../app/connectionPathPresentation.ts";

const now = 1_000_000;

test("history recovery reuses the device icon without changing computer availability", () => {
  const input = { trusted: true, matrixStatus: "connected" as const, gatewayLabel: "Mac",
    gatewaySnapshotAvailable: true, now,
    gatewayLiveness: {state: "online" as const, lastVerifiedAt: now},
    historyRecovery: {tone: "progress" as const, label: "Syncing", detail: "12 history pages checked"} };
  const p = deriveConnectionPathPresentation(input);
  assert.equal(p.deviceToMatrix.tone, "progress");
  assert.equal(p.matrixToGateway.tone, "ready");
  const html = renderToStaticMarkup(createElement(ConnectionPathIndicator, {presentation:p, variant:"compact"}));
  assert.match(html, /connection-status-spinner/);
  assert.equal((html.match(/<svg/g) ?? []).length, 2);
  assert.match(p.accessibleLabel, /12 history pages/);
  assert.equal(deriveConnectionPathPresentation({...input, historyRecovery: undefined}).deviceToMatrix.tone, "ready");
  assert.equal(deriveConnectionPathPresentation({...input, matrixStatus: "offline"}).deviceToMatrix.tone, "offline");
  assert.equal(deriveConnectionPathPresentation({...input, trusted:false}).deviceToMatrix.tone, "setup");
  assert.equal(deriveConnectionPathPresentation({...input, historyRecovery: {...input.historyRecovery, tone:"attention"}}).deviceToMatrix.tone, "attention");
});

test("shows this device and its Workspace computer as separate healthy statuses", () => {
  const presentation = deriveConnectionPathPresentation({
    trusted: true,
    matrixStatus: "connected",
    gatewayLabel: "Office Mac",
    gatewaySnapshotAvailable: true,
    gatewayLiveness: {
      state: "online",
      lastVerifiedAt: now - 10_000,
    },
    now,
  });

  assert.equal(presentation.deviceToMatrix.tone, "ready");
  assert.equal(presentation.matrixToGateway.tone, "ready");
  assert.equal(presentation.summary, "Connected");
});

test("does not describe Gateway as offline when the client loses Matrix", () => {
  const presentation = deriveConnectionPathPresentation({
    trusted: true,
    matrixStatus: "reconnecting",
    gatewayLabel: "Office Mac",
    gatewaySnapshotAvailable: true,
    gatewayLiveness: {
      state: "online",
      lastVerifiedAt: now - 10_000,
    },
    now,
  });

  assert.equal(presentation.deviceToMatrix.tone, "progress");
  assert.equal(presentation.deviceToMatrix.label, "Reconnecting");
  assert.equal(presentation.matrixToGateway.tone, "unknown");
  assert.equal(presentation.matrixToGateway.label, "Not checked");
  assert.equal(presentation.summary, "Reconnecting");
});

test("keeps background rechecks out of the user-facing status", () => {
  const stale = deriveConnectionPathPresentation({
    trusted: true,
    matrixStatus: "connected",
    gatewayLabel: "Office Mac",
    gatewaySnapshotAvailable: true,
    gatewayLiveness: {
      state: "online",
      lastVerifiedAt: now - 151_000,
    },
    now,
  });
  const firstMiss = deriveConnectionPathPresentation({
    trusted: true,
    matrixStatus: "connected",
    gatewayLabel: "Office Mac",
    gatewaySnapshotAvailable: true,
    gatewayLiveness: {
      state: "unreachable",
      consecutiveNoReplies: 1,
      lastVerifiedAt: now - 151_000,
    },
    now,
  });

  assert.equal(stale.matrixToGateway.tone, "ready");
  assert.equal(stale.matrixToGateway.label, "Available");
  assert.equal(firstMiss.matrixToGateway.tone, "ready");
  assert.equal(firstMiss.matrixToGateway.label, "Available");
});

test("keeps a previous available result while an automatic check is running", () => {
  const presentation = deriveConnectionPathPresentation({
    trusted: true,
    matrixStatus: "connected",
    gatewayLabel: "Office Mac",
    gatewaySnapshotAvailable: true,
    gatewayLiveness: {
      state: "checking",
      lastVerifiedAt: now - 151_000,
    },
    now,
  });

  assert.equal(presentation.matrixToGateway.tone, "ready");
  assert.equal(presentation.matrixToGateway.label, "Available");
  assert.equal(presentation.summary, "Connected");
});

test("stays neutral until the first Gateway check has a result", () => {
  const checking = deriveConnectionPathPresentation({
    trusted: true,
    matrixStatus: "connected",
    gatewayLabel: "Office Mac",
    gatewaySnapshotAvailable: true,
    gatewayLiveness: { state: "checking" },
    now,
  });
  const firstMiss = deriveConnectionPathPresentation({
    trusted: true,
    matrixStatus: "connected",
    gatewayLabel: "Office Mac",
    gatewaySnapshotAvailable: true,
    gatewayLiveness: {
      state: "unreachable",
      consecutiveNoReplies: 1,
    },
    now,
  });

  assert.equal(checking.matrixToGateway.tone, "unknown");
  assert.equal(checking.matrixToGateway.label, "Unable to verify");
  assert.equal(firstMiss.matrixToGateway.tone, "unknown");
  assert.equal(firstMiss.matrixToGateway.label, "Unable to verify");
});

test("reserves attention styling for repeated signed-check failures", () => {
  const presentation = deriveConnectionPathPresentation({
    trusted: true,
    matrixStatus: "connected",
    gatewayLabel: "Office Mac",
    gatewaySnapshotAvailable: true,
    gatewayLiveness: {
      state: "unreachable",
      consecutiveNoReplies: 2,
    },
    now,
  });

  assert.equal(presentation.deviceToMatrix.tone, "ready");
  assert.equal(presentation.matrixToGateway.tone, "attention");
  assert.equal(presentation.matrixToGateway.label, "Not responding");
  assert.equal(presentation.summary, "Not responding");
});

test("keeps an unverified Gateway neutral when durable workspace data exists", () => {
  const presentation = deriveConnectionPathPresentation({
    trusted: true,
    matrixStatus: "connected",
    gatewayLabel: "Office Mac",
    gatewaySnapshotAvailable: true,
    now,
  });

  assert.equal(presentation.deviceToMatrix.tone, "ready");
  assert.equal(presentation.matrixToGateway.tone, "unknown");
  assert.equal(presentation.matrixToGateway.label, "Unable to verify");
});

test("renders two named status units without a device-cloud-computer diagram", () => {
  const presentation = deriveConnectionPathPresentation({
    trusted: true,
    matrixStatus: "connected",
    gatewayLabel: "Office Mac",
    gatewaySnapshotAvailable: true,
    gatewayLiveness: {
      state: "online",
      lastVerifiedAt: now - 10_000,
    },
    now,
  });
  const html = renderToStaticMarkup(createElement(ConnectionPathIndicator, {
    presentation,
  }));

  assert.match(html, />This device</);
  assert.match(html, />Connected</);
  assert.match(html, />Computer</);
  assert.match(html, />Available</);
  assert.doesNotMatch(html, /connection-path-(?:node|route|segment)/);
  assert.doesNotMatch(html, /connection-status-divider/);
});

test("compact status names the affected service and uses one short value", () => {
  const presentation = deriveConnectionPathPresentation({
    trusted: true,
    matrixStatus: "reconnecting",
    gatewayLabel: "Office Mac",
    gatewaySnapshotAvailable: true,
    now,
  });
  const html = renderToStaticMarkup(createElement(ConnectionPathIndicator, {
    presentation,
    variant: "compact",
  }));

  assert.match(html, />Device</);
  assert.match(html, />Syncing</);
  assert.match(html, />Computer</);
  assert.match(html, />Can&#x27;t verify</);
  assert.doesNotMatch(html, />Office Mac</);
});
