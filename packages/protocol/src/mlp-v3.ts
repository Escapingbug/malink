import { z } from 'zod'
import {
  matrixGatewayCapabilitiesSchema,
  matrixModelCapabilitySchema,
} from './matrix-native.js'
import { signedWorkspaceGatewayDirectorySchema } from './workspace-authorization.js'
import { gatewayRestartStatusSchema } from './gateway-lifecycle.js'
import { gatewayEnrollmentPendingSchema } from './gateway-enrollment.js'
import { gatewayUpdateStatusSchema } from './gateway-release.js'
import {
  attachmentSchema,
  artifactReferenceSchema,
  jsonValueSchema,
  providerControlSchema,
  providerControlErrorSchema,
  providerControlValuesSchema,
  sessionExtensionActionIdSchema,
  sessionExtensionBindingSchema,
  sessionExtensionDescriptorSchema,
  sessionExtensionSummarySchema,
  sessionExtensionViewSchema,
  signatureSchema,
} from './schema.js'

/**
 * Malink Protocol version 3 (MLP/3).
 *
 * MLP owns execution authorization, business semantics and project-content
 * encryption. Matrix is the current durable transport and owns rooms,
 * threads, history, relations and incremental sync; it is not the protocol
 * named by this version number.
 */
export const MALINK_PROTOCOL_NAME = 'Malink Protocol' as const
export const MALINK_PROTOCOL_ACRONYM = 'MLP' as const
export const MALINK_PROTOCOL_VERSION = 3 as const
export const MALINK_PROTOCOL_LABEL = 'MLP/3' as const

export const MLP3_MATRIX_TIMELINE_EVENT_TYPE = 'm.room.message' as const
export const MALINK_MATRIX_EXTENSION = 'io.malink' as const
export const MLP3_MATRIX_PROJECT_POINTER_EVENT_TYPE =
  'io.malink.project.current.v3' as const
export const MLP3_MATRIX_WORKSPACE_POINTER_EVENT_TYPE =
  'io.malink.workspace.current.v3' as const
/** Application-encrypted, paginated provider catalogs stored as bounded Room State. */
export const MLP3_MATRIX_PROVIDER_CATALOG_EVENT_TYPE =
  'io.malink.provider_catalog.v1' as const
export const MLP3_MATRIX_PROJECT_KEY_GRANT_EVENT_TYPE =
  'io.malink.project.key_grant.v3' as const
/** Idempotent ownership marker for a Gateway-created Matrix project room. */
export const MLP3_MATRIX_PROJECT_PROVISIONING_EVENT_TYPE =
  'io.malink.project.provisioning.v1' as const
/** Idempotent ownership marker for one recovered session's read-only history room. */
export const MLP3_MATRIX_PROVIDER_HISTORY_PROVISIONING_EVENT_TYPE =
  'io.malink.provider_history.provisioning.v1' as const
/** Signed Workspace control state replicated to every authorized project room. */
export const MLP3_MATRIX_WORKSPACE_DIRECTORY_EVENT_TYPE =
  'io.malink.workspace.gateway_directory.v1' as const
export const MLP3_MATRIX_WORKSPACE_DEVICE_GRANT_EVENT_TYPE =
  'io.malink.workspace.device_grant.v1' as const
export const MLP3_MATRIX_WORKSPACE_DEVICE_REVOCATION_EVENT_TYPE =
  'io.malink.workspace.device_revocation.v1' as const
/** Cleartext rendezvous metadata. Authority remains in Malink signatures and sealed responses. */
export const MLP3_MATRIX_GATEWAY_ENROLLMENT_REQUEST_EVENT_TYPE =
  'io.malink.gateway.enrollment_request.v1' as const
export const MLP3_MATRIX_GATEWAY_ENROLLMENT_RESPONSE_EVENT_TYPE =
  'io.malink.gateway.enrollment_response.v1' as const

const opaqueId = z.string().min(1).max(256)
const requiredProjectId = z.string({ error: 'Project is required' }).min(1).max(256)
const requiredSessionId = z.string({ error: 'Session is required' }).min(1).max(256)
const matrixRoomId = z.string().min(1).max(512)
const matrixEventId = z.string().min(1).max(512)
const timestamp = z.number().int().nonnegative()
const base64Url = z.string().regex(/^[A-Za-z0-9_-]+$/)

export const mlp3ProjectProvisioningStateSchema = z
  .object({
    kind: z.literal('malink.project.provisioning'),
    version: z.literal(1),
    workspaceId: opaqueId,
    gatewayNodeId: opaqueId,
    projectId: opaqueId,
  })
  .strict()

export type Mlp3ProjectProvisioningState = z.infer<
  typeof mlp3ProjectProvisioningStateSchema
>

export const mlp3ProviderHistoryProvisioningStateSchema = z
  .object({
    kind: z.literal('malink.provider_history.provisioning'),
    version: z.literal(1),
    workspaceId: opaqueId,
    gatewayNodeId: opaqueId,
    projectId: opaqueId,
    /** Non-sensitive, one-way room ownership identifier; never a provider session ID. */
    historyId: opaqueId,
  })
  .strict()

export type Mlp3ProviderHistoryProvisioningState = z.infer<
  typeof mlp3ProviderHistoryProvisioningStateSchema
>

export const providerCommandSchema = z
  .object({
    name: z.string().min(1).max(256),
    description: z.string().max(4_096),
    inputHint: z.string().max(1_024).nullable(),
  })
  .strict()

export type ProviderCommand = z.infer<typeof providerCommandSchema>

export const providerSessionEntrySchema = z
  .object({
    sessionId: opaqueId,
    title: z.string().min(1).max(512),
    updatedAt: timestamp,
    cwd: z.string().min(1).max(8_192).optional(),
    managedSessionId: opaqueId.optional(),
    latestArchivedSessionId: opaqueId.optional(),
    lastArchivedAt: timestamp.optional(),
  })
  .strict()
  .refine(
    value => (value.latestArchivedSessionId === undefined) === (value.lastArchivedAt === undefined),
    { message: 'Archived Malink session identity and timestamp must be published together' },
  )

