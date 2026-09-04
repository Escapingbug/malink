import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

  assert.match(html, /Sign out on this phone/);
  assert.match(html, /Remove this Android app’s local account, Workspace authorization/);
  assert.match(html, />Sign out on this phone<\/button>/);
  assert.doesNotMatch(html, /Matrix/);
  assert.doesNotMatch(html, /Remove computer/);
});

test("explains that Matrix availability cannot block local Android sign-out", () => {
  const html = renderToStaticMarkup(createElement(GatewayForgetDialog, {
    open: true,
    deviceKind: "android",
    busy: false,
    error: "Matrix is offline.",
    onClose() {},
    onConfirm() {},
  }));

  assert.match(html, /Sign out on this phone/);
  assert.match(html, /try to invalidate this app.*server login/);
  assert.match(html, /Being offline will not block local sign-out/);
  assert.match(html, /Sign-out needs attention/);
  assert.match(html, /Matrix is offline/);
  assert.match(html, /Stay signed in/);
});

test("uses the same local sign-out contract in a browser", () => {
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

  assert.match(action, /Sign out in this browser/);
  assert.match(action, /Remove this browser’s local account, Workspace authorization/);
  assert.match(dialog, /try to invalidate this app.*server login/);
  assert.doesNotMatch(action, /Matrix/);
  assert.doesNotMatch(action, /Remove computer/);
});

test("keeps sign-out available while unrelated connection work is busy", () => {
  const source = readFileSync(
    new URL("../app/MatrixSettings.tsx", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /<DeviceRemovalSettings[\s\S]*?busy=\{signOutBusy\}/u,
  );
});

test("does not expose the retired automatic Matrix account upgrade", () => {
  const settings = readFileSync(
    new URL("../app/MatrixSettings.tsx", import.meta.url),
    "utf8",
  );
  const app = readFileSync(new URL("../app/MalinkApp.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(settings, /Matrix account upgrade available/u);
  assert.doesNotMatch(settings, /Rejoin with invitation/u);
  assert.doesNotMatch(app, /clientMatrixAccountUpgrade/u);
});

test("does not report an already removed native account as unchanged", () => {
  const app = readFileSync(new URL("../app/MalinkApp.tsx", import.meta.url), "utf8");
  assert.match(app, /nativeAccountRemoved = client\.runtime === "native"/u);
  assert.match(app, /Android has signed out, but this page could not finish resetting/u);
});
