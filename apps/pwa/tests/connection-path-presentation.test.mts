import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ConnectionPathIndicator } from "../app/ConnectionPathIndicator.tsx";
import { deriveConnectionPathPresentation } from "../app/connectionPathPresentation.ts";

const now = 1_000_000;

test("shows Matrix and Gateway as separate healthy statuses", () => {
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
  assert.equal(presentation.matrixToGateway.label, "Gateway unknown");
  assert.equal(presentation.summary, "Reconnecting");
});

test("uses delayed styling for stale proof and the first missed reply", () => {
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
    },
    now,
  });

  assert.equal(stale.matrixToGateway.tone, "delayed");
  assert.equal(stale.matrixToGateway.label, "Gateway check delayed");
  assert.equal(firstMiss.matrixToGateway.tone, "delayed");
  assert.equal(firstMiss.matrixToGateway.label, "Gateway reply delayed");
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
  assert.equal(presentation.summary, "Gateway not responding");
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
  assert.equal(presentation.matrixToGateway.label, "Gateway not verified");
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
    gatewayLabel: "Office Mac",
    presentation,
  }));

  assert.match(html, />Matrix</);
  assert.match(html, />Synced</);
  assert.match(html, />Gateway · Office Mac</);
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
    gatewayLabel: "Office Mac",
    presentation,
    variant: "compact",
  }));

  assert.match(html, />Matrix</);
  assert.match(html, />Syncing</);
  assert.match(html, />Gateway</);
  assert.match(html, />Unknown</);
  assert.doesNotMatch(html, />Office Mac</);
});
