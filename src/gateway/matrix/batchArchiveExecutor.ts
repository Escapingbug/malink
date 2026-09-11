import { createHash } from 'node:crypto'
import {
  batchArchiveProgressSchema, batchArchiveRequestSchema,
  type BatchArchiveRequest, type BatchArchiveProgress,
} from '@malink/protocol'

type Target = BatchArchiveRequest['targets'][number]

/** Stable item identity lets the existing lifecycle journal recover a crash
 * between archiving an item and persisting the enclosing batch checkpoint. */
export function batchArchiveItemCommandId(batchId: string, target: Target): string {
  return `batch-archive-${createHash('sha256').update(JSON.stringify([batchId, target.projectId, target.sessionId])).digest('hex')}`
}

/** Storage is compare-and-swap: concurrent/replayed executions cannot both
 * acquire the same revision. A caller must serialize execution by batch ID.
 * archive() must authorize each project and use its normal session queue and
 * durable lifecycle journal; this coordinator never bypasses those boundaries. */
export async function executeBatchArchive(input: {
  batchId: string
  request: BatchArchiveRequest
  checkpoint?: BatchArchiveProgress
  concurrency?: number
  persist: (progress: BatchArchiveProgress, previousRevision: number) => Promise<void>
  publish: (progress: BatchArchiveProgress) => Promise<void>
  archive: (target: Target, itemCommandId: string) => Promise<void>
  describeFailure: (error: unknown) => { code: string; message: string; retryable: boolean }
}): Promise<BatchArchiveProgress> {
  const request = batchArchiveRequestSchema.parse(input.request)
  const concurrency = input.concurrency ?? 3
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new Error('Invalid batch concurrency')
  let state: BatchArchiveProgress = input.checkpoint
    ? batchArchiveProgressSchema.parse(input.checkpoint)
    : { type: 'session.archive.batch.progress', batchId: input.batchId, revision: 1, state: 'running',
      items: request.targets.map(target => ({ ...target, state: 'pending' })) }
  if (state.batchId !== input.batchId || JSON.stringify(state.items.map(({ projectId, sessionId }) => ({ projectId, sessionId }))) !== JSON.stringify(request.targets)) {
    throw new Error('Batch checkpoint does not match the immutable request')
  }
  if (!input.checkpoint) await input.persist(structuredClone(state), 0)
  if (state.state === 'completed') { await input.publish(structuredClone(state)); return state }
  let mutation = Promise.resolve()
  const update = (index: number, patch: Partial<BatchArchiveProgress['items'][number]>) => {
    const operation = mutation.then(async () => {
      const next = structuredClone(state)
      next.items[index] = { ...next.items[index]!, ...patch }
      next.revision++
      next.state = next.items.every(item => ['succeeded', 'failed'].includes(item.state)) ? 'completed' : 'running'
      batchArchiveProgressSchema.parse(next)
      await input.persist(next, state.revision)
      state = next
      // publish must enqueue in the durable outbox, not await Matrix receipt.
      await input.publish(structuredClone(next))
    })
    mutation = operation
    return operation
  }
  const pending = state.items.flatMap((item, index) => ['pending', 'running'].includes(item.state) ? [index] : [])
  let cursor = 0
  const workers = await Promise.allSettled(Array.from({ length: Math.min(concurrency, pending.length) }, async () => {
    while (cursor < pending.length) {
      const index = pending[cursor++]!
      const target = request.targets[index]!
      await update(index, { state: 'running' })
      let failure: ReturnType<typeof input.describeFailure> | undefined
      try { await input.archive(target, batchArchiveItemCommandId(input.batchId, target)) }
      catch (error) { failure = input.describeFailure(error) }
      await update(index, failure ? { state: 'failed', error: failure } : { state: 'succeeded' })
    }
  }))
  const failed = workers.find((worker): worker is PromiseRejectedResult => worker.status === 'rejected')
  if (failed) throw failed.reason
  return state
}
