import { z } from 'zod'

export const PROTOCOL_VERSION = 1 as const
export const MAX_MALINK_ATTACHMENT_BYTES = 50 * 1024 * 1024
export const MAX_MALINK_ATTACHMENTS = 10
export const MAX_MALINK_PROMPT_ATTACHMENT_BYTES = 100 * 1024 * 1024

const opaqueId = z.string().min(1).max(256)
const timestamp = z.number().int().nonnegative()
const jsonPrimitive: z.ZodType<null | boolean | number | string> = z.union([
  z.null(),
  z.boolean(),
  z.number().finite(),
  z.string(),
])
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue }
export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([jsonPrimitive, z.array(jsonValueSchema), z.record(z.string(), jsonValueSchema)]),
)

export const providerControlIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u)

export const providerControlValueSchema = z.union([
  z.string().max(4_096),
  z.boolean(),
])

export type ProviderControlValue = z.infer<typeof providerControlValueSchema>

export const providerControlValuesSchema = z
  .record(providerControlIdSchema, providerControlValueSchema)
  .refine(values => Object.keys(values).length <= 64, 'Provider control values contain too many entries')
  .refine(
    values => JSON.stringify(values).length <= 32 * 1024,
    'Provider control values are too large',
  )

export type ProviderControlValues = z.infer<typeof providerControlValuesSchema>

export const providerControlSurfaceSchema = z.enum([
  'project-default',
  'session-create',
  'session-active',
])

export type ProviderControlSurface = z.infer<typeof providerControlSurfaceSchema>

const providerControlConditionSchema = z
  .object({
    controlId: providerControlIdSchema,
    values: z.array(providerControlValueSchema).min(1).max(256),
  })
  .strict()

const providerControlOptionSchema = z
  .object({
    value: providerControlValueSchema,
    label: z.string().min(1).max(256),
    description: z.string().max(2_048).optional(),
    when: providerControlConditionSchema.optional(),
    defaults: providerControlValuesSchema.optional(),
  })
  .strict()

export const providerControlErrorSchema = z
  .object({
    code: z.string().min(1).max(128).regex(/^[a-z][a-z0-9._-]*$/u),
    message: z.string().min(1).max(2_048),
    retryable: z.boolean(),
    detail: z.string().min(1).max(4_096).optional(),
  })
  .strict()

export type ProviderControlError = z.infer<typeof providerControlErrorSchema>

