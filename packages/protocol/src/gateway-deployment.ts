import { z } from 'zod'

const opaqueId = z.string().min(1).max(256)
const releaseId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u)
const timestamp = z.number().int().nonnegative()

export const gatewayDeploymentPhaseSchema = z.enum([
  'steady',
  'preparing',
  'trial',
  'draining',
  'transferring',
  'committing',
  'discarding',
  'repair_required',
])

export type GatewayDeploymentPhase = z.infer<typeof gatewayDeploymentPhaseSchema>

export const gatewayDeploymentSlotSchema = z.object({
  gatewayNodeId: opaqueId,
  releaseId: releaseId.optional(),
  buildId: opaqueId,
  projectCount: z.number().int().nonnegative().max(256),
  sessionCount: z.number().int().nonnegative(),
}).strict()

export type GatewayDeploymentSlot = z.infer<typeof gatewayDeploymentSlotSchema>

/** A repair-only runtime; it never owns the promoted node's ordinary projects. */
export const gatewayRecoverySlotSchema = gatewayDeploymentSlotSchema.extend({
  projectId: opaqueId,
  sessionId: opaqueId.optional(),
  retainedAt: timestamp,
}).strict()

export type GatewayRecoverySlot = z.infer<typeof gatewayRecoverySlotSchema>

/**
 * Signed semantic state for the temporary two-Gateway topology on one host.
 * It stays outside the strict Gateway Directory v1 descriptor so older clients
 * can continue parsing project routes during a mixed-version trial.
 */
export const gatewayDeploymentStatusSchema = z.object({
  version: z.literal(1),
  strategy: z.literal('blue-green-v1'),
  maxDeployments: z.literal(2),
  computerId: opaqueId,
  generation: z.number().int().nonnegative(),
  phase: gatewayDeploymentPhaseSchema,
  active: gatewayDeploymentSlotSchema,
  candidate: gatewayDeploymentSlotSchema.optional(),
  recovery: gatewayRecoverySlotSchema.optional(),
  updateId: opaqueId.optional(),
  activeTurns: z.number().int().nonnegative().optional(),
  detail: z.string().min(1).max(4_096).optional(),
  updatedAt: timestamp,
}).strict().superRefine((status, context) => {
  if (status.recovery && (status.recovery.gatewayNodeId === status.active.gatewayNodeId || status.candidate)) {
    context.addIssue({ code: 'custom', path: ['recovery'],
      message: 'Recovery requires an independent node and must rotate before a candidate occupies the second slot' })
  }
  const hasTransaction = status.phase !== 'steady'
    && status.phase !== 'repair_required'
  if (hasTransaction && (!status.candidate || !status.updateId)) {
    context.addIssue({
      code: 'custom',
      path: ['candidate'],
      message: `${status.phase} requires a candidate and update ID`,
    })
  }
  if (status.phase === 'steady' && (status.candidate || status.updateId)) {
    context.addIssue({
      code: 'custom',
      path: ['phase'],
      message: 'A steady computer cannot retain a candidate or update ID',
    })
  }
  if (status.candidate?.gatewayNodeId === status.active.gatewayNodeId) {
    context.addIssue({
      code: 'custom',
      path: ['candidate', 'gatewayNodeId'],
      message: 'Active and candidate deployments require distinct Gateway node IDs',
    })
  }
})

export type GatewayDeploymentStatus = z.infer<typeof gatewayDeploymentStatusSchema>
