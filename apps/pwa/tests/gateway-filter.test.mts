import assert from "node:assert/strict";
import test from "node:test";
import {
  ALL_GATEWAYS_FILTER,
  normalizeGatewayFilter,
  projectMatchesGatewayFilter,
  readGatewayFilter,
  writeGatewayFilter,
} from "../app/gatewayFilter.ts";

class MemoryStorage {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

test("persists one Gateway filter per Workspace", () => {
  const storage = new MemoryStorage();

  writeGatewayFilter(storage, "workspace-a", "gateway-office");
  writeGatewayFilter(storage, "workspace-b", "gateway-home");

  assert.equal(readGatewayFilter(storage, "workspace-a"), "gateway-office");
  assert.equal(readGatewayFilter(storage, "workspace-b"), "gateway-home");

  writeGatewayFilter(storage, "workspace-a", ALL_GATEWAYS_FILTER);
  assert.equal(readGatewayFilter(storage, "workspace-a"), ALL_GATEWAYS_FILTER);
  assert.equal(readGatewayFilter(storage, "workspace-b"), "gateway-home");
});

test("falls back to All Gateways when a saved node is no longer available", () => {
  assert.equal(
    normalizeGatewayFilter("gateway-retired", ["gateway-office", "gateway-home"]),
    ALL_GATEWAYS_FILTER,
  );
  assert.equal(
    normalizeGatewayFilter("gateway-home", ["gateway-office", "gateway-home"]),
    "gateway-home",
  );
});

test("treats unavailable preference storage as All Gateways", () => {
  assert.equal(
    readGatewayFilter({
      getItem() {
        throw new DOMException("Storage is blocked", "SecurityError");
      },
    }, "workspace-a"),
    ALL_GATEWAYS_FILTER,
  );
});

test("filters projects and temporary sessions through their owning project route", () => {
  const owners = new Map([
    ["project-office", { gatewayNodeId: "gateway-office" }],
    ["project-home", { gatewayNodeId: "gateway-home" }],
  ]);

  assert.equal(
    projectMatchesGatewayFilter(
      "gateway-office",
      "project-office",
      owners,
      "gateway-fallback",
    ),
    true,
  );
  assert.equal(
    projectMatchesGatewayFilter(
      "gateway-office",
      "project-home",
      owners,
      "gateway-fallback",
    ),
    false,
  );
  assert.equal(
    projectMatchesGatewayFilter(
      "gateway-fallback",
      "legacy-project",
      owners,
      "gateway-fallback",
    ),
    true,
  );
  assert.equal(
    projectMatchesGatewayFilter(
      ALL_GATEWAYS_FILTER,
      "project-home",
      owners,
      "gateway-fallback",
    ),
    true,
  );
});
