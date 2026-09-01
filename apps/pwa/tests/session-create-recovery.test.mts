import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  clearPendingSessionCreateRecovery,
  completedSessionCreateTarget,
  isMissingSessionCreateRecoveryCommand,
  isSessionCreateRecoveryUncertain,
  pendingSessionCreateRecoveryFromOptimistic,
  readPendingSessionCreateRecovery,
  rebindPendingSessionCreateRecovery,
  sessionCreateCompletionMatchesRecovery,
  sessionCreateFailureMessage,
  sessionCreateRecoveryMatches,
  sessionCreateRecoveryRemainingMs,
  writePendingSessionCreateRecovery,
  type PendingSessionCreateRecovery,
} from "../app/sessionCreateRecovery.ts";
import { CommandRecoveryNotFoundError } from "../app/matrix.ts";
import {
  bindOptimisticSession,
  createOptimisticSessionRecord,
} from "../app/optimisticSession.ts";

test("does not leave a pending selection when the session root arrives first", () => {
  assert.deepEqual(
    completedSessionCreateTarget("session-new", new Set(["session-new"])),
    {
      pendingSessionId: null,
      sessionToReveal: "session-new",
      skipHistoryRestore: true,
    },
  );
});

test("waits for the session root when the command result arrives first", () => {
  assert.deepEqual(
    completedSessionCreateTarget("session-new", new Set()),
    {
      pendingSessionId: "session-new",
      sessionToReveal: null,
      skipHistoryRestore: true,
    },
  );
});

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

const recovery: PendingSessionCreateRecovery = {
  version: 1,
  commandId: "command-create-1",
  gatewayId: "gateway-1",
  conversationId: "room-1",
  createdAt: 1_785_000_000_000,
  input: {
    cwd: "/workspace/malink",
    projectName: "Malink",
    model: "gpt-5",
    reasoningEffort: "high",
    extensions: [],
  },
};

test("persists the durable session-create identity across a reload", () => {
  const storage = new MemoryStorage();
  writePendingSessionCreateRecovery(storage, recovery);

  assert.deepEqual(readPendingSessionCreateRecovery(storage), recovery);
  assert.equal(
    sessionCreateRecoveryMatches(recovery, {
      gatewayId: "gateway-1",
      conversationId: "room-1",
    }),
    true,
  );
  assert.equal(
    sessionCreateRecoveryMatches(recovery, {
      gatewayId: "gateway-2",
      conversationId: "room-1",
    }),
    false,
  );
});

test("consumes only a late terminal result for the persisted create command", () => {
  assert.equal(
    sessionCreateCompletionMatchesRecovery(recovery, {
      commandId: recovery.commandId,
    }),
    true,
  );
  assert.equal(
    sessionCreateCompletionMatchesRecovery(recovery, {
      commandId: "another-command",
    }),
    false,
  );
  assert.equal(
    sessionCreateCompletionMatchesRecovery(null, {
      commandId: recovery.commandId,
    }),
    false,
  );
});

