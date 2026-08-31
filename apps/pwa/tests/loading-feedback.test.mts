import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { GatewayEnrollmentPanel } from "../app/GatewayEnrollmentPanel.tsx";
import {
  HistoryOperationTimeoutError,
  shouldAutoLoadEarlierMessages,
  waitForHistoryOperation,
} from "../app/historyPagination.ts";
import { PairingWizard } from "../app/PairingWizard.tsx";
import {
  ClipboardOperationTimeoutError,
  readClipboardTextWithTimeout,
  writeClipboardTextWithTimeout,
} from "../app/uiClipboard.ts";

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

test("bounds a foreground history source without losing a fast result", async () => {
  assert.equal(
    await waitForHistoryOperation(Promise.resolve("cached"), 1_000, "cache"),
    "cached",
  );
  await assert.rejects(
    waitForHistoryOperation(new Promise<never>(() => {}), 0, "cache"),
    (error: unknown) =>
      error instanceof HistoryOperationTimeoutError &&
      error.message === "cache did not finish in time.",
  );
});

test("bounds clipboard access so the paste action always reaches a terminal state", async () => {
  assert.equal(
    await readClipboardTextWithTimeout(async () => "malink://pair", 1_000),
    "malink://pair",
  );
  await assert.rejects(
    readClipboardTextWithTimeout(() => new Promise<string>(() => {}), 0),
    ClipboardOperationTimeoutError,
  );
  await assert.rejects(
    writeClipboardTextWithTimeout(
      "Malink",
      () => new Promise<void>(() => {}),
      0,
    ),
    ClipboardOperationTimeoutError,
  );
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

test("shows the exact secure pairing stage while finishing a connection", () => {
  const html = renderToStaticMarkup(createElement(PairingWizard, {
    preview: {
      gatewayName: "Studio Gateway",
      verificationCode: "123 456",
      expiresAt: Date.now() + 60_000,
    } as never,
    trustedGateway: null,
    repairReason: null,
    busy: true,
    progressDetail: "Recovering the approved pairing response…",
    canConfirm: true,
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

  assert.match(html, /Connecting this device…/);
  assert.match(html, /Recovering the approved pairing response…/);
  assert.doesNotMatch(html, /Finishing the connection…/);
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
