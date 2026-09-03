import { z } from 'zod'
import {
  nativeClientReleaseSchema,
  type NativeClientRelease,
} from '@malink/protocol'
import {
  privilegedExecutionInputSchema,
  type PrivilegedExecutionResult,
} from '@/privilege'
import type { AgentEvent } from '@/providers/types'
import type { ClientMatrixLoginStatus } from '@/gateway/pairing'

export const createInvitationRequestSchema = z
  .object({
    lifetimeMs: z.number().int().min(30_000).max(10 * 60_000).optional(),
    matrixLogin: z.enum(['required', 'preferred', 'disabled']).optional(),
    appUrl: z
      .url()
      .refine((value) => {
        const protocol = new URL(value).protocol
        return protocol === 'https:' || protocol === 'http:'
      }, 'appUrl must use http or https')
      .optional(),
    privilegeApproval: z.boolean().optional(),
  })
  .strict()

export type CreateInvitationRequest = z.infer<
  typeof createInvitationRequestSchema
>

export const revokeDeviceRequestSchema = z
  .object({
    reason: z.string().min(1).max(1024).optional(),
  })
  .strict()

export type RevokeDeviceRequest = z.infer<typeof revokeDeviceRequestSchema>

export const renameGatewayRequestSchema = z.object({
  gatewayName: z.string().trim().min(1).max(128),
}).strict()

export type RenameGatewayRequest = z.infer<typeof renameGatewayRequestSchema>

export interface GatewayAdminIdentity {
  workspaceId: string
  gatewayNodeId: string
  gatewayShortId: string
  gatewayName: string
  computerName?: string
}

export const receiveWorkspaceFileRequestSchema = z
  .object({
    path: z.string().min(1).max(8_192),
    filename: z.string().min(1).max(512).optional(),
    caption: z.string().max(8_192).optional(),
    sourceLabel: z.string().min(1).max(256).optional(),
  })
  .strict()

export type ReceiveWorkspaceFileRequest = z.infer<
  typeof receiveWorkspaceFileRequestSchema
>

export interface ReceiveWorkspaceFileResponse {
  fileId: string
  eventId: string
  delivery: 'delivered' | 'queued'
}

export const sendSessionFileRequestSchema = z
  .object({
    sessionId: z.string().min(1).max(256),
    path: z.string().min(1).max(8_192),
    filename: z.string().min(1).max(512).optional(),
    caption: z.string().max(8_192).optional(),
    type: z.enum(['document', 'file', 'markdown', 'code', 'image']).optional(),
    language: z.string().min(1).max(128).optional(),
  })
  .strict()

export type SendSessionFileRequest = z.infer<
  typeof sendSessionFileRequestSchema
>

export interface SendSessionFileResponse {
  status: 'queued' | 'sent' | 'failed'
  deliveryId?: string
  path?: string
  filename?: string
  type?: string
  message?: string
}

export const gatewayPrivilegedExecutionRequestSchema = privilegedExecutionInputSchema
  .extend({ sessionId: z.string().min(1).max(256) })
  .strict()

export type GatewayPrivilegedExecutionRequest = z.infer<
  typeof gatewayPrivilegedExecutionRequestSchema
>

export type GatewayPrivilegedExecutionResponse = PrivilegedExecutionResult

export const publishNativeClientReleaseRequestSchema = nativeClientReleaseSchema

export type PublishNativeClientReleaseRequest = NativeClientRelease

export interface PublishNativeClientReleaseResponse {
  changed: boolean
  release: NativeClientRelease
  projectCount: number
}

export const gatewayProviderPromptRequestSchema = z.object({
  prompt: z.string().min(1).max(32 * 1024),
  provider: z.string().trim().min(1).max(128).optional(),
  cwd: z.string().trim().min(1).max(8_192).optional(),
  providerSessionId: z.string().trim().min(1).max(256).optional(),
  model: z.string().trim().min(1).max(256).optional(),
  reasoningEffort: z.string().trim().min(1).max(64).optional(),
  permissionMode: z.enum(['default', 'acceptEdits', 'bypassPermissions']).optional(),
  timeoutMs: z.number().int().min(1_000).max(10 * 60_000).optional(),
}).strict()

export type GatewayProviderPromptRequest = z.infer<
  typeof gatewayProviderPromptRequestSchema
>

export interface GatewayProviderPromptEvent {
  elapsedMs: number
  event: AgentEvent
}

export interface GatewayProviderPromptResponse {
  provider: string
  cwd: string
  requestedProviderSessionId?: string
  providerSessionId?: string
  startedAt: number
  completedAt: number
  durationMs: number
  sessionOpenMs?: number
  outcome: 'success' | 'error' | 'max_turns' | 'timed_out' | 'cancelled'
  text: string
  events: GatewayProviderPromptEvent[]
  eventCounts: Record<string, number>
  truncated: boolean
  error?: string
}

export const gatewayFilesystemPreflightRequestSchema = z.object({
  paths: z.array(z.string().min(1).max(8_192)).min(1).max(16).optional(),
  allowCreate: z.boolean().optional(),
  timeoutMs: z.number().int().min(100).max(120_000).optional(),
}).strict()

export type GatewayFilesystemPreflightRequest = z.infer<
  typeof gatewayFilesystemPreflightRequestSchema
>

export interface GatewayFilesystemPreflightResult {
  path: string
  state: 'ready' | 'missing' | 'not_directory' | 'denied' | 'timeout' | 'error'
  exists?: boolean
  code?: string
  detail?: string
}

export interface GatewayFilesystemPreflightResponse {
  mode: 'gateway-host'
  ready: boolean
  results: GatewayFilesystemPreflightResult[]
}

export interface GatewayAdminStatus {
  version: 1
  /** Compatibility alias for workspaceId. */
  gatewayId: string
  workspaceId: string
  gatewayNodeId: string
  gatewayShortId: string
  gatewayName: string
  computerName?: string
  state: string
  pid: number
  startedAt: number
  activeDeviceCount: number
  clientMatrixUserId?: string
  clientMatrixLoginStatus?: ClientMatrixLoginStatus
  legacyClientDeviceCount?: number
  clientMatrixIdentityStatus?: 'converged' | 'migration-required'
  openInvitationCount: number
  buildId?: string
  runtimeEpoch?: string
  activeTurns?: number
  activeCommands?: number
  expiredCommandExecutions?: number
  unfinishedCommands?: number
  oldestUnfinishedCommandAgeMs?: number | null
  pendingOutboxDeliveries?: number
  oldestPendingOutboxDeliveryAgeMs?: number | null
  outboxWalBytes?: number
  pendingInboxEvents?: number
  quarantinedInboxEvents?: number
  matrixReady?: boolean | null
  lastMatrixSyncAt?: number | null
}

export interface GatewayAdminDevice {
  deviceId: string
  deviceName: string
  status: 'active' | 'revoked' | 'expired'
  matrixUserId: string
  matrixDeviceId: string
  activatedAt: number
  expiresAt: number
  revokedAt?: number
  revocationReason?: string
}

export interface GatewayAdminInvitation {
  invitationId: string
  url: string
  pairingLink: string
  expiresAt: number
  verificationCode: string
  includesMatrixLogin: boolean
  matrixLoginStatus:
    | 'included'
    | 'disabled'
    | 'reauth-required'
    | 'unsupported'
    | 'unavailable'
}

export interface GatewayAdminErrorBody {
  error: {
    code: string
    message: string
  }
}
