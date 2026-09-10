import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import * as sdk from "matrix-js-sdk";
import { createManagedMatrixClient, waitForRecoverableMatrixSync } from "../app/matrixSyncLifecycle";
import { matrixSyncDatabaseName, resolveMatrixSyncDatabaseName, flushAndReleaseMatrixSyncStore } from "../app/matrixSyncStore";
import { shouldReloadInterruptedMatrixStartup } from "../app/matrixStartup";

const config = { homeserver: "https://matrix.example", userId: "@alice:example", matrixDeviceId: "PWA-A", roomId: "!room-a:example" };
const memory = () => {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
};

test("adopts an existing cache without copying keys and reuses it after repeated updates", async () => {
  const storage = memory();
  const previous = await resolveMatrixSyncDatabaseName(config, storage, async name => name.startsWith("malink-matrix-sync-v1-"));
  assert.match(previous, /sync-v1-/);
  for (const roomId of ["!room-b:example", "!room-c:example", "!room-d:example"]) {
    assert.equal(await resolveMatrixSyncDatabaseName({ ...config, roomId }, storage, async () => false), previous);
  }
  const otherDevice = { ...config, matrixDeviceId: "PWA-B" };
  assert.equal(await resolveMatrixSyncDatabaseName(otherDevice, storage, async () => false), await matrixSyncDatabaseName(otherDevice));
});

test("a fresh account cache survives room switches and does not adopt a later stale legacy cache", async () => {
  const storage = memory();
  const stable = await resolveMatrixSyncDatabaseName(config, storage, async () => false);
  assert.equal(await resolveMatrixSyncDatabaseName({ ...config, roomId: "!new:example" }, storage, async () => true), stable);
});

class Sync extends EventEmitter {
  getSyncState() { return null; }
}

test("a slow sync remains alive across warning, network failure and recovery", async () => {
  const sync = new Sync();
  const controller = new AbortController();
  const messages: string[] = [];
  let ready = false;
  const pending = waitForRecoverableMatrixSync(sync, "sync", controller.signal, detail => messages.push(detail), 1).then(() => { ready = true; });
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(ready, false);
  assert.match(messages[0], /Keeping the connection open/);
  sync.emit("sync", "ERROR", null, { error: { errcode: "M_UNKNOWN" } });
  assert.equal(sync.listenerCount("sync"), 1);
  sync.emit("sync", "SYNCING");
  await pending;
  assert.equal(ready, true);
  assert.equal(sync.listenerCount("sync"), 0);
});

test("invalid authorization fails rather than waiting forever", async () => {
  const sync = new Sync();
  const pending = waitForRecoverableMatrixSync(sync, "sync", new AbortController().signal, () => {});
  sync.emit("sync", "ERROR", null, { error: { errcode: "M_UNKNOWN_TOKEN" } });
  await assert.rejects(pending, /authorization failed/);
  assert.equal(sync.listenerCount("sync"), 0);
});

test("explicit cancellation clears waiters", async () => {
  const sync = new Sync();
  const controller = new AbortController();
  const pending = waitForRecoverableMatrixSync(sync, "sync", controller.signal, () => {});
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(sync.listenerCount("sync"), 0);
});

test("slow foreground or resumed transport does not reload the page", () => {
  for (const hiddenAt of [null, 5_000]) {
    assert.equal(shouldReloadInterruptedMatrixStartup({ phase: "connecting", startedAt: 0, hiddenAt, now: 300_000, visible: true }), false);
  }
});

test("the real SDK adapter waits for in-flight work even when STOPPED is never emitted", async () => {
  const client = createManagedMatrixClient(sdk, { baseUrl: config.homeserver });
  let finish!: () => void;
  const events: string[] = [];
  const loop = new Promise<void>(resolve => { finish = resolve; });
  // Exercise the same protected-slot assignment and sync call used by SDK startClient.
  const transport = { getSyncState: () => null, sync: () => loop, stop: () => { events.push("stop-transport"); } };
  Object.assign(client, { syncApi: transport, cryptoBackend: { stop: () => { events.push("stop-crypto"); } } });
  void transport.sync();
  const closing = client.stopAfterSync();
  await Promise.resolve();
  assert.deepEqual(events, ["stop-transport"]);
  finish();
  await closing;
  assert.deepEqual(events, ["stop-transport", "stop-crypto"]);
});

test("a failed transport drain does not release encryption ownership", async () => {
  let released = false;
  await assert.rejects(flushAndReleaseMatrixSyncStore("failed-drain", { async save() {}, async destroy() {} }, { async release() { released = true; } }, async () => { throw new Error("drain failed"); }), /drain failed/);
  assert.equal(released, false);
});