export type ProviderSessionEntry = z.infer<typeof providerSessionEntrySchema>

export const providerHistoryMessageSchema = z
  .object({
    id: opaqueId,
    role: z.enum(['user', 'assistant']),
    text: z.string().max(16 * 1024),
  })
  .strict()

export type ProviderHistoryMessage = z.infer<typeof providerHistoryMessageSchema>

export const providerHistoryRoomBindingSchema = z
  .object({
    roomId: matrixRoomId,
    snapshotId: opaqueId,
    ordering: z.literal('reverse_append_v1'),
  })
  .strict()

export type ProviderHistoryRoomBinding = z.infer<typeof providerHistoryRoomBindingSchema>

export const webPushSubscriptionSchema = z
  .object({
    endpoint: z.string().url().max(4_096).refine(value => {
      try {
        const endpoint = new URL(value)
        return endpoint.protocol === 'https:'
          && !endpoint.username
          && !endpoint.password
          && !endpoint.hash
      } catch {
        return false
      }
    }, 'Web Push endpoint must be a credential-free HTTPS URL'),
    expirationTime: timestamp.nullable().optional(),
    keys: z
      .object({
        p256dh: base64Url.min(32).max(256),
        auth: base64Url.min(16).max(128),
      })
      .strict(),
  })
  .strict()

export type WebPushSubscription = z.infer<typeof webPushSubscriptionSchema>

export const nativeClientReleaseSchema = z
  .object({
    platform: z.literal('android'),
    channel: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/),
    architecture: z.literal('arm64-v8a'),
    packageName: z.string().min(1).max(256),
    versionCode: z.number().int().positive().max(2_100_000_000),
    versionName: z.string().min(1).max(256),
    buildId: opaqueId,
    publishedAt: z.number().int().positive(),
    minimumAndroid: z.number().int().min(21).max(10_000),
    nativeBridgeMinimum: z.number().int().positive().max(1_000),
    nativeBridgeMaximum: z.number().int().positive().max(1_000),
    importance: z.enum(['recommended', 'required']),
    releaseNotes: z.array(z.string().min(1).max(500)).max(20),
    artifact: z
      .object({
        url: z.url().max(2_048).refine(value => {
          const url = new URL(value)
          const trustedScheme = url.protocol === 'https:'
            || (
              url.protocol === 'http:'
              && url.hostname === '127.0.0.1'
              && Number(url.port) >= 1
              && Number(url.port) <= 65_535
            )
          return trustedScheme
            && !url.username
            && !url.password
            && !url.search
            && !url.hash
        }, 'Native release artifacts must use credential-free HTTPS URLs'),
        size: z.number().int().positive().max(100 * 1024 * 1024),
        sha256: z.string().regex(/^[0-9a-f]{64}$/),
        signingCertificateSha256: z.string().regex(/^[0-9a-f]{64}$/),
      })
      .strict(),
  })
  .strict()
  .refine(value => value.nativeBridgeMinimum <= value.nativeBridgeMaximum, {
    message: 'Native bridge minimum cannot exceed its maximum',
  })

export type NativeClientRelease = z.infer<typeof nativeClientReleaseSchema>

export const mlp3SessionExtensionBindingSchema = sessionExtensionBindingSchema

const sessionSettingsPatchSchema = z
  .object({
    title: z.string().min(1).max(512).optional(),
    model: z.string().min(1).max(256).nullable().optional(),
    reasoningEffort: z.string().min(1).max(64).nullable().optional(),
    permissionMode: z
      .enum(['default', 'accept_edits', 'plan', 'bypass_permissions'])
      .optional(),
    extensions: z.array(mlp3SessionExtensionBindingSchema).max(8).optional(),
    controls: providerControlValuesSchema.optional(),
  })
  .strict()
  .refine(value => Object.values(value).some(field => field !== undefined), {
    message: 'A session update requires at least one changed field',
  })

