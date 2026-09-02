import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { GatewayForgetDialog } from "../app/GatewayForgetDialog.tsx";
import { DeviceRemovalSettings } from "../app/MatrixSettings.tsx";

test("exposes Android sign-out as an account action instead of computer removal", () => {
  const html = renderToStaticMarkup(createElement(DeviceRemovalSettings, {
    deviceKind: "android",
    busy: false,
    onRemove() {},
  }));

  assert.match(html, /Sign out of Android app/);
  assert.match(html, /Revoke this Android device’s Matrix login/);
  assert.match(html, />Sign out<\/button>/);
  assert.doesNotMatch(html, /Remove computer/);
});

test("explains Android sign-out ordering and fail-closed recovery", () => {
  const html = renderToStaticMarkup(createElement(GatewayForgetDialog, {
    open: true,
    deviceKind: "android",
    busy: false,
    error: "Matrix is offline.",
    onClose() {},
    onConfirm() {},
  }));

  assert.match(html, /Sign out of this Android app/);
  assert.match(html, /Matrix will revoke this Android device first/);
  assert.match(html, /keeps its local data/);
  assert.match(html, /Sign-out needs attention/);
  assert.match(html, /Matrix is offline/);
  assert.match(html, /Stay signed in/);
});

test("uses the same Matrix-first sign-out contract in a browser", () => {
  const action = renderToStaticMarkup(createElement(DeviceRemovalSettings, {
    deviceKind: "browser",
    busy: false,
    onRemove() {},
  }));
  const dialog = renderToStaticMarkup(createElement(GatewayForgetDialog, {
    open: true,
    deviceKind: "browser",
    busy: false,
    onClose() {},
    onConfirm() {},
  }));

  assert.match(action, /Sign out of this browser/);
  assert.match(action, /Revoke this browser’s Matrix login/);
  assert.match(dialog, /Matrix will revoke this browser session first/);
  assert.doesNotMatch(action, /Remove computer/);
});
