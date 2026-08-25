import assert from "node:assert/strict";
import test from "node:test";
import {
  MATRIX_CONFIG_PROFILES_STORAGE_KEY,
  MATRIX_CONFIG_STORAGE_KEY,
  clearMatrixConfig,
  loadMatrixConfig,
  saveMatrixConfig,
  selectMatrixConfigGateway,
  type MatrixConnectionConfig,
} from "../app/matrix.ts";
import {
  PAIRING_TRUST_PROFILES_STORAGE_KEY,
  PAIRING_TRUST_STORAGE_KEY,
  activeTrustedGatewayId,
  clearTrustedGateway,
  saveTrustedGateway,
  selectTrustedGateway,
  type TrustedGateway,
} from "../app/pairing.ts";

class MemoryStorage implements Storage {
  readonly values = new Map<string, string>();
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

function config(gatewayId: string): MatrixConnectionConfig {
  return {
    homeserver: `https://${gatewayId}.example`, userId: `@device:${gatewayId}.example`,
    accessToken: `token-${gatewayId}`, matrixDeviceId: `matrix-device-${gatewayId}`,
    roomId: `!room-${gatewayId}:example`, gatewayId,
    conversationId: `conversation-${gatewayId}`,
    gatewayMatrixUserId: `@gateway:${gatewayId}.example`,
    gatewayMatrixDeviceId: `gateway-device-${gatewayId}`,
    gatewayMatrixEd25519: `ed25519-${gatewayId}`,
  };
}

function trust(gatewayId: string): TrustedGateway {
  return { gatewayId, gatewayName: gatewayId } as TrustedGateway;
}

test("legacy active connection migrates and additional Gateways remain isolated", () => {
  const storage = new MemoryStorage();
  Object.assign(globalThis, { localStorage: storage });
  storage.setItem(MATRIX_CONFIG_STORAGE_KEY, JSON.stringify(config("one")));
  assert.equal(loadMatrixConfig()?.gatewayId, "one");
  saveMatrixConfig(config("two"));
  assert.equal(loadMatrixConfig()?.gatewayId, "two");
  assert.equal(loadMatrixConfig("one")?.accessToken, "token-one");
  assert.equal(selectMatrixConfigGateway("one").gatewayId, "one");
  clearMatrixConfig("one");
  assert.equal(loadMatrixConfig("one"), null);
  assert.equal(loadMatrixConfig()?.gatewayId, "two");
  const registry = JSON.parse(storage.getItem(MATRIX_CONFIG_PROFILES_STORAGE_KEY)!);
  assert.deepEqual(Object.keys(registry.configs), ["two"]);
});

test("Gateway trust selects and removes one profile without deleting others", () => {
  const storage = new MemoryStorage();
  Object.assign(globalThis, { localStorage: storage });
  storage.setItem(PAIRING_TRUST_STORAGE_KEY, JSON.stringify(trust("one")));
  assert.equal(activeTrustedGatewayId(), "one");
  saveTrustedGateway(trust("two"));
  selectTrustedGateway("one");
  assert.equal(activeTrustedGatewayId(), "one");
  clearTrustedGateway("one");
  assert.equal(activeTrustedGatewayId(), "two");
  const registry = JSON.parse(storage.getItem(PAIRING_TRUST_PROFILES_STORAGE_KEY)!);
  assert.deepEqual(Object.keys(registry.gateways), ["two"]);
});
