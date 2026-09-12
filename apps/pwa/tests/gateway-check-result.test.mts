import assert from "node:assert/strict";
import test from "node:test";
import { gatewayCheckFailureStillCurrent } from "../app/gatewayCheckResult";

test("old online proof cannot override the failed check", () => {
  assert.equal(gatewayCheckFailureStillCurrent({ failed: true, checkedAt: 20, lastVerifiedAt: 10 }), true);
  assert.equal(gatewayCheckFailureStillCurrent({ failed: true, checkedAt: 20, lastVerifiedAt: 20 }), true);
});
test("a newer signed reply automatically clears a stale failed check", () => {
  assert.equal(gatewayCheckFailureStillCurrent({ failed: true, checkedAt: 20, lastVerifiedAt: 21 }), false);
});
