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

  assert.match(html, /Sign out of Android app/);
  assert.match(html, /Remove this app’s local Matrix account/);
  assert.match(html, />Sign out<\/button>/);
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

  assert.match(html, /Sign out of this Android app/);
  assert.match(html, /short best-effort request/);
  assert.match(html, /Matrix being offline will not block local sign-out/);
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

  assert.match(action, /Sign out of this browser/);
  assert.match(action, /Remove this browser’s local Matrix account/);
  assert.match(dialog, /short best-effort request/);
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
