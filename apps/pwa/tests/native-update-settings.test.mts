import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NativeUpdateSettings } from "../app/MatrixSettings.tsx";
import {
  NATIVE_UPDATE_DISCOVERY_GRACE_MS,
  shouldPollNativeUpdateStatus,
} from "../app/nativeUpdatePolling.ts";

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

test("shows live APK bytes and a native progress bar", () => {
  const state = {
    phase: "downloading" as const,
    currentVersionCode: 1,
    currentVersionName: "0.1.0-old",
    latestVersionCode: 2,
    latestVersionName: "0.1.0-new",
    downloadedBytes: 19_382_296,
    totalBytes: 38_764_593,
  };
  const html = renderToStaticMarkup(createElement(NativeUpdateSettings, {
    state,
    busy: false,
    onRefresh() {},
    onInstall() {},
  }));

  assert.match(html, /downloading 49% \(18\.5 MB \/ 37\.0 MB\)/);
  assert.match(html, /<progress aria-label="APK download progress" max="38764593" value="19382296"><\/progress>/);
  assert.doesNotMatch(html, /from your Gateway/i);
});

test("polls active downloads and bounds the initial discovery race", () => {
  assert.equal(shouldPollNativeUpdateStatus(null, 0), true);
  assert.equal(shouldPollNativeUpdateStatus({
    phase: "current",
    currentVersionCode: 1,
    currentVersionName: "0.1.0",
  }, NATIVE_UPDATE_DISCOVERY_GRACE_MS - 1), true);
  assert.equal(shouldPollNativeUpdateStatus({
    phase: "current",
    currentVersionCode: 1,
    currentVersionName: "0.1.0",
  }, NATIVE_UPDATE_DISCOVERY_GRACE_MS), false);
  assert.equal(shouldPollNativeUpdateStatus({
    phase: "downloading",
    currentVersionCode: 1,
    currentVersionName: "0.1.0",
  }, NATIVE_UPDATE_DISCOVERY_GRACE_MS * 10), true);
  assert.equal(shouldPollNativeUpdateStatus({
    phase: "ready",
    currentVersionCode: 1,
    currentVersionName: "0.1.0",
  }, 0), false);
});