const sessionCreatePayloadSchema = z
  .object({
    operation: z.literal('session.create'),
    scope: z.enum(['project', 'scratch']).optional(),
    title: z.string().min(1).max(512).optional(),
    model: z.string().min(1).max(256).optional(),
    provider: z.string().min(1).max(256).optional(),
    providerSessionId: opaqueId.optional(),
    reasoningEffort: z.string().min(1).max(64).optional(),
    permissionMode: z
      .enum(['default', 'accept_edits', 'plan', 'bypass_permissions'])
      .optional(),
    extensions: z.array(mlp3SessionExtensionBindingSchema).max(8).optional(),
    controls: providerControlValuesSchema.optional(),
    initialPrompt: z
      .object({
        text: z.string(),
        attachments: z.array(attachmentSchema).max(10).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.initialPrompt
      && value.initialPrompt.text.length === 0
      && (value.initialPrompt.attachments?.length ?? 0) === 0
    ) {
      context.addIssue({
        code: 'custom',
        path: ['initialPrompt'],
        message: 'An initial prompt requires text or an attachment',
      })
    }
  })

const promptSubmitPayloadSchema = z
  .object({
    operation: z.literal('prompt.submit'),
    text: z.string(),
    attachments: z.array(attachmentSchema).max(10).optional(),
  })
  .strict()
  .refine(
    value => value.text.length > 0 || (value.attachments?.length ?? 0) > 0,
    { message: 'A prompt requires text or an attachment' },
  )

const turnCancelPayloadSchema = z
  .object({ operation: z.literal('turn.cancel'), turnId: opaqueId })
  .strict()
const decisionAnswerPayloadSchema = z
  .object({
    operation: z.literal('decision.answer'),
    requestId: opaqueId,
    decision: z.string().min(1).max(256),
    totp: z.string().regex(/^\d{6}$/u).optional(),
  })
  .strict()
const artifactMaterializePayloadSchema = z
  .object({
    operation: z.literal('artifact.materialize'),
    referenceId: opaqueId,
    expectedStatRevision: opaqueId,
  })
  .strict()
const artifactMaterializationUiSchema = z
  .object({
    kind: z.literal('artifact_materialization'),
    version: z.literal(1),
    referenceId: opaqueId,
    status: z.enum(['materialized', 'changed']),
  })
  .strict()

const commandReconciledPayloadSchema = z
  .object({
    type: z.literal('command.reconciled'),
    commandId: opaqueId,
    state: z.enum(['accepted', 'running', 'terminal']),
    acceptedAt: timestamp,
    dispatchedAt: timestamp.optional(),
    terminalAt: timestamp.optional(),
    outcome: z
      .enum(['succeeded', 'failed', 'cancelled', 'rejected', 'interrupted'])
      .optional(),
    result: jsonValueSchema.optional(),
    error: z
      .object({
        code: z.string().min(1).max(128),
        message: z.string().min(1).max(8_192),
        retryable: z.boolean(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const terminal = value.state === 'terminal'
    if (terminal !== (value.outcome !== undefined)) {
      context.addIssue({
        code: 'custom',
        path: ['outcome'],
        message: 'A reconciled terminal command requires an outcome',
      })
    }
    if (!terminal && (value.terminalAt !== undefined || value.result !== undefined || value.error)) {
      context.addIssue({
        code: 'custom',
        path: ['state'],
        message: 'Only a reconciled terminal command may carry terminal data',
      })
    }
    if (value.state === 'accepted' && value.dispatchedAt !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['dispatchedAt'],
        message: 'An accepted command has not been dispatched',
      })
    }
    const failed = value.outcome === 'failed'
      || value.outcome === 'rejected'
      || value.outcome === 'interrupted'
    if (terminal && failed !== (value.error !== undefined)) {
      context.addIssue({
        code: 'custom',
        path: ['error'],
        message: 'A failed reconciled command requires an error',
      })
    }
  })
const sessionUpdatePayloadSchema = z
  .object({ operation: z.literal('session.update'), patch: sessionSettingsPatchSchema })
  .strict()
const sessionLifecyclePayloadSchema = z
  .object({
    operation: z.literal('session.set_lifecycle'),
    state: z.enum(['active', 'archived', 'deleted']),
  })
  .strict()
const deviceInvitationPayloadSchema = z
  .object({
    operation: z.literal('device.invitation.create'),
    lifetimeMs: z.number().int().min(30_000).max(10 * 60_000).optional(),
  })
  .strict()
const gatewayEnrollmentInvitationPayloadSchema = z
  .object({
    operation: z.literal('gateway.enrollment.invitation.create'),
    lifetimeMs: z.number().int().min(30_000).max(10 * 60_000).optional(),
  })
  .strict()
const gatewayEnrollmentApprovePayloadSchema = z
  .object({
    operation: z.literal('gateway.enrollment.approve'),
    enrollmentId: opaqueId,
  })
  .strict()
const gatewayEnrollmentCancelPayloadSchema = z
  .object({
    operation: z.literal('gateway.enrollment.cancel'),
    enrollmentId: opaqueId,
  })
  .strict()
const gatewayProfileUpdatePayloadSchema = z
  .object({
    operation: z.literal('gateway.profile.update'),
    gatewayNodeId: opaqueId,
    gatewayName: z.string().trim().min(1).max(128),
  })
  .strict()
const gatewayRetirePayloadSchema = z
  .object({
    operation: z.literal('gateway.retire'),
    gatewayNodeId: opaqueId,
    expectedDirectoryRevision: z.number().int().nonnegative(),
    expectedGatewayKeyId: base64Url.length(43),
  })
  .strict()
const projectCreatePayloadSchema = z
  .object({
    operation: z.literal('project.create'),
    name: z.string().min(1).max(256),
    cwd: z.string().min(1).max(8_192),
    provider: z.string().min(1).max(256).optional(),
    createDirectory: z.boolean().optional(),
  })
  .strict()
const projectUpdatePayloadSchema = z
  .object({
    operation: z.literal('project.update'),
    patch: z
      .object({
        name: z.string().trim().min(1).max(256).optional(),
        model: z.string().min(1).max(256).nullable().optional(),
        reasoningEffort: z.string().min(1).max(64).nullable().optional(),
        defaultExtensions: z.array(mlp3SessionExtensionBindingSchema).max(8).optional(),
        controls: providerControlValuesSchema.optional(),
      })
      .strict()
      .refine(value => Object.values(value).some(field => field !== undefined), {
        message: 'A project update requires at least one changed field',
      }),
  })
  .strict()
const projectDeletePayloadSchema = z
  .object({ operation: z.literal('project.delete') })
  .strict()
const providerSessionsListPayloadSchema = z
  .object({
    operation: z.literal('provider.sessions.list'),
    provider: z.string().min(1).max(256),
    cursor: z.string().min(1).max(4_096).optional(),
  })
  .strict()
const providerSessionInspectPayloadSchema = z
  .object({
    operation: z.literal('provider.session.inspect'),
    provider: z.string().min(1).max(256),
    providerSessionId: opaqueId,
  })
  .strict()
const providerHistoryMaterializePayloadSchema = z
  .object({
    operation: z.literal('provider.history.materialize'),
    expectedFrontier: z.number().int().nonnegative(),
    limit: z.number().int().min(1).max(100).optional(),
  })
  .strict()
const notificationSubscribePayloadSchema = z
  .object({
    operation: z.literal('notification.subscribe'),
    subscription: webPushSubscriptionSchema,
  })
  .strict()
const notificationUnsubscribePayloadSchema = z
  .object({
    operation: z.literal('notification.unsubscribe'),
    endpoint: z.string().url().max(4_096).optional(),
  })
  .strict()
const gatewayUpdateStagePayloadSchema = z
  .object({
    operation: z.literal('gateway.update.stage'),
    releaseId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u),
  })
  .strict()
const gatewayUpdateApplyPayloadSchema = z
  .object({
    operation: z.literal('gateway.update.apply'),
    releaseId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u),
    mode: z.enum(['when_idle', 'force']).default('when_idle'),
    allowForwardOnly: z.literal(true).optional(),
  })
  .strict()
