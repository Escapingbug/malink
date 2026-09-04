import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CurrentAppAccessCard } from "../app/MatrixSettings.tsx";
import { PairingWizard } from "../app/PairingWizard.tsx";
import { SettingsNavigation } from "../app/SettingsNavigation.tsx";

test("labels the Computers count as a software update instead of an error", () => {
  const html = renderToStaticMarkup(createElement(SettingsNavigation, {
    activeSection: "workspace",
    gatewayUpdateAvailableCount: 2,
    onSelect() {},
  }));

  assert.match(html, /Computers/);
  assert.match(html, /2 Gateway software updates available/);
  assert.doesNotMatch(html, /needs attention/i);
});

test("keeps every settings destination visible without a notice", () => {
  const html = renderToStaticMarkup(createElement(SettingsNavigation, {
    activeSection: "support",
    gatewayUpdateAvailableCount: 0,
    onSelect() {},
  }));

  assert.match(html, /Overview/);
  assert.match(html, /Access/);
  assert.match(html, /Computers/);
  assert.match(html, /App &amp; help/);
  assert.doesNotMatch(html, />Devices</);
  assert.doesNotMatch(html, /Gateway software update/);
});

test("keeps the current app and another app distinct from Workspace computers", () => {
  const currentApp = renderToStaticMarkup(createElement(CurrentAppAccessCard, {
    nativeHostDetected: true,
    status: "connected",
    busy: false,
    onPause() {},
    onResume() {},
  }));
  const invitation = renderToStaticMarkup(createElement(PairingWizard, {
    preview: null,
    trustedGateway: { gatewayName: "Studio Gateway" } as never,
    repairReason: null,
    busy: false,
    connectionStatus: "connected",
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

  assert.match(currentApp, /Current app/);
  assert.match(currentApp, /Malink on this phone/);
  assert.match(invitation, /Another phone or browser/);
  assert.match(invitation, /Add another Malink app/);
  assert.match(invitation, /does not add or change a Workspace computer/);
  assert.doesNotMatch(invitation, /Connected computer/);
  assert.doesNotMatch(invitation, /Studio Gateway/);
});

test("uses a two-column mobile grid instead of overflowing four fixed-width tabs", async () => {
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  const mobileSettings = css.slice(css.indexOf("@media (max-width: 520px)"));
  const navigation = mobileSettings.slice(
    mobileSettings.indexOf(".settings-navigation"),
    mobileSettings.indexOf(".workspace-overview"),
  );

  assert.match(navigation, /grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/);
  assert.doesNotMatch(navigation, /overflow-x:\s*auto/);
});
