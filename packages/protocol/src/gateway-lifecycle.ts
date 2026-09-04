import { z } from 'zod'

const opaqueId = z.string().min(1).max(256)
const timestamp = z.number().int().nonnegative()

export const gatewayRestartModeSchema = z.enum(['when_idle', 'force'])

export type GatewayRestartMode = z.infer<typeof gatewayRestartModeSchema>

export const gatewayRestartStatusSchema = z
  .object({
    version: z.literal(1),
    phase: z.enum([
      'idle',
      'waiting_for_idle',
      'scheduled',
      'restarting',
      'ready',
      'failed',
    ]),
    restartId: opaqueId.optional(),
    mode: gatewayRestartModeSchema.optional(),
    requestedAt: timestamp.optional(),
    scheduledAt: timestamp.optional(),
    startedAt: timestamp.optional(),
    completedAt: timestamp.optional(),
    activeTurns: z.number().int().nonnegative().optional(),
    detail: z.string().min(1).max(4_096).optional(),
    updatedAt: timestamp,
  })
  .strict()

export type GatewayRestartStatus = z.infer<typeof gatewayRestartStatusSchema>
