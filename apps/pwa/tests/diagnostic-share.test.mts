import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SharedFileDialog, filterShareSessions } from "../app/SharedFileDialog.tsx";

test("diagnostic destination requires explicit choice and only offers adding a draft", () => {
  let attachments = 0;
  const html = renderToStaticMarkup(createElement(SharedFileDialog, {
    files: [new File(["diagnostic"], "diagnostics.txt"), new File(["ordinary file"], "notes.txt")],
    sessions: [{ key: '["project","session"]', title: "Bug report", projectId: "project", projectName: "Malink", computer: "Candidate Gateway · version-b", updatedAt: 100 }],
    onAttach() { attachments++; }, onClose() {},
  }));
  assert.equal(attachments, 0);
  assert.match(html, /Candidate Gateway/);
  assert.match(html, /notes.txt/);
  assert.match(html, /<footer>/);
  assert.match(html, /class="secondary-button"/);
  assert.match(html, /only adds an attachment draft/);
  assert.match(html, /type="search"/);
  assert.match(html, /Share to Bug report/);
  assert.doesNotMatch(html, /<select|Add attachments/);
  assert.doesNotMatch(html, /type="submit"/);
});

test("share search matches title project and computer and sorts recent conversations first", () => {
  const sessions = [
    { key: "a", title: "日志故障", projectId: "p", projectName: "Malink", computer: "Phone gateway", updatedAt: 1 },
    { key: "b", title: "Other", projectId: "p", projectName: "Malink", computer: "PC gateway", updatedAt: 2 },
  ];
  assert.deepEqual(filterShareSessions(sessions, " MALINK phone ").map(s => s.key), ["a"]);
  assert.deepEqual(filterShareSessions(sessions, "日志").map(s => s.key), ["a"]);
  assert.deepEqual(filterShareSessions(sessions, "").map(s => s.key), ["b", "a"]);
  assert.deepEqual(filterShareSessions(sessions, "missing"), []);
});

test("diagnostic file is staged after choosing a route without invoking a send", () => {
  const source = readFileSync(new URL("../app/MalinkApp.tsx", import.meta.url), "utf8");
  const attach = source.slice(source.indexOf("onAttach={key =>"), source.indexOf('<header className="conversation-header">'));
  assert.match(attach, /chooseSession\(target.id, target.projectId\)/);
  assert.match(attach, /setPendingFiles\(\[\.\.\.existing, \.\.\.sharedFileBatch.files\]\)/);
  assert.doesNotMatch(attach, /sendMessage\(|sendRealCommand\(|uploadAttachment\(/);
  assert.match(source, /if \(!value && pendingFiles.some\(file => sharedDraftFilesRef.current.has\(file\)\)\)/);
  assert.match(source, /conversationDraftsRef.current.set\(oldKey, \{ text: draft, files: pendingFiles \}\)/);
});
