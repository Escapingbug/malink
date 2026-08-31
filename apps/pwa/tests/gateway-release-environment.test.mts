import assert from "node:assert/strict";
import test from "node:test";
import { gatewayReleaseFromBuildEnvironment } from "../build/gatewayReleaseEnvironment.ts";

test("ignores the installed Gateway build ID inherited by a maintenance build", () => {
  assert.equal(gatewayReleaseFromBuildEnvironment({
    MALINK_GATEWAY_BUILD_ID: "gateway-installed-build",
  }), null);
});

test("requires a build ID when a static PWA release ID is configured", () => {
  assert.throws(
    () => gatewayReleaseFromBuildEnvironment({
      MALINK_GATEWAY_RELEASE_ID: "release-1",
    }),
    /MALINK_GATEWAY_BUILD_ID must be set/u,
  );
});

test("returns a complete static PWA Gateway release identity", () => {
  assert.deepEqual(gatewayReleaseFromBuildEnvironment({
    MALINK_GATEWAY_RELEASE_ID: "release-1",
    MALINK_GATEWAY_BUILD_ID: "gateway-release-1",
  }), {
    releaseId: "release-1",
    buildId: "gateway-release-1",
  });
});