const gatewayUpdateStatusPayloadSchema = z
  .object({ operation: z.literal('gateway.update.status') })
  .strict()
const gatewayRestartPayloadSchema = z
  .object({
    operation: z.literal('gateway.restart'),
    mode: z.enum(['when_idle', 'force']),
  })
  .strict()
const gatewayRestartStatusPayloadSchema = z
  .object({ operation: z.literal('gateway.restart.status') })
  .strict()

export const mlp3CommandPayloadSchema = z.discriminatedUnion('operation', [
  sessionCreatePayloadSchema,
  promptSubmitPayloadSchema,
  turnCancelPayloadSchema,
  decisionAnswerPayloadSchema,
  artifactMaterializePayloadSchema,
  sessionUpdatePayloadSchema,
  sessionLifecyclePayloadSchema,
  projectCreatePayloadSchema,
  projectUpdatePayloadSchema,
  projectDeletePayloadSchema,
  providerSessionsListPayloadSchema,
  providerSessionInspectPayloadSchema,
  providerHistoryMaterializePayloadSchema,
  deviceInvitationPayloadSchema,
  gatewayEnrollmentInvitationPayloadSchema,
  gatewayEnrollmentApprovePayloadSchema,
  gatewayEnrollmentCancelPayloadSchema,
  gatewayProfileUpdatePayloadSchema,
  gatewayRetirePayloadSchema,
  notificationSubscribePayloadSchema,
  notificationUnsubscribePayloadSchema,
  gatewayUpdateStagePayloadSchema,
  gatewayUpdateApplyPayloadSchema,
  gatewayUpdateStatusPayloadSchema,
  gatewayRestartPayloadSchema,
  gatewayRestartStatusPayloadSchema,
])

export type Mlp3CommandPayload = z.infer<
  typeof mlp3CommandPayloadSchema
>
export type Mlp3CommandOperation = Mlp3CommandPayload['operation']

const commandCommon = {
  kind: z.literal('malink.command'),
  version: z.literal(MALINK_PROTOCOL_VERSION),
  commandId: opaqueId,
  workspaceId: opaqueId,
  deviceId: opaqueId,
  certificateId: opaqueId,
  createdAt: timestamp,
}

const projectCommandCommon = { ...commandCommon, projectId: requiredProjectId }
const sessionCommandCommon = { ...projectCommandCommon, sessionId: requiredSessionId }

/** The whole command is a discriminated union, not merely its payload. */
export const mlp3CommandSchema = z.union([
  z.object({
    ...projectCommandCommon,
    sessionId: requiredSessionId,
    operation: z.literal('session.create'),
    payload: sessionCreatePayloadSchema,
  }).strict(),
  z.object({
    ...sessionCommandCommon,
    operation: z.literal('prompt.submit'),
    payload: promptSubmitPayloadSchema,
  }).strict(),
  z.object({
    ...projectCommandCommon,
    sessionId: z.undefined().optional(),
    operation: z.literal('project.create'),
    payload: projectCreatePayloadSchema,
  }).strict(),
  z.object({
    ...projectCommandCommon,
    sessionId: z.undefined().optional(),
    operation: z.literal('project.update'),
    payload: projectUpdatePayloadSchema,
  }).strict(),
  z.object({
    ...projectCommandCommon,
    sessionId: z.undefined().optional(),
    operation: z.literal('project.delete'),
    payload: projectDeletePayloadSchema,
  }).strict(),
  z.object({
    ...projectCommandCommon,
    sessionId: z.undefined().optional(),
    operation: z.literal('provider.sessions.list'),
    payload: providerSessionsListPayloadSchema,
  }).strict(),
  z.object({
    ...projectCommandCommon,
    sessionId: z.undefined().optional(),
    operation: z.literal('provider.session.inspect'),
    payload: providerSessionInspectPayloadSchema,
  }).strict(),
  z.object({
    ...sessionCommandCommon,
    operation: z.literal('provider.history.materialize'),
    payload: providerHistoryMaterializePayloadSchema,
  }).strict(),
  z.object({
    ...sessionCommandCommon,
    operation: z.literal('turn.cancel'),
    payload: turnCancelPayloadSchema,
  }).strict(),
  z.object({
    ...sessionCommandCommon,
    operation: z.literal('decision.answer'),
    payload: decisionAnswerPayloadSchema,
  }).strict(),
  z.object({
    ...sessionCommandCommon,
    operation: z.literal('artifact.materialize'),
    payload: artifactMaterializePayloadSchema,
  }).strict(),
  z.object({
    ...sessionCommandCommon,
    operation: z.literal('session.update'),
    payload: sessionUpdatePayloadSchema,
  }).strict(),
  z.object({
    ...sessionCommandCommon,
    operation: z.literal('session.set_lifecycle'),
    payload: sessionLifecyclePayloadSchema,
  }).strict(),
  z.object({
    ...commandCommon,
    projectId: opaqueId.optional(),
    sessionId: opaqueId.optional(),
    operation: z.literal('device.invitation.create'),
    payload: deviceInvitationPayloadSchema,
  }).strict(),
  z.object({
    ...commandCommon,
    projectId: opaqueId.optional(),
    sessionId: opaqueId.optional(),
    operation: z.literal('gateway.enrollment.invitation.create'),
    payload: gatewayEnrollmentInvitationPayloadSchema,
  }).strict(),
  z.object({
    ...commandCommon,
    projectId: opaqueId.optional(),
    sessionId: opaqueId.optional(),
    operation: z.literal('gateway.enrollment.approve'),
    payload: gatewayEnrollmentApprovePayloadSchema,
  }).strict(),
  z.object({
    ...commandCommon,
    projectId: opaqueId.optional(),
    sessionId: opaqueId.optional(),
    operation: z.literal('gateway.enrollment.cancel'),
    payload: gatewayEnrollmentCancelPayloadSchema,
  }).strict(),
  z.object({
    ...projectCommandCommon,
    sessionId: z.undefined().optional(),
    operation: z.literal('gateway.profile.update'),
    payload: gatewayProfileUpdatePayloadSchema,
  }).strict(),
  z.object({
    ...projectCommandCommon,
    sessionId: z.undefined().optional(),
    operation: z.literal('gateway.retire'),
    payload: gatewayRetirePayloadSchema,
  }).strict(),
  z.object({
    ...projectCommandCommon,
    sessionId: z.undefined().optional(),
    operation: z.literal('notification.subscribe'),
    payload: notificationSubscribePayloadSchema,
  }).strict(),
  z.object({
    ...projectCommandCommon,
    sessionId: z.undefined().optional(),
    operation: z.literal('notification.unsubscribe'),
    payload: notificationUnsubscribePayloadSchema,
  }).strict(),
  z.object({
    ...projectCommandCommon,
    sessionId: z.undefined().optional(),
    operation: z.literal('gateway.update.stage'),
    payload: gatewayUpdateStagePayloadSchema,
  }).strict(),
  z.object({
    ...projectCommandCommon,
    sessionId: z.undefined().optional(),
    operation: z.literal('gateway.update.apply'),
    payload: gatewayUpdateApplyPayloadSchema,
  }).strict(),
  z.object({
    ...projectCommandCommon,
    sessionId: z.undefined().optional(),
    operation: z.literal('gateway.update.status'),
    payload: gatewayUpdateStatusPayloadSchema,
  }).strict(),
  z.object({
    ...projectCommandCommon,
    sessionId: z.undefined().optional(),
    operation: z.literal('gateway.restart'),
    payload: gatewayRestartPayloadSchema,
  }).strict(),
  z.object({
    ...projectCommandCommon,
    sessionId: z.undefined().optional(),
    operation: z.literal('gateway.restart.status'),
    payload: gatewayRestartStatusPayloadSchema,
  }).strict(),
])

