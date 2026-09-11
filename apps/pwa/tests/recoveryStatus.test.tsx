import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { RecoveryStatus, deviceSetupPresentation, nativeHistoryRecoveryPages } from "../app/RecoveryStatus";
import { AgentActivityIndicator } from "../app/AgentActivityIndicator";
import { deriveConnectionPresentation } from "../app/connectionPresentation";

test("only offer setup after saved identity lookup conclusively completes", () => {
  assert.equal(deviceSetupPresentation(true, null), "restoring");
  assert.equal(deviceSetupPresentation(true, "slow storage"), "restoring");
  assert.equal(deviceSetupPresentation(false, "unreadable trust"), "attention");
  assert.equal(deviceSetupPresentation(false, null), "setup");
});

test("cached working state is not presented as live during recovery or a failed check", () => {
  const activity = { phase: "working" as const, label: "Agent is working…" };
  const checking = renderToStaticMarkup(<AgentActivityIndicator activity={activity} recovering />);
  assert.match(checking, /Checking saved task status/);
  assert.doesNotMatch(checking, /Agent is working/);
  const failed = renderToStaticMarkup(<AgentActivityIndicator activity={activity} recoveryIncomplete />);
  assert.match(failed, /Saved task status not verified/);
  assert.doesNotMatch(failed, /Agent is working/);
  assert.equal(deriveConnectionPresentation("connected", "matrix_session_history_recovering_2").state, "ready");
  assert.match(deriveConnectionPresentation("connected", "matrix_session_history_incomplete").detail, /Reconnect/);
});

test("native recovery reports actual checked pages without inventing a total", () => {
  assert.equal(nativeHistoryRecoveryPages("matrix_session_history_recovering_12"), 12);
  assert.equal(nativeHistoryRecoveryPages("matrix_session_history_recovering_0"), 0);
  assert.equal(nativeHistoryRecoveryPages("matrix_session_history_recovering_invalid"), null);
  assert.equal(nativeHistoryRecoveryPages(null), null);
  const html = renderToStaticMarkup(<RecoveryStatus connected messages={3} pages={12} />);
  assert.match(html, /Connected/);
  assert.match(html, /12 history pages checked/);
  assert.match(html, /total is not yet known/);
  assert.doesNotMatch(html, /100%|3 messages/);
});
