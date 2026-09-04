import assert from "node:assert/strict";
import test from "node:test";
import {
  GENERIC_ERROR_DETAIL,
  formatDeviceInvitationSignInFailure,
  formatPairingFailure,
  formatUserFacingError,
  isCommandRecoveryPendingError,
} from "../app/userFacingError.ts";

test("turns native RPC and network failures into calm product copy", () => {
  assert.equal(
    formatUserFacingError(
      new Error(
        "The native bridge did not answer malink.history.page in time.",
      ),
    ),
    "The connected device did not respond in time.",
  );
  assert.equal(
    formatUserFacingError(new TypeError("Failed to fetch")),
    "The network request did not complete.",
  );
  assert.equal(
    formatUserFacingError(new Error("Request timeout after 30000ms")),
    "The operation took too long.",
  );
  assert.equal(
    formatUserFacingError(new Error("HTTP 429: Too Many Requests")),
    "Too many requests. Wait a moment and try again.",
  );
  assert.equal(
    formatUserFacingError(
      new Error(
        "Command 8b9f21b8-760d-46af-bccc-414972433d38 must be acknowledged, recovered, or discarded first.",
      ),
    ),
    "Malink is restoring your previous action. Try again in a moment.",
  );
  assert.equal(
    isCommandRecoveryPendingError(
      new Error(
        "Command 8b9f21b8-760d-46af-bccc-414972433d38 must be acknowledged, recovered, or discarded first.",
      ),
    ),
    true,
  );
  assert.equal(isCommandRecoveryPendingError(new Error("Gateway offline.")), false);
});

test("keeps the failed pairing stage and recovery action visible", () => {
  assert.equal(
    formatPairingFailure(
      new Error("Request timeout after 30000ms"),
      "Mac Studio",
    ),
    "Mac Studio did not finish the secure connection in time. The pending request is kept for safe recovery; check that the computer is online and retry.",
  );
  assert.equal(
    formatPairingFailure(
      new Error("The pairing request expired before its signed response arrived."),
      "Mac Studio",
    ),
    "Mac Studio did not return the device authorization before the invitation expired. Make sure Malink Gateway is running on that computer, then create a new invitation.",
  );
  assert.match(
    formatPairingFailure(
      new Error("The computer approved this device, but its conversation authorization did not arrive."),
      "Mac Studio",
    ),
    /approved this device, but the Workspace did not finish syncing/,
  );
});

test("hides machine details while preserving short actionable copy", () => {
  assert.equal(
    formatUserFacingError(new Error("matrix_runtime_failed")),
    GENERIC_ERROR_DETAIL,
  );
  assert.equal(
    formatUserFacingError(new Error("Connect to https://internal.invalid")),
    GENERIC_ERROR_DETAIL,
  );
  assert.equal(
    formatUserFacingError(new TypeError("Cannot read properties of undefined")),
    GENERIC_ERROR_DETAIL,
  );
  assert.equal(
    formatUserFacingError(new Error("Choose a project before continuing.")),
    "Choose a project before continuing.",
  );
  assert.equal(formatUserFacingError({ reason: "secret" }), GENERIC_ERROR_DETAIL);
});

test("normalizes and bounds user-facing details", () => {
  assert.equal(
    formatUserFacingError("  The session\n could not be opened.  "),
    "The session could not be opened.",
  );
  assert.equal(formatUserFacingError("x".repeat(300)).length, 180);
});

test("keeps an authorization file reusable when Android startup fails locally", () => {
  assert.equal(
    formatDeviceInvitationSignInFailure(
      Object.assign(
        new Error("The persistent native runtime is not active."),
        { data: { userAction: "open_app" } },
      ),
    ),
    "The one-time sign-in was not submitted: The persistent native runtime is not active. Complete the Android requirement, then open this same authorization file again.",
  );
});

test("does not promise token reuse after an ambiguous sign-in failure", () => {
  assert.equal(
    formatDeviceInvitationSignInFailure(
      new Error("Matrix sign-in was not accepted."),
    ),
    "The one-time sign-in could not be completed: Matrix sign-in was not accepted. Open this authorization file again to retry. Create a new invitation only if Malink says this one expired or was already used.",
  );
});
