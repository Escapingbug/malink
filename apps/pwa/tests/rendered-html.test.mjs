import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const appRoot = new URL("../", import.meta.url);

test("builds a migration-safe static Malink boot shell", async () => {
  const html = await readFile(new URL("../dist/index.html", import.meta.url), "utf8");
  assert.match(html, /<title>Your agents, anywhere · Malink<\/title>/i);
  assert.match(html, /Preparing this version/);
  assert.match(html, /Checking saved connection and recovery state before Malink starts/);
  assert.doesNotMatch(html, /Connect a computer/);
  assert.doesNotMatch(html, /Matrix|P-256|Gateway/);
  assert.doesNotMatch(html, />Demo</);
  assert.doesNotMatch(html, /Connection mode/);
  assert.doesNotMatch(html, /Permission required/);
  assert.doesNotMatch(html, /Your site is taking shape|codex-preview/i);
  await access(new URL("../dist/404.html", import.meta.url));
  await access(new URL("../dist/.nojekyll", import.meta.url));
  await assert.rejects(access(new URL("../dist/server/index.js", import.meta.url)));
  await assert.rejects(access(new URL("app/api/version/route.ts", appRoot)));
  await assert.rejects(access(new URL("app/api/invitations/route.ts", appRoot)));
  await assert.rejects(access(new URL("worker/index.ts", appRoot)));
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
  assert.equal(manifest.start_url, "./");
  assert.ok(manifest.icons.length > 0);
  assert.match(serviceWorker, /malink-shell-v9/);
  assert.match(serviceWorker, /caches\.open\(CACHE_NAME\)/);
  assert.match(serviceWorker, /event\.request\.mode === "navigate"/);
  assert.match(serviceWorker, /cache:\s*"no-store"/);
  assert.match(serviceWorker, /requestUrl\.pathname\.startsWith\(`\$\{BASE_PATH\}assets\/`\)/);
  assert.match(
    serviceWorker,
    /pathname\.startsWith\(`\$\{BASE_PATH\}assets\/`\)[\s\S]*?caches\.match\(event\.request\)[\s\S]*?fetch\(event\.request\)/,
  );
  assert.match(serviceWorker, /pathname\.startsWith\("\/_matrix\/"\)/);
  assert.match(
    serviceWorker,
    /pathname\.startsWith\("\/_matrix\/"\)[\s\S]*?return;/,
  );
  assert.match(serviceWorker, /pathname === `\$\{BASE_PATH\}version\.json`/);
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
    /className="settings-diagnostic-card"[\s\S]*onClick=\{onExportDiagnostics\}[\s\S]*<details className="settings-build-details">[\s\S]*Build and version details/,
  );
  assert.match(
    matrixSettings,
    /className="settings-group settings-app-group"[\s\S]*<PwaSourceSettings[\s\S]*<PwaUpdateSettings/,
  );
  const buildDetails = matrixSettings.slice(
    matrixSettings.indexOf('<details className="settings-build-details">'),
    matrixSettings.indexOf("</details>", matrixSettings.indexOf('<details className="settings-build-details">')),
  );
  assert.doesNotMatch(buildDetails, /Change address|Check for updates|onExportDiagnostics/);
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
  assert.match(source, /aria-label="Filter conversations by computer"/);
  assert.match(source, /<option value=\{ALL_GATEWAYS_FILTER\}>All computers<\/option>/);
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
  assert.match(source, /id="composer-send-shortcut"/);
  assert.match(source, /<kbd>Ctrl\/⌘<\/kbd>[\s\S]*?<kbd>Enter<\/kbd>[\s\S]*?to send/);
  assert.match(source, /aria-describedby="composer-status composer-send-shortcut"/);
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
  assert.match(source, /session-signal-\$\{visualSignal\}/);
  assert.match(source, /session-status-summary session-status-\$\{statusTone\}/);
  assert.match(source, /className=\{`session-signal-mark signal-\$\{visualSignal\}/);
  assert.match(source, /title=\{visualSignalLabel \?\? undefined\}/);
  assert.doesNotMatch(source, /className="agent-ready"/);
  assert.doesNotMatch(source, /className="agent-failed"/);
  assert.match(styles, /\.project-signal-ready \{[\s\S]*?background: #ece8ff/);
  assert.match(styles, /\.project-signal-failed \{[\s\S]*?background: #fae7e9/);
  assert.match(styles, /\.session-signal-mark\.signal-ready \{[\s\S]*?background: var\(--violet\)/);
  assert.match(styles, /\.session-signal-mark\.signal-working \{[\s\S]*?background: #e4f5ed/);
  assert.match(styles, /\.session-signal-spinner \{[\s\S]*?animation: session-status-spin/);
  assert.match(styles, /\.session-status-summary\.session-status-sending \{[\s\S]*?color: #3569b2/);
  assert.match(styles, /\.session-status-summary\.session-status-waiting \{[\s\S]*?color: #8a671d/);
  assert.match(styles, /\.session-status-summary\.session-status-working \{[\s\S]*?color: #267859/);
  assert.match(styles, /\.session-status-summary\.session-status-stopping \{[\s\S]*?color: #a3542d/);
  assert.match(styles, /@media \(min-width: 901px\)[\s\S]*?\.composer-send-shortcut \{[\s\S]*?display: inline-flex/);
  assert.doesNotMatch(styles, /inset 3px 0 0 var\(--violet\)/);
  assert.match(styles, /\.matrix-settings > footer \{[\s\S]*?position: sticky;[\s\S]*?bottom: 0/);
  await assert.rejects(access(new URL("app/_sites-preview", appRoot)));
});

test("publishes a static authoritative build version", async () => {
  const body = JSON.parse(
    await readFile(new URL("../dist/version.json", import.meta.url), "utf8"),
  );
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
  assert.doesNotMatch(app, /tool-focus-context-message|tool-focus-source|show-focus-history/);
  assert.match(toolFocus, /className="tool-focus-invocation"/);
  assert.match(toolFocus, /outputOpen && tool\.result/);
  assert.match(toolFocus, /Show captured output/);
  assert.match(toolFocus, /\{toolIndex \+ 1\}\/\{group\.tools\.length\}/);
  assert.match(turnTimeline, /messageActivityAt\(message\)/);
  assert.match(styles, /\.conversation-workspace\.is-tool-focused/);
  assert.doesNotMatch(styles, /tool-focus-context-message|tool-focus-source|show-focus-history/);
  assert.match(
    styles,
    /\.conversation-panel\s*\{[\s\S]*?container-type:\s*inline-size/,
  );
  assert.match(styles, /@container \(min-width: 820px\)/);
  assert.match(
    styles,
    /grid-template-columns:\s*minmax\(0, 1fr\) clamp\(390px, 42%, 620px\)/,
  );
  assert.match(styles, /flex:\s*0 1 clamp\(140px, 42%, 440px\)/);
  assert.match(styles, /max-height:\s*48%/);
  assert.match(presentation, /const TOOL_LIMIT = 200/);
  assert.match(packageJson, /"react-markdown"/);
  assert.match(packageJson, /"remark-gfm"/);
  assert.match(styles, /\.markdown-content pre/);
  assert.match(styles, /\.tool-activity-details/);
  assert.match(styles, /\.tool-stage-nav/);
  assert.match(styles, /\.agent-turn-continuation/);
  assert.match(styles, /overflow-wrap: anywhere/);
});

test("uses one Matrix SDK host around the MLP/3 client core", async () => {
  const [matrix, matrixConnection, webClient, pairing, packageJson] =
    await Promise.all([
      readFile(new URL("app/matrix.ts", appRoot), "utf8"),
      readFile(new URL("app/matrixMlp3Connection.ts", appRoot), "utf8"),
      readFile(new URL("app/client/web/WebMalinkClient.ts", appRoot), "utf8"),
      readFile(new URL("app/pairing.ts", appRoot), "utf8"),
      readFile(new URL("package.json", appRoot), "utf8"),
    ]);

  assert.match(packageJson, /"matrix-js-sdk": "41\.0\.0"/);
  assert.match(packageJson, /"@malink\/protocol"/);
  assert.match(packageJson, /"@malink\/security"/);
  assert.match(
    webClient,
    /import \{ connectMatrixMlp3 \} from "\.\.\/\.\.\/matrixMlp3Connection"/,
  );
  assert.match(webClient, /connect: connectMatrixMlp3/);
  assert.doesNotMatch(matrix, /export async function connectMatrix\(/);

  assert.match(matrixConnection, /new sdk\.IndexedDBStore\(\{/);
  assert.match(matrixConnection, /await client\.initRustCrypto\(\{/);
  assert.match(matrixConnection, /globalBlacklistUnverifiedDevices = true/);
  assert.match(matrixConnection, /if \(!client\.isRoomEncrypted\(config\.roomId\)\)/);
  assert.match(matrixConnection, /new MatrixMlp3ProtocolClient\(/);
  assert.match(matrixConnection, /new IndexedDbMatrixMlp3ClientStore\(/);
  assert.match(matrixConnection, /resolveAuthoritativeProjectKeyGrant\(/);
  assert.match(matrixConnection, /await target\.send\(payload\)/);
  assert.match(matrixConnection, /client\.http\.authedRequest/);
  assert.match(
    matrixConnection,
    /localTimeoutMs: MATRIX_HISTORY_REQUEST_TIMEOUT_MS/,
  );
  assert.doesNotMatch(matrixConnection, /client\.relations\(/);
  assert.doesNotMatch(matrixConnection, /client\.scrollback\(/);
  assert.match(matrixConnection, /await completePairing\(/);
  assert.match(
    matrixConnection,
    /await verifyAndPinGatewayDevice\(client, preview\.transport\)/,
  );
  assert.match(matrixConnection, /MLP\/3 has no global revision conflict to retry/);

  assert.match(matrix, /kind: "pairing_request"/);
  assert.match(matrix, /processMatrixEventWithDecryptionRetry\(/);
  assert.match(matrix, /await verifyPairingResponse\(parsed, offer, request\)/);
  assert.match(
    pairing,
    /await verifyPairingCertificate\(certificate, offer, request\)/,
  );
  assert.match(pairing, /export function saveTrustedGateway\(/);
});
