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
  assert.match(html, /<h2 id="connection-onboarding-title">Connect your computer<\/h2>/);
  assert.match(html, />Connect a computer</);
  assert.equal((html.match(/<li>/g) ?? []).length, 3);
  assert.match(html, /Only approved devices can read or send workspace messages/);
  assert.doesNotMatch(html, /Message Agent/);
});
