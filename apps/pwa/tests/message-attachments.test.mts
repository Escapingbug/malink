import test from "node:test";
import assert from "node:assert/strict";
import { messageAttachments } from "../app/messageAttachments.ts";

const attachment = { id: "file-1", name: "diagnostics.txt", mimeType: "text/plain", size: 12,
  sha256: "A".repeat(43), media: { url: "mxc://example.org/file", key: "A".repeat(43),
    iv: "A".repeat(16), sha256: "A".repeat(43), size: 28 } };

test("user attachments survive confirmation, initial prompt and cached semantics", () => {
  for (const semantic of [
    { type: "turn.queued", attachments: [attachment] },
    { operation: "prompt.submit", attachments: [attachment] },
    { type: "session.ready", initialPrompt: { attachments: [attachment] } },
    { type: "assistant.message", attachments: [attachment] },
  ]) assert.deepEqual(messageAttachments(undefined, semantic), [attachment]);
  assert.deepEqual(messageAttachments([attachment], {}), [attachment]);
});
test("missing or malformed descriptors do not become download links", () => {
  assert.equal(messageAttachments(undefined, null), undefined);
  assert.equal(messageAttachments(undefined, { attachments: [{ name: "fake" }] }), undefined);
});
