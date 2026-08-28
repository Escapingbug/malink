import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NativeUpdateSettings } from "../app/MatrixSettings.tsx";

test("shows Android update recovery without Workspace authorization", () => {
  const html = renderToStaticMarkup(createElement(NativeUpdateSettings, {
    state: null,
    busy: false,
    onRefresh() {},
    onInstall() {},
  }));

  assert.match(html, /Android app/);
  assert.match(html, /Workspace authorization is not required/);
  assert.match(html, /Check APK update/);
});

test("offers the verified APK when the native host reports it ready", () => {
  const html = renderToStaticMarkup(createElement(NativeUpdateSettings, {
    state: {
      phase: "ready",
      currentVersionCode: 1,
      currentVersionName: "0.1.0-old",
      latestVersionCode: 2,
      latestVersionName: "0.1.0-new",
    },
    busy: false,
    onRefresh() {},
    onInstall() {},
  }));

  assert.match(html, /0\.1\.0-new is ready to install/);
  assert.match(html, /Install APK update/);
});
