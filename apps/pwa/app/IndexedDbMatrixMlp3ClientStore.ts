import type {
  MatrixMlp3ClientStore,
  MatrixMlp3InboxRecord,
  MatrixMlp3OutboxRecord,
} from "./matrixMlp3Client";
import type { MatrixMlp3ProjectionState } from "./matrixMlp3Projection";

// Persisted identifier from the first MLP/3 release. Renaming it would orphan
// the durable inbox, outbox and projection during an application upgrade.
export const MATRIX_MLP3_DATABASE_NAME = "malink-matrix-v3";
const DATABASE_VERSION = 2;
const OUTBOX = "outbox";
const INBOX = "inbox";
const PROJECTION = "projection";

// Application-level schemas are intentionally independent from the physical
// IndexedDB version. Version 1 shipped before this database was registered in
// the PWA upgrade manifest. Bumping the read-model schema discards only state
// that Matrix can rebuild, even when a user skips several application builds.
export const MATRIX_MLP3_OUTBOX_SCHEMA_VERSION = 1;
export const MATRIX_MLP3_READ_MODEL_SCHEMA_VERSION = 4;

type OutboxRow = MatrixMlp3OutboxRecord & {
  key: string;
  scope: string;
  scopeStatus: string;
};

type InboxRow = MatrixMlp3InboxRecord & {
  key: string;
  scope: string;
  scopeStatus: string;
};

type ProjectionRow = {
  key: string;
  state: unknown;
  syncCheckpoint?: string;
};

/** Bounded raw processing inbox and independently durable command outbox. */
export class IndexedDbMatrixMlp3ClientStore implements MatrixMlp3ClientStore {
  constructor(private readonly scope: string) {
    if (!scope.trim()) throw new Error("MLP/3 IndexedDB scope is required.");
  }

  async putOutbox(record: MatrixMlp3OutboxRecord): Promise<void> {
    const database = await openDatabase();
    try {
      await put(database, OUTBOX, this.outboxRow(record));
    } finally {
      database.close();
    }
  }

  async getOutbox(commandId: string): Promise<MatrixMlp3OutboxRecord | null> {
    const database = await openDatabase();
    try {
      const row = await get<OutboxRow>(database, OUTBOX, this.key(commandId));
      return row ? stripOutboxRow(row) : null;
    } finally {
      database.close();
    }
  }

  async deleteOutbox(commandId: string): Promise<void> {
    const database = await openDatabase();
    try {
      const transaction = database.transaction(OUTBOX, "readwrite", { durability: "strict" });
      transaction.objectStore(OUTBOX).delete(this.key(commandId));
      await transactionDone(transaction);
    } finally {
      database.close();
    }
  }

  async listPendingOutbox(): Promise<MatrixMlp3OutboxRecord[]> {
    const database = await openDatabase();
    try {
      return (await readIndex<OutboxRow>(
        database,
        OUTBOX,
        "scopeStatus",
        IDBKeyRange.only(`${this.scope}\u0000pending`),
      )).map(stripOutboxRow);
    } finally {
      database.close();
    }
  }

  async putInbox(record: MatrixMlp3InboxRecord): Promise<boolean> {
    const database = await openDatabase();
    try {
      const key = this.key(record.raw.eventId);
      const transaction = database.transaction(INBOX, "readwrite", { durability: "strict" });
      const store = transaction.objectStore(INBOX);
      const existing = await request(store.getKey(key));
      if (existing !== undefined) {
        transaction.abort();
        return false;
      }
      store.add({
        ...structuredClone(record),
        key,
        scope: this.scope,
        scopeStatus: `${this.scope}\u0000${record.status}`,
      } satisfies InboxRow);
      await transactionDone(transaction);
      return true;
    } finally {
      database.close();
    }
  }

  async getInbox(eventId: string): Promise<MatrixMlp3InboxRecord | null> {
    const database = await openDatabase();
    try {
      const row = await get<InboxRow>(database, INBOX, this.key(eventId));
      return row ? stripInboxRow(row) : null;
    } finally {
      database.close();
    }
  }

  async listPendingInbox(): Promise<MatrixMlp3InboxRecord[]> {
    const database = await openDatabase();
    try {
      return (await readIndex<InboxRow>(
        database,
        INBOX,
        "scopeStatus",
        IDBKeyRange.only(`${this.scope}\u0000pending`),
      )).map(stripInboxRow);
    } finally {
      database.close();
    }
  }

  async listInbox(): Promise<MatrixMlp3InboxRecord[]> {
    const database = await openDatabase();
    try {
      return (await readIndex<InboxRow>(
        database,
        INBOX,
        "scope",
        IDBKeyRange.only(this.scope),
      )).map(stripInboxRow);
    } finally {
      database.close();
    }
  }