export const providerControlSchema = z
  .object({
    id: providerControlIdSchema,
    label: z.string().min(1).max(256),
    description: z.string().max(2_048).optional(),
    renderer: z.enum(['select', 'segmented', 'toggle', 'text']),
    surfaces: z.array(providerControlSurfaceSchema).min(1).max(3),
    updateEffect: z.enum(['immediate', 'next-turn', 'restart-session']).optional(),
    status: z.enum(['loading', 'ready', 'stale', 'error']),
    options: z.array(providerControlOptionSchema).max(256).optional(),
    value: providerControlValueSchema.optional(),
    defaultValue: providerControlValueSchema.optional(),
    error: providerControlErrorSchema.optional(),
    checkedAt: z.number().int().nonnegative().optional(),
    deadlineAt: z.number().int().nonnegative().optional(),
    retryAt: z.number().int().nonnegative().optional(),
  })
  .strict()
  .superRefine((control, context) => {
    if (new Set(control.surfaces).size !== control.surfaces.length) {
      context.addIssue({
        code: 'custom',
        path: ['surfaces'],
        message: 'Provider control surfaces must be unique',
      })
    }
    if (
      (control.renderer === 'select' || control.renderer === 'segmented')
      && control.status === 'ready'
      && (!control.options || control.options.length === 0)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['options'],
        message: 'Ready selectable provider controls require options',
      })
    }
    if (control.status === 'loading' && control.deadlineAt === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['deadlineAt'],
        message: 'Loading provider controls require a deadline',
      })
    }
    const optionValues = new Set<string>()
    control.options?.forEach((option, index) => {
      const key = `${typeof option.value}:${String(option.value)}`
      if (optionValues.has(key)) {
        context.addIssue({
          code: 'custom',
          path: ['options', index, 'value'],
          message: 'Provider control option values must be unique',
        })
      }
      optionValues.add(key)
    })
    if (control.renderer === 'select' || control.renderer === 'segmented') {
      if (
        control.defaultValue !== undefined
        && !control.options?.some(option => option.value === control.defaultValue)
      ) {
        context.addIssue({
          code: 'custom',
          path: ['defaultValue'],
          message: 'Provider control defaults must match an advertised option',
        })
      }
    }
    if (
      control.renderer === 'toggle'
      && (
        (control.value !== undefined && typeof control.value !== 'boolean')
        || (control.defaultValue !== undefined && typeof control.defaultValue !== 'boolean')
      )
    ) {
      context.addIssue({
        code: 'custom',
        path: ['value'],
        message: 'Toggle provider controls require boolean values',
      })
    }
    if (
      control.renderer === 'text'
      && (
        (control.value !== undefined && typeof control.value !== 'string')
        || (control.defaultValue !== undefined && typeof control.defaultValue !== 'string')
      )
    ) {
      context.addIssue({
        code: 'custom',
        path: ['value'],
        message: 'Text provider controls require string values',
      })
    }
    if ((control.status === 'error' || control.status === 'stale') && !control.error) {
      context.addIssue({
        code: 'custom',
        path: ['error'],
        message: 'Failed or stale provider controls require an error',
      })
    }
    if (control.status !== 'error' && control.status !== 'stale' && control.error) {
      context.addIssue({
        code: 'custom',
        path: ['error'],
        message: 'Only failed or stale provider controls may include an error',
      })
    }
  })

export type ProviderControl = z.infer<typeof providerControlSchema>

const sessionExtensionSettingSchema = z.discriminatedUnion('type', [
  z
    .object({
      id: z.string().min(1).max(128),
      type: z.literal('text'),
      label: z.string().min(1).max(256),
      description: z.string().max(2_048).optional(),
      required: z.boolean().optional(),
      placeholder: z.string().max(512).optional(),
      defaultValue: z.string().max(4_096).optional(),
    })
    .strict(),
  z
    .object({
      id: z.string().min(1).max(128),
      type: z.literal('boolean'),
      label: z.string().min(1).max(256),
      description: z.string().max(2_048).optional(),
      defaultValue: z.boolean().optional(),
    })
    .strict(),
])

export type SessionExtensionSetting = z.infer<typeof sessionExtensionSettingSchema>

export const sessionExtensionDescriptorSchema = z
  .object({
    id: opaqueId,
    name: z.string().min(1).max(256),
    description: z.string().min(1).max(4_096),
    version: z.string().min(1).max(128),
    settings: z.array(sessionExtensionSettingSchema).max(32),
  })
  .strict()
  .superRefine((descriptor, context) => {
    const ids = new Set<string>()
    descriptor.settings.forEach((setting, index) => {
      if (ids.has(setting.id)) {
        context.addIssue({
          code: 'custom',
          path: ['settings', index, 'id'],
          message: 'Session extension setting IDs must be unique',
        })
      }
      ids.add(setting.id)
    })
  })

export type SessionExtensionDescriptor = z.infer<typeof sessionExtensionDescriptorSchema>

export const sessionExtensionSummarySchema = z
  .object({
    id: opaqueId,
    name: z.string().min(1).max(256),
    version: z.string().min(1).max(128),
  })
  .strict()

export type SessionExtensionSummary = z.infer<typeof sessionExtensionSummarySchema>

export const sessionExtensionManifestSchema = z
  .object({
    protocolVersion: z.literal(1),
    descriptor: sessionExtensionDescriptorSchema,
  })
  .strict()

export type SessionExtensionManifest = z.infer<typeof sessionExtensionManifestSchema>

