import { z } from 'zod'

const id = z.string().min(1).max(512)
export const batchArchiveTargetSchema = z.object({ projectId: id, sessionId: id }).strict()
export const batchArchiveRequestSchema = z.object({
  operation: z.literal('session.archive.batch'),
  targets: z.array(batchArchiveTargetSchema).min(1).max(100),
}).strict().superRefine((value, context) => {
  const seen = new Set<string>()
  value.targets.forEach((target, index) => {
    const key = JSON.stringify([target.projectId, target.sessionId])
    if (seen.has(key)) context.addIssue({ code: 'custom', path: ['targets', index], message: 'Duplicate archive target' })
    seen.add(key)
  })
})

export const batchArchiveItemSchema = z.object({
  projectId: id,
  sessionId: id,
  state: z.enum(['pending', 'running', 'succeeded', 'failed']),
  error: z.object({ code: id, message: z.string().min(1).max(8192), retryable: z.boolean() }).strict().optional(),
}).strict().refine(value => (value.state === 'failed') === Boolean(value.error), 'Only failed items require an error')

export const batchArchiveProgressSchema = z.object({
  type: z.literal('session.archive.batch.progress'),
  batchId: id,
  revision: z.number().int().positive(),
  state: z.enum(['running', 'completed']),
  items: z.array(batchArchiveItemSchema).min(1).max(100),
}).strict().superRefine((value, context) => {
  const terminal = value.items.every(item => item.state === 'succeeded' || item.state === 'failed')
  if ((value.state === 'completed') !== terminal) context.addIssue({ code: 'custom', path: ['state'], message: 'Batch completion must match all item outcomes' })
  const ids = value.items.map(item => JSON.stringify([item.projectId, item.sessionId]))
  if (new Set(ids).size !== ids.length) context.addIssue({ code: 'custom', path: ['items'], message: 'Duplicate archive outcome' })
})

export type BatchArchiveRequest = z.infer<typeof batchArchiveRequestSchema>
export type BatchArchiveProgress = z.infer<typeof batchArchiveProgressSchema>