  async updateInbox(
    eventId: string,
    update: Pick<MatrixMlp3InboxRecord, "status" | "error">,
  ): Promise<void> {
    const database = await openDatabase();
    try {
      const key = this.key(eventId);
      const transaction = database.transaction(INBOX, "readwrite", { durability: "strict" });
      const store = transaction.objectStore(INBOX);
      const row = await request<InboxRow | undefined>(store.get(key));
      if (!row) {
        transaction.abort();
        throw new Error(`Unknown raw Matrix event ${eventId}`);
      }
      store.put({
        ...row,
        status: update.status,
        scopeStatus: `${this.scope}\u0000${update.status}`,
        ...(update.error ? { error: update.error } : { error: undefined }),
      } satisfies InboxRow);
      await transactionDone(transaction);
    } finally {
      database.close();
    }
  }

  async deleteInbox(eventId: string): Promise<void> {
    const database = await openDatabase();
    try {
      const transaction = database.transaction(
        INBOX,
        "readwrite",
        { durability: "strict" },
      );
      transaction.objectStore(INBOX).delete(this.key(eventId));
      await transactionDone(transaction);
    } finally {
      database.close();
    }
  }

  async loadProjection(): Promise<unknown | null> {
    const database = await openDatabase();
    try {
      const row = await get<ProjectionRow>(
        database,
        PROJECTION,
        this.scope,
      );
      return row ? structuredClone(row.state) : null;
    } finally {
      database.close();
    }
  }

  async saveProjection(state: MatrixMlp3ProjectionState): Promise<void> {
    const database = await openDatabase();
    try {
      const transaction = database.transaction(PROJECTION, "readwrite", { durability: "strict" });
      const store = transaction.objectStore(PROJECTION);
      const current = await request<ProjectionRow | undefined>(store.get(this.scope));
      store.put({
        ...current,
        key: this.scope,
        state: structuredClone(state),
      } satisfies ProjectionRow);
      await transactionDone(transaction);
    } finally {
      database.close();
    }
  }

  async loadSyncCheckpoint(): Promise<string | null> {
    const database = await openDatabase();
    try {
      const row = await get<ProjectionRow>(database, PROJECTION, this.scope);
      return typeof row?.syncCheckpoint === "string" ? row.syncCheckpoint : null;
    } finally {
      database.close();
    }
  }

  async saveSyncCheckpoint(token: string): Promise<void> {
    const database = await openDatabase();
    try {
      const transaction = database.transaction(PROJECTION, "readwrite", { durability: "strict" });
      const store = transaction.objectStore(PROJECTION);
      const current = await request<ProjectionRow | undefined>(store.get(this.scope));
      if (current) store.put({ ...current, syncCheckpoint: token } satisfies ProjectionRow);
      await transactionDone(transaction);
    } finally {
      database.close();
    }
  }

  async clearProjection(): Promise<void> {
    const database = await openDatabase();
    try {
      const transaction = database.transaction(PROJECTION, "readwrite", { durability: "strict" });
      transaction.objectStore(PROJECTION).delete(this.scope);
      await transactionDone(transaction);
    } finally {
      database.close();
    }
  }

  async resetRebuildableState(): Promise<void> {
    const database = await openDatabase();
    try {
      const transaction = database.transaction(
        [INBOX, PROJECTION],
        "readwrite",
        { durability: "strict" },
      );
      const inbox = transaction.objectStore(INBOX);
      const cursor = inbox.index("scope").openCursor(IDBKeyRange.only(this.scope));
      cursor.onsuccess = () => {
        const current = cursor.result;
        if (!current) return;
        current.delete();
        current.continue();
      };
      transaction.objectStore(PROJECTION).delete(this.scope);
      await transactionDone(transaction);
    } finally {
      database.close();
    }
  }

  private key(id: string): string {
    return `${this.scope}\u0000${id}`;
  }

  private outboxRow(record: MatrixMlp3OutboxRecord): OutboxRow {
    return {
      ...structuredClone(record),
      key: this.key(record.command.commandId),
      scope: this.scope,
      scopeStatus: `${this.scope}\u0000${record.status}`,
    };
  }
}

export async function ensureMatrixMlp3OutboxDatabase(
  factory: IDBFactory = indexedDB,
): Promise<void> {
  const database = await openDatabase(factory);
  try {
    if (!database.objectStoreNames.contains(OUTBOX)) {
      throw new Error("MLP/3 IndexedDB outbox store is unavailable.");
    }
    const transaction = database.transaction(OUTBOX, "readonly");
    if (!transaction.objectStore(OUTBOX).indexNames.contains("scopeStatus")) {
      throw new Error("MLP/3 outbox scope index is unavailable.");
    }
    await transactionDone(transaction);
  } finally {
    database.close();
  }
}

export async function ensureMatrixMlp3ReadModelDatabase(
  factory: IDBFactory = indexedDB,
): Promise<void> {
  const database = await openDatabase(factory);
  try {
    for (const storeName of [INBOX, PROJECTION]) {
      if (!database.objectStoreNames.contains(storeName)) {
        throw new Error(`MLP/3 IndexedDB store ${storeName} is unavailable.`);
      }
    }
    const transaction = database.transaction(INBOX, "readonly");
    const inbox = transaction.objectStore(INBOX);
    if (
      !inbox.indexNames.contains("scopeStatus")
      || !inbox.indexNames.contains("scope")
    ) {
      throw new Error("MLP/3 inbox scope indexes are unavailable.");
    }
    await transactionDone(transaction);
  } finally {
    database.close();
  }
}