export type Mlp3Command = z.infer<typeof mlp3CommandSchema>

export const signedMlp3CommandSchema = z
  .object({ command: mlp3CommandSchema, signature: signatureSchema })
  .strict()

export type SignedMlp3Command = z.infer<
  typeof signedMlp3CommandSchema
>

const sessionProjectionSchema = z
  .object({
    title: z.string().min(1).max(512),
    scope: z.enum(['project', 'scratch']).optional(),
    cwd: z.string().min(1).max(8_192).optional(),
    lifecycle: z.enum(['active', 'archived', 'deleted']),
    activity: z.enum(['idle', 'queued', 'working', 'attention', 'failed']),
    updatedAt: timestamp,
    stateVersion: z.number().int().positive(),
    extensions: z.array(sessionExtensionSummarySchema).max(8).optional(),
    availableCommands: z.array(providerCommandSchema).max(256).optional(),
    extensionRevision: z.number().int().positive().optional(),
    providerHistory: providerHistoryRoomBindingSchema.optional(),
    controls: z.array(providerControlSchema).max(64).optional(),
  })
  .strict()

export type Mlp3SessionProjection = z.infer<
  typeof sessionProjectionSchema
>

export const mlp3EventPayloadSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('workspace.snapshot'),
      protocolMin: z.number().int().positive(),
      protocolMax: z.number().int().positive(),
      gatewayKeyId: opaqueId,
      capabilities: matrixGatewayCapabilitiesSchema,
      clientReleases: z.array(nativeClientReleaseSchema).max(8).optional(),
      gatewayDirectory: signedWorkspaceGatewayDirectorySchema.optional(),
      pendingGatewayEnrollments: z.array(gatewayEnrollmentPendingSchema).max(32).optional(),
      gatewayUpdate: gatewayUpdateStatusSchema.optional(),
      snapshotVersion: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      type: z.literal('provider.catalog.page'),
      providerId: opaqueId,
      catalog: z.literal('models'),
      revision: base64Url.length(43),
      pageIndex: z.number().int().nonnegative(),
      pageCount: z.number().int().positive().max(4_096),
      items: z.array(matrixModelCapabilitySchema).min(1).max(64),
    })
    .strict()
    .superRefine((page, context) => {
      if (page.pageIndex >= page.pageCount) {
        context.addIssue({
          code: 'custom',
          path: ['pageIndex'],
          message: 'Provider catalog page index must be inside its page count',
        })
      }
    }),
  z
    .object({
      type: z.literal('provider.catalog.manifest'),
      providerId: opaqueId,
      catalog: z.literal('models'),
      revision: base64Url.length(43),
      status: z.enum(['loading', 'ready', 'stale', 'error']),
      itemCount: z.number().int().nonnegative().max(4_096),
      pageCount: z.number().int().nonnegative().max(4_096),
      error: providerControlErrorSchema.optional(),
    })
    .strict()
    .superRefine((manifest, context) => {
      if (manifest.itemCount === 0 && manifest.pageCount !== 0) {
        context.addIssue({
          code: 'custom',
          path: ['pageCount'],
          message: 'An empty provider catalog cannot contain pages',
        })
      }
      if (manifest.itemCount > 0 && manifest.pageCount === 0) {
        context.addIssue({
          code: 'custom',
          path: ['pageCount'],
          message: 'A non-empty provider catalog must contain pages',
        })
      }
      if ((manifest.status === 'loading' || manifest.status === 'error')
        && (manifest.itemCount !== 0 || manifest.pageCount !== 0)) {
        context.addIssue({
          code: 'custom',
          path: ['status'],
          message: 'An unavailable provider catalog cannot advertise items',
        })
      }
      if ((manifest.status === 'error' || manifest.status === 'stale') && !manifest.error) {
        context.addIssue({
          code: 'custom',
          path: ['error'],
          message: 'An unavailable or stale provider catalog requires an error',
        })
      }
      if (manifest.status !== 'error' && manifest.status !== 'stale' && manifest.error) {
        context.addIssue({
          code: 'custom',
          path: ['error'],
          message: 'Only unavailable or stale provider catalogs may include an error',
        })
      }
    }),
  z
    .object({
      type: z.literal('project.snapshot'),
      name: z.string().min(1).max(256),
      cwd: z.string().min(1).max(8_192),
      provider: z.string().min(1).max(256),
      model: z.string().min(1).max(256).optional(),
      reasoningEffort: z.string().min(1).max(64).optional(),
      permissionMode: z.string().min(1).max(128),
      installedExtensions: z.array(sessionExtensionDescriptorSchema).max(64).optional(),
      defaultExtensions: z.array(mlp3SessionExtensionBindingSchema).max(8).optional(),
      controls: providerControlValuesSchema.optional(),
      extensionDefaultsRevision: z.number().int().positive().optional(),
      snapshotVersion: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      type: z.literal('session.ready'),
      rootCommandId: opaqueId.optional(),
      originDeviceId: opaqueId.optional(),
      initialPrompt: z
        .object({
          text: z.string(),
          attachments: z.array(attachmentSchema).max(10).optional(),
        })
        .strict()
        .optional(),
      projection: sessionProjectionSchema,
      provider: z.string().min(1).max(256),
      model: z.string().min(1).max(256).optional(),
      reasoningEffort: z.string().min(1).max(64).optional(),
      permissionMode: z.string().min(1).max(128),
      extensionBindings: z.array(mlp3SessionExtensionBindingSchema).max(8).optional(),
      controls: providerControlValuesSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('session.updated'),
      projection: sessionProjectionSchema,
      patch: sessionSettingsPatchSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('session.lifecycle'),
      projection: sessionProjectionSchema,
      state: z.enum(['active', 'archived', 'deleted']),
      alreadyApplied: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('turn.queued'),
      turnId: opaqueId,
      originDeviceId: opaqueId,
      text: z.string(),
      attachments: z.array(attachmentSchema).max(10).optional(),
      projection: sessionProjectionSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('turn.started'),
      turnId: opaqueId,
      projection: sessionProjectionSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('turn.completed'),
      turnId: opaqueId,
      projection: sessionProjectionSchema,
      outcome: z.enum(['succeeded', 'cancelled']),
    })
    .strict(),
  z
    .object({
      type: z.literal('turn.failed'),
      turnId: opaqueId,
      projection: sessionProjectionSchema,
      code: z.string().min(1).max(128),
      message: z.string().min(1).max(8_192),
    })
    .strict(),
  z
    .object({
      type: z.literal('assistant.message'),
      messageId: opaqueId,
      messageVersion: z.number().int().positive(),
      body: z.string(),
      format: z.enum(['plain', 'markdown']).default('markdown'),
      final: z.boolean(),
      partIndex: z.number().int().nonnegative().optional(),
      partCount: z.number().int().positive().optional(),
      projection: sessionProjectionSchema,
      ui: jsonValueSchema.optional(),
      attachments: z.array(attachmentSchema).max(10).optional(),
      artifactReferences: z.array(artifactReferenceSchema).max(10).optional(),
    })
    .strict()
    .superRefine((value, context) => {
      if ((value.partIndex === undefined) !== (value.partCount === undefined)) {
        context.addIssue({
          code: 'custom',
          path: ['partIndex'],
          message: 'Message part index and count must be provided together',
        })
      } else if (
        value.partIndex !== undefined
        && value.partCount !== undefined
        && value.partIndex >= value.partCount
      ) {
        context.addIssue({
          code: 'custom',
          path: ['partIndex'],
          message: 'Message part index must be smaller than part count',
        })
      }
      if (
        value.ui
        && typeof value.ui === 'object'
        && !Array.isArray(value.ui)
        && value.ui.kind === 'artifact_materialization'
      ) {
        const marker = artifactMaterializationUiSchema.safeParse(value.ui)
        if (!marker.success) {
          context.addIssue({
            code: 'custom',
            path: ['ui'],
            message: 'Artifact materialization UI metadata is invalid',
          })
          return
        }
        if (!value.artifactReferences?.some(item => item.id === marker.data.referenceId)) {
          context.addIssue({
            code: 'custom',
            path: ['artifactReferences'],
            message: 'Artifact materialization must include its referenced stat metadata',
          })
        }
        const hasAttachment = value.attachments?.some(
          attachment => attachment.id === marker.data.referenceId,
        ) === true
        if (marker.data.status === 'materialized' && !hasAttachment) {
          context.addIssue({
            code: 'custom',
            path: ['attachments'],
            message: 'A materialized artifact must include its attachment descriptor',
          })
        }
        if (marker.data.status === 'changed' && hasAttachment) {
          context.addIssue({
            code: 'custom',
            path: ['attachments'],
            message: 'A changed artifact must require confirmation before attachment delivery',
          })
        }
      }
    }),
  z
    .object({
      type: z.literal('inbox.file.received'),
      fileId: opaqueId,
      caption: z.string().max(8_192).optional(),
      source: z
        .object({
          kind: z.literal('local-cli'),
          label: z.string().min(1).max(256).optional(),
        })
        .strict(),
      attachment: attachmentSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('tool.activity'),
      toolCallId: opaqueId,
      toolVersion: z.number().int().positive(),
      name: z.string().min(1).max(256),
      phase: z.enum(['started', 'updated', 'completed', 'failed']),
      input: jsonValueSchema.optional(),
      output: jsonValueSchema.optional(),
      projection: sessionProjectionSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('decision.requested'),
      decisionType: z.enum(['permission', 'question', 'privilege']).default('permission'),
      requestId: opaqueId,
      title: z.string().min(1).max(1_024),
      details: jsonValueSchema.optional(),
      options: z
        .array(z.object({ label: z.string(), value: z.string() }).strict())
        .min(1)
        .max(16),
      expiresAt: timestamp.optional(),
      projection: sessionProjectionSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('extension.interaction.requested'),
      requestId: opaqueId,
      extension: sessionExtensionSummarySchema,
      view: sessionExtensionViewSchema,
      cancelActionId: sessionExtensionActionIdSchema,
      projection: sessionProjectionSchema,
    })
    .strict()
    .refine(
      value => value.view.actions.some(action => action.id === value.cancelActionId),
      { message: 'Extension interaction cancel action must be present in the view' },
    ),
  z
    .object({
      type: z.literal('decision.resolved'),
      requestId: opaqueId,
      decision: z.string().min(1).max(128),
      projection: sessionProjectionSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('extension.interaction.resolved'),
      requestId: opaqueId,
      extensionId: opaqueId,
      actionId: sessionExtensionActionIdSchema,
      projection: sessionProjectionSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('command.rejected'),
      commandId: opaqueId,
      code: z.string().min(1).max(128),
      message: z.string().min(1).max(8_192),
      retryable: z.boolean(),
    })
    .strict(),
  commandReconciledPayloadSchema,
  z
    .object({
      type: z.literal('project.created'),
      gatewayNodeId: opaqueId,
      projectId: opaqueId,
      roomId: matrixRoomId,
      conversationId: opaqueId,
      name: z.string().min(1).max(256),
      cwd: z.string().min(1).max(8_192),
      alreadyExisted: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('project.deleted'),
      projectId: opaqueId,
      name: z.string().min(1).max(256),
    })
    .strict(),
  z
    .object({
      type: z.literal('provider.sessions.listed'),
      provider: z.string().min(1).max(256),
      sessions: z.array(providerSessionEntrySchema).max(256),
      nextCursor: z.string().min(1).max(4_096).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('provider.session.inspected'),
      provider: z.string().min(1).max(256),
      providerSessionId: opaqueId,
      title: z.string().min(1).max(512),
      managedSessionId: opaqueId.optional(),
      latestArchivedSessionId: opaqueId.optional(),
      lastArchivedAt: timestamp.optional(),
      messages: z.array(providerHistoryMessageSchema).max(256),
    })
    .strict()
    .refine(
      value => (value.latestArchivedSessionId === undefined) === (value.lastArchivedAt === undefined),
      { message: 'Archived Malink session identity and timestamp must be published together' },
    )
    .refine(value => JSON.stringify(value.messages).length <= 96 * 1024, {
      message: 'Provider session history is too large',
    }),
  z
    .object({
      type: z.literal('provider.history.message'),
      snapshotId: opaqueId,
      sourceMessageId: opaqueId,
      sourceOrdinal: z.number().int().nonnegative(),
      role: z.enum(['user', 'assistant']),
      body: z.string().max(16 * 1024),
      pageIndex: z.number().int().nonnegative(),
      partIndex: z.number().int().nonnegative().optional(),
      partCount: z.number().int().positive().optional(),
    })
    .strict()
    .superRefine((value, context) => {
      if ((value.partIndex === undefined) !== (value.partCount === undefined)) {
        context.addIssue({
          code: 'custom',
          path: ['partIndex'],
          message: 'History message part index and count must be provided together',
        })
      } else if (
        value.partIndex !== undefined
        && value.partCount !== undefined
        && value.partIndex >= value.partCount
      ) {
        context.addIssue({
          code: 'custom',
          path: ['partIndex'],
          message: 'History message part index must be less than part count',
        })
      }
    }),
  z
    .object({
      type: z.literal('provider.history.page.committed'),
      snapshotId: opaqueId,
      pageIndex: z.number().int().nonnegative(),
      previousFrontier: z.number().int().nonnegative(),
      frontier: z.number().int().nonnegative(),
      messageCount: z.number().int().nonnegative(),
      hasMore: z.boolean(),
      digest: base64Url.length(43),
    })
    .strict()
    .refine(value => value.frontier >= value.previousFrontier, {
      message: 'Provider history frontier cannot move backwards',
    }),
  z
    .object({
      type: z.literal('provider.history.materialized'),
      historyRoomId: matrixRoomId,
      snapshotId: opaqueId,
      previousFrontier: z.number().int().nonnegative(),
      frontier: z.number().int().nonnegative(),
      hasMore: z.boolean(),
      alreadyMaterialized: z.boolean().optional(),
    })
    .strict()
    .refine(value => value.frontier >= value.previousFrontier, {
      message: 'Provider history frontier cannot move backwards',
    }),
  z
    .object({
      type: z.literal('device.invitation.created'),
      pairingLink: z.string().min(1).max(128 * 1024),
      expiresAt: timestamp,
    })
    .strict(),
  z
    .object({
      type: z.literal('gateway.enrollment.invitation.created'),
      enrollmentLink: z.string().min(1).max(128 * 1024),
      expiresAt: timestamp,
    })
    .strict(),
  z
    .object({
      type: z.literal('gateway.enrollment.approved'),
      enrollmentId: opaqueId,
      gatewayNodeId: opaqueId,
      gatewayName: z.string().min(1).max(128),
    })
    .strict(),
  z
    .object({
      type: z.literal('gateway.enrollment.cancelled'),
      enrollmentId: opaqueId,
      gatewayNodeId: opaqueId,
      gatewayName: z.string().min(1).max(128),
    })
    .strict(),
  z
    .object({
      type: z.literal('gateway.profile.updated'),
      gatewayNodeId: opaqueId,
      gatewayName: z.string().min(1).max(128),
      computerName: z.string().min(1).max(128),
    })
    .strict(),
  z
    .object({
      type: z.literal('gateway.retired'),
      gatewayNodeId: opaqueId,
      removedProjectCount: z.number().int().nonnegative().max(256),
      directoryRevision: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      type: z.literal('notification.subscription.changed'),
      enabled: z.boolean(),
    })
    .strict(),
  z
    .object({
      type: z.literal('gateway.update.status'),
      status: gatewayUpdateStatusSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('gateway.restart.status'),
      status: gatewayRestartStatusSchema,
    })
    .strict(),
])

