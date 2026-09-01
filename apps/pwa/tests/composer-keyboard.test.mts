import assert from "node:assert/strict";
import test from "node:test";
import {
  composerEnterAction,
  isDesktopBrowserUserAgent,
} from "../app/composerKeyboard.ts";

const desktopEnter = (overrides: Partial<Parameters<typeof composerEnterAction>[0]> = {}) =>
  composerEnterAction({
    key: "Enter",
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    composing: false,
    desktopBrowser: true,
    ...overrides,
  });

test("desktop browsers send only on unmodified Enter", () => {
  assert.equal(desktopEnter(), "send");
  assert.equal(desktopEnter({ shiftKey: true }), "newline");
  assert.equal(desktopEnter({ ctrlKey: true }), "newline");
  assert.equal(desktopEnter({ metaKey: true }), "newline");
  assert.equal(desktopEnter({ altKey: true }), "newline");
});

test("composition never submits and mobile keeps the existing shortcut", () => {
  assert.equal(desktopEnter({ composing: true }), "ignore");
  assert.equal(desktopEnter({ desktopBrowser: false }), "newline");
  assert.equal(desktopEnter({ desktopBrowser: false, ctrlKey: true }), "send");
});

test("classifies desktop and mobile browser user agents", () => {
  assert.equal(isDesktopBrowserUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X)"), true);
  assert.equal(isDesktopBrowserUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64)"), true);
  assert.equal(isDesktopBrowserUserAgent("Malink Desktop Mobile Shell"), true);
  assert.equal(isDesktopBrowserUserAgent("Mozilla/5.0 (Linux; Android 16; Mobile)"), false);
  assert.equal(isDesktopBrowserUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 20_0)"), false);
  assert.equal(
    isDesktopBrowserUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X)", 5),
    false,
  );
});
