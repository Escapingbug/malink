import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DiagnosticShareDialog } from "../app/DiagnosticShareDialog.tsx";

test("diagnostic destination requires explicit choice and only offers adding a draft", () => {
  let attachments = 0;
  const html = renderToStaticMarkup(createElement(DiagnosticShareDialog, {
    file: new File(["diagnostic"], "diagnostics.txt"),
    sessions: [{ key: '["project","session"]', label: "Bug report — Candidate Gateway · version-b" }],
    onAttach() { attachments++; }, onExternal() {}, onClose() {},
  }));
  assert.equal(attachments, 0);
  assert.match(html, /Candidate Gateway/);
  assert.match(html, /only adds an attachment draft/);
  assert.match(html, /disabled="">Add attachment/);
  assert.doesNotMatch(html, /type="submit"/);
});

test("diagnostic file is staged after choosing a route without invoking a send", () => {
  const source = readFileSync(new URL("../app/MalinkApp.tsx", import.meta.url), "utf8");
  const attach = source.slice(source.indexOf("onAttach={key =>"), source.indexOf('<header className="conversation-header">'));
  assert.match(attach, /chooseSession\(target.id, target.projectId\)/);
  assert.match(attach, /setPendingFiles\(\[\.\.\.existing, diagnosticShareFile\]\)/);
  assert.doesNotMatch(attach, /sendMessage\(|sendRealCommand\(|uploadAttachment\(/);
  assert.match(source, /if \(!value && pendingFiles.some\(file => diagnosticDraftFilesRef.current.has\(file\)\)\)/);
  assert.match(source, /conversationDraftsRef.current.set\(oldKey, \{ text: draft, files: pendingFiles \}\)/);
});
