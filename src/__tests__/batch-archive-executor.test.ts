import { describe, expect, it } from 'vitest'
import { batchArchiveRequestSchema, type BatchArchiveProgress } from '../../packages/protocol/src/batch-archive'
import { executeBatchArchive, batchArchiveItemCommandId } from '../gateway/matrix/batchArchiveExecutor'

const request = { operation: 'session.archive.batch' as const, targets: Array.from({ length: 7 }, (_, index) => ({ projectId: 'project', sessionId: `session-${index}` })) }
const describeFailure = () => ({ code: 'item_failed', message: 'Item failed', retryable: false })
describe('protocol batch archive coordinator', () => {
  it('rejects empty, oversized and duplicate targets', () => {
    for (const targets of [[], Array(101).fill(request.targets[0]), [request.targets[0], request.targets[0]]]) {
      expect(batchArchiveRequestSchema.safeParse({ ...request, targets }).success).toBe(false)
    }
  })
  it('runs three items concurrently and reports failures independently', async () => {
    let active = 0; let peak = 0; let revision = 0
    const publications: BatchArchiveProgress[] = []
    const result = await executeBatchArchive({ batchId: 'batch', request, describeFailure,
      persist: async (state, previous) => { expect(previous).toBe(revision); revision = state.revision },
      publish: async state => { publications.push(state) },
      archive: async target => {
        active++; peak = Math.max(active, peak)
        await new Promise(resolve => setTimeout(resolve, 5))
        active--
        if (target.sessionId === 'session-1') throw new Error('private detail')
      },
    })
    expect(peak).toBe(3)
    expect(result.state).toBe('completed')
    expect(result.items.filter(item => item.state === 'succeeded')).toHaveLength(6)
    expect(result.items[1]?.error?.code).toBe('item_failed')
    expect(publications.at(-1)).toEqual(result)
  })
  it('resumes running items with stable identities and skips settled items', async () => {
    const checkpoint: BatchArchiveProgress = { type: 'session.archive.batch.progress', batchId: 'batch', revision: 4, state: 'running',
      items: request.targets.map((target, index) => ({ ...target, state: index === 0 ? 'succeeded' : index === 1 ? 'running' : 'pending' })) }
    const ids: string[] = []
    await executeBatchArchive({ batchId: 'batch', request, checkpoint, describeFailure,
      persist: async () => {}, publish: async () => {}, archive: async (target, id) => {
        expect(id).toBe(batchArchiveItemCommandId('batch', target)); ids.push(id)
      },
    })
    expect(ids).toHaveLength(6)
    expect(ids).not.toContain(batchArchiveItemCommandId('batch', request.targets[0]!))
  })
  it('does not execute when initial persistence fails', async () => {
    let executed = false
    await expect(executeBatchArchive({ batchId: 'batch', request, describeFailure,
      persist: async () => { throw new Error('disk unavailable') }, publish: async () => {},
      archive: async () => { executed = true },
    })).rejects.toThrow('disk unavailable')
    expect(executed).toBe(false)
  })
  it('rejects a checkpoint belonging to a different request', async () => {
    await expect(executeBatchArchive({ batchId: 'batch', request, describeFailure,
      checkpoint: { type: 'session.archive.batch.progress', batchId: 'other', revision: 1, state: 'running', items: request.targets.map(target => ({ ...target, state: 'pending' })) },
      persist: async () => {}, publish: async () => {}, archive: async () => {},
    })).rejects.toThrow('immutable request')
  })
})
