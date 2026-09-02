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
  assert.match(html, /operation-progress/);
  assert.doesNotMatch(html, /Finishing the connection…/);
});

test("requires explicit confirmation before replacing a legacy Matrix account", () => {
  const html = renderToStaticMarkup(createElement(PairingWizard, {
    preview: {
      gatewayName: "Studio Gateway",
      verificationCode: "123 456",
      expiresAt: Date.now() + 60_000,
    } as never,
    trustedGateway: {
      state: "trusted",
      gatewayId: "workspace-1",
      gatewayNodeId: "gateway-1",
      gatewayName: "Studio Gateway",
      certificateId: "certificate-1",
      pairedAt: Date.now(),
    },
    repairReason: null,
    busy: false,
    canConfirm: true,
    deviceInvitation: null,
    invitationBusy: false,
    invitationError: null,
    invitationReauthRequired: false,
    accountRejoin: {
      currentUserId: "@legacy:example",
      targetUserId: "@workspace:example",
    },
    accountRejoinRequested: true,
    onLink() {},
    onClear() {},
    onConfirm() {},
    onCreateInvitation() {},
    onClearInvitation() {},
  }));

  assert.match(html, /Workspace invitation ready/);
  assert.match(html, /sign this device out of @legacy:example/);
  assert.match(html, /Sign out and rejoin Workspace/);
  assert.doesNotMatch(html, /Invitation code/);
});

test("shows the canonical invitation input instead of another-device sharing", () => {
  const html = renderToStaticMarkup(createElement(PairingWizard, {
    preview: null,
    trustedGateway: {
      state: "trusted",
      gatewayId: "workspace-1",
      gatewayNodeId: "gateway-1",
      gatewayName: "Studio Gateway",
      certificateId: "certificate-1",
      pairedAt: Date.now(),
    },
    repairReason: null,
    busy: false,
    canConfirm: true,
    deviceInvitation: null,
    invitationBusy: false,
    invitationError: null,
    invitationReauthRequired: false,
    accountRejoinRequested: true,
    onLink() {},
    onClear() {},
    onConfirm() {},
    onCreateInvitation() {},
    onClearInvitation() {},
  }));

  assert.match(html, /Rejoin the Workspace account/);
  assert.match(html, /One-time device invitation/);
  assert.doesNotMatch(html, /<button[^>]*>Add another device<\/button>/);
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
  assert.equal(html.match(/>Approve Gateway</g)?.length, 1);
  assert.match(html, /2\. Approve Office Gateway/);
  assert.match(html, /2\. Approve NAS Gateway/);
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