export const sessionExtensionActionIdSchema = z
  .string()
  .min(1)
  .max(32)
  .regex(/^[a-z][a-z0-9._-]*$/)

const sessionExtensionViewElementSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('status'),
      tone: z.enum(['info', 'success', 'warning', 'error']),
      text: z.string().min(1).max(2_048),
    })
    .strict(),
  z
    .object({
      type: z.literal('text'),
      text: z.string().min(1).max(8_192),
    })
    .strict(),
  z
    .object({
      type: z.literal('readonly_textarea'),
      label: z.string().min(1).max(256),
      value: z.string().max(8 * 1024),
    })
    .strict(),
  z
    .object({
      type: z.literal('list'),
      label: z.string().min(1).max(256).optional(),
      items: z.array(z.string().min(1).max(2_048)).min(1).max(32),
    })
    .strict(),
])

export const sessionExtensionViewSchema = z
  .object({
    version: z.literal(1),
    title: z.string().min(1).max(256),
    elements: z.array(sessionExtensionViewElementSchema).max(16),
    actions: z
      .array(z
        .object({
          id: sessionExtensionActionIdSchema,
          label: z.string().min(1).max(64),
          style: z.enum(['primary', 'secondary', 'danger']).optional(),
        })
        .strict())
      .min(1)
      .max(8),
  })
  .strict()
  .superRefine((view, context) => {
    const ids = new Set<string>()
    view.actions.forEach((action, index) => {
      if (ids.has(action.id)) {
        context.addIssue({
          code: 'custom',
          path: ['actions', index, 'id'],
          message: 'Session extension action IDs must be unique',
        })
      }
      ids.add(action.id)
    })
    if (new TextEncoder().encode(JSON.stringify(view)).byteLength > 16 * 1024) {
      context.addIssue({
        code: 'custom',
        message: 'Session extension view is too large',
      })
    }
  })

export type SessionExtensionViewElement = z.infer<typeof sessionExtensionViewElementSchema>
export type SessionExtensionView = z.infer<typeof sessionExtensionViewSchema>

const sessionExtensionConfigSchema = z
  .record(z.string().min(1).max(128), jsonValueSchema)
  .refine((config) => Object.keys(config).length <= 32, 'Session extension config has too many settings')
  .refine(
    (config) => JSON.stringify(config).length <= 32 * 1024,
    'Session extension config is too large',
  )

export const sessionExtensionBindingSchema = z
  .object({
    id: opaqueId,
    config: sessionExtensionConfigSchema.optional(),
  })
  .strict()

export type SessionExtensionBinding = z.infer<typeof sessionExtensionBindingSchema>

export const encryptedMediaSchema = z
  .object({
    url: z.string().regex(/^mxc:\/\/[^/\s]+\/[^/\s]+$/),
    key: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    iv: z.string().regex(/^[A-Za-z0-9_-]{16}$/),
    sha256: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    size: z.number().int().positive().max(MAX_MALINK_ATTACHMENT_BYTES + 16),
  })
  .strict()

export type EncryptedMedia = z.infer<typeof encryptedMediaSchema>

export const attachmentSchema = z
  .object({
    id: opaqueId,
    name: z.string().min(1).max(1024),
    mimeType: z.string().min(1).max(256),
    size: z.number().int().nonnegative().max(MAX_MALINK_ATTACHMENT_BYTES),
    sha256: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    media: encryptedMediaSchema,
  })
  .strict()

export type MalinkAttachment = z.infer<typeof attachmentSchema>

export const artifactReferenceSchema = z
  .object({
    id: opaqueId,
    kind: z.enum(['file', 'image']),
    name: z.string().min(1).max(1_024),
    relativePath: z.string().min(1).max(4_096),
    mimeType: z.string().min(1).max(256),
    size: z.number().int().nonnegative().max(MAX_MALINK_ATTACHMENT_BYTES),
    modifiedAt: timestamp,
    statRevision: opaqueId,
  })
  .strict()