export type Mlp3EventPayload = z.infer<typeof mlp3EventPayloadSchema>

export const mlp3EventSchema = z
  .object({
    kind: z.literal('malink.event'),
    version: z.literal(MALINK_PROTOCOL_VERSION),
    eventId: opaqueId,
    workspaceId: opaqueId,
    projectId: opaqueId.optional(),
    sessionId: opaqueId.optional(),
    occurredAt: timestamp,
    causationCommandId: opaqueId.optional(),
    payload: mlp3EventPayloadSchema,
  })
  .strict()

export type Mlp3Event = z.infer<typeof mlp3EventSchema>

export const signedMlp3EventSchema = z
  .object({ event: mlp3EventSchema, signature: signatureSchema })
  .strict()

export type SignedMlp3Event = z.infer<typeof signedMlp3EventSchema>

export const mlp3PlaintextSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('signed_command'),
      value: signedMlp3CommandSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('signed_event'),
      value: signedMlp3EventSchema,
    })
    .strict(),
])

export type Mlp3Plaintext = z.infer<typeof mlp3PlaintextSchema>

/** One content envelope is used for commands, events, edits and snapshots. */
export const mlp3ContentEnvelopeSchema = z
  .object({
    kind: z.literal('malink.project-envelope'),
    version: z.literal(MALINK_PROTOCOL_VERSION),
    roomId: matrixRoomId,
    projectId: opaqueId,
    keyId: opaqueId,
    logicalEventId: opaqueId,
    nonce: base64Url.length(16),
    ciphertext: base64Url.min(22).max(128 * 1024),
  })
  .strict()

