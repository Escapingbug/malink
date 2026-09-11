import { it, expect } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BatchArchiveStore } from '../gateway/matrix/batchArchiveStore'
it('retains progress across reopen and rejects conflicting revisions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'malink-batch-store-'))
  try {
    const store = new BatchArchiveStore(root)
    const state = { type: 'session.archive.batch.progress' as const, batchId: 'b', revision: 1,
      state: 'running' as const, items: [{ projectId: 'p', sessionId: 's', state: 'pending' as const }] }
    await store.write('key', state, 0)
    expect(await new BatchArchiveStore(root).read('key')).toEqual(state)
    await expect(store.write('key', { ...state, revision: 2 }, 0)).rejects.toThrow('revision conflict')
    expect(await store.read('key')).toEqual(state)
  } finally { await rm(root, { recursive: true, force: true }) }
})
