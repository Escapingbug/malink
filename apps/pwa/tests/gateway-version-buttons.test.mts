import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
const source = readFileSync(new URL("../app/GatewayUpdateDialog.tsx", import.meta.url), "utf8");
test("version button appearance does not depend on a different actions container", () => {
  const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
  const rule = css.match(/\.gateway-version-button \{([^}]+)\}/)?.[1] ?? "";
  for (const property of ["background", "border", "border-radius", "padding", "color", "cursor"]) {
    assert.match(rule, new RegExp(`(?:^|[;\\n])\\s*${property}:`));
  }
  assert.match(css, /\.gateway-version-button:focus-visible/);
  assert.match(css, /\.gateway-version-button:disabled/);
});
test("version actions use the shared button appearance and show checking feedback", () => {
  assert.match(source, /onCheckVersions && <button type="button" className="secondary-button gateway-version-button"/);
  assert.match(source, /key=\{id\} type="button" className="secondary-button gateway-version-button"/);
  assert.match(source, /Checking available versions…/);
  assert.match(source, /aria-busy=\{activeMode === "check_versions"\}/);
  assert.match(source, /gateway-version-check-icon is-checking/);
});