export type MalinkArtifactReference = z.infer<typeof artifactReferenceSchema>

export const commandPayloadSchema = z.discriminatedUnion('operation', [
  z
    .object({
      operation: z.literal('prompt'),
      sessionId: opaqueId,
      text: z.string(),
      attachments: z.array(attachmentSchema).max(MAX_MALINK_ATTACHMENTS).optional(),
    })
    .strict(),
  z
    .object({
      operation: z.literal('cancel'),
      sessionId: opaqueId,
      targetCommandId: opaqueId.optional(),
    })
    .strict(),
  z
    .object({
      operation: z.literal('decision'),
      sessionId: opaqueId,
      requestId: opaqueId,
      decision: sessionExtensionActionIdSchema,
      totp: z.string().regex(/^\d{6}$/u).optional(),
    })
    .strict(),
  z
    .object({
      operation: z.literal('artifact.materialize'),
      sessionId: opaqueId,
      referenceId: opaqueId,
      expectedStatRevision: opaqueId,
    })
    .strict(),
  z
    .object({
      operation: z.literal('session.settings'),
      sessionId: opaqueId,
      model: z.string().min(1).max(256).optional(),
      reasoningEffort: z.string().min(1).max(64).optional(),
      permissionMode: z.enum(['default', 'accept_edits', 'plan', 'bypass_permissions']).optional(),
      cwd: z.string().min(1).max(4096).optional(),
      projectName: z.string().min(1).max(256).optional(),
      controls: providerControlValuesSchema.optional(),
    })
    .strict()
    .refine(
      (settings) =>
        settings.model !== undefined ||
        settings.reasoningEffort !== undefined ||
        settings.permissionMode !== undefined ||
        settings.cwd !== undefined ||
        settings.projectName !== undefined ||
        settings.controls !== undefined,
      'At least one session setting is required',
    ),
  z
    .object({
      operation: z.literal('session.create'),
      scope: z.enum(['project', 'scratch']).optional(),
      cwd: z.string().min(1).max(4096).optional(),
      projectName: z.string().min(1).max(256).optional(),
      provider: z.string().min(1).max(256).optional(),
      providerSessionId: opaqueId.optional(),
      title: z.string().min(1).max(512).optional(),
      model: z.string().min(1).max(256).optional(),
      reasoningEffort: z.string().min(1).max(64).optional(),
      permissionMode: z.enum(['default', 'accept_edits', 'plan', 'bypass_permissions']).optional(),
      extensions: z.array(sessionExtensionBindingSchema).max(8).optional(),
      controls: providerControlValuesSchema.optional(),
      initialPrompt: z.string().min(1).max(64 * 1024).optional(),
    })
    .strict()
    .superRefine((value, context) => {
      const ids = new Set<string>()
      for (const [index, extension] of (value.extensions ?? []).entries()) {
        if (ids.has(extension.id)) {
          context.addIssue({
            code: 'custom',
            path: ['extensions', index, 'id'],
            message: 'Session extension IDs must be unique',
          })
        }
        ids.add(extension.id)
      }
    }),
  z
    .object({
      operation: z.literal('project.create'),
      name: z.string().min(1).max(256),
      cwd: z.string().min(1).max(4096),
      provider: z.string().min(1).max(256).optional(),
      createDirectory: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      operation: z.literal('project.settings'),
      name: z.string().trim().min(1).max(256).optional(),
      model: z.string().min(1).max(256).nullable().optional(),
      reasoningEffort: z.string().min(1).max(64).nullable().optional(),
      defaultExtensions: z.array(sessionExtensionBindingSchema).max(8).optional(),
      controls: providerControlValuesSchema.optional(),
    })
    .strict()
    .refine(
      settings => settings.name !== undefined
        || settings.model !== undefined
        || settings.reasoningEffort !== undefined
        || settings.defaultExtensions !== undefined
        || settings.controls !== undefined,
      'At least one project setting is required',
    ),
  z
    .object({ operation: z.literal('project.delete') })
    .strict(),
  z
    .object({
      operation: z.literal('provider.sessions.list'),
      provider: z.string().min(1).max(256),
      cursor: z.string().min(1).max(4_096).optional(),
    })
    .strict(),
  z
    .object({
      operation: z.literal('provider.session.inspect'),
      provider: z.string().min(1).max(256),
      providerSessionId: opaqueId,
    })
    .strict(),
  z
    .object({
      operation: z.literal('provider.history.materialize'),
      sessionId: opaqueId,
      expectedFrontier: z.number().int().nonnegative(),
      limit: z.number().int().min(1).max(100).optional(),
    })
    .strict(),
  z
    .object({
      operation: z.literal('session.archive'),
      sessionId: opaqueId,
    })
    .strict(),
  z
    .object({
      operation: z.literal('session.restore'),
      sessionId: opaqueId,
    })
    .strict(),
  z
    .object({
      operation: z.literal('session.delete'),
      sessionId: opaqueId,
    })
    .strict(),
  z
    .object({
      operation: z.literal('device.invite'),
      lifetimeMs: z.number().int().min(30_000).max(10 * 60_000).optional(),
    })
    .strict(),
  z
    .object({
      operation: z.literal('gateway.enrollment.invite'),
      lifetimeMs: z.number().int().min(30_000).max(10 * 60_000).optional(),
    })
    .strict(),
  z
    .object({
      operation: z.literal('gateway.enrollment.approve'),
      enrollmentId: opaqueId,
    })
    .strict(),
  z
    .object({
      operation: z.literal('gateway.enrollment.cancel'),
      enrollmentId: opaqueId,
    })
    .strict(),
  z
    .object({
      operation: z.literal('gateway.profile.update'),
      gatewayNodeId: opaqueId,
      gatewayName: z.string().trim().min(1).max(128),
    })
    .strict(),
  z
    .object({
      operation: z.literal('gateway.retire'),
      gatewayNodeId: opaqueId,
      expectedDirectoryRevision: z.number().int().nonnegative(),
      expectedGatewayKeyId: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    })
    .strict(),
  z
    .object({
      operation: z.literal('gateway.update.stage'),
      releaseId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u),
    })
    .strict(),
  z
    .object({
      operation: z.literal('gateway.update.apply'),
      releaseId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u),
      mode: z.enum(['when_idle', 'force']).optional(),
    })
    .strict(),
  z
    .object({ operation: z.literal('gateway.update.status') })
    .strict(),
])

