import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { CommandCompletionTimeoutError } from "../app/commandLifecycle.ts";

const source = readFileSync(new URL("../app/MalinkApp.tsx", import.meta.url), "utf8");
test("leaving selection is independent of pending archive results", () => {
  const bar = source.slice(source.indexOf('{trustedGateway && bulkSelect && ('), source.indexOf('<div className="session-list">', source.indexOf('{trustedGateway && bulkSelect && (')));
  const exit = bar.slice(0, bar.indexOf('</button>'));
  assert.match(exit, /setBulkSelect\(false\)/);
  assert.doesNotMatch(exit, /disabled=/);
  assert.match(source, /全选 \$\{project.projectName\} 下可归档会话/);
});
test("batch archives await settlement and keep unknown results durable", () => {
  assert.match(source, /if \(waitForSettlement\) await settlement/);
  assert.match(source, /operation: "session.archive.batch"/);
  assert.match(source, /consumeBatchArchiveProgress\(result.result\)/);
  const deletion = source.slice(source.indexOf('async function deleteProject()'), source.indexOf('function retryFailedOptimisticProjectCreate'));
  assert.match(deletion, /waitForCommandCompletion\(sent.completion\)/);
  assert.match(deletion, /commandId && confirmed/);
  assert.match(deletion, /rememberBackgroundRecoveredNativeCommand/);
  assert.doesNotMatch(new CommandCompletionTimeoutError().message, /Reconnect before retrying/);
});