test("routes a late authenticated create result into idempotent consumption", async () => {
  const app = await readFile(
    new URL("../app/MalinkApp.tsx", import.meta.url),
    "utf8",
  );
  const resultHandler = app.slice(
    app.indexOf("onCommandResult(result)"),
    app.indexOf("onHistoryRecovered(page)"),
  );
  assert.match(resultHandler, /sessionCreateCompletionMatchesRecovery\(/);
  assert.match(resultHandler, /consumeSessionCreateCompletion\(/);
  const consumer = app.slice(
    app.indexOf("async function consumeSessionCreateCompletion"),
    app.indexOf("function promoteOptimisticSession"),
  );
  assert.match(
    consumer,
    /pendingSessionCreateRecoveryRef\.current\?\.commandId !== commandId[\s\S]*?return;/,
  );
});

test("rebuilds a missing recovery marker from a bound creating draft", () => {
  const optimistic = bindOptimisticSession(
    createOptimisticSessionRecord(
      {
        projectId: "project-1",
        cwd: "/workspace/malink",
        projectName: "Malink",
        provider: "codex",
        model: "gpt-5",
        reasoningEffort: "high",
        extensions: [],
      },
      { gatewayId: "gateway-1", conversationId: "room-1" },
      "local-session-1",
      1_785_000_000_000,
    ),
    "command-create-1",
    "remote-session-1",
    1_785_000_000_100,
  );

  assert.deepEqual(pendingSessionCreateRecoveryFromOptimistic(optimistic), {
    version: 1,
    commandId: "command-create-1",
    gatewayId: "gateway-1",
    conversationId: "room-1",
    createdAt: 1_785_000_000_000,
    input: optimistic.input,
  });
  assert.equal(
    pendingSessionCreateRecoveryFromOptimistic({
      ...optimistic,
      phase: "failed",
    }),
    null,
  );
  assert.equal(
    pendingSessionCreateRecoveryFromOptimistic({
      ...optimistic,
      commandId: undefined,
    }),
    null,
  );
});

test("turns every non-success session-create completion into a readable failure", () => {
  const base = {
    commandId: "command-create-1",
    sequence: 1,
    revision: 2,
  };

  assert.equal(
    sessionCreateFailureMessage({ ...base, outcome: "succeeded" }),
    null,
  );
  assert.equal(
    sessionCreateFailureMessage({
      ...base,
      outcome: "failed",
      error: {
        code: "execution_interrupted",
        message: "The Gateway restarted after dispatch.",
        retryable: true,
      },
    }),
    "The Gateway restarted after dispatch.",
  );
  assert.equal(
    sessionCreateFailureMessage({ ...base, outcome: "failed" }),
    "Your computer could not create the session.",
  );
  assert.equal(
    sessionCreateFailureMessage({ ...base, outcome: "cancelled" }),
    "Session creation was cancelled.",
  );
});

test("only the matching command may clear a newer recovery record", () => {
  const storage = new MemoryStorage();
  writePendingSessionCreateRecovery(storage, recovery);

  assert.equal(
    clearPendingSessionCreateRecovery(storage, "older-command"),
    false,
  );
  assert.deepEqual(readPendingSessionCreateRecovery(storage), recovery);

  assert.equal(
    clearPendingSessionCreateRecovery(storage, recovery.commandId),
    true,
  );
  assert.equal(readPendingSessionCreateRecovery(storage), null);
});

test("rebinds a recovery marker to the current command after an epoch migration", () => {
  const storage = new MemoryStorage();
  writePendingSessionCreateRecovery(storage, recovery);

  assert.equal(
    rebindPendingSessionCreateRecovery(
      storage,
      "older-command",
      "current-command",
    ),
    null,
  );
  const rebound = rebindPendingSessionCreateRecovery(
    storage,
    recovery.commandId,
    "current-command",
  );

  assert.deepEqual(rebound, {
    ...recovery,
    commandId: "current-command",
  });
  assert.deepEqual(readPendingSessionCreateRecovery(storage), rebound);
});

test("rejects malformed recovery records instead of replaying them", () => {
  const storage = new MemoryStorage();
  storage.setItem(
    "malink:pending-session-create:v1",
    JSON.stringify({ ...recovery, commandId: "", input: { cwd: 7 } }),
  );

  assert.equal(readPendingSessionCreateRecovery(storage), null);
});

test("treats unavailable browser storage as no recoverable command", () => {
  const unavailable = {
    getItem(): string | null {
      throw new Error("storage unavailable");
    },
    setItem(): void {
      throw new Error("storage unavailable");
    },
    removeItem(): void {
      throw new Error("storage unavailable");
    },
  };

  assert.equal(readPendingSessionCreateRecovery(unavailable), null);
  assert.throws(
    () => writePendingSessionCreateRecovery(unavailable, recovery),
    /storage unavailable/,
  );
});

test("stops restoring a local create marker when the native command no longer exists", () => {
  assert.equal(
    isMissingSessionCreateRecoveryCommand({ errorCode: "OPERATION_NOT_FOUND" }),
    true,
  );
  assert.equal(
    isMissingSessionCreateRecoveryCommand({ errorCode: "OFFLINE" }),
    false,
  );
  assert.equal(isMissingSessionCreateRecoveryCommand(new Error("missing")), false);
});

test("stops restoring an old browser marker when its durable command no longer exists", () => {
  const error = new CommandRecoveryNotFoundError("old-command");

  assert.equal(error.errorCode, "OPERATION_NOT_FOUND");
  assert.equal(isMissingSessionCreateRecoveryCommand(error), true);
});

test("marks a durable create as uncertain only after its bounded recovery window", () => {
  assert.equal(
    isSessionCreateRecoveryUncertain(recovery, recovery.createdAt + 59_999),
    false,
  );
  assert.equal(
    isSessionCreateRecoveryUncertain(recovery, recovery.createdAt + 60_000),
    true,
  );
});

test("bounds the independent session creation watchdog delay", () => {
  assert.equal(sessionCreateRecoveryRemainingMs(recovery, recovery.createdAt), 60_000);
  assert.equal(sessionCreateRecoveryRemainingMs(recovery, recovery.createdAt + 59_999), 1);
  assert.equal(sessionCreateRecoveryRemainingMs(recovery, recovery.createdAt + 90_000), 0);
});
