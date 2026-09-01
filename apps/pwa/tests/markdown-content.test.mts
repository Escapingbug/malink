import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkdownContent } from "../app/MarkdownContent.tsx";

test("does not navigate unverified local Markdown links", () => {
  const html = renderToStaticMarkup(createElement(MarkdownContent, {
    content: [
      "[absolute](/Users/user/project/file.ts:12)",
      "[relative](src/file.ts)",
      "[file URL](file:///Users/user/project/file.ts)",
      "[remote](https://example.test/source)",
      "[section](#details)",
    ].join("\n"),
  }));

  assert.equal((html.match(/artifact-reference-unavailable/g) ?? []).length, 3);
  assert.doesNotMatch(html, /href="\/Users\/user\/project\/file\.ts:12"/);
  assert.doesNotMatch(html, /href="src\/file\.ts"/);
  assert.doesNotMatch(html, /href="file:/);
  assert.match(html, /href="https:\/\/example\.test\/source"/);
  assert.match(html, /href="#details"/);
});

test("keeps verified artifact references in the confirmation UI", () => {
  const html = renderToStaticMarkup(createElement(MarkdownContent, {
    content: "[report](malink-artifact:reference-1)",
    artifactReferences: [{
      id: "reference-1",
      kind: "file",
      name: "report.txt",
      relativePath: "report.txt",
      mimeType: "text/plain",
      size: 12,
      modifiedAt: 1,
      statRevision: "revision-1",
    }],
  }));

  assert.match(html, /artifact-reference-trigger/);
  assert.match(html, />▤ report<\/button>/);
  assert.doesNotMatch(html, /href=/);
});