export type Mlp3ContentEnvelope = z.infer<
  typeof mlp3ContentEnvelopeSchema
>

export const mlp3TimelineContentSchema = z
  .object({
    msgtype: z.literal('m.notice'),
    body: z.literal('Encrypted Malink event'),
    'm.relates_to': z.record(z.string(), jsonValueSchema).optional(),
    [MALINK_MATRIX_EXTENSION]: z
      .object({
        version: z.literal(MALINK_PROTOCOL_VERSION),
        envelope: mlp3ContentEnvelopeSchema,
      })
      .strict(),
  })
  .strict()

export const mlp3CurrentPointerDocumentSchema = z
  .object({
    kind: z.enum(['workspace.current', 'project.current']),
    version: z.literal(MALINK_PROTOCOL_VERSION),
    workspaceId: opaqueId,
    projectId: opaqueId.optional(),
    roomId: matrixRoomId,
    eventId: matrixEventId,
    logicalEventId: opaqueId,
    snapshotVersion: z.number().int().positive(),
    gatewayKeyId: opaqueId,
    updatedAt: timestamp,
  })
  .strict()

export const mlp3CurrentPointerSchema = z
  .object({
    document: mlp3CurrentPointerDocumentSchema,
    signature: signatureSchema,
  })
  .strict()

