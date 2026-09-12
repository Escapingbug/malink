import assert from "node:assert/strict";
import test from "node:test";
import { computerUserState } from "../app/computerUserState";
import type { GatewayUpdateNodeRuntime } from "../app/GatewayUpdateDialog";

const now = 1_000_000;
const base = { connected: true, now, currentBuild: "old", targetBuild: "new", liveness: { state: "online" as const, lastVerifiedAt: now } };
const runtime = (phase: NonNullable<GatewayUpdateNodeRuntime["status"]>["phase"]): GatewayUpdateNodeRuntime => ({ state: "online", status: { version: 1, updatedAt: now, phase, currentBuildId: "old" } });

test("healthy current computer asks for nothing", () => {
  const result = computerUserState({ ...base, currentBuild: "new" });
  assert.equal(result.title, "Available");
  assert.equal(result.description, "No action needed.");
  assert.equal(result.showUpdate, false);
});
for (const phase of ["agent_required", "agent_running", "agent_validating", "staging"] as const) {
  test(`${phase} is normal background preparation`, () => {
    const result = computerUserState({ ...base, runtime: runtime(phase) });
    assert.equal(result.title, "Available · Preparing update");
    assert.equal(result.attention, false);
  });
}
test("waiting and ready do not claim that the computer is unavailable", () => {
  assert.equal(computerUserState({ ...base, runtime: runtime("staged") }).title, "Available · Update ready");
  assert.equal(computerUserState({ ...base, runtime: runtime("waiting_for_idle") }).title, "Available · Update waiting");
});
test("restart silence is normal only while its signed evidence is recent", () => {
  const current = runtime("activating");
  assert.equal(computerUserState({ ...base, runtime: current }).title, "Temporarily unavailable · Updating");
  const stale = computerUserState({ ...base, now: now + 600_000, runtime: current });
  assert.equal(stale.availability, "Connection not confirmed");
  assert.equal(stale.needsConnectionHelp, true);
});
test("missed check preserves both recent availability evidence and installed result", () => {
  const result = computerUserState({ ...base, currentBuild: "new", liveness: { state: "unreachable", lastVerifiedAt: now - 10_000 }, runtime: { state: "unreachable", versionCheckError: "timeout" } });
  assert.equal(result.title, "Available");
  assert.equal(result.complete, true);
});
test("old completion cannot assert online or become update failed", () => {
  const result = computerUserState({ ...base, currentBuild: "new", liveness: { state: "unreachable", lastVerifiedAt: 1 } });
  assert.equal(result.title, "Connection not confirmed");
  assert.equal(result.complete, true);
  assert.equal(result.failed, false);
  assert.match(result.description, /does not undo that result/);
});
test("repair failure never promises working conversations just because transport is online", () => {
  assert.equal(computerUserState({ ...base, runtime: runtime("repair_required") }).availability, "Needs repair");
});
test("client disconnection is not blamed on the computer", () => {
  const result = computerUserState({ ...base, connected: false });
  assert.equal(result.availability, "Client disconnected");
  assert.equal(result.showUpdate, false);
});
test("version handoff and repair override the installed build", () => {
  const current = { ...base, currentBuild: "new" };
  assert.equal(computerUserState({ ...current, action: "select_version" }).availability, "Temporarily unavailable");
  assert.equal(computerUserState({ ...current, runtime: { state: "online", status: { version: 1, updatedAt: now, currentBuildId: "new", phase: "repair_required" } } }).availability, "Needs repair");
});
test("an older staged update cannot be presented as the newly published version ready to install", () => {
  const result = computerUserState({ ...base, runtime: { state: "online", status: { version: 1, updatedAt: now, phase: "staged", currentBuildId: "old", targetBuildId: "previous-target" } } });
  assert.equal(result.ready, false);
  assert.equal(result.notice, "Update available");
});
