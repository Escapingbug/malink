import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { observeConversationRecovery } from "../app/conversationRecovery.ts";
import { ConversationRecoveryDetails } from "../app/ConversationRecoveryDetails.tsx";
import { ProjectRecoveryDiagnostics } from "../app/projectRecoveryDiagnostics.ts";

test("a hung initialization becomes visible without duplicate requests and can still recover", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let resolve!: () => void;
  let requests = 0;
  let ready = 0;
  const failures: unknown[] = [];
  const stop = observeConversationRecovery({
    ensureReady: () => { requests++; return new Promise<void>(r => { resolve = r; }); },
    onReady: () => { ready++; }, onFailure: e => failures.push(e),
  });
  t.mock.timers.tick(20_000);
  assert.match(String(failures[0]), /20 seconds/);
  t.mock.timers.tick(60_000);
  assert.equal(requests, 1);
  resolve();
  await Promise.resolve();
  assert.equal(ready, 1);
  stop();
});

test("actual failures remain available during retry and switching conversations ignores stale results", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  let resolve!: () => void;
  let ready = false;
  const failures: unknown[] = [];
  const failure = new Error("This project's verified state is unavailable");
  const stop = observeConversationRecovery({
    ensureReady: () => ++calls === 1 ? Promise.reject(failure) : new Promise<void>(r => { resolve = r; }),
    onReady: () => { ready = true; }, onFailure: e => failures.push(e),
  });
  await Promise.resolve();
  assert.equal(failures[0], failure);
  t.mock.timers.tick(2_000);
  assert.equal(calls, 2);
  t.mock.timers.tick(20_000);
  assert.deepEqual(failures, [failure]);
  stop();
  resolve();
  await Promise.resolve();
  assert.equal(ready, false);
});

test("failure details offer an export and show only the selected project's safe debug fields", () => {
  const diagnostics = new ProjectRecoveryDiagnostics();
  diagnostics.directory([{ projectId: "project-1", gatewayNodeId: "node-1", roomId: "room-1" }], 1);
  diagnostics.stage("project-1", "validate_grant");
  diagnostics.fail("project-1", { errcode: "M_FORBIDDEN", httpStatus: 403, access_token: "secret-token" });
  const html = renderToStaticMarkup(createElement(ConversationRecoveryDetails, {
    error: "The project could not be restored.", sessionId: "session-1", projectId: "project-1",
    exportBusy: false, onExport() {},
  }));
  assert.match(html, /Recovery error details/);
  assert.match(html, /The project could not be restored/);
  assert.match(html, /validate_grant/);
  assert.match(html, /M_FORBIDDEN/);
  assert.match(html, /Export diagnostics/);
  assert.doesNotMatch(html, /secret-token|<details open/);
  diagnostics.stop();
});
