import assert from 'node:assert/strict';
import test from 'node:test';
import { batchArchiveUiStorageKey, readBatchArchiveUiResults, writeBatchArchiveUiResults } from '../app/batchArchiveUiStorage.ts';

test('batch uncertainty survives reload and is isolated by account and workspace', () => {
  const data = new Map<string, string>();
  const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } };
  const key = batchArchiveUiStorageKey(['server', 'alice', 'workspace']);
  writeBatchArchiveUiResults(storage, key, { 'project/session': 'pending' });
  assert.deepEqual(readBatchArchiveUiResults(storage, key), { 'project/session': 'pending' });
  assert.deepEqual(readBatchArchiveUiResults(storage, batchArchiveUiStorageKey(['server', 'bob', 'workspace'])), {});
  assert.deepEqual(readBatchArchiveUiResults(storage, batchArchiveUiStorageKey(['server', 'alice', 'other'])), {});
});

test('unreadable saved state does not silently make pending sessions selectable', () => {
  for (const raw of ['{', '[]', 'null', '{"session":"unknown"}']) {
    assert.throws(() => readBatchArchiveUiResults({ getItem: () => raw, setItem() {} }, 'key'));
  }
  assert.throws(() => writeBatchArchiveUiResults({ getItem: () => null, setItem() { throw new Error('quota'); } }, 'key', { session: 'pending' }), /quota/);
});
