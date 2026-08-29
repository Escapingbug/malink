import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { GatewayEnrollmentPanel } from "../app/GatewayEnrollmentPanel.tsx";
import { shouldAutoLoadEarlierMessages } from "../app/historyPagination.ts";
import { PairingWizard } from "../app/PairingWizard.tsx";

test("auto-loads earlier messages only from an idle, healthy feed", () => {
  const idle = {
    scrollTop: 40,
    hasMore: true,
    loading: false,
    checkingRemote: false,
    hasError: false,
  };
  assert.equal(shouldAutoLoadEarlierMessages(idle), true);
  assert.equal(shouldAutoLoadEarlierMessages({ ...idle, scrollTop: 81 }), false);
  assert.equal(shouldAutoLoadEarlierMessages({ ...idle, loading: true }), false);
  assert.equal(
    shouldAutoLoadEarlierMessages({ ...idle, checkingRemote: true }),
    false,
  );
  assert.equal(shouldAutoLoadEarlierMessages({ ...idle, hasError: true }), false);
});

test("shows an explicit busy state while a pairing invitation is verified", () => {
  const html = renderToStaticMarkup(createElement(PairingWizard, {
    preview: null,
    trustedGateway: null,
    repairReason: null,
    busy: true,
    canConfirm: false,
    deviceInvitation: null,
    invitationBusy: false,
    invitationError: null,
    invitationReauthRequired: false,
    onLink() {},
    onClear() {},
    onConfirm() {},
    onCreateInvitation() {},
    onClearInvitation() {},
  }));

  assert.match(html, /Checking invitation…/);
  assert.match(html, /Verifying the invitation…/);
  const continueButton = html.match(
    /<button(?=[^>]*class="continue-link-button")[^>]*>/,
  )?.[0];
  assert.ok(continueButton);
  assert.match(continueButton, /disabled/);
});

test("identifies only the Gateway row whose approval is in flight", () => {
  const requestedAt = Date.now();
  const pending = [{
    enrollmentId: "enrollment-a",
    gatewayNodeId: "gateway-a",
    gatewayName: "Office Gateway",
    verificationCode: "123-456",
    requestedAt,
    expiresAt: requestedAt + 60_000,
  }, {
    enrollmentId: "enrollment-b",
    gatewayNodeId: "gateway-b",
    gatewayName: "NAS Gateway",
    verificationCode: "654-321",
    requestedAt,
    expiresAt: requestedAt + 60_000,
  }];
  const html = renderToStaticMarkup(createElement(GatewayEnrollmentPanel, {
    invitation: null,
    pending,
    approvedEnrollmentIds: new Set<string>(),
    busy: { kind: "approve", enrollmentId: "enrollment-b" },
    error: null,
    onCreate() {},
    onApprove() {},
    onClear() {},
  }));

  assert.equal(html.match(/Sending approval…/g)?.length, 1);
  assert.equal(html.match(/>Approve Gateway</g)?.length, 1);
  assert.match(html, /2\. Approve Office Gateway/);
  assert.match(html, /2\. Approve NAS Gateway/);
});

test("keeps async operation context visible until terminal completion", async () => {
  const appRoot = new URL("../", import.meta.url);
  const [app, settings] = await Promise.all([
    readFile(new URL("app/MalinkApp.tsx", appRoot), "utf8"),
    readFile(new URL("app/MatrixSettings.tsx", appRoot), "utf8"),
  ]);

  assert.match(
    app,
    /const completion = await sent\.completion;[\s\S]*?completion\.outcome !== "succeeded"[\s\S]*?setNativeCommandReview\(null\)/,
  );
  assert.match(app, /if \(!sessionId \|\| sessionSettingsUpdate\) return;/);
  assert.match(app, /setSessionSettingsUpdate\(update\)/);
  assert.match(app, /The setting update did not complete/);
  assert.match(settings, /if \(actionBusy\) return;/);
  assert.match(settings, /escapeDisabled: actionBusy/);
  assert.match(settings, /nativeUpdateBusy[\s\S]*?"Installing APK…"/);

  const restoreHistory = app.slice(
    app.indexOf("async function restoreSessionHistory"),
    app.indexOf("async function loadOlderHistory"),
  );
  const olderHistory = app.slice(
    app.indexOf("async function loadOlderHistory"),
    app.indexOf("function handleFeedScroll"),
  );
  assert.match(restoreHistory, /connection\.loadLocalHistory\(sessionId\)/);
  assert.doesNotMatch(restoreHistory, /await connection\.loadHistoryPage/);
  assert.match(olderHistory, /loadRemoteHistoryInBackground/);
  assert.doesNotMatch(olderHistory, /await connection\.loadHistoryPage/);
  assert.match(app, /Checking archived history in the background/);
});
