import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
const source = readFileSync(new URL("../app/GatewayUpdateDialog.tsx", import.meta.url), "utf8");
test("version actions use the shared button appearance and show checking feedback", () => {
  assert.match(source, /onCheckVersions && <button type="button" className="secondary-button gateway-version-button"/);
  assert.match(source, /key=\{id\} type="button" className="secondary-button gateway-version-button"/);
  assert.match(source, /Checking available versions…/);
  assert.match(source, /aria-busy=\{activeMode === "check_versions"\}/);
  assert.match(source, /gateway-version-check-icon is-checking/);
});
