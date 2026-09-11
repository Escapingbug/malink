export type BatchArchiveUiResults = Record<string, 'pending' | 'done' | 'failed'>;
type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem'>;

export function batchArchiveUiStorageKey(scope: readonly string[]): string {
  return `malink.batch-archive.v1:${JSON.stringify(scope)}`;
}

export function readBatchArchiveUiResults(storage: Storage, key: string): BatchArchiveUiResults {
  const raw = storage.getItem(key);
  if (raw === null) return {};
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    Object.values(value).some(state => typeof state !== 'string' || !['pending', 'done', 'failed'].includes(state))) {
    throw new Error('Saved batch archive state is unreadable; recover the outstanding commands before retrying');
  }
  return value as BatchArchiveUiResults;
}

export function writeBatchArchiveUiResults(storage: Storage, key: string, value: BatchArchiveUiResults): void {
  storage.setItem(key, JSON.stringify(value));
}
