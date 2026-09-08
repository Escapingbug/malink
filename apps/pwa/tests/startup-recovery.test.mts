import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  StartupFailureRecovery,
  pwaStartupFailureCode,
} from "../app/StartupRecoveryBoundary.tsx";

test("session settings render safely before a conversation has been selected", () => {
  // Exercise the actual render branch: both optional IDs used to compare equal
  // when absent, and the branch then dereferenced the null pending update.
  const source = readFileSync(new URL("../app/MalinkApp.tsx", import.meta.url), "utf8");
  const branch = source.match(/  if \([^\n]+\) \{\n    Object\.assign\(activeProviderControlValues, sessionSettingsUpdate\.changes\);[\s\S]*?\n  \}/u)?.[0];
  assert.ok(branch);
  const renderValues = new Function("sessionSettingsUpdate", "selected", "activeProviderControlValues", `${branch}\nreturn activeProviderControlValues;`);
  assert.deepEqual(renderValues(null, undefined, {}), {});
  assert.deepEqual(renderValues(null, { id: "session-a" }, { model: "original" }), { model: "original" });
  const update = { sessionId: "session-a", changes: { model: "new" }, cleared: ["reasoningEffort"] };
  assert.deepEqual(renderValues(update, undefined, {}), {});
  assert.deepEqual(renderValues(update, { id: "session-b" }, { model: "original" }), { model: "original" });
  assert.deepEqual(renderValues(update, { id: "session-a" }, { model: "original", reasoningEffort: "high" }), { model: "new" });
  assert.equal(pwaStartupFailureCode(new TypeError("Cannot read properties of null (reading 'changes')")), "ui-start-3928c805");
});

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
