import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { GatewayEnrollmentPanel } from "../app/GatewayEnrollmentPanel.tsx";
import { NewProjectDialog } from "../app/NewProjectDialog.tsx";
import { NotificationCenter } from "../app/NotificationCenter.tsx";
import { UiNoticeList } from "../app/UiNoticeList.tsx";
import {
  HistoryOperationTimeoutError,
  shouldAutoLoadEarlierMessages,
  waitForHistoryOperation,
} from "../app/historyPagination.ts";
import { PairingWizard, pairingProgressStep } from "../app/PairingWizard.tsx";
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
    connectionStatus: "offline",
    error: null,
    completion: null,
    canConfirm: false,
    deviceInvitation: null,
    invitationBusy: false,
    invitationError: null,
    invitationReauthRequired: false,
    onLink() {},
    onClear() {},
    onConfirm() {},
    onFinish() {},
    onCreateInvitation() {},
    onClearInvitation() {},
  }));

  assert.match(html, /Checking invitation…/);
  assert.match(html, /Verifying the invitation…/);
  assert.match(html, /operation-progress/);
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
    connectionStatus: "securing",
    progressDetail: "Recovering the approved pairing response…",
    error: null,
    completion: null,
    canConfirm: true,
    deviceInvitation: null,
    invitationBusy: false,
    invitationError: null,
    invitationReauthRequired: false,
    onLink() {},
    onClear() {},
    onConfirm() {},
    onFinish() {},
    onCreateInvitation() {},
    onClearInvitation() {},
  }));

  assert.match(html, /Connecting this device…/);
  assert.match(html, /Recovering the approved pairing response…/);
  assert.match(html, /operation-progress/);
  assert.doesNotMatch(html, /Finishing the connection…/);
});

test("does not confuse account connectivity with completed Workspace setup", () => {
  assert.equal(pairingProgressStep("connected", null, false), 1);
  assert.equal(
    pairingProgressStep("connected", "Waiting for computer authorization…", true),
    3,
  );
  assert.equal(
    pairingProgressStep(
      "connected",
      "The Workspace did not finish syncing.",
      true,
    ),
    4,
  );
});

test("marks the exact stopped setup stage after a recoverable failure", () => {
  const html = renderToStaticMarkup(createElement(PairingWizard, {
    preview: {
      gatewayName: "Studio computer",
      verificationCode: "123 456",
      expiresAt: Date.now() + 60_000,
    } as never,
    trustedGateway: null,
    repairReason: null,
    busy: false,
    connectionStatus: "connected",
    error: "Studio computer did not return the device authorization before the invitation expired.",
    completion: null,
    canConfirm: true,
    deviceInvitation: null,
    invitationBusy: false,
    invitationError: null,
    invitationReauthRequired: false,
    onLink() {},
    onClear() {},
    onConfirm() {},
    onFinish() {},
    onCreateInvitation() {},
    onClearInvitation() {},
  }));

  assert.match(html, /class="is-error" aria-current="step"><span aria-hidden="true">!<\/span><strong>Computer authorization/);
  assert.match(html, /Retry secure setup/);
  assert.match(html, /recoverable request remain/);
});

test("keeps successful setup visible until the user opens conversations", () => {
  const html = renderToStaticMarkup(createElement(PairingWizard, {
    preview: null,
    trustedGateway: null,
    repairReason: null,
    busy: false,
    connectionStatus: "connected",
    error: null,
    completion: { gatewayName: "Studio computer" },
    canConfirm: true,
    deviceInvitation: null,
    invitationBusy: false,
    invitationError: null,
    invitationReauthRequired: false,
    onLink() {},
    onClear() {},
    onConfirm() {},
    onFinish() {},
    onCreateInvitation() {},
    onClearInvitation() {},
  }));

  assert.match(html, /Setup complete/);
  assert.match(html, /This device is ready/);
  assert.match(html, /Studio computer/);
  assert.match(html, />Open conversations<\/button>/);
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
  assert.equal(html.match(/operation-progress/g)?.length, 1);
  assert.equal(html.match(/>Approve computer</g)?.length, 1);
  assert.match(html, /2\. Approve computer · Office Gateway/);
  assert.match(html, /2\. Approve computer · NAS Gateway/);
});

test("keeps long-running notices visibly active until their terminal state", () => {
  const activeNotice = {
    key: "provider:history-background",
    scope: "background" as const,
    severity: "info" as const,
    message: "Provider sessions are loading in the background.",
    createdAt: 1_000,
    expiresAt: null,
    active: true,
    hidden: false,
  };
  const activeHtml = renderToStaticMarkup(createElement(UiNoticeList, {
    notices: [activeNotice],
    onDismiss() {},
  }));
  assert.match(activeHtml, /ui-notice-active/);
  assert.match(activeHtml, /operation-progress/);
  assert.match(activeHtml, /aria-live="polite"/);

  const completedHtml = renderToStaticMarkup(createElement(UiNoticeList, {
    notices: [{
      ...activeNotice,
      severity: "success" as const,
      message: "Provider sessions finished loading.",
      active: false,
    }],
    onDismiss() {},
  }));
  assert.doesNotMatch(completedHtml, /operation-progress/);
  assert.match(completedHtml, />✓</);
});

test("shows motion for active notification-center operations", () => {
  const html = renderToStaticMarkup(createElement(NotificationCenter, {
    open: true,
    items: [{
      key: "gateway-update",
      severity: "info",
      title: "Gateway is preparing its update",
      detail: "The maintenance Agent continues in the background.",
      active: true,
    }],
    onClose() {},
  }));

  assert.match(html, /notification-center-item-active/);
  assert.match(html, /operation-progress/);
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /Closing this panel never cancels/);
});

test("never leaves an attention notification without a diagnostic action", () => {
  const html = renderToStaticMarkup(createElement(NotificationCenter, {
    open: true,
    items: [{
      key: "unexpected-error",
      severity: "error",
      title: "Something needs attention",
      detail: "The operation could not continue.",
    }],
    onExportDiagnostics() {},
    onClose() {},
  }));

  assert.match(html, /Export diagnostics/);
});

test("keeps diagnostics available beside a recovery action", () => {
  const html = renderToStaticMarkup(createElement(NotificationCenter, {
    open: true,
    items: [{
      key: "recoverable-error",
      severity: "warning",
      title: "Connection needs attention",
      detail: "Review the connection before trying again.",
      actions: [{ label: "Review settings", onClick() {} }],
    }],
    onExportDiagnostics() {},
    onClose() {},
  }));

  assert.match(html, /Review settings/);
  assert.match(html, /Export diagnostics/);
});

test("shows motion while project creation is still running", () => {
  const html = renderToStaticMarkup(createElement(NewProjectDialog, {
    open: true,
    busy: true,
    gateways: [{
      gatewayNodeId: "gateway-1",
      gatewayName: "Studio Gateway",
      targetProjectId: "project-1",
      providers: [{ id: "codex", name: "Codex" }],
      defaultProvider: "codex",
    }],
    onClose() {},
    onCreate() {},
  }));

  assert.match(html, /aria-busy="true"/);
  assert.match(html, /Creating…/);
  assert.match(html, /operation-progress/);
});