export type CommandPayload = z.infer<typeof commandPayloadSchema>
export type CommandOperation = CommandPayload['operation']

export const commandSchema = z
  .object({
    kind: z.literal('malink.command'),
    version: z.literal(PROTOCOL_VERSION),
    commandId: opaqueId,
    gatewayId: opaqueId,
    deviceId: opaqueId,
    /** Pairing-certificate generation that authorized this device command. */
    sequenceEpoch: opaqueId,
    conversationId: opaqueId,
    revisionEpoch: opaqueId,
    sequence: z.number().int().positive(),
    /** Last Gateway-assigned conversation revision observed by this device. */
    baseRevision: z.number().int().nonnegative(),
    operation: z.enum([
      'prompt',
      'cancel',
      'decision',
      'session.settings',
      'session.create',
      'project.settings',
      'project.delete',
      'provider.sessions.list',
      'provider.session.inspect',
      'session.archive',
      'session.restore',
      'session.delete',
      'device.invite',
      'gateway.enrollment.invite',
      'gateway.enrollment.approve',
      'gateway.enrollment.cancel',
      'gateway.profile.update',
      'gateway.retire',
      'gateway.update.stage',
      'gateway.update.apply',
      'gateway.update.status',
    ]),
    issuedAt: timestamp,
    expiresAt: timestamp,
    nonce: z.string().min(16).max(256),
    payload: commandPayloadSchema,
  })
  .strict()
  .superRefine((command, context) => {
    if (command.operation !== command.payload.operation) {
      context.addIssue({
        code: 'custom',
        path: ['payload', 'operation'],
        message: 'Payload operation must match the signed operation binding',
      })
    }
    if (command.expiresAt <= command.issuedAt) {
      context.addIssue({
        code: 'custom',
        path: ['expiresAt'],
        message: 'expiresAt must be later than issuedAt',
      })
    }
    if (command.payload.operation === 'prompt') {
      const attachments = command.payload.attachments ?? []
      const totalBytes = attachments.reduce(
        (total, attachment) => total + attachment.size,
        0,
      )
      if (totalBytes > MAX_MALINK_PROMPT_ATTACHMENT_BYTES) {
        context.addIssue({
          code: 'custom',
          path: ['payload', 'attachments'],
          message: `Prompt attachments exceed ${MAX_MALINK_PROMPT_ATTACHMENT_BYTES} bytes`,
        })
      }
      if (command.payload.text.length === 0 && attachments.length === 0) {
        context.addIssue({
          code: 'custom',
          path: ['payload'],
          message: 'A prompt requires text or at least one attachment',
        })
      }
    }
  })

