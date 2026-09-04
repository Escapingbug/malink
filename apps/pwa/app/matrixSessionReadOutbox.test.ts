import { describe, expect, it } from "vitest";
import {
  MATRIX_SESSION_READ_OUTBOX_STORAGE_KEY,
  MatrixSessionReadReceiptOutbox,
} from "./matrixSessionReadOutbox";

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

const target = (overrides: Partial<{
  roomId: string;
  projectId: string;
  sessionId: string;
  threadRootEventId: string;
  eventId: string;
  stateVersion: number;
  readUpdatedAt: number;
}> = {}) => ({
  roomId: "!project:example.org",
  projectId: "project-a",
  sessionId: "session-a",
  threadRootEventId: "$root-a",
  eventId: "$event-a",
  stateVersion: 4,
  readUpdatedAt: 100,
  ...overrides,
});

describe("MatrixSessionReadReceiptOutbox", () => {
  it("restores the exact verified receipt target after a reconnect", () => {
    const storage = new MemoryStorage();
    new MatrixSessionReadReceiptOutbox(storage, "scope-a").enqueue(target(), 200);

    expect(new MatrixSessionReadReceiptOutbox(storage, "scope-a").pending()).toEqual([{
      scope: "scope-a",
      queuedAt: 200,
      ...target(),
    }]);
  });

  it("coalesces a session thread to its newest verified projection", () => {
    const storage = new MemoryStorage();
    const outbox = new MatrixSessionReadReceiptOutbox(storage, "scope-a");
    outbox.enqueue(target(), 200);
    outbox.enqueue(target({
      eventId: "$event-b",
      stateVersion: 5,
      readUpdatedAt: 110,
    }), 210);
    outbox.enqueue(target({
      eventId: "$stale-event",
      stateVersion: 3,
      readUpdatedAt: 90,
    }), 220);

    expect(outbox.pending()).toMatchObject([{
      eventId: "$event-b",
      stateVersion: 5,
      readUpdatedAt: 110,
    }]);
  });

  it("does not let an older in-flight acknowledgement erase a newer target", () => {
    const storage = new MemoryStorage();
    const outbox = new MatrixSessionReadReceiptOutbox(storage, "scope-a");
    const older = outbox.enqueue(target(), 200);
    outbox.enqueue(target({ eventId: "$event-b", stateVersion: 5 }), 210);

    outbox.acknowledge(older);

    expect(outbox.pending()).toMatchObject([{ eventId: "$event-b" }]);
    expect(storage.getItem(MATRIX_SESSION_READ_OUTBOX_STORAGE_KEY)).not.toBeNull();
  });

  it("rejects a thread root because Matrix treats it as a main-timeline event", () => {
    const outbox = new MatrixSessionReadReceiptOutbox(new MemoryStorage(), "scope-a");

    expect(() => outbox.enqueue(target({ eventId: "$root-a" }), 200))
      .toThrow("receipt target is invalid");
  });

  it("keeps other connection scopes and removes only the delivered target", () => {
    const storage = new MemoryStorage();
    const first = new MatrixSessionReadReceiptOutbox(storage, "scope-a");
    const delivered = first.enqueue(target(), 200);
    new MatrixSessionReadReceiptOutbox(storage, "scope-b").enqueue(
      target({ roomId: "!other:example.org" }),
      210,
    );

    first.acknowledge(delivered);

    expect(first.pending()).toEqual([]);
    expect(new MatrixSessionReadReceiptOutbox(storage, "scope-b").pending())
      .toHaveLength(1);
  });
});
