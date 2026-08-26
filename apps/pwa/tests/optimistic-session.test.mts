import assert from "node:assert/strict";
import test from "node:test";
import {
  bindOptimisticSession,
  clearOptimisticSession,
  createOptimisticSessionRecord,
  failOptimisticSession,
  readOptimisticSession,
  retryOptimisticSession,
  writeOptimisticSession,
} from "../app/optimisticSession";

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

const input = {
  projectId: "project-1",
  cwd: "/workspace/malink",
  projectName: "Malink",
  provider: "codex",
  model: "gpt-5",
  extensions: [],
};

test("persists the optimistic identity before Gateway creation finishes", () => {
  const storage = new MemoryStorage();
  const created = createOptimisticSessionRecord(
    input,
    { gatewayId: "gateway-1", conversationId: "room-1" },
    "local-session-1",
    100,
  );
  writeOptimisticSession(storage, created);

  assert.deepEqual(
    readOptimisticSession(storage, {
      gatewayId: "gateway-1",
      conversationId: "room-1",
    }),
    created,
  );
  assert.equal(
    readOptimisticSession(storage, {
      gatewayId: "gateway-2",
      conversationId: "room-1",
    }),
    null,
  );
});

test("keeps the local identity and queued UI across bind, failure, and retry", () => {
  const created = createOptimisticSessionRecord(
    input,
    { gatewayId: "gateway-1", conversationId: "room-1" },
    "local-session-1",
    100,
  );
  const bound = bindOptimisticSession(
    created,
    "command-1",
    "remote-session-1",
    110,
  );
  assert.equal(bound.localSessionId, created.localSessionId);
  assert.equal(bound.remoteSessionId, "remote-session-1");

  const failed = failOptimisticSession(bound, "Provider unavailable", 120);
  assert.equal(failed.phase, "failed");
  assert.equal(failed.commandId, undefined);
  assert.equal(failed.remoteSessionId, undefined);

  const retried = retryOptimisticSession(failed, 130);
  assert.equal(retried.phase, "creating");
  assert.equal(retried.error, undefined);
  assert.equal(retried.localSessionId, created.localSessionId);
});

test("only clears the matching optimistic session", () => {
  const storage = new MemoryStorage();
  const record = createOptimisticSessionRecord(
    input,
    { gatewayId: "gateway-1", conversationId: "room-1" },
    "local-session-1",
  );
  writeOptimisticSession(storage, record);

  assert.equal(clearOptimisticSession(storage, "other-session"), false);
  assert.deepEqual(readOptimisticSession(storage), record);
  assert.equal(clearOptimisticSession(storage, "local-session-1"), true);
  assert.equal(readOptimisticSession(storage), null);
});
