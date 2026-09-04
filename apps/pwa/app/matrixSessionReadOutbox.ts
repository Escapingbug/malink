export const MATRIX_SESSION_READ_OUTBOX_STORAGE_KEY =
  "malink.matrix-session-read-outbox.v1";

const MAX_PENDING_RECEIPTS = 1_000;

type StorageLike = Pick<Storage, "getItem" | "setItem"> &
  Partial<Pick<Storage, "removeItem">>;

export type PendingMatrixSessionReadReceipt = {
  scope: string;
  roomId: string;
  projectId: string;
  sessionId: string;
  threadRootEventId: string;
  eventId: string;
  stateVersion: number;
  readUpdatedAt: number;
  queuedAt: number;
};

type PersistedMatrixSessionReadOutbox = {
  version: 1;
  receipts: PendingMatrixSessionReadReceipt[];
};

/**
 * Durable browser retry state for Matrix private threaded receipts.
 *
 * Every entry retains the exact physical event already authenticated by MLP/3.
 * A reconnect therefore cannot turn an old local "read" action into a receipt
 * for a newer Agent projection that the user has not viewed.
 */
export class MatrixSessionReadReceiptOutbox {
  readonly #records = new Map<string, PendingMatrixSessionReadReceipt>();
  #persistenceDirty = false;

  constructor(
    private readonly storage: StorageLike | null | undefined,
    private readonly scope: string,
  ) {
    if (!scope) throw new Error("A Matrix session read outbox scope is required.");
    for (const receipt of readPersistedReceipts(storage).receipts) {
      this.#records.set(receiptKey(receipt), receipt);
    }
  }

  pending(): PendingMatrixSessionReadReceipt[] {
    return [...this.#records.values()]
      .filter(receipt => receipt.scope === this.scope)
      .sort((left, right) =>
        left.queuedAt - right.queuedAt
        || left.projectId.localeCompare(right.projectId)
        || left.sessionId.localeCompare(right.sessionId));
  }

  enqueue(
    input: Omit<PendingMatrixSessionReadReceipt, "scope" | "queuedAt">,
    queuedAt = Date.now(),
  ): PendingMatrixSessionReadReceipt {
    this.#reloadPersistedRecords();
    const receipt: PendingMatrixSessionReadReceipt = {
      ...input,
      scope: this.scope,
      queuedAt,
    };
    if (!isPendingReceipt(receipt)) {
      throw new Error("The Matrix session read receipt target is invalid.");
    }
    const key = receiptKey(receipt);
    const current = this.#records.get(key);
    if (current && compareProjection(current, receipt) > 0) return current;
    this.#records.set(key, receipt);
    this.#persist();
    return receipt;
  }

  acknowledge(receipt: PendingMatrixSessionReadReceipt): void {
    this.#reloadPersistedRecords();
    const key = receiptKey(receipt);
    const current = this.#records.get(key);
    if (
      !current
      || current.eventId !== receipt.eventId
      || current.stateVersion !== receipt.stateVersion
    ) return;
    this.#records.delete(key);
    this.#persist();
  }

  #reloadPersistedRecords(): void {
    if (this.#persistenceDirty) return;
    const loaded = readPersistedReceipts(this.storage);
    if (!loaded.available) return;
    this.#records.clear();
    for (const receipt of loaded.receipts) {
      this.#records.set(receiptKey(receipt), receipt);
    }
  }

  #persist(): void {
    if (!this.storage) return;
    const receipts = [...this.#records.values()]
      .sort((left, right) => right.queuedAt - left.queuedAt)
      .slice(0, MAX_PENDING_RECEIPTS);
    this.#records.clear();
    for (const receipt of receipts) this.#records.set(receiptKey(receipt), receipt);
    try {
      if (receipts.length === 0 && this.storage.removeItem) {
        this.storage.removeItem(MATRIX_SESSION_READ_OUTBOX_STORAGE_KEY);
      } else {
        this.storage.setItem(
          MATRIX_SESSION_READ_OUTBOX_STORAGE_KEY,
          JSON.stringify({ version: 1, receipts } satisfies PersistedMatrixSessionReadOutbox),
        );
      }
      this.#persistenceDirty = false;
    } catch {
      this.#persistenceDirty = true;
      // Keep the in-memory entry so this live connection can still retry. A
      // storage quota/privacy failure is surfaced only if Matrix delivery also
      // fails; the ordinary read operation can otherwise complete normally.
    }
  }
}

function readPersistedReceipts(
  storage: Pick<Storage, "getItem"> | null | undefined,
): { available: boolean; receipts: PendingMatrixSessionReadReceipt[] } {
  if (!storage) return { available: false, receipts: [] };
  try {
    const raw = storage.getItem(MATRIX_SESSION_READ_OUTBOX_STORAGE_KEY);
    if (!raw) return { available: true, receipts: [] };
    const parsed: unknown = JSON.parse(raw);
    if (!isPersistedOutbox(parsed)) return { available: true, receipts: [] };
    return {
      available: true,
      receipts: parsed.receipts.map(receipt => ({ ...receipt })),
    };
  } catch {
    return { available: false, receipts: [] };
  }
}

function receiptKey(
  receipt: Pick<
    PendingMatrixSessionReadReceipt,
    "scope" | "roomId" | "threadRootEventId"
  >,
): string {
  return `${receipt.scope}\0${receipt.roomId}\0${receipt.threadRootEventId}`;
}

function compareProjection(
  left: Pick<PendingMatrixSessionReadReceipt, "stateVersion" | "readUpdatedAt" | "queuedAt">,
  right: Pick<PendingMatrixSessionReadReceipt, "stateVersion" | "readUpdatedAt" | "queuedAt">,
): number {
  return left.stateVersion - right.stateVersion
    || left.readUpdatedAt - right.readUpdatedAt
    || left.queuedAt - right.queuedAt;
}

function isPersistedOutbox(value: unknown): value is PersistedMatrixSessionReadOutbox {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.receipts)) {
    return false;
  }
  return value.receipts.length <= MAX_PENDING_RECEIPTS
    && value.receipts.every(isPendingReceipt);
}

function isPendingReceipt(value: unknown): value is PendingMatrixSessionReadReceipt {
  if (!isRecord(value)) return false;
  return [
    value.scope,
    value.roomId,
    value.projectId,
    value.sessionId,
    value.threadRootEventId,
    value.eventId,
  ].every(text)
    && value.eventId !== value.threadRootEventId
    && integer(value.stateVersion)
    && integer(value.readUpdatedAt)
    && integer(value.queuedAt);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4_096;
}

function integer(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