export type Mlp3CurrentPointer = z.infer<
  typeof mlp3CurrentPointerSchema
>

/**
 * Key grants are the only pairwise application envelope in MLP/3. They are
 * directly addressable Matrix state and are never repeated on timeline data.
 */
export const mlp3ProjectKeyGrantStateSchema = z
  .object({
    kind: z.literal('project.key_grant'),
    version: z.literal(MALINK_PROTOCOL_VERSION),
    workspaceId: opaqueId,
    projectId: opaqueId,
    roomId: matrixRoomId,
    deviceId: opaqueId,
    certificateId: opaqueId,
    grantId: opaqueId,
    sealedGrant: z
      .object({
        envelope: z
          .object({
            kind: z.literal('malink.project-key-grant-envelope'),
            version: z.literal(MALINK_PROTOCOL_VERSION),
            grantId: opaqueId,
            workspaceId: opaqueId,
            projectId: opaqueId,
            roomId: matrixRoomId,
            deviceId: opaqueId,
            certificateId: opaqueId,
            senderKeyId: base64Url.length(43),
            recipientKeyId: base64Url.length(43),
            nonce: base64Url.length(16),
            ciphertext: base64Url.min(22).max(64 * 1024),
          })
          .strict(),
        signature: signatureSchema,
      })
      .strict(),
  })
  .strict()

export const mlp3ProjectKeyGrantPlaintextSchema = z
  .object({
    kind: z.literal('project.key_grant'),
    version: z.literal(MALINK_PROTOCOL_VERSION),
    workspaceId: opaqueId,
    projectId: opaqueId,
    roomId: matrixRoomId,
    deviceId: opaqueId,
    certificateId: opaqueId,
    activeKeyId: opaqueId,
    keys: z
      .array(
        z
          .object({
            keyId: opaqueId,
            key: base64Url.length(43),
            createdAt: timestamp,
          })
          .strict(),
      )
      .min(1)
      .max(64),
  })
  .strict()
  .superRefine((grant, context) => {
    const ids = grant.keys.map(key => key.keyId)
    if (new Set(ids).size !== ids.length) {
      context.addIssue({ code: 'custom', path: ['keys'], message: 'Key IDs must be unique' })
    }
    if (!ids.includes(grant.activeKeyId)) {
      context.addIssue({
        code: 'custom',
        path: ['activeKeyId'],
        message: 'The active key must be included in the grant',
      })
    }
  })

export type Mlp3ProjectKeyGrantPlaintext = z.infer<
  typeof mlp3ProjectKeyGrantPlaintextSchema
>

export const mlp3ProjectKeyGrantEnvelopeSchema =
  mlp3ProjectKeyGrantStateSchema.shape.sealedGrant

export type Mlp3ProjectKeyGrantEnvelope = z.infer<
  typeof mlp3ProjectKeyGrantEnvelopeSchema
>
