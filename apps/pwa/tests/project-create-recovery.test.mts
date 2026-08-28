import assert from "node:assert/strict";
import test from "node:test";
import {
  bindOptimisticProjectCreate,
  clearOptimisticProjectCreate,
  completedProjectId,
  createOptimisticProjectCreate,
  failOptimisticProjectCreate,
  markOptimisticProjectCreateUncertain,
  optimisticProjectMatchesProjection,
  projectCreateRecoveryMatches,
  readOptimisticProjectCreate,
  rebindOptimisticProjectCreate,
  retryOptimisticProjectCreate,
  syncOptimisticProjectCreate,
  writeOptimisticProjectCreate,
} from "../app/projectCreateRecovery.ts";

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
  gatewayNodeId: "gateway-a",
  targetProjectId: "bootstrap-project",
  name: "Malink",
  cwd: "/workspace/malink/",
  provider: "codex",
  createDirectory: true,
};

const binding = {
  gatewayId: "workspace-a",
  conversationId: "bootstrap-room",
};

test("persists the project placeholder through command and projection phases", () => {
  const storage = new MemoryStorage();
  const submitting = createOptimisticProjectCreate(
    input,
    binding,
    "Office Gateway",
    "local-project:1",
    100,
  );
  const creating = bindOptimisticProjectCreate(submitting, "command-1", 200);
  const syncing = syncOptimisticProjectCreate(creating, "project-1", 300);

  writeOptimisticProjectCreate(storage, syncing);
  assert.deepEqual(readOptimisticProjectCreate(storage, binding), syncing);
  assert.equal(
    optimisticProjectMatchesProjection(syncing, [{
      projectId: "project-1",
      projectName: "Malink",
      cwd: "/workspace/malink",
    }]),
    true,
  );
  assert.equal(clearOptimisticProjectCreate(storage, "another-local-id"), false);
  assert.equal(clearOptimisticProjectCreate(storage, syncing.localId), true);
  assert.equal(readOptimisticProjectCreate(storage), null);
});

test("recovers the same durable command without creating a duplicate", () => {
  const creating = bindOptimisticProjectCreate(
    createOptimisticProjectCreate(
      input,
      binding,
      "Office Gateway",
      "local-project:1",
      100,
    ),
    "old-command",
    200,
  );
  const rebound = rebindOptimisticProjectCreate(
    creating,
    "old-command",
    "current-command",
    300,
  );

  assert.equal(rebound?.commandId, "current-command");
  assert.equal(rebound?.phase, "creating");
  assert.equal(
    rebindOptimisticProjectCreate(creating, "wrong-command", "new-command"),
    null,
  );
  const uncertain = markOptimisticProjectCreateUncertain(
    rebound!,
    "Still waiting",
    400,
  );
  assert.equal(uncertain.commandId, "current-command");
  assert.equal(uncertain.phase, "uncertain");
});

test("keeps failed input retryable while clearing the previous command identity", () => {
  const creating = bindOptimisticProjectCreate(
    createOptimisticProjectCreate(
      input,
      binding,
      "Office Gateway",
      "local-project:1",
      100,
    ),
    "command-1",
    200,
  );
  const failed = failOptimisticProjectCreate(creating, "Permission denied", 300);
  const retrying = retryOptimisticProjectCreate(failed, 400);

  assert.equal(failed.phase, "failed");
  assert.equal(failed.commandId, undefined);
  assert.deepEqual(failed.input, input);
  assert.equal(retrying.phase, "submitting");
  assert.equal(retrying.error, undefined);
  assert.equal(retrying.commandId, undefined);
});

test("extracts the authoritative project identity from a successful completion", () => {
  assert.equal(completedProjectId({
    commandId: "command-1",
    sequence: 1,
    revision: 1,
    outcome: "succeeded",
    result: { projectId: "project-1", roomId: "!room:example.org" },
  }), "project-1");
  assert.equal(completedProjectId({
    commandId: "command-2",
    sequence: 1,
    revision: 1,
    outcome: "failed",
  }), null);
});

test("scopes recovery to the Matrix Gateway binding that accepted the command", () => {
  const record = createOptimisticProjectCreate(
    input,
    binding,
    "Office Gateway",
    "local-project:binding",
    100,
  );

  assert.equal(projectCreateRecoveryMatches(record, binding), true);
  assert.equal(projectCreateRecoveryMatches(record, {
    gatewayId: "another-workspace",
    conversationId: binding.conversationId,
  }), false);
  assert.equal(projectCreateRecoveryMatches(record, {
    gatewayId: binding.gatewayId,
    conversationId: "another-room",
  }), false);
});

test("rejects a persisted record whose creating phase has no command ID", () => {
  const storage = new MemoryStorage();
  storage.setItem("malink:optimistic-project-create:v1", JSON.stringify({
    ...createOptimisticProjectCreate(
      input,
      binding,
      "Office Gateway",
      "local-project:1",
      100,
    ),
    phase: "creating",
  }));
  assert.equal(readOptimisticProjectCreate(storage, binding), null);
});
