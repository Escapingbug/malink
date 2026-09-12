import assert from "node:assert/strict";
import test from "node:test";
import { gatewayVersionChoices } from "../app/gatewayVersionChoices";

const tracks = { generation: 11, phase: "attention" as const, activeRelease: "current",
  standbyRelease: "previous", targetRelease: "prepared" };
test("forward-only repair never offers an old reader", () => {
  assert.deepEqual(gatewayVersionChoices(tracks, "forward-only"), [{ id: "prepared", label: "Retry prepared update" }]);
  assert.deepEqual(gatewayVersionChoices({ ...tracks, phase: "steady" }, "forward-only"), []);
});
test("healthy dual track offers only the retained version", () => {
  assert.deepEqual(gatewayVersionChoices({ ...tracks, phase: "steady" }),
    [{ id: "previous", label: "Use previous version" }]);
});
test("handoff cannot be changed while running", () => {
  assert.deepEqual(gatewayVersionChoices({ ...tracks, phase: "activating" }), []);
});
test("compatible recovery has explicit, distinct choices", () => {
  assert.deepEqual(gatewayVersionChoices(tracks).map(x => x.label),
    ["Use previous version", "Keep current version", "Retry prepared update"]);
});
