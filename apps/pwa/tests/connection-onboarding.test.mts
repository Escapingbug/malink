import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ConnectionOnboarding } from "../app/ConnectionOnboarding.tsx";

test("presents one clear connection action before conversation controls", () => {
  const html = renderToStaticMarkup(createElement(ConnectionOnboarding, {
    onConnect() {},
  }));

  assert.match(html, /aria-labelledby="connection-onboarding-title"/);
  assert.match(html, /<h2 id="connection-onboarding-title">Add this device to Malink<\/h2>/);
  assert.match(html, />Use an invitation</);
  assert.equal((html.match(/<li>/g) ?? []).length, 3);
  assert.match(html, /authorized device or Workspace computer/);
  assert.match(html, /Open Access in an authorized Malink app/);
  assert.match(html, /Only authorized Malink apps can read or send Workspace messages/);
  assert.doesNotMatch(html, /Message Agent/);
});

test("explains the boundary after this device signs out", () => {
  const html = renderToStaticMarkup(createElement(ConnectionOnboarding, {
    notice: "signed-out",
    onDismissNotice() {},
    onConnect() {},
  }));

  assert.match(html, /Signed out on this device/);
  assert.match(html, /Workspace, computers, and server history remain available/);
  assert.match(html, /other authorized Malink apps/);
  assert.match(html, /Use an invitation/);
});
