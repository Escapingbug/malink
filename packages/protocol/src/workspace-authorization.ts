import { z } from 'zod'
import {
  matrixTransportBindingSchema,
  pairingOperationSchema,
  pairingPublicKeySchema,
  pairingSignatureSchema,
} from './pairing.js'

const opaqueId = z.string().min(1).max(512)
const matrixUserId = z.string().min(4).max(512).regex(/^@[^:\s]+:[^\s]+$/u)
const timestamp = z.number().int().nonnegative()

export const workspaceDeviceGrantSchema = z.object({
  kind: z.literal('malink.workspace.device-grant'),
  version: z.literal(1),
  grantId: opaqueId,
  workspaceId: opaqueId,
  certificateId: opaqueId,
  deviceId: opaqueId,
  deviceName: z.string().min(1).max(128),
  deviceKey: pairingPublicKeySchema,
  deviceTransport: matrixTransportBindingSchema,
  allowedOperations: z.array(pairingOperationSchema).max(pairingOperationSchema.options.length),
  issuedAt: timestamp,
  expiresAt: timestamp,
}).strict().refine(value => value.expiresAt > value.issuedAt, {
  message: 'expiresAt must be later than issuedAt',
  path: ['expiresAt'],
})

export const signedWorkspaceDeviceGrantSchema = z.object({
  grant: workspaceDeviceGrantSchema,
  signature: pairingSignatureSchema,
}).strict()

export const workspaceDeviceRevocationSchema = z.object({
  kind: z.literal('malink.workspace.device-revocation'),
  version: z.literal(1),
  revocationId: opaqueId,
  workspaceId: opaqueId,
  deviceId: opaqueId,
  certificateId: opaqueId,
  reason: z.string().min(1).max(1024).optional(),
  issuedAt: timestamp,
}).strict()

export const signedWorkspaceDeviceRevocationSchema = z.object({
  revocation: workspaceDeviceRevocationSchema,
  signature: pairingSignatureSchema,
}).strict()

export const workspaceGatewayDescriptorSchema = z.object({
  gatewayNodeId: opaqueId,
  workspaceId: opaqueId,
  gatewayName: z.string().min(1).max(128),
  computerName: z.string().min(1).max(128).optional(),
  buildId: z.string().min(1).max(256).optional(),
  onlineUpdate: z.literal(true).optional(),
  transport: matrixTransportBindingSchema,
  publicKey: pairingPublicKeySchema,
  projects: z.array(z.object({
    projectId: opaqueId,
    roomId: z.string().min(1).max(512),
    conversationId: opaqueId,
  }).strict()).max(256).optional(),
  issuedAt: timestamp,
}).strict()

export const workspaceGatewayDirectorySchema = z.object({
  kind: z.literal('malink.workspace.gateway-directory'),
  version: z.literal(1),
  directoryId: opaqueId,
  workspaceId: opaqueId,
  /** One Workspace-owned Matrix user shared by every client device. */
  clientMatrixUserId: matrixUserId.optional(),
  revision: z.number().int().nonnegative(),
  gateways: z.array(workspaceGatewayDescriptorSchema).max(256),
  removedGatewayNodeIds: z.array(opaqueId).max(256).optional(),
  issuedAt: timestamp,
}).strict().superRefine((value, context) => {
  const ids = value.gateways.map(gateway => gateway.gatewayNodeId)
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: 'custom', path: ['gateways'], message: 'Gateway node IDs must be unique' })
  }
  const removed = value.removedGatewayNodeIds ?? []
  if (new Set(removed).size !== removed.length) {
    context.addIssue({ code: 'custom', path: ['removedGatewayNodeIds'], message: 'Removed Gateway node IDs must be unique' })
  }
  if (removed.some(id => ids.includes(id))) {
    context.addIssue({ code: 'custom', path: ['removedGatewayNodeIds'], message: 'A removed Gateway cannot remain in the directory' })
  }
  if (value.gateways.some(gateway => gateway.workspaceId !== value.workspaceId)) {
    context.addIssue({ code: 'custom', path: ['gateways'], message: 'Gateway belongs to another workspace' })
  }
  const projects = value.gateways.flatMap(gateway =>
    (gateway.projects ?? []).map(project => ({ ...project, gatewayNodeId: gateway.gatewayNodeId })))
  for (const field of ['projectId', 'roomId'] as const) {
    const values = projects.map(project => project[field])
    if (new Set(values).size !== values.length) {
      context.addIssue({
        code: 'custom', path: ['gateways'],
        message: `Workspace project routes must have unique ${field} values`,
      })
    }
  }
})

export const signedWorkspaceGatewayDirectorySchema = z.object({
  directory: workspaceGatewayDirectorySchema,
  signature: pairingSignatureSchema,
}).strict()

export type WorkspaceDeviceGrant = z.infer<typeof workspaceDeviceGrantSchema>
export type SignedWorkspaceDeviceGrant = z.infer<typeof signedWorkspaceDeviceGrantSchema>
export type WorkspaceDeviceRevocation = z.infer<typeof workspaceDeviceRevocationSchema>
export type SignedWorkspaceDeviceRevocation = z.infer<typeof signedWorkspaceDeviceRevocationSchema>
export type WorkspaceGatewayDescriptor = z.infer<typeof workspaceGatewayDescriptorSchema>
export type WorkspaceProjectRoute = NonNullable<WorkspaceGatewayDescriptor['projects']>[number]
export type WorkspaceGatewayDirectory = z.infer<typeof workspaceGatewayDirectorySchema>
export type SignedWorkspaceGatewayDirectory = z.infer<typeof signedWorkspaceGatewayDirectorySchema>
