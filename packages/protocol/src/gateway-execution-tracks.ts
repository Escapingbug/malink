import { z } from 'zod'

const release = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u)
/** Public signed version-selection state. Never includes filesystem locations. */
export const gatewayExecutionTracksStatusSchema = z.object({
  generation: z.number().int().nonnegative(),
  activeRelease: release,
  standbyRelease: release.optional(),
  phase: z.enum(['steady', 'releasing', 'activating', 'attention']),
  targetRelease: release.optional(),
  error: z.string().max(4096).optional(),
  controlProjectId: z.string().min(1).max(256).optional(),
}).strict()
export type GatewayExecutionTracksStatus = z.infer<typeof gatewayExecutionTracksStatusSchema>
