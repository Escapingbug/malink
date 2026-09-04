import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
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

  assert.match(html, /Workspace/);
  assert.match(html, /Devices/);
  assert.match(html, /Computers/);
  assert.match(html, /App &amp; support/);
  assert.doesNotMatch(html, /Gateway software update/);
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
