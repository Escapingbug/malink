import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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

test("keeps async operation context visible until terminal completion", async () => {
  const appRoot = new URL("../", import.meta.url);
  const [app, settings, matrixConnection, androidActivity, css] = await Promise.all([
    readFile(new URL("app/MalinkApp.tsx", appRoot), "utf8"),
    readFile(new URL("app/MatrixSettings.tsx", appRoot), "utf8"),
    readFile(new URL("app/matrixMlp3Connection.ts", appRoot), "utf8"),
    readFile(new URL(
      "../../clients/android/app/src/main/java/id/my/anciety/malink/web/MainActivity.kt",
      appRoot,
    ), "utf8"),
    readFile(new URL("app/globals.css", appRoot), "utf8"),
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
  assert.match(
    settings,
    /recoveryActionInFlight[\s\S]*?check-updates[\s\S]*?pwaUpdateBusy/,
  );
  assert.match(
    settings,
    /recoveryActionLabel[\s\S]*?Checking updates…[\s\S]*?Update waiting…[\s\S]*?Applying update…/,
  );
  assert.match(
    settings,
    /diagnosticExportStatus[\s\S]*?Diagnostic report download started[\s\S]*?could not be downloaded/,
  );
  assert.match(
    settings,
    /disabled=\{diagnosticExportBusy\}[\s\S]*?await onExportDiagnostics\(\)[\s\S]*?Exporting diagnostics…/,
  );
  assert.match(
    app,
    /async function stopStreaming[\s\S]*?try \{[\s\S]*?await sent\.completion[\s\S]*?finally \{[\s\S]*?setSessionStopping\(sessionId, false\)/,
  );
  assert.match(
    app,
    /function exportConnectionDiagnostics\(\): Promise<boolean>[\s\S]*?diagnosticExportFlightRef\.current[\s\S]*?return existing[\s\S]*?setDiagnosticExportBusy\(false\)/,
  );
  assert.match(
    app,
    /const resetBlockedConnection = async \(\)[\s\S]*?upgradeRepairBusyRef\.current[\s\S]*?await resetBlockedPwaIndexedDb[\s\S]*?setUpgradeRepairError/,
  );
  assert.match(
    app,
    /function reconnectWorkspaceFromUi\(\)[\s\S]*?status === "reconnecting"[\s\S]*?connectMalinkClient\(matrixConfig, false\)/,
  );
  assert.match(
    app,
    /async function checkForPwaUpdates\(\)[\s\S]*?Checking for a newer Malink version in the background[\s\S]*?await updater\.checkNow\(\)[\s\S]*?Malink is up to date/,
  );
  assert.match(
    app,
    /function closeProviderHistory\(\)[\s\S]*?providerHistoryLoadRef\.current[\s\S]*?Provider sessions are loading in the background/,
  );
  assert.match(
    app,
    /function finishProviderHistoryBackground\([\s\S]*?Provider History finished loading/,
  );
  const globalNoticeRule = css.slice(
    css.indexOf(".global-ui-notices {"),
    css.indexOf(".global-ui-notices .ui-notice"),
  );
  const settingsBackdropRule = css.slice(
    css.indexOf(".settings-backdrop {"),
    css.indexOf(".matrix-settings {"),
  );
  assert.match(globalNoticeRule, /z-index:\s*59;/);
  assert.match(settingsBackdropRule, /z-index:\s*60;/);

  const nativeRecoveryPage = androidActivity.slice(
    androidActivity.indexOf("private fun showRecoveryPage"),
    androidActivity.indexOf("private fun showDisconnectedPage"),
  );
  assert.match(nativeRecoveryPage, /showWebHost\(reloadExisting = true\)/);
  assert.doesNotMatch(nativeRecoveryPage, /webView\?\.reload\(\)/);
  assert.match(
    androidActivity,
    /showWebLoading\([\s\S]*?Loading Malink…[\s\S]*?onPageCommitVisible[\s\S]*?hideWebLoading\(view\)/,
  );
  assert.match(androidActivity, /The update service is still starting/);
  assert.match(
    androidActivity,
    /manager\.status\(\)\.phase == NativeUpdatePhase\.INSTALLING[\s\S]*?already waiting for Android confirmation/,
  );
  assert.match(
    androidActivity,
    /if \(!isEnabled\) return@setOnClickListener[\s\S]*?isEnabled = false[\s\S]*?text = "\$action…"/,
  );

  const restoreHistory = app.slice(
    app.indexOf("async function restoreSessionHistory"),
    app.indexOf("async function loadOlderHistory"),
  );
  const olderHistory = app.slice(
    app.indexOf("async function loadOlderHistory"),
    app.indexOf("function handleFeedScroll"),
  );
  assert.match(restoreHistory, /waitForHistoryOperation\(/);
  assert.match(restoreHistory, /loadInitialConnectionHistoryInBackground\(/);
  assert.doesNotMatch(restoreHistory, /await connection\.loadLocalHistory/);
  assert.doesNotMatch(restoreHistory, /await connection\.loadHistoryPage/);
  assert.match(olderHistory, /loadRemoteHistoryInBackground/);
  assert.doesNotMatch(olderHistory, /await connection\.loadHistoryPage/);
  assert.match(app, /Restoring conversation history in the background/);
  assert.match(
    app,
    /persistRecoveredHistoryInBackground\(\s*scope,\s*historyCacheSessionId\(sessionId, projectId\),\s*remoteMessages,?\s*\);[\s\S]*?if \(!isCurrent\(\)\) return;/,
  );
  const relationsFetch = matrixConnection.slice(
    matrixConnection.indexOf("const loadHistory = async"),
    matrixConnection.indexOf("const uploadAttachment = async"),
  );
  assert.match(relationsFetch, /client\.http\.authedRequest/);
  assert.match(relationsFetch, /localTimeoutMs: MATRIX_HISTORY_REQUEST_TIMEOUT_MS/);
  assert.doesNotMatch(relationsFetch, /client\.relations\(/);
  assert.match(
    app,
    /waitForHistoryOperation\(\s*connection\.loadLocalHistory/,
  );
  assert.match(
    app,
    /waitForHistoryOperation\(\s*connection\.loadHistoryPage/,
  );
});
