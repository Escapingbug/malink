import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const appRoot = new URL("../", import.meta.url);

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

async function fetchBuiltRoute(pathname) {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}-${pathname}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request(`http://localhost${pathname}`),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the migration-safe Malink boot shell", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>Your agents, anywhere · Malink<\/title>/i);
  assert.match(html, /Preparing this version/);
  assert.match(html, /Checking saved connection and recovery state before Malink starts/);
  assert.doesNotMatch(html, /Connect a computer/);
  assert.doesNotMatch(html, /Matrix|P-256|Gateway/);
  assert.doesNotMatch(html, />Demo</);
  assert.doesNotMatch(html, /Connection mode/);
  assert.doesNotMatch(html, /Permission required/);
  assert.doesNotMatch(html, /Your site is taking shape|codex-preview/i);
});

test("ships a complete installable offline shell", async () => {
  const [
    manifestText,
    serviceWorker,
    source,
    matrixSettings,
    newSession,
    providerHistory,
    history,
    messageDelivery,
    styles,
  ] = await Promise.all([
    readFile(new URL("public/manifest.webmanifest", appRoot), "utf8"),
    readFile(new URL("public/sw.js", appRoot), "utf8"),
    readFile(new URL("app/MalinkApp.tsx", appRoot), "utf8"),
    readFile(new URL("app/MatrixSettings.tsx", appRoot), "utf8"),
    readFile(new URL("app/NewSessionDialog.tsx", appRoot), "utf8"),
    readFile(new URL("app/ProviderHistoryDialog.tsx", appRoot), "utf8"),
    readFile(new URL("app/messageHistory.ts", appRoot), "utf8"),
    readFile(new URL("app/messageDelivery.ts", appRoot), "utf8"),
    readFile(new URL("app/globals.css", appRoot), "utf8"),
  ]);
  const manifest = JSON.parse(manifestText);

  assert.equal(manifest.name, "Malink — Secure Agent Workspace");
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.start_url, "/");
  assert.ok(manifest.icons.length > 0);
  assert.match(serviceWorker, /malink-shell-v8/);
  assert.match(serviceWorker, /caches\.open\(CACHE_NAME\)/);
  assert.match(serviceWorker, /event\.request\.mode === "navigate"/);
  assert.match(serviceWorker, /cache:\s*"no-store"/);
  assert.match(serviceWorker, /requestUrl\.pathname\.startsWith\("\/assets\/"\)/);
  assert.match(
    serviceWorker,
    /pathname\.startsWith\("\/assets\/"\)[\s\S]*?caches\.match\(event\.request\)[\s\S]*?fetch\(event\.request\)/,
  );
  assert.match(serviceWorker, /pathname\.startsWith\("\/_matrix\/"\)/);
  assert.match(
    serviceWorker,
    /pathname\.startsWith\("\/_matrix\/"\)[\s\S]*?return;/,
  );
  assert.match(serviceWorker, /pathname === "\/api\/version"/);
  assert.match(serviceWorker, /addEventListener\("push"/);
  assert.match(serviceWorker, /showNotification/);
  assert.match(serviceWorker, /notificationclick/);
  assert.match(serviceWorker, /claimPushEvent/);
  assert.match(matrixSettings, /Agent notifications/);
  assert.match(source, /function NewProjectIcon\(\)[\s\S]*className="toolbar-icon"/);
  assert.match(source, /aria-label="New project"[\s\S]*title="New project"[\s\S]*<NewProjectIcon \/>/);
  assert.doesNotMatch(source, /▱\+/);
  assert.match(styles, /\.toolbar-icon \{[\s\S]*width: 21px;[\s\S]*height: 21px;[\s\S]*stroke: currentColor/);
  assert.match(matrixSettings, /deriveConnectionRecoveryPlan/);
  assert.match(matrixSettings, /runRecoveryAction\(recoveryPlan\.primary\.action\)/);
  assert.match(matrixSettings, /case "update-native-app"[\s\S]*onUpdateNativeApp\(\)/);
  assert.match(matrixSettings, /case "reload-app"[\s\S]*onRestartApp\(\)/);
  assert.match(matrixSettings, /case "copy-page-link"[\s\S]*onCopyPageLink\(\)/);
  assert.match(matrixSettings, /onClick=\{onExportDiagnostics\}/);
  assert.match(
    matrixSettings,
    /<details className="settings-build-details">[\s\S]*onClick=\{onExportDiagnostics\}[\s\S]*<\/details>/,
  );
  assert.match(matrixSettings, /recoveryPlan\.secondary\.label/);
  assert.match(matrixSettings, /setManualRepairReason\("manual"\)/);
  assert.match(providerHistory, /role="alert"[\s\S]*onClick=\{onRetry\}[\s\S]*Retry/);
  assert.match(
    source,
    /registerPwaUpdates\(setPwaUpdateState, \{[\s\S]*canReload:/,
  );
  assert.doesNotMatch(
    source,
    /pendingSessionCreateRecoveryRef\.current = recovery;\s*pwaReloadBlockedRef\.current = true;/,
    "a persisted pre-upgrade session marker must not prevent the repair build from loading",
  );
  assert.match(
    source,
    /if \(isNativeManagedMatrixConfig\(stored\)\)[\s\S]*connectMalinkClient\(stored, true, true\)/,
  );
  assert.match(source, /Updating Malink/);
  assert.match(source, /onCheckForUpdates/);
  assert.match(source, /navigator\.clipboard\?\.writeText/);
  assert.match(source, /navigator\.clipboard\.writeText\(pageLink\)/);
  assert.match(source, /onCopyPageLink=\{\(\) => void copyPageLinkForAnotherBrowser\(\)\}/);
  assert.doesNotMatch(source, /const sessions:|const initialMessages|appMode/);
  assert.match(source, /operation: "session\.create"/);
  assert.match(source, /extensions: input\.extensions/);
  assert.match(source, /session-extension-badge/);
  assert.match(source, /className="permission-details"/);
  assert.match(source, /typeof message\.raw\?\.details === "string"/);
  assert.match(source, /permissionActionOptions\(message\.raw\)/);
  assert.match(source, /message\.raw\?\.decisionType === "privilege"/);
  assert.match(source, /This exact command will run as root/);
  assert.match(newSession, /Project defaults are preselected/);
  assert.match(newSession, /Use this selection as the project default/);
  assert.match(newSession, /enabledExtensions/);
  assert.doesNotMatch(newSession, /endpoint|bearerToken/);
  assert.match(styles, /\.session-extensions\s*\{/);
  assert.match(styles, /\.permission-details\s*\{/);
  assert.match(source, /session-row session-create-pending/);
  assert.match(source, /function ProjectFolderIcon\(\{ temporary \}:/);
  assert.match(source, /className="project-folder-clock"/);
  assert.match(source, /Temporary workspace on \$\{project\.gatewayLabel\}/);
  assert.match(source, /<ProjectDisclosureIcon \/>/);
  assert.doesNotMatch(source, /project\.temporary \? "◇" : "▱"/);
  assert.match(source, /aria-label="Filter conversations by Gateway"/);
  assert.match(source, /<option value=\{ALL_GATEWAYS_FILTER\}>All Gateways<\/option>/);
  assert.match(source, /projectMatchesGatewayFilter\(/);
  assert.match(source, /scratchGroups/);
  assert.match(newSession, /The selected Gateway creates a private working folder/);
  assert.match(newSession, /choice\.gateway\.shortId/);
  assert.match(styles, /\.gateway-filter-control\s*\{/);
  assert.match(
    styles,
    /\.project-chevron\.expanded svg\s*\{\s*transform:\s*rotate\(90deg\)/,
  );
  assert.match(
    styles,
    /\.project-folder-shell\s*\{[\s\S]*?fill:\s*var\(--violet-soft\);[\s\S]*?stroke-width:\s*1\.55/,
  );
  assert.match(source, /aria-pressed=\{selectedSessionId === session\.id\}/);
  assert.match(source, /Creating this conversation/);
  assert.match(source, /Creating · Ready for messages/);
  assert.match(source, /Conversation creation failed/);
  assert.match(source, /Retry creation/);
  assert.match(source, /Creation result not confirmed/);
  assert.match(source, /Check result again/);
  assert.match(source, /Stop waiting/);
  assert.match(source, /discardFailedOptimisticSession/);
  assert.match(
    source,
    /setPendingSessionCreate\(input\);[\s\S]*?setNewSessionOpen\(false\);[\s\S]*?await waitForUiCommit\(\);[\s\S]*?operation: "session\.create"/,
  );
  assert.match(styles, /\.session-create-spinner\s*\{/);
  assert.match(source, /rememberPendingSessionCreate\(input, sent\.commandId\)/);
  assert.match(
    source,
    /writePendingSessionCreateRecovery\(window\.localStorage, recovery\);[\s\S]*?setSessionCreateReloadBlocked\(false\)/,
    "a durable create command must release any deferred PWA upgrade",
  );
  assert.match(
    source,
    /const optimisticHistoryPersisted = submissionHistoryScope[\s\S]*?await optimisticHistoryPersisted;[\s\S]*?result = await sendRealCommand/,
  );
  assert.match(
    source,
    /error instanceof CommandAcknowledgementTimeoutError[\s\S]*rememberPendingSessionCreate\(input, error\.commandId\)/,
  );
  assert.match(source, /continuePendingSessionCreate\(connection/);
  assert.match(source, /resumeDeferredUpdate/);
  assert.match(
    source,
    /<button[\s\S]{0,160}?aria-label="Settings"[\s\S]{0,160}?onClick=\{\(\) => setSettingsOpen\(true\)\}/,
  );
  assert.doesNotMatch(source, /operation: "session\.select"/);
  assert.match(
    source,
    /function chooseSession\(id: string\)[\s\S]*?activateLocalSession\(id\)/,
  );
  assert.match(source, /agentActivitiesBySession/);
  assert.match(source, /setSessionAgentActivity\(sessionId/);
  assert.match(source, /pendingPromptSessionIdsRef\.current\.has\(sessionId\)/);
  assert.match(source, /deriveComposerState/);
  assert.match(source, /composerState\.mode === "queue"/);
  assert.match(source, /aria-label="Stop agent"|"Stop agent"/);
  assert.match(
    source,
    /createCancelCommandPayload\(sessionId, activeTurnId\)/,
  );
  assert.match(
    source,
    /disabled=\{isStopping \|\| !selected\?\.activeTurnId\}/,
  );
  assert.match(source, /disabled=\{!composerState\.canSend\}/);
  assert.match(source, /aria-label="Agent options"/);
  assert.match(source, /aria-controls="composer-agent-options"/);
  assert.doesNotMatch(
    source,
    /Connected directly to an encrypted Matrix room|Future Matrix device rotations/,
  );
  assert.match(
    styles,
    /@media \(max-width: 900px\)[\s\S]*?\.composer-hint\s*\{\s*display: none;/,
  );
  assert.doesNotMatch(
    source,
    /\{isStreaming \? \([\s\S]{0,700}?key="send-message"/,
  );
  assert.doesNotMatch(source, /const \[isStreaming, setIsStreaming\]/);
  assert.match(source, /gatewayProjectKey/);
  assert.match(
    source,
    /updateSessionSetting\([\s\S]{0,80}?"reasoningEffort"/,
  );
  assert.match(source, /Updating \{sessionSettingsFieldLabel/);
  assert.match(newSession, /Computer · Project/);
  assert.match(
    newSession,
    /all listed projects[\s\S]*remain connected and manageable at the same time/,
  );
  assert.match(newSession, /Reasoning effort/);
  assert.match(source, /stopStreaming/);
  assert.match(source, /onScroll=\{handleFeedScroll\}/);
  assert.match(source, /loadOlderHistory/);
  assert.match(source, /persistMessageHistoryPage/);
  assert.doesNotMatch(
    source,
    /if \(cachedMessages\.length > 0\) \{[\s\S]{0,240}?return;/,
  );
  assert.match(source, /History only · request not replayed/);
  assert.match(source, /findOptimisticMessageId/);
  assert.doesNotMatch(
    source,
    /local composer already rendered this prompt optimistically/,
  );
  assert.match(history, /malink-pwa-message-history/);
  assert.match(history, /loadMessageHistoryPage/);
  assert.match(history, /moveSessionMessageHistory/);
  assert.match(history, /loadQueuedSessionMessages/);
  assert.match(source, /deliveryState: "queued"/);
  assert.match(source, /queueMessageForCreatingSession/);
  assert.match(
    source,
    /moveSessionMessageHistory\(scope, localSessionId, remoteSessionId\)[\s\S]*?\.then\(\(\) => \{[\s\S]*?removeOptimisticSession\(localSessionId\);[\s\S]*?flushQueuedSessionMessages\(/,
    "queued history must migrate durably before the optimistic recovery marker is cleared and sending starts",
  );
  assert.match(messageDelivery, /Waiting for session creation/);
  assert.match(messageDelivery, /Message sent successfully/);
  assert.match(messageDelivery, /Agent received and started/);
  assert.match(source, /WAITING_AGENT_ACTIVITY/);
  assert.match(source, /aria-keyshortcuts="Control\+Enter Meta\+Enter"/);
  assert.match(source, /event\.ctrlKey \|\| event\.metaKey/);
  assert.match(source, /Enter for new line · Ctrl\/⌘ Enter to send/);
  assert.match(source, /resizeComposerTextarea\(composerTextareaRef\.current\)/);
  assert.match(source, /const contentHeight = textarea\.scrollHeight/);
  assert.match(styles, /\.optimistic-session-card\s*\{/);
  assert.match(styles, /\.delivery-indicator\.queued\s*\{/);
  assert.match(styles, /\.delivery-indicator\.received\s*\{/);
  assert.match(styles, /\.user-bubble p\s*\{[\s\S]*?white-space:\s*pre-wrap/);
  assert.match(history, /reconcileMessageHistory/);
  assert.match(history, /\["scope", "sessionId", "timestamp", "id"\]/);
  assert.match(
    styles,
    /@media \(max-width: 900px\), \(max-height: 610px\) and \(max-width: 1100px\)/,
  );
  assert.match(styles, /\.mobile-chat-open \.conversation-panel/);
  assert.match(styles, /Readable product type scale/);
  assert.match(styles, /\.bubble \{[\s\S]*?font-size: 15px/);
  assert.match(styles, /\.composer textarea \{[\s\S]*?font-size: 15px/);
  assert.match(
    styles,
    /@media \(max-width: 900px\)[\s\S]*?\.composer textarea,[\s\S]*?font-size: 16px/,
  );
  assert.match(styles, /\.composer textarea \{[\s\S]*?field-sizing: content/);
  assert.match(
    styles,
    /\.composer textarea \{[\s\S]*?max-height:\s*min\(36vh, 240px\)/,
  );
  assert.match(styles, /\.mobile-back \{[\s\S]*?width: 44px;[\s\S]*?min-width: 44px/);
  assert.doesNotMatch(
    styles,
    /\.header-actions \.header-button:first-child\s*\{\s*display:\s*none/,
  );
  assert.match(
    styles,
    /\.conversation-header \.header-actions \.header-button\s*\{\s*display:\s*grid/,
  );
  assert.match(
    styles,
    /@media \(max-width: 900px\)[\s\S]*?\.session-header\s*\{[\s\S]*?height:\s*calc\(52px \+ env\(safe-area-inset-top\)\)/,
  );
  assert.match(
    styles,
    /@media \(max-width: 900px\)[\s\S]*?\.gateway-card\s*\{[\s\S]*?position:\s*static;[\s\S]*?width:\s*calc\(100% - 24px\)/,
  );
  assert.match(
    styles,
    /@media \(max-width: 900px\)[\s\S]*?\.gateway-card\s*\{[\s\S]*?margin:\s*0 12px 7px;[\s\S]*?background:\s*#f7f6fc/,
  );
  assert.match(source, /className="gateway-mobile-status-copy"/);
  assert.match(
    source,
    /title=\{`Connection: \$\{mobileConnectionSignal\.label\}`\}/,
  );
  assert.match(
    styles,
    /\.gateway-mobile-status-copy\s*\{[\s\S]*?min-width:\s*0;[\s\S]*?text-overflow:\s*ellipsis/,
  );
  assert.match(source, /function HistoryIcon\(/);
  assert.match(source, /function FileInboxIcon\(/);
  assert.match(source, /function SearchIcon\(/);
  assert.match(source, /function NewConversationIcon\(/);
  assert.doesNotMatch(source, /<span aria-hidden="true">↺<\/span>/);
  assert.doesNotMatch(source, /className="mobile-files-button"[\s\S]{0,180}>\s*⇩/);
  assert.match(source, /className="conversation-status-copy"/);
  assert.match(
    styles,
    /\.conversation-status-copy\s*\{[\s\S]*?min-width:\s*0;[\s\S]*?text-overflow:\s*ellipsis/,
  );
  assert.match(
    styles,
    /@media \(max-width: 900px\)[\s\S]*?\.session-row\s*\{[\s\S]*?min-height:\s*56px/,
  );
  assert.match(
    styles,
    /@media \(max-width: 900px\)[\s\S]*?\.project-session-toggle\s*\{[\s\S]*?min-height:\s*44px/,
  );
  assert.match(
    styles,
    /@media \(max-width: 900px\)[\s\S]*?\.session-title-line strong\s*\{[\s\S]*?text-overflow:\s*ellipsis;[\s\S]*?white-space:\s*nowrap/,
  );
  assert.match(
    styles,
    /@media \(max-width: 900px\)[\s\S]*?\.conversation-header\s*\{[\s\S]*?height:\s*calc\(58px \+ env\(safe-area-inset-top\)\)/,
  );
  assert.match(
    styles,
    /@media \(max-width: 900px\)[\s\S]*?\.chat-feed\s*\{[\s\S]*?gap:\s*8px;[\s\S]*?padding:\s*9px 8px 16px/,
  );
  assert.match(
    styles,
    /@media \(max-width: 900px\)[\s\S]*?\.bubble,[\s\S]*?\.permission-card\s*\{[\s\S]*?max-width:\s*92%/,
  );
  assert.match(
    styles,
    /@media \(max-width: 900px\)[\s\S]*?\.bubble\s*\{[\s\S]*?font-size:\s*14\.5px/,
  );
  assert.match(
    styles,
    /@media \(max-width: 900px\)[\s\S]*?\.tool-activity-summary\s*\{[\s\S]*?min-height:\s*54px/,
  );
  assert.match(
    styles,
    /@media \(max-width: 900px\)[\s\S]*?\.trust-footer\s*\{\s*display:\s*none/,
  );
  assert.match(
    styles,
    /@media \(min-width: 901px\)[\s\S]*?\.app-shell\s*\{[\s\S]*?grid-template-columns:\s*72px 344px minmax\(520px, 1fr\)/,
  );
  assert.match(
    styles,
    /@media \(min-width: 901px\)[\s\S]*?\.session-row\s*\{[\s\S]*?min-height:\s*56px/,
  );
  assert.match(
    styles,
    /@media \(min-width: 901px\)[\s\S]*?\.conversation-header\s*\{[\s\S]*?height:\s*62px/,
  );
  assert.match(
    styles,
    /@media \(min-width: 901px\)[\s\S]*?\.chat-feed\s*\{[\s\S]*?gap:\s*9px;[\s\S]*?padding:\s*10px clamp\(14px, 2\.4vw, 36px\) 20px/,
  );
  assert.match(
    styles,
    /@media \(min-width: 901px\)[\s\S]*?\.bubble\s*\{[\s\S]*?max-width:\s*min\(760px, 84%\);[\s\S]*?font-size:\s*14\.5px/,
  );
  assert.match(
    styles,
    /\.tool-activity-summary\s*\{[\s\S]*?min-height:\s*62px/,
  );
  assert.match(
    styles,
    /\.tool-activity-details\s*\{[\s\S]*?grid-template-columns:\s*210px minmax\(0, 1fr\)/,
  );
  assert.match(
    styles,
    /@media \(min-width: 901px\)[\s\S]*?\.composer\s*\{[\s\S]*?min-height:\s*82px/,
  );
  assert.match(source, /completedTurnPresentation/);
  assert.match(source, /className={`turn-process-disclosure/);
  assert.match(source, /<TurnResultState outcome={result\.outcome} \/>/);
  assert.match(source, /className=\{`message-row user-row turn-prompt/);
  assert.match(source, /turnPresentationClass/);
  assert.match(source, /className="activity-copy"/);
  assert.doesNotMatch(source, /className="activity-copy visually-hidden"/);
  assert.doesNotMatch(
    styles,
    /\.agent-activity \.activity-copy\s*\{[^}]*position:\s*absolute/,
  );
  assert.match(source, /aria-label=\{`\$\{session\.title\}\. \$\{statusSummary\}/);
  assert.match(source, /title=\{`\$\{session\.title\} · \$\{statusSummary\}`\}/);
  assert.match(source, /const showStatusSummary =/);
  assert.match(source, /\{showStatusSummary && \(\s*<span className="session-status-summary">/);
  assert.doesNotMatch(source, /TurnResultContext/);
  assert.match(
    styles,
    /@media \(max-width: 900px\)[\s\S]*?\.new-session-dialog > header\s*\{[\s\S]*?position:\s*sticky;[\s\S]*?top:\s*0/,
  );
  assert.match(
    styles,
    /@media \(max-width: 900px\)[\s\S]*?\.new-session-dialog footer\s*\{[\s\S]*?position:\s*sticky;[\s\S]*?bottom:\s*0/,
  );
  assert.match(source, /<kbd aria-label="Control or Command K">Ctrl\/⌘ K<\/kbd>/);
  assert.match(source, /className="mobile-search-button"/);
  assert.doesNotMatch(source, /aria-label="Filter conversations"/);
  assert.match(
    styles,
    /@media \(max-width: 900px\)[\s\S]*?\.search-box:not\(\.search-box-open\)\s*\{\s*display:\s*none/,
  );
  assert.match(styles, /\.composer-options-open \.agent-controls \{\s*display: grid/);
  assert.match(styles, /\.agent-controls select \{[\s\S]*?min-height: 44px/);
  assert.match(source, /function SessionSignalIcon\(/);
  assert.match(source, /data-session-signal=\{visualSignal\}/);
  assert.match(source, /className=\{`session-signal-mark signal-\$\{visualSignal\}/);
  assert.match(source, /title=\{visualSignalLabel \?\? undefined\}/);
  assert.doesNotMatch(source, /className="agent-ready"/);
  assert.doesNotMatch(source, /className="agent-failed"/);
  assert.match(styles, /\.project-signal-ready \{[\s\S]*?background: #ece8ff/);
  assert.match(styles, /\.project-signal-failed \{[\s\S]*?background: #fae7e9/);
  assert.match(styles, /\.session-signal-mark\.signal-ready \{[\s\S]*?background: var\(--violet\)/);
  assert.match(styles, /\.session-signal-mark\.signal-working \{[\s\S]*?background: #e4f5ed/);
  assert.match(styles, /\.session-signal-spinner \{[\s\S]*?animation: session-status-spin/);
  assert.doesNotMatch(styles, /inset 3px 0 0 var\(--violet\)/);
  assert.match(styles, /\.matrix-settings > footer \{[\s\S]*?position: sticky;[\s\S]*?bottom: 0/);
  await assert.rejects(access(new URL("app/_sites-preview", appRoot)));
});

test("publishes an authoritative uncached build version", async () => {
  const response = await fetchBuiltRoute("/api/version");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^application\/json\b/i);
  assert.match(response.headers.get("cache-control") ?? "", /no-store/i);
  assert.equal(response.headers.get("cdn-cache-control"), "no-store");
  const body = await response.json();
  assert.match(body.buildVersion, /^[A-Za-z0-9._+-]+$/u);
  if (process.env.MALINK_GATEWAY_RELEASE_ID && process.env.MALINK_GATEWAY_BUILD_ID) {
    assert.deepEqual(body.gatewayRelease, {
      releaseId: process.env.MALINK_GATEWAY_RELEASE_ID,
      buildId: process.env.MALINK_GATEWAY_BUILD_ID,
    });
  } else {
    assert.equal(body.gatewayRelease, undefined);
  }
});

test("keeps conversations inside the viewport with an independently scrollable feed", async () => {
  const [source, styles] = await Promise.all([
    readFile(new URL("app/MalinkApp.tsx", appRoot), "utf8"),
    readFile(new URL("app/globals.css", appRoot), "utf8"),
  ]);
  const appShell = styles.match(/\.app-shell \{([\s\S]*?)\}/)?.[1] ?? "";
  const sessionPanel =
    styles.match(/\.session-panel \{([\s\S]*?)\}/)?.[1] ?? "";
  const conversationPanel =
    styles.match(/\.conversation-panel \{([\s\S]*?)\}/)?.[1] ?? "";
  const chatFeed = styles.match(/\.chat-feed \{([\s\S]*?)\}/)?.[1] ?? "";

  assert.match(appShell, /grid-template-rows:\s*minmax\(0,\s*1fr\)/);
  assert.match(appShell, /height:\s*100dvh/);
  assert.match(appShell, /min-height:\s*0/);
  assert.match(sessionPanel, /min-height:\s*0/);
  assert.match(sessionPanel, /overflow:\s*hidden/);
  assert.match(conversationPanel, /min-height:\s*0/);
  assert.match(conversationPanel, /overflow:\s*hidden/);
  assert.match(chatFeed, /overflow-y:\s*auto/);
  assert.match(chatFeed, /touch-action:\s*pan-y/);
  assert.match(
    source,
    /followLatestRef\.current = isNearFeedBottom\(feed\)/,
  );
  assert.match(
    source,
    /function isNearFeedBottom[\s\S]*?scrollHeight - feed\.scrollTop - feed\.clientHeight <= 96/,
  );
  assert.doesNotMatch(source, /behavior:\s*"smooth"/);
});

test("renders safe Markdown with phase-aware, responsive tool focus", async () => {
  const [
    app,
    markdown,
    toolGroup,
    toolFocus,
    turnTimeline,
    presentation,
    packageJson,
    styles,
  ] =
    await Promise.all([
      readFile(new URL("app/MalinkApp.tsx", appRoot), "utf8"),
      readFile(new URL("app/MarkdownContent.tsx", appRoot), "utf8"),
      readFile(new URL("app/ToolActivityCard.tsx", appRoot), "utf8"),
      readFile(new URL("app/ToolFocusPanel.tsx", appRoot), "utf8"),
      readFile(new URL("app/turnTimeline.ts", appRoot), "utf8"),
      readFile(new URL("app/presentation.ts", appRoot), "utf8"),
      readFile(new URL("package.json", appRoot), "utf8"),
      readFile(new URL("app/globals.css", appRoot), "utf8"),
    ]);

  assert.match(
    app,
    /<MarkdownContent[\s\S]*?content=\{message\.text \?\? ""\}[\s\S]*?artifactReferences=\{artifactReferences\}[\s\S]*?onMaterializeArtifact=/,
  );
  assert.match(
    app,
    /<ToolActivityCard[\s\S]*?group=\{message\.toolGroup\}[\s\S]*?fullText=\{fullToolTranscript\(message\.text\)\}[\s\S]*?live=\{liveToolMessage\?\.id === message\.id\}/,
  );
  assert.match(app, /text\?\.startsWith\("Tool transcript\\n\\n"\)/);
  assert.doesNotMatch(app, /legacyCommandText|legacyToolGroupPresentation/);
  assert.match(app, /className="failed-message-retry"/);
  assert.match(app, /className="jump-to-latest"/);
  assert.doesNotMatch(app, /JSON\.stringify\(message\.raw/);
  assert.match(markdown, /remarkPlugins=\{\[remarkGfm\]\}/);
  assert.match(markdown, /skipHtml/);
  assert.match(markdown, /rel="noopener noreferrer"/);
  assert.match(markdown, /MarkdownCodeBlock/);
  assert.match(markdown, /navigator\.clipboard\.writeText/);
  assert.match(markdown, /url\.startsWith\(ARTIFACT_SCHEME\)/);
  assert.match(markdown, /The file changed\. Review the updated size and confirm again\./);
  assert.match(markdown, /connection\.downloadAttachment\(attachment\)/);
  assert.match(styles, /\.artifact-reference-details\s*\{/);
  assert.match(styles, /\.artifact-inline-image\s*\{/);
  assert.match(toolGroup, /aria-expanded=\{expanded\}/);
  assert.match(toolGroup, /toolStages\(group\.tools\)/);
  assert.match(toolGroup, /Diagnostics · Raw transcript/);
  assert.match(toolGroup, /copyDetails/);
  assert.match(toolGroup, /copyState === "copying"/);
  assert.match(toolGroup, /Copying…/);
  assert.match(toolGroup, /className="tool-call-invocation"/);
  assert.match(toolGroup, /outputOpen && tool\.result/);
  assert.doesNotMatch(toolGroup, /Waiting for output|No output was captured/);
  assert.match(app, /activeTurnToolFocus\(messages, isStreaming\)/);
  assert.match(app, /<ToolFocusPanel/);
  assert.match(app, /tool-focus-context-message/);
  assert.match(toolFocus, /className="tool-focus-invocation"/);
  assert.match(toolFocus, /outputOpen && tool\.result/);
  assert.match(toolFocus, /Show captured output/);
  assert.match(toolFocus, /\{toolIndex \+ 1\}\/\{group\.tools\.length\}/);
  assert.match(turnTimeline, /messageActivityAt\(message\)/);
  assert.match(styles, /\.conversation-workspace\.is-tool-focused/);
  assert.match(
    styles,
    /\.conversation-panel\s*\{[\s\S]*?container-type:\s*inline-size/,
  );
  assert.match(styles, /@container \(min-width: 820px\)/);
  assert.match(
    styles,
    /grid-template-columns:\s*minmax\(0, 1fr\) clamp\(390px, 42%, 620px\)/,
  );
  assert.match(styles, /max-height:\s*min\(48vh, 440px\)/);
  assert.match(presentation, /const TOOL_LIMIT = 200/);
  assert.match(packageJson, /"react-markdown"/);
  assert.match(packageJson, /"remark-gfm"/);
  assert.match(styles, /\.markdown-content pre/);
  assert.match(styles, /\.tool-activity-details/);
  assert.match(styles, /\.tool-stage-nav/);
  assert.match(styles, /\.agent-turn-continuation/);
  assert.match(styles, /overflow-wrap: anywhere/);
});

test("pairs a Gateway without exposing Matrix fingerprints and signs strict commands", async () => {
  const [
    matrix,
    pairing,
    replayStore,
    wizard,
    qrScanning,
    qrDecodeFallback,
    settings,
    app,
    matrixAuth,
    chatMessages,
    invitationRelay,
    invitationRoute,
    relayStore,
    packageJson,
    malinkClient,
    webMalinkClient,
    pairingRoute,
  ] = await Promise.all([
      readFile(new URL("app/matrix.ts", appRoot), "utf8"),
      readFile(new URL("app/pairing.ts", appRoot), "utf8"),
      readFile(new URL("app/IndexedDbReplayStore.ts", appRoot), "utf8"),
      readFile(new URL("app/PairingWizard.tsx", appRoot), "utf8"),
      readFile(new URL("app/qrScanning.ts", appRoot), "utf8"),
      readFile(new URL("app/qrDecodeFallback.ts", appRoot), "utf8"),
      readFile(new URL("app/MatrixSettings.tsx", appRoot), "utf8"),
      readFile(new URL("app/MalinkApp.tsx", appRoot), "utf8"),
      readFile(new URL("app/matrixAuth.ts", appRoot), "utf8"),
      readFile(new URL("app/chatMessages.ts", appRoot), "utf8"),
      readFile(new URL("app/invitationRelay.ts", appRoot), "utf8"),
      readFile(new URL("app/api/invitations/route.ts", appRoot), "utf8"),
      readFile(
        new URL("app/api/invitations/relayStore.ts", appRoot),
        "utf8",
      ),
      readFile(new URL("package.json", appRoot), "utf8"),
      readFile(new URL("app/client/MalinkClient.ts", appRoot), "utf8"),
      readFile(
        new URL("app/client/web/WebMalinkClient.ts", appRoot),
        "utf8",
      ),
      readFile(new URL("app/pairingRoute.ts", appRoot), "utf8"),
    ]);

  assert.match(packageJson, /"matrix-js-sdk": "41\.0\.0"/);
  assert.match(packageJson, /"@malink\/security"/);
  assert.match(packageJson, /"jsqr": "1\.4\.0"/);
  assert.match(packageJson, /"qrcode": "1\.5\.4"/);
  assert.match(matrix, /initRustCrypto\(\{/);
  assert.doesNotMatch(matrix, /readonly client: MatrixClient/);
  assert.match(malinkClient, /disconnect\(\): Promise<void>/);
  assert.match(settings, /Refresh APK status/);
  assert.match(settings, /Install APK update/);
  assert.match(app, /nativeUpdateStatus/);
  assert.match(malinkClient, /dispose\(\): void/);
  assert.match(webMalinkClient, /createWebMalinkClient/);
  assert.match(webMalinkClient, /this\.transport\.stop\(\)/);
  assert.match(app, /malinkClientRef/);
  assert.match(app, /malinkClientRef\.current\?\.dispose\(\)/);
  assert.match(app, /disconnectingClient\?\.disconnect\(\)/);
  assert.match(matrix, /initialSyncLimit: matrixInitialSyncLimit/);
  assert.match(matrix, /Publishing this device’s encryption keys/);
  assert.match(
    matrix,
    /completePairingPreview[\s\S]*await startupReady[\s\S]*await ensureOwnMatrixDeviceKeysPublished\(\)[\s\S]*async pair[\s\S]*completePairingPreview/,
  );
  assert.doesNotMatch(
    matrix.slice(
      matrix.indexOf("const finishMatrixStartup"),
      matrix.indexOf("const startupReady"),
    ),
    /Publishing this device’s encryption keys/,
  );
  assert.match(matrix, /CRYPTO_INITIALIZATION_TIMEOUT_MS/);
  assert.match(
    matrix,
    /await waitForInitialSync[\s\S]*handlers\.onStatus\(\s*"securing"/,
  );
  assert.match(matrix, /readonly ready: Promise<void>/);
  assert.match(matrix, /ready: startupReady/);
  assert.equal(matrix.match(/forceDiscardSession\(/gu)?.length, 3);
  const recoveredGatewayEncryptionBranch = matrix.slice(
    matrix.indexOf("if (gatewayTransportChanged)"),
    matrix.indexOf("if (rebuildingSyncStore)"),
  );
  assert.match(
    recoveredGatewayEncryptionBranch,
    /const cryptoApi = client\.getCrypto\(\);[\s\S]*if \(!cryptoApi\)[\s\S]*cryptoApi\.forceDiscardSession\(config\.roomId\)/,
  );
  assert.match(
    matrix,
    /if \(configuredGateway && activeTrust\)[\s\S]*verifyAndPinGatewayDevice/,
  );
  assert.match(
    matrix,
    /completePairingPreview[\s\S]*verifyAndPinGatewayDevice[\s\S]*createMatrixPairingTransport/,
  );
  assert.match(matrix, /new sdk\.IndexedDBStore\(\{/);
  assert.match(matrix, /store: syncStore/);
  assert.match(
    matrix,
    /createClient\([\s\S]*syncStore\.startup\(\)[\s\S]*initRustCrypto/,
  );
  assert.match(matrix, /flushMatrixSyncStore/);
  assert.match(matrix, /flushAndReleaseMatrixSyncStore/);
  assert.doesNotMatch(matrix, /destroyAndReleaseMatrixSyncStore/);
  assert.match(matrix, /shouldRebuildMatrixSyncStore/);
  assert.match(matrix, /acquireMatrixCryptoLock/);
  assert.match(matrix, /getSavedSyncToken\(\)/);
  assert.match(matrix, /assertPersistenceHealthy\(\)/);
  assert.match(matrix, /persistence degraded to memory/);
  assert.match(matrix, /state === "SYNCING" \|\| state === "PREPARED"/);
  assert.match(matrix, /signed Gateway Matrix device is not present/i);
  assert.ok(
    matrix.indexOf("getUserDeviceInfo([gateway.userId], false)") <
      matrix.indexOf("getUserDeviceInfo([gateway.userId], true)"),
  );
  assert.match(matrix, /useIndexedDB: true/);
  assert.match(matrix, /cryptoDatabasePrefix:/);
  assert.match(matrix, /indexedDB\.open\(MATRIX_IDENTITY_DATABASE_NAME/);
  assert.match(matrix, /signCommand\(command, identity\.privateKey/);
  assert.match(matrix, /deviceId: identity\.keyId/);
  assert.match(matrix, /kind: "signed_command"/);
  assert.match(matrix, /signed_command: envelope/);
  assert.match(matrix, /sealSecureEnvelope\(\{/);
  assert.match(matrix, /openSecureEnvelope\(extension\.secure_envelope/);
  assert.match(matrix, /openSecureEnvelopeBundle\(/);
  assert.match(matrix, /kind === "secure_envelope_bundle"/);
  assert.match(matrix, /secure_envelope_bundle/);
  assert.match(matrix, /replaces_logical_event_id/);
  assert.match(matrix, /kind: "secure_envelope"/);
  assert.match(matrix, /body: "Encrypted Malink message"/);
  assert.match(matrix, /kind === "command_ack"/);
  assert.match(matrix, /baseRevision: reservation\.baseRevision/);
  assert.match(matrix, /kind === "revision_conflict"/);
  assert.match(matrix, /rebasePendingCommand/);
  assert.match(matrix, /confirmRevisionRetry\(commandId\)/);
  assert.match(matrix, /discardRevisionConflict\(commandId\)/);
  assert.match(matrix, /CommandRevisionConflictError/);
  assert.doesNotMatch(matrix, /transmitWithConflictRetry/);
  assert.match(
    matrix,
    /confirmRevisionRetry\(commandId\)[\s\S]*rebasePendingCommand/,
  );
  assert.match(
    matrix,
    /sequence: reservation\.sequence,[\s\S]*baseRevision: expectedRevision/,
  );
  assert.match(matrix, /kind === "collaboration_command"/);
  assert.match(matrix, /kind === "command_result"/);
  assert.match(matrix, /isPositiveInteger\(decryptedExtension\.sequence\)/);
  assert.match(matrix, /onAuthenticatedCommandResult/);
  assert.match(
    matrix,
    /await onCommandAcknowledged\([\s\S]*commandLifecycle\.recordResult\(result\)/,
  );
  assert.match(matrix, /completion: commandLifecycle\.waitForCompletion/);
  assert.match(matrix, /origin_device_name/);
  assert.match(matrix, /waitForCommandAcknowledgement/);
  assert.match(matrix, /lastAcknowledged/);
  assert.match(matrix, /retryPendingCommand/);
  assert.match(matrix, /COMMAND_RECOVERY_INTERVAL_MS = 30_000/);
  assert.match(matrix, /recoverPendingCommand/);
  assert.match(matrix, /window\.setInterval/);
  assert.match(
    matrix,
    /const samePayload =[\s\S]*JSON\.stringify\(recovered\.payload\) === JSON\.stringify\(payload\)/,
  );
  assert.doesNotMatch(matrix, /recovered\.expired/);
  assert.doesNotMatch(
    matrix,
    /A queued command expired before the Gateway confirmed it/,
  );
  assert.match(matrix, /certificate\.certificate\.certificateId/);
  assert.match(matrix, /direction: "device_to_gateway"/);
  assert.match(matrix, /direction: "gateway_to_device"/);
  assert.match(matrix, /signedSecureEnvelopeSchema\.safeParse/);
  assert.match(matrix, /signedSecureEnvelopeBundleSchema\.safeParse/);
  assert.match(matrix, /recipient\.recipientDeviceId === expected\.recipientDeviceId/);
  assert.match(matrix, /routed\.data\.envelope\.recipientDeviceId !== expected\.recipientDeviceId/);
  assert.match(matrix, /recipient\.recipientKeyId === expected\.recipientKeyId/);
  assert.match(matrix, /routed\.data\.envelope\.recipientKeyId !== expected\.recipientKeyId/);
  assert.match(matrix, /senderPublicKey: trust\.gatewayKey\.publicKey/);
  assert.match(matrix, /replayStore/);
  assert.match(matrix, /Timeline traffic must use v2 application encryption/);
  assert.match(matrix, /dedicated application-control event type/);
  assert.doesNotMatch(
    matrix,
    /parseMalinkEvent\([\s\S]{0,160}event\.getSender\(\)/,
  );
  assert.match(matrix, /globalBlacklistUnverifiedDevices = true/);
  assert.match(matrix, /AllDevicesIsolationMode/);
  assert.match(matrix, /gatewayMatrixEd25519/);
  assert.match(matrix, /setDeviceVerified/);
  assert.match(matrix, /getOwnDeviceKeys\(\)/);
  assert.match(matrix, /\/_matrix\/client\/v3\/account\/whoami/);
  assert.match(matrixAuth, /\/_matrix\/client\/v1\/login\/get_token/);
  assert.match(matrixAuth, /type: TOKEN_LOGIN_TYPE/);
  assert.match(matrixAuth, /type: PASSWORD_LOGIN_TYPE/);
  assert.match(wizard, /Add another device/);
  assert.match(wizard, /One-time Malink device invitation QR code/);
  assert.match(wizard, /margin: 4/);
  assert.match(wizard, /width: 256/);
  assert.match(app, /shortenDeviceInvitation/);
  assert.match(app, /resolveShortDeviceInvitation/);
  assert.match(invitationRelay, /name: "AES-GCM"/);
  assert.match(invitationRelay, /url\.hash = new URLSearchParams/);
  assert.match(invitationRoute, /action === "store"/);
  assert.match(invitationRoute, /action === "resolve"/);
  assert.match(relayStore, /new Map<string, EncryptedInvitationRelayEntry>/);
  assert.match(relayStore, /INVITATION_RELAY_MAX_ENTRIES = 256/);
  assert.doesNotMatch(invitationRoute, /loginToken|accessToken|pairingLink/);
  assert.match(settings, /"Sign in"/);
  assert.match(settings, /Advanced: use an access token/);
  assert.match(app, /operation: "device\.invite"/);
  assert.match(app, /error instanceof CommandAcknowledgementTimeoutError/);
  assert.match(app, /observeCommandCompletion/);
  assert.match(
    app,
    /parseGatewayInvitationResult\([\s\S]*requestMatrixLoginToken\(/,
  );
  assert.match(matrix, /sender === config\.userId/);
  assert.match(matrix, /error instanceof SecurityError && error\.code === "replay"/);
  assert.match(matrix, /Refusing to send to an unencrypted Matrix room/);
  assert.match(matrix, /kind: "pairing_request"/);
  const pairingResponseWaiter = matrix.slice(
    matrix.indexOf("function waitForPairingResponse"),
    matrix.indexOf("export async function verifyAndPinGatewayDevice"),
  );
  assert.match(pairingResponseWaiter, /processMatrixEventWithDecryptionRetry/);
  assert.match(pairingResponseWaiter, /request\.request\.expiresAt - Date\.now\(\)/);
  assert.match(pairingResponseWaiter, /Malink will keep waiting safely/);
  assert.doesNotMatch(
    pairingResponseWaiter,
    /did not approve this pairing request in time/,
  );
  assert.match(matrix, /applyGatewayDeviceRotation/);
  assert.match(pairing, /verifyGatewayDeviceRotation/);
  assert.match(matrix, /MALINK_GATEWAY_TRANSPORT_PROFILE_FIELD/);
  assert.match(matrix, /recoverGatewayTransportSnapshot/);
  assert.match(matrix, /applyGatewayTransportSnapshot/);
  assert.match(pairing, /verifyGatewayTransportSnapshot/);
  assert.match(pairing, /transportSnapshots/);
  assert.match(matrix, /enqueueInboundEvent/);
  assert.match(
    matrix,
    /const startupReady = finishMatrixStartup\(\);[\s\S]*void startupReady\.catch/,
  );
  assert.match(app, /shouldReloadInterruptedMatrixStartup/);
  assert.match(app, /MATRIX_STARTUP_RECOVERY_SESSION_KEY/);
  assert.match(app, /matrixStartupGenerationRef/);
  assert.match(app, /window\.location\.reload\(\)/);
  assert.ok(
    matrix.indexOf("client.on(sdk.RoomEvent.Timeline, onTimeline)") >
      matrix.indexOf("const recoveredTrust = await recoverGatewayTransportSnapshot"),
  );
  assert.match(app, /waitForCommandCompletion\(sent\.completion\)/);
  const projectCreation = app.slice(
    app.indexOf("async function createProject"),
    app.indexOf("async function createSession"),
  );
  assert.ok(
    projectCreation.indexOf("setNewProjectOpen(false)") <
      projectCreation.indexOf("await sendRealCommand"),
    "project creation should leave the modal before waiting on secure transport",
  );
  assert.match(projectCreation, /continuePendingProjectCreate\(connection, sent\)/);
  assert.match(projectCreation, /autoRetryRevisionConflict:\s*true/);
  assert.match(
    projectCreation,
    /CommandRevisionConflictError[\s\S]*CommandReviewRequiredError[\s\S]*holdProjectCreateForConflictReview/,
  );
  assert.match(
    app,
    /function continuePendingProjectCreate[\s\S]*waitForCommandCompletion\([\s\S]*sent\.completion,[\s\S]*PROJECT_CREATE_RESULT_TIMEOUT_MS/,
  );
  assert.match(
    app,
    /async function consumeProjectCreateCompletion[\s\S]*releaseCommand\(commandId\)/,
  );
  assert.match(
    app,
    /waitForCommandCompletion\([\s\S]*sent\.completion,[\s\S]*PROVIDER_HISTORY_RESULT_TIMEOUT_MS/,
  );
  assert.match(app, /providerHistoryPendingCommandRef/);
  assert.match(app, /recoverCommand\(pending\.commandId\)/);
  assert.match(app, /mobile-history-button\$\{providerHistoryLoad \? " is-loading"/);
  assert.match(app, /connection\.recoverCommand\(sent\.commandId\)/);
  assert.match(app, /await connection\.releaseCommand\(commandId\)/);
  assert.match(
    matrix,
    /Refusing to recover command \$\{expectedCommandId\}/,
  );
  assert.match(
    matrix,
    /applyGatewayDeviceRotation\(trust, signedRotation\)[\s\S]*assertMatrixEventMatchesTransport\(event, rotation\.nextTransport\)/,
  );
  assert.match(
    matrix,
    /event\.getClaimedEd25519Key\(\) !== transport\.ed25519/,
  );
  assert.doesNotMatch(
    matrix,
    /event\.getClaimedEd25519Key\(\) !== trust\.gatewayTransport\.ed25519/,
  );
  assert.match(matrix, /saveTrustedGateway\(nextTrust\)/);
  assert.match(
    pairing,
    /trust\.rotations\.some[\s\S]*rotationId === signedRotation\.rotation\.rotationId/,
  );
  assert.match(
    matrix,
    /event\.isDecryptionFailure\(\)[\s\S]*seen\.add\(eventId\);[\s\S]*return;/,
  );
  assert.match(matrix, /localStorage\.setItem/);
  assert.match(
    matrix,
    /config\.gatewayId,[\s\S]*identity\.keyId,[\s\S]*config\.conversationId,[\s\S]*sequenceEpoch/,
  );
  assert.doesNotMatch(
    matrix,
    /getClaimedEd25519Key\(\) !== gateway\.ed25519[\s\S]{0,600}pairing_response/,
  );
  assert.doesNotMatch(matrix, /fetch\(["'`]\/api|server action|use server/i);
  assert.match(pairing, /verifyPairingOffer/);
  assert.match(pairing, /signPairingRequest/);
  assert.match(pairing, /verifyPairingResponse/);
  assert.match(pairing, /export async function loadTrustedGateway/);
  assert.match(pairing, /verifyPairingRequest/);
  assert.match(pairing, /verifyPairingCertificate/);
  assert.match(pairing, /await verifyGatewayDeviceRotation/);
  assert.match(pairing, /PAIRING_TRUST_STORAGE_KEY/);
  assert.match(pairing, /PENDING_PAIRING_STORAGE_KEY/);
  assert.match(pairing, /PENDING_PAIRING_RETENTION_MS = 366 \* 24 \* 60 \* 60_000/);
  assert.match(pairing, /MIN_PAIRING_START_WINDOW_MS = 15_000/);
  assert.match(
    pairing,
    /savePendingPairing\([\s\S]*transport\.exchange\(\s*signedRequest/,
  );
  assert.match(pairing, /clearPendingPairing\(\);\s*saveTrustedGateway/);
  assert.match(pairing, /loadPendingPairingRecovery/);
  assert.doesNotMatch(
    pairing,
    /verifyPairingResponse\([\s\S]{0,300}now: signedResponse\.response\.issuedAt/,
  );
  assert.match(
    pairing,
    /signedResponse\.response\.expiresAt <= Date\.now\(\)/,
  );
  assert.match(matrix, /pairing_rejection/);
  assert.match(matrix, /verifyPairingRejection/);
  assert.match(pairing, /error instanceof PairingRejectedError/);
  assert.match(
    pairing,
    /previous pairing request expired\. Scan a new Gateway QR code/i,
  );
  assert.doesNotMatch(pairing, /function signDocument|function verifyDocument/);
  assert.match(replayStore, /class IndexedDbReplayStore implements ReplayStore/);
  assert.match(replayStore, /database\.transaction\(STORE_NAME, "readwrite"\)/);
  assert.match(replayStore, /claims\.some\(\(claim\) => activeKeys\.has\(claim\.key\)\)/);
  assert.match(wizard, /Scan QR code/);
  assert.match(wizard, /Paste from clipboard/);
  assert.match(wizard, /capture="environment"/);
  assert.match(wizard, /Take photo/);
  assert.match(wizard, /Choose photo/);
  assert.match(wizard, /Invitation code/);
  assert.match(wizard, /Connect to \$\{preview\.gatewayName\}/);
  assert.match(wizard, /Finishing the connection/);
  assert.match(
    app,
    /setConnectionDetail\(presentedStatus === "offline" \? null : detail \?\? null\)/,
  );
  assert.match(qrScanning, /BarcodeDetector/);
  assert.match(wizard, /decodeQrImageFile/);
  assert.match(qrScanning, /import\("\.\/qrDecodeFallback"\)/);
  assert.match(qrDecodeFallback, /jsQR/);
  assert.match(settings, /Only devices/);
  assert.match(settings, /signs in only this Malink device/);
  assert.match(settings, /never be[\s\S]*asked to copy a private access token/);
  assert.match(settings, /Advanced: use an access token/);
  assert.doesNotMatch(settings, /label: "Matrix account"|label: "This device"/);
  assert.doesNotMatch(settings, /Gateway Matrix user|Gateway Ed25519 fingerprint/);
  assert.match(
    app,
    /useState<GatewayStateSnapshot \| null>\(initialGatewayUi\.gatewayState\)/,
  );
  assert.match(app, /readGatewayUiCache\(window\.localStorage, config\)/);
  assert.match(app, /writeGatewayUiCache\(/);
  assert.match(app, /clearGatewayUiCache\(window\.localStorage\)/);
  assert.match(settings, /const showGatewayManagement =/);
  assert.match(
    settings,
    /hasSavedConnection \|\| gatewayProfiles\.length > 0/,
  );
  assert.match(
    settings,
    /savedGateways\.length > 0[\s\S]{0,120}\? \[trustedGateway\]/,
  );
  assert.match(settings, /Loading the current Gateway authorization/);
  assert.match(settings, /Build: \{gateway\.buildId \?\? "Not reported"\}/);
  assert.match(app, /gateways: gatewayDirectory\?\.directory\.gateways/);
  assert.doesNotMatch(
    settings,
    /savedGateways\.length > 0 && !pairingPreview && !repairRequired/,
  );
  assert.match(
    app,
    /operation: "gateway\.enrollment\.invite"[\s\S]{0,200}autoRetryRevisionConflict: true/,
  );
  assert.match(
    app,
    /operation: "gateway\.enrollment\.approve"[\s\S]{0,200}autoRetryRevisionConflict: true/,
  );
  assert.doesNotMatch(app, /Gateway setup request is waiting for review/);
  assert.match(
    app,
    /setActiveDeviceCount\(state\.gatewayState\.activeDeviceCount\)/,
  );
  assert.doesNotMatch(app, /setActiveDeviceCount\(incoming\.activeDeviceCount\)/);
  assert.doesNotMatch(app, /const sessions:|const initialMessages|appMode/);
  assert.doesNotMatch(matrix, /parseGatewayStateExtension\(decryptedExtension\)/);
  assert.doesNotMatch(matrix, /loadCachedGatewayState\(/);
  assert.doesNotMatch(matrix, /gatewayStateRequestSchema/);
  assert.doesNotMatch(matrix, /kind: "gateway_state_request"/);
  assert.match(
    matrix,
    /startupRoom\.on\(sdk\.RoomStateEvent\.Events, onRoomState\);[\s\S]*await loadAuthoritativeRoomState\(\)/,
  );
  assert.doesNotMatch(
    matrix,
    /const initialTimeline = [^;]*getLiveTimeline\(\)\.getEvents\(\)/,
    "startup must not queue room history ahead of live conversation events",
  );
  assert.doesNotMatch(
    matrix,
    /await client\.roomState\(config\.roomId\)/,
    "authoritative recovery must not depend on an unpaginated whole-room state response",
  );
  assert.match(
    matrix,
    /client\.getStateEvent\([\s\S]*MALINK_MATRIX_GATEWAY_STATE_EVENT_TYPE[\s\S]*MALINK_MATRIX_SESSION_DIRECTORY_EVENT_TYPE[\s\S]*matrixDirectoryStateKey\(descriptor, pageIndex\)/,
    "Gateway state and its bounded directory pages must be directly addressable",
  );
  assert.match(
    matrix,
    /sameMatrixDirectory\(before, after\)[\s\S]*validateMatrixDirectory\(after, pages\)[\s\S]*nativeProjection\.applyRoomStateBatch\(decodedState\)[\s\S]*authoritativeStateInitialized = true;[\s\S]*await onGatewayState\(snapshot\)/,
    "one stable and complete Matrix directory generation must reach the UI atomically",
  );
  assert.doesNotMatch(
    matrix,
    /await requestGatewayStateSnapshot\(\)/,
  );
  assert.match(
    matrix,
    /state === "RECONNECTING" \|\| state === "CATCHUP"[\s\S]*refreshNativeStateAfterReconnect = true/,
  );
  assert.match(
    matrix,
    /state === "ERROR"[\s\S]*refreshNativeStateAfterReconnect = true[\s\S]*handlers\.onStatus\([\s\S]*"reconnecting"/,
  );
  assert.match(matrix, /createGatewayStateCacheRecord\(/);
  assert.doesNotMatch(matrix, /parseGatewayStateCacheRecord\(/);
  assert.doesNotMatch(matrix, /cachedGatewayState/);
  assert.match(
    matrix,
    /const state = await nativeProjection\.applyRoomState\(content\);[\s\S]*await onGatewayState\(state\)/,
  );
  assert.match(matrix, /revisionInitialized: false/);
  assert.match(matrix, /classifyGatewayStateProgress/);
  assert.match(matrix, /isIgnorableGatewayStateReplay/);
  assert.match(matrix, /retiredRevisionEpochs/);
  assert.match(matrix, /gateway-epoch-v1/);
  assert.match(
    matrix,
    /function gatewayEpochScope[\s\S]*config\.gatewayId,[\s\S]*identity\.keyId,[\s\S]*config\.conversationId/,
  );
  assert.match(matrix, /isIgnorableGatewayStateReplay\(epochStatus/);
  assert.match(matrix, /revisionEpochGeneration/);
  assert.match(matrix, /changed epoch without advancing its generation/);
  assert.match(matrix, /lastAcknowledged: 0,[\s\S]*revisionEpoch,[\s\S]*stateVersion/);
  assert.match(matrix, /revisionEpoch: reservation\.revisionEpoch/);
  assert.match(matrix, /revision_epoch !== "string"/);
  assert.match(matrix, /assertMatchingRevisionEpoch/);
  assert.match(matrix, /Waiting for the current Gateway session state/);
  assert.match(
    app,
    /await optimisticHistoryPersisted;[\s\S]*setMessages\(\(current\) => \[\.\.\.current, optimisticMessage\]\)/,
    "a visible optimistic prompt must already be locally durable",
  );
  assert.doesNotMatch(app, />\s*Demo\s*</);
  assert.match(app, /connectMalinkClient/);
  assert.doesNotMatch(app, /connectMatrix/);
  assert.match(app, /confirmPairing/);
  assert.match(settings, /Native APK/);
  assert.match(settings, /connection-error-build/);
  assert.match(app, /onNativeRuntime/);
  assert.match(app, /pairingRouteFromUrl\(window\.location\.href\)/);
  assert.match(pairingRoute, /const pairingLink = hash\.get\("pair"\)/);
  assert.doesNotMatch(app, /searchParams\.get\("pair"\)/);
  assert.match(pairingRoute, /url\.searchParams\.has\("pair"\)/);
  assert.match(pairingRoute, /url\.searchParams\.delete\("pair"\)/);
  assert.doesNotMatch(pairing, /url\.searchParams\.get\("(?:pair|data)"\)/);
  assert.match(pairing, /url\.searchParams\.has\("pair"\)/);
  assert.match(app, /window\.history\.replaceState/);
  assert.match(app, /await loadTrustedGateway\(identity\)/);
  assert.match(
    app,
    /if \(trust\) \{[\s\S]*setSettingsOpen\(false\);[\s\S]*await connectMalinkClient\([\s\S]*trustedConfig/,
  );
  assert.match(app, /await loadPendingPairingRecovery\(identity\)/);
  assert.match(
    app,
    /await pairingRecoveryRef\.current\(preview, recoveryConfig\)/,
  );
  assert.match(
    app,
    /saveMatrixConfig\(nextConfig\);[\s\S]*settleNativeBootstrapTransfer\("offline"\);[\s\S]*catch \(error\) \{[\s\S]*settleNativeBootstrapTransfer\("error"\);/,
  );
  assert.match(
    app,
    /function settleNativeBootstrapTransfer\(status: "offline" \| "error"\)[\s\S]*setConnectionStatus\(status\);[\s\S]*setConnectionDetail\(null\);/,
  );
  assert.match(matrix, /room\.getLiveTimeline\(\)\.getEvents\(\)/);
  assert.match(matrix, /loadHistoryPage\(sessionId/);
  assert.doesNotMatch(app, /loadRecentHistory/);
  assert.doesNotMatch(app, /history:cross-device-sync/);
  assert.doesNotMatch(
    app,
    /(?:visibilitychange|window\.addEventListener\("focus"|window\.addEventListener\("online")[\s\S]{0,800}loadHistoryPage/,
  );
  assert.doesNotMatch(matrix, /kind: "malink\.history\.request"/);
  assert.doesNotMatch(matrix, /kind: "history_request"/);
  assert.doesNotMatch(matrix, /historyPageSchema\.parse|parseHistoryReplayEvent/);
  assert.doesNotMatch(matrix, /createDetachedSerialDispatcher/);
  assert.doesNotMatch(matrix, /historyRequestLifecycle/);
  assert.match(
    app,
    /onHistoryRecovered\(page\)[\s\S]*if \(isCurrentStartup\(\)\) recoverLateHistory\(page\)/,
  );
  assert.match(app, /setHistoryError/);
  assert.match(matrix, /await room\.fetchRoomThreads\(\)/);
  assert.match(
    matrix,
    /const loadHistoryPage = async[\s\S]*await fetchSessionRelations\(/,
  );
  assert.doesNotMatch(matrix, /client\.scrollback\(room/);
  assert.doesNotMatch(
    matrix,
    /client\.paginateEventTimeline\(thread\.liveTimeline/,
  );
  assert.doesNotMatch(matrix, /return requestGatewayHistoryPage\(/);
  assert.match(matrix, /class DisplayOnlyReplayStore implements ReplayStore/);
  assert.match(matrix, /now: routed\.data\.envelope\.issuedAt/);
  assert.match(matrix, /sessionId: effectiveExtension\.session_id/);
  assert.match(
    matrix,
    /`malink\.pair\.\$\{request\.request\.requestId\}\.\$\{crypto\.randomUUID\(\)\}`/,
  );
  assert.match(app, /sendRealCommand/);
  assert.match(app, /sessionLifecyclePayload\(action, sessionId\)/);
  assert.match(app, /operation: "session\.archive"/);
  assert.match(app, /sessionsAvailableForAutomaticSelection/);
  assert.match(app, /Remove from Malink; provider history remains/);
  assert.match(app, /ProviderHistoryDialog/);
  assert.match(app, /provider\.sessions\.list/);
  assert.match(app, /provider\.session\.inspect/);
  assert.match(app, /clearSessionMessageHistory/);
  assert.match(chatMessages, /entry\.commandId === message\.commandId/);
  assert.match(app, /message\.originDeviceName/);
  assert.match(app, /Another device updated this session/);
  assert.match(app, /Review complete · send/);
  assert.match(app, /discardRevisionConflict/);
  assert.match(app, /error instanceof CommandRevisionConflictError/);
  assert.match(
    app,
    /else if \(nativeCommandReviewRef\.current\)[\s\S]*?setDraft\(value\)[\s\S]*?The command was not sent\. Open connection settings\./,
  );
  assert.match(app, /completedCommandResultsRef/);
  assert.match(app, /await sent\.completion/);
  assert.match(app, /completion\?\.outcome === "succeeded"/);
  assert.match(
    app,
    /completedCommandResultsRef\.current\.delete\(result\.commandId\)[\s\S]*finishLocalPromptCommand\(sessionId\)/,
  );
  assert.match(
    app,
    /activePromptCommandsRef\.current\.get\(result\.commandId\)[\s\S]*finishLocalPromptCommand\(promptSessionId\)/,
  );
  assert.match(
    app,
    /function finishLocalPromptCommand\(sessionId: string\)[\s\S]*hasActivePromptCommand\(sessionId\)/,
  );
  assert.match(
    app,
    /acknowledgementTimeout\.commandId[\s\S]*activePromptCommandsRef\.current\.set/,
  );
});
