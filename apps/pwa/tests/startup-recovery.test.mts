import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  StartupFailureRecovery,
  pwaStartupFailureCode,
} from "../app/StartupRecoveryBoundary.tsx";

test("uses a stable bounded startup failure code without exposing the error", () => {
  const first = pwaStartupFailureCode(new TypeError("private workspace detail"));
  const second = pwaStartupFailureCode(new TypeError("private workspace detail"));
  assert.equal(first, second);
  assert.match(first, /^ui-start-[0-9a-f]{8}$/u);
  assert.doesNotMatch(first, /private|workspace/u);
});

test("keeps startup failure recovery actionable instead of rendering a white root", () => {
  const html = renderToStaticMarkup(createElement(StartupFailureRecovery, {
    error: new Error("test startup failure"),
  }));
  assert.match(html, /Malink could not finish opening/);
  assert.match(html, /Android account, Matrix connection, queued actions, and native history remain intact/);
  assert.match(html, /Retry interface/);
  assert.match(html, /Check APK update/);
  assert.match(html, /Export diagnostics/);
  assert.match(html, /Open APK releases/);
  assert.doesNotMatch(html, /test startup failure/);
});
