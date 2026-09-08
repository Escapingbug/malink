import assert from "node:assert/strict";
import test from "node:test";
import { MatrixStartupLifetime } from "../app/matrixStartupLifetime.ts";
import { waitForInitialSync } from "../app/matrix.ts";
import { formatPairingFailure } from "../app/userFacingError.ts";

test("stop retains ownership until late crypto initialization settles and prevents restart", async () => {
  const lifetime = new MatrixStartupLifetime();
  let finish!: () => void;
  const pending = lifetime.run(() => new Promise<void>(resolve => { finish = resolve; }));
  const rejected = assert.rejects(pending, { name: "AbortError" });
  await Promise.resolve();
  let closed = false;
  const stop = lifetime.stop().then(() => { closed = true; });
  await Promise.resolve();
  assert.equal(closed, false);
  finish();
  await stop;
  await rejected;
  let restarted = false;
  await assert.rejects(lifetime.run(async () => { restarted = true; }), { name: "AbortError" });
  assert.equal(restarted, false);
});

test("stopping before queued startup executes does not create a crypto machine", async () => {
  const lifetime = new MatrixStartupLifetime();
  let initialized = false;
  const operation = lifetime.run(async () => { initialized = true; });
  const rejected = assert.rejects(operation, { name: "AbortError" });
  await lifetime.stop();
  await rejected;
  assert.equal(initialized, false);
});

test("initial sync cancellation removes listeners and timers immediately", async () => {
  const previous = globalThis.window;
  const timers = new Set<() => void>();
  globalThis.window = {
    setTimeout(callback: () => void) { timers.add(callback); return callback; },
    clearTimeout(callback: () => void) { timers.delete(callback); },
  } as unknown as Window & typeof globalThis;
  try {
    for (const outcome of ["STOPPED", "abort", "PREPARED", "ERROR", "timeout"]) {
      const listeners = new Set<(state: string) => void>();
      const controller = new AbortController();
      const client = {
        getSyncState: () => null,
        on(_event: string, listener: (state: string) => void) { listeners.add(listener); },
        off(_event: string, listener: (state: string) => void) { listeners.delete(listener); },
      } as unknown as Parameters<typeof waitForInitialSync>[0];
      const pending = waitForInitialSync(client, "sync", 30_000, controller.signal);
      const checked = outcome === "PREPARED" ? pending : assert.rejects(pending,
        outcome === "abort" || outcome === "STOPPED" ? { name: "AbortError" } : /Matrix/);
      if (outcome === "abort") controller.abort();
      else if (outcome === "timeout") for (const timer of timers) timer();
      else for (const listener of listeners) listener(outcome);
      await checked;
      assert.equal(listeners.size, 0);
      assert.equal(timers.size, 0);
    }
  } finally {
    globalThis.window = previous;
  }
});

test("first sync timeout identifies this browser rather than blaming Gateway", () => {
  const message = formatPairingFailure(new Error("Timed out waiting for the first Matrix sync."), "Mac Gateway");
  assert.match(message, /This browser did not finish synchronizing/);
  assert.match(message, /sign-in is saved/);
  assert.doesNotMatch(message, /Mac Gateway did not finish/);
});