/**
 * Preserves the durable Matrix-derived projection while forcing one bounded
 * authoritative thread-directory convergence after the next connection.
 *
 * Schema 3 was shipped for an optional receipt field but incorrectly reset the
 * whole read model. Preserve the materialized sessions/messages, but clear the
 * rebuildable raw inbox and its logical-event fence so the bounded replay can
 * actually re-apply authoritative roots and latest events. The migration is
 * idempotent and intentionally covers every stored Workspace/project scope in
 * the shared database.
 */
export async function migrateMatrixMlp3ReadModel(
  factory: IDBFactory = indexedDB,
): Promise<void> {
  const database = await openDatabase(factory);
  try {
    const transaction = database.transaction(
      [INBOX, PROJECTION],
      "readwrite",
      { durability: "strict" },
    );
    transaction.objectStore(INBOX).clear();
    const cursor = transaction.objectStore(PROJECTION).openCursor();
    cursor.onsuccess = () => {
      const current = cursor.result;
      if (!current) return;
      const row = current.value as ProjectionRow;
      const migrated = {
        ...row,
        state: prepareMatrixMlp3ProjectionForReplay(row.state),
      };
      delete migrated.syncCheckpoint;
      current.update(migrated);
      current.continue();
    };
    cursor.onerror = () => transaction.abort();
    await transactionDone(transaction);
  } finally {
    database.close();
  }
}

export function prepareMatrixMlp3ProjectionForReplay(state: unknown): unknown {
  if (!state || typeof state !== "object" || Array.isArray(state)) return state;
  const record = state as Record<string, unknown>;
  return Array.isArray(record.seenLogicalEvents)
    ? { ...record, seenLogicalEvents: [] }
    : state;
}

/** Clears Matrix-derived state without touching independently durable commands. */
export async function resetMatrixMlp3ReadModel(
  factory: IDBFactory = indexedDB,
): Promise<void> {
  const database = await openDatabase(factory);
  try {
    const transaction = database.transaction(
      [INBOX, PROJECTION],
      "readwrite",
      { durability: "strict" },
    );
    transaction.objectStore(INBOX).clear();
    transaction.objectStore(PROJECTION).clear();
    await transactionDone(transaction);
  } finally {
    database.close();
  }
}

function openDatabase(factory: IDBFactory = indexedDB): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const opened = factory.open(MATRIX_MLP3_DATABASE_NAME, DATABASE_VERSION);
    opened.onupgradeneeded = () => {
      const database = opened.result;
      if (!database.objectStoreNames.contains(OUTBOX)) {
        const store = database.createObjectStore(OUTBOX, { keyPath: "key" });
        store.createIndex("scopeStatus", "scopeStatus", { unique: false });
      }
      if (!database.objectStoreNames.contains(INBOX)) {
        const store = database.createObjectStore(INBOX, { keyPath: "key" });
        store.createIndex("scopeStatus", "scopeStatus", { unique: false });
        store.createIndex("scope", "scope", { unique: false });
      } else {
        const store = opened.transaction!.objectStore(INBOX);
        if (!store.indexNames.contains("scope")) {
          store.createIndex("scope", "scope", { unique: false });
        }
      }
      if (!database.objectStoreNames.contains(PROJECTION)) {
        database.createObjectStore(PROJECTION, { keyPath: "key" });
      }
    };
    opened.onsuccess = () => resolve(opened.result);
    opened.onerror = () => reject(opened.error ?? new Error("MLP/3 IndexedDB open failed."));
    opened.onblocked = () => reject(new Error("MLP/3 IndexedDB upgrade is blocked by another tab."));
  });
}

function put(database: IDBDatabase, storeName: string, value: unknown): Promise<void> {
  const transaction = database.transaction(storeName, "readwrite", { durability: "strict" });
  transaction.objectStore(storeName).put(value);
  return transactionDone(transaction);
}

function get<T>(database: IDBDatabase, storeName: string, key: IDBValidKey): Promise<T | undefined> {
  const transaction = database.transaction(storeName, "readonly");
  return request<T | undefined>(transaction.objectStore(storeName).get(key));
}

function readIndex<T>(
  database: IDBDatabase,
  storeName: string,
  indexName: string,
  range: IDBKeyRange,
): Promise<T[]> {
  const transaction = database.transaction(storeName, "readonly");
  return request<T[]>(transaction.objectStore(storeName).index(indexName).getAll(range));
}

function request<T>(input: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    input.onsuccess = () => resolve(input.result);
    input.onerror = () => reject(input.error ?? new Error("IndexedDB request failed."));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted."));
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed."));
  });
}

function stripOutboxRow(row: OutboxRow): MatrixMlp3OutboxRecord {
  const { key, scope, scopeStatus, ...record } = row;
  void key;
  void scope;
  void scopeStatus;
  return structuredClone(record);
}

function stripInboxRow(row: InboxRow): MatrixMlp3InboxRecord {
  const { key, scope, scopeStatus, ...record } = row;
  void key;
  void scope;
  void scopeStatus;
  return structuredClone(record);
}
