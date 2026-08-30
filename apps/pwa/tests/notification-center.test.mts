import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(
  new URL("../app/NotificationCenter.tsx", import.meta.url),
  "utf8",
);

test("notification center is always dismissible without cancelling operations", () => {
  assert.match(source, /aria-label="Close notifications"/);
  assert.match(source, /onMouseDown=\{onClose\}/);
  assert.match(source, /onEscape: onClose/);
  assert.match(source, /Closing this panel never cancels/);
});

test("notification center keeps actions available after a message is hidden", () => {
  assert.match(source, /Hidden messages stay here/);
  assert.match(source, /item\.actions\.map/);
  assert.match(source, /Nothing needs your attention/);
});
