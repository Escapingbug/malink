import { z } from 'zod'
import { matrixLoginInvitationSchema, pairingPublicKeySchema, pairingSignatureSchema } from './pairing.js'
import { signedSecureEnvelopeSchema } from './secure-envelope.js'

const opaqueId = z.string().min(1).max(512)
const timestamp = z.number().int().nonnegative()
const base64Url = z.string().regex(/^[A-Za-z0-9_-]+$/u)

export const gatewayEnrollmentInvitationSchema = z.object({
  kind: z.literal('malink.gateway.enrollment-invitation'),
  version: z.literal(1),
  enrollmentId: opaqueId,
  workspaceId: opaqueId,
  workspaceKey: pairingPublicKeySchema,
  rendezvous: z.object({
    homeserver: z.url(),
    roomId: opaqueId,
    userId: opaqueId,
  }).strict(),
  matrixLogin: matrixLoginInvitationSchema,
  challenge: base64Url.min(43).max(128),
  issuedAt: timestamp,
  expiresAt: timestamp,
}).strict().superRefine((value, context) => {
  if (value.expiresAt <= value.issuedAt || value.matrixLogin.expiresAt > value.expiresAt) {
    context.addIssue({
      code: 'custom',
      path: ['expiresAt'],
      message: 'Gateway enrollment invitation lifetime is invalid',
    })
  }
  let rendezvousOrigin: string | undefined
  let loginOrigin: string | undefined
  try {
    rendezvousOrigin = new URL(value.rendezvous.homeserver).origin
    loginOrigin = new URL(value.matrixLogin.homeserver).origin
  } catch {
    // The URL schemas report the concrete field error.
  }
  if (
    rendezvousOrigin !== loginOrigin
    || value.rendezvous.userId !== value.matrixLogin.userId
  ) {
    context.addIssue({
      code: 'custom',
      path: ['matrixLogin'],
      message: 'Gateway enrollment login does not match its rendezvous account',
    })
  }
})

export const signedGatewayEnrollmentInvitationSchema = z.object({
  invitation: gatewayEnrollmentInvitationSchema,
  signature: pairingSignatureSchema,
}).strict()

export const gatewayEnrollmentRequestSchema = z.object({
  kind: z.literal('malink.gateway.enrollment-request'),
  version: z.literal(1),
  enrollmentId: opaqueId,
  workspaceId: opaqueId,
  gatewayNodeId: opaqueId,
  gatewayName: z.string().min(1).max(128),
  gatewayKey: pairingPublicKeySchema,
  challenge: base64Url.min(43).max(128),
  issuedAt: timestamp,
  expiresAt: timestamp,
}).strict().refine(value => value.expiresAt > value.issuedAt, {
  message: 'Gateway enrollment request lifetime is invalid',
  path: ['expiresAt'],
})

export const signedGatewayEnrollmentRequestSchema = z.object({
  request: gatewayEnrollmentRequestSchema,
  signature: pairingSignatureSchema,
}).strict()

export const gatewayEnrollmentResponseSchema = z.object({
  kind: z.literal('malink.gateway.enrollment-response'),
  version: z.literal(1),
  enrollmentId: opaqueId,
  workspaceId: opaqueId,
  gatewayNodeId: opaqueId,
  sealedInvitation: signedSecureEnvelopeSchema,
  issuedAt: timestamp,
  expiresAt: timestamp,
}).strict().refine(value => value.expiresAt > value.issuedAt, {
  message: 'Gateway enrollment response lifetime is invalid',
  path: ['expiresAt'],
})

export const gatewayEnrollmentPendingSchema = z.object({
  enrollmentId: opaqueId,
  gatewayNodeId: opaqueId,
  gatewayName: z.string().min(1).max(128),
  verificationCode: z.string().regex(/^\d{3}-\d{3}$/u),
  requestedAt: timestamp,
  expiresAt: timestamp,
  approverProjectId: opaqueId.optional(),
}).strict().refine(value => value.expiresAt > value.requestedAt, {
  message: 'Pending Gateway enrollment lifetime is invalid',
  path: ['expiresAt'],
})

export type GatewayEnrollmentInvitation = z.infer<typeof gatewayEnrollmentInvitationSchema>
export type SignedGatewayEnrollmentInvitation = z.infer<typeof signedGatewayEnrollmentInvitationSchema>
export type GatewayEnrollmentRequest = z.infer<typeof gatewayEnrollmentRequestSchema>
export type SignedGatewayEnrollmentRequest = z.infer<typeof signedGatewayEnrollmentRequestSchema>
export type GatewayEnrollmentResponse = z.infer<typeof gatewayEnrollmentResponseSchema>
export type GatewayEnrollmentPending = z.infer<typeof gatewayEnrollmentPendingSchema>