export type MalinkCommand = z.infer<typeof commandSchema>

export const eventPayloadSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('command.accepted'), commandId: opaqueId }).strict(),
  z.object({ type: z.literal('agent.text.delta'), streamId: opaqueId, text: z.string() }).strict(),
  z.object({ type: z.literal('agent.text.completed'), streamId: opaqueId, text: z.string() }).strict(),
  z
    .object({
      type: z.literal('agent.tool.started'),
      toolCallId: opaqueId,
      name: z.string().min(1).max(256),
      input: jsonValueSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('agent.tool.completed'),
      toolCallId: opaqueId,
      status: z.enum(['succeeded', 'failed']),
      output: jsonValueSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('agent.permission.requested'),
      requestId: opaqueId,
      title: z.string().min(1).max(1024),
      details: jsonValueSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('session.updated'),
      status: z.enum(['idle', 'running', 'stopping', 'failed']),
      model: z.string().optional(),
      provider: z.string().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('command.completed'),
      commandId: opaqueId,
      outcome: z.enum(['succeeded', 'cancelled', 'failed']),
      error: z.string().optional(),
    })
    .strict(),
  z.object({ type: z.literal('agent.error'), code: z.string(), message: z.string() }).strict(),
])

export type AgentEventPayload = z.infer<typeof eventPayloadSchema>

export const eventSchema = z
  .object({
    kind: z.literal('malink.event'),
    version: z.literal(PROTOCOL_VERSION),
    eventId: opaqueId,
    gatewayId: opaqueId,
    conversationId: opaqueId,
    sequence: z.number().int().positive(),
    occurredAt: timestamp,
    causationCommandId: opaqueId.optional(),
    payload: eventPayloadSchema,
  })
  .strict()

export type MalinkEvent = z.infer<typeof eventSchema>

export const signatureSchema = z
  .object({
    algorithm: z.literal('ES256'),
    keyId: opaqueId,
    value: z.string().regex(/^[A-Za-z0-9_-]+$/),
  })
  .strict()

export type MalinkSignature = z.infer<typeof signatureSchema>

export const signedCommandSchema = z
  .object({
    command: commandSchema,
    signature: signatureSchema,
  })
  .strict()

export type SignedCommand = z.infer<typeof signedCommandSchema>

export const signedEventSchema = z
  .object({
    event: eventSchema,
    signature: signatureSchema,
  })
  .strict()

export type SignedEvent = z.infer<typeof signedEventSchema>

export function parseCommand(input: unknown): MalinkCommand {
  return commandSchema.parse(input)
}

export function parseEvent(input: unknown): MalinkEvent {
  return eventSchema.parse(input)
}