test("cached PREPARED waits for the new Gateway room to arrive", async () => {
  const sync = new Sync();
  let hasTargetRoom = false;
  let ready = false;
  const pending = waitForRecoverableMatrixSync(sync, "sync", new AbortController().signal, () => {}, 30_000, () => hasTargetRoom).then(() => { ready = true; });
  sync.emit("sync", "PREPARED", null, { fromCache: true });
  await Promise.resolve();
  assert.equal(ready, false);
  hasTargetRoom = true;
  sync.emit("sync", "SYNCING");
  await pending;
  assert.equal(ready, true);
});

test("real SDK startup drains an aborted request before cleanup", { timeout: 5000 }, async context => {
  // SDK HTTP timeout signals retain timers after successful/aborted fetches.
  context.mock.timers.enable({ apis: ["setTimeout"] });
  let requested!: () => void;
  const syncRequested = new Promise<void>(resolve => { requested = resolve; });
  let aborted = false;
  const client = createManagedMatrixClient(sdk, {
    baseUrl: config.homeserver, userId: config.userId, deviceId: config.matrixDeviceId,
    store: new sdk.MemoryStore(),
    fetchFn: async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/sync")) {
        requested();
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => { aborted = true; reject(new DOMException("Aborted", "AbortError")); }, { once: true });
        });
      }
      const data = path.endsWith("/versions") ? { versions: ["v1.11"], unstable_features: {} }
        : path.endsWith("/filter") ? { filter_id: "1" }
        : path.endsWith("/pushrules/") || path.endsWith("/pushrules") ? { global: {} }
        : path.endsWith("/capabilities") ? { capabilities: {} } : {};
      return new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });
  try {
    await client.startClient({ initialSyncLimit: 1, lazyLoadMembers: true });
    await syncRequested;
    await client.stopAfterSync();
    assert.equal(aborted, true);
  } finally {
    await client.stopAfterSync();
  }
});

test("a live sync confirms a missing project instead of waiting indefinitely", async () => {
  const sync = new Sync();
  const pending = waitForRecoverableMatrixSync(sync, "sync", new AbortController().signal, () => {}, 30_000, () => false);
  sync.emit("sync", "PREPARED", null, { fromCache: true });
  sync.emit("sync", "SYNCING", null, { fromCache: false });
  await assert.rejects(pending, /room is unavailable after syncing/);
  assert.equal(sync.listenerCount("sync"), 0);
});

test("lazy member loading keeps other projects and new invitations in the real SDK sync", { timeout: 5000 }, async context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  let filter: { room?: { rooms?: string[]; state?: { lazy_load_members?: boolean }; timeline?: { limit?: number } } } | undefined;
  const joined = () => ({ state: { events: [] }, timeline: { events: [], limited: false }, ephemeral: { events: [] }, account_data: { events: [] } });
  const client = createManagedMatrixClient(sdk, {
    baseUrl: config.homeserver, userId: config.userId, deviceId: config.matrixDeviceId, store: new sdk.MemoryStore(),
    fetchFn: async (input, init) => {
      const url = new URL(String(input));
      const path = url.pathname;
      let data: unknown = {};
      if (path.endsWith("/sync")) {
        if (calls++ > 0) return new Promise<Response>((_resolve, reject) => {
          const abort = () => reject(new DOMException("Aborted", "AbortError"));
          if (init?.signal?.aborted) abort();
          else init?.signal?.addEventListener("abort", abort, { once: true });
        });
        filter = JSON.parse(url.searchParams.get("filter")!);
        data = { next_batch: "test-next", rooms: {
          join: { [config.roomId]: joined(), "!other-project:example": joined() },
          invite: { "!new-invitation:example": { invite_state: { events: [{
            type: "m.room.member", state_key: config.userId, sender: "@gateway:example", content: { membership: "invite" },
          }] } } },
        } };
      } else if (path.endsWith("/versions")) data = { versions: ["v1.11"], unstable_features: {} };
      else if (path.endsWith("/filter")) data = { filter_id: "1" };
      else if (path.endsWith("/pushrules/")) data = { global: {} };
      else if (path.endsWith("/capabilities")) data = { capabilities: {} };
      return new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });
  try {
    await client.startClient({ initialSyncLimit: 1, lazyLoadMembers: true });
    await waitForRecoverableMatrixSync(client, sdk.ClientEvent.Sync, new AbortController().signal, () => {}, 30_000, () => Boolean(client.getRoom(config.roomId)));
    assert.ok(client.getRoom("!other-project:example"));
    assert.equal(client.getRoom("!new-invitation:example")?.getMyMembership(), "invite");
    assert.equal(filter?.room?.state?.lazy_load_members, true);
    assert.equal(filter?.room?.timeline?.limit, 1);
    assert.equal(filter?.room?.rooms, undefined);
  } finally {
    await client.stopAfterSync();
  }
});
