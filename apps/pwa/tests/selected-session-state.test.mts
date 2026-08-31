import assert from "node:assert/strict";
import test from "node:test";
import {
  readSelectedSession,
  readSelectedSessionRoute,
  resolveSessionSelection,
  selectedSessionStorageKey,
  writeSelectedSession,
  writeSelectedSessionRoute,
} from "../app/selectedSessionState.ts";

test("persists the selected conversation independently for each Gateway scope", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
    removeItem(key: string) {
      values.delete(key);
    },
  };

  assert.equal(writeSelectedSession(storage, "gateway-a\0room-a", "session-a"), true);
  assert.equal(writeSelectedSession(storage, "gateway-b\0room-b", "session-b"), true);
  assert.equal(readSelectedSession(storage, "gateway-a\0room-a"), "session-a");
  assert.equal(readSelectedSession(storage, "gateway-b\0room-b"), "session-b");
  assert.notEqual(
    selectedSessionStorageKey("gateway-a\0room-a"),
    selectedSessionStorageKey("gateway-b\0room-b"),
  );
});

test("clears deleted selections and ignores unavailable storage", () => {
  let stored: string | null = "session-a";
  const storage = {
    getItem() {
      return stored;
    },
    setItem(_key: string, value: string) {
      stored = value;
    },
    removeItem() {
      stored = null;
    },
  };

  assert.equal(writeSelectedSession(storage, "scope", null), true);
  assert.equal(readSelectedSession(storage, "scope"), null);
  assert.equal(writeSelectedSession(undefined, "scope", "session-a"), false);
  assert.equal(readSelectedSession(undefined, "scope"), null);
});

test("storage failures and invalid persisted ids do not break startup", () => {
  const blocked = {
    getItem(): string | null {
      throw new DOMException("blocked", "SecurityError");
    },
    setItem(): void {
      throw new DOMException("blocked", "SecurityError");
    },
    removeItem(): void {
      throw new DOMException("blocked", "SecurityError");
    },
  };

  assert.equal(readSelectedSession(blocked, "scope"), null);
  assert.equal(writeSelectedSession(blocked, "scope", "session-a"), false);
  assert.equal(readSelectedSession({ getItem: () => "x".repeat(513) }, "scope"), null);
});

test("persists an exact project route while retaining the v1 session id", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };

  assert.equal(writeSelectedSessionRoute(storage, "scope", {
    projectId: "project-b",
    sessionId: "shared-update-session",
  }), true);
  assert.deepEqual(readSelectedSessionRoute(storage, "scope"), {
    projectId: "project-b",
    sessionId: "shared-update-session",
  });
  assert.equal(readSelectedSession(storage, "scope"), "shared-update-session");

  assert.equal(writeSelectedSessionRoute(storage, "scope", null), true);
  assert.equal(readSelectedSessionRoute(storage, "scope"), null);
  assert.equal(readSelectedSession(storage, "scope"), null);
});

test("upgrades a legacy scalar selection without rewriting it", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
  writeSelectedSession(storage, "scope", "legacy-session");
  assert.deepEqual(readSelectedSessionRoute(storage, "scope"), {
    sessionId: "legacy-session",
  });
});

const sessions = [
  { id: "selected", projectId: "project-a", status: "idle" },
  { id: "fallback", projectId: "project-b", status: "idle" },
] as const;

test("keeps an exact selected route without reactivating it on status refresh", () => {
  const refreshed = [
    { ...sessions[0], status: "running" },
    sessions[1],
  ] as const;
  const result = resolveSessionSelection({
    sessions: refreshed,
    selectedRoute: { sessionId: "selected", projectId: "project-a" },
  });

  assert.equal(result.session, refreshed[0]);
  assert.equal(result.source, "selected");
  assert.equal(result.shouldActivate, false);
});

test("canonicalizes a legacy id-only route with its authoritative project", () => {
  const result = resolveSessionSelection({
    sessions,
    selectedRoute: { sessionId: "selected" },
  });

  assert.equal(result.session, sessions[0]);
  assert.equal(result.source, "selected");
  assert.equal(result.shouldActivate, true);
});

test("falls back with an exact route only after the selected route disappears", () => {
  const result = resolveSessionSelection({
    sessions: [sessions[1]],
    selectedRoute: { sessionId: "selected", projectId: "project-a" },
  });

  assert.equal(result.session, sessions[1]);
  assert.equal(result.source, "fallback");
  assert.equal(result.shouldActivate, true);
});

test("preserves a selected optimistic draft while it is absent from snapshots", () => {
  assert.deepEqual(
    resolveSessionSelection({
      sessions,
      selectedRoute: { sessionId: "local-draft", projectId: "project-a" },
      localDraftSessionId: "local-draft",
    }),
    { session: null, source: "local-draft", shouldActivate: false },
  );
});

test("explicit and newly created selections still activate their exact route", () => {
  const requested = resolveSessionSelection({
    sessions,
    selectedRoute: { sessionId: "fallback", projectId: "project-b" },
    requestedSessionId: "selected",
  });
  assert.equal(requested.session, sessions[0]);
  assert.equal(requested.source, "requested");
  assert.equal(requested.shouldActivate, true);

  const created = resolveSessionSelection({
    sessions,
    selectedRoute: { sessionId: "fallback", projectId: "project-b" },
    pendingCreatedSessionId: "selected",
  });
  assert.equal(created.session, sessions[0]);
  assert.equal(created.source, "pending-created");
  assert.equal(created.shouldActivate, true);
});

test("does not treat an ambiguous id-only route as the exact selection", () => {
  const duplicated = [
    { id: "shared", projectId: "project-a", status: "idle" },
    { id: "shared", projectId: "project-b", status: "idle" },
  ] as const;
  const result = resolveSessionSelection({
    sessions: duplicated,
    selectedRoute: { sessionId: "shared" },
  });

  assert.equal(result.source, "fallback");
  assert.equal(result.session, duplicated[0]);
  assert.equal(result.shouldActivate, true);
});
