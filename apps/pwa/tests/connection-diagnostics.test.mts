import assert from "node:assert/strict";
import test from "node:test";
import { createConnectionDiagnostics } from "../app/connectionDiagnostics.ts";

test("exports bounded connection diagnostics without unstructured errors or credentials", () => {
  const nativeRuntime = {
    runtimeVersion: "native-1",
    runtimeBuild: "native-build-1",
    secret: "native-secret",
  };
  const report = createConnectionDiagnostics({
    buildVersion: "build-1",
    status: "error",
    detail: "https://matrix.example/_matrix?access_token=secret-token",
    deviceKeyId: "device-key-1",
    nativeRuntime,
    gateways: [{
      gatewayNodeId: "gateway-node-1",
      gatewayName: "Office Gateway",
      computerName: "alice-macbook",
      buildId: "gateway-2026.08.27.1-arm64",
    }],
    online: true,
    visibility: "visible",
    userAgent: "test-browser",
  }, 0);
  const parsed = JSON.parse(report);

  assert.equal(parsed.connection.detailCode, null);
  assert.equal(parsed.connection.hasUnstructuredDetail, true);
  assert.equal(parsed.device.keyId, "device-key-1");
  assert.deepEqual(parsed.gateways, [{
    nodeId: "gateway-node-1",
    name: "Office Gateway",
    computerName: "alice-macbook",
    buildId: "gateway-2026.08.27.1-arm64",
  }]);
  assert.equal(report.includes("secret-token"), false);
  assert.equal(report.includes("access_token"), false);
  assert.equal(report.includes("native-secret"), false);
});

test("marks missing Gateway versions explicitly", () => {
  const report = JSON.parse(createConnectionDiagnostics({
    buildVersion: "build-1",
    status: "connected",
    gateways: [{
      gatewayNodeId: "gateway-node-legacy",
      gatewayName: "Legacy Gateway",
    }],
    online: true,
    visibility: "visible",
    userAgent: "test-browser",
  }, 0));

  assert.equal(report.gateways[0].buildId, null);
  assert.equal(report.gateways[0].computerName, null);
});

test("retains a safe recovery code for support", () => {
  const report = JSON.parse(createConnectionDiagnostics({
    buildVersion: "build-1",
    status: "error",
    detail: "matrix_project_authorization_repair_required",
    online: true,
    visibility: "visible",
    userAgent: "test-browser",
  }, 0));

  assert.equal(
    report.connection.detailCode,
    "matrix_project_authorization_repair_required",
  );
});

test("retains the MLP3 recovery stage without exporting an underlying error", () => {
  const report = JSON.parse(createConnectionDiagnostics({
    buildVersion: "build-1",
    status: "error",
    detail: "matrix_gateway_state_recovery_failed",
    online: true,
    visibility: "visible",
    userAgent: "test-browser",
  }, 0));

  assert.equal(
    report.connection.detailCode,
    "matrix_gateway_state_recovery_failed",
  );
  assert.equal(report.connection.hasUnstructuredDetail, false);
});
