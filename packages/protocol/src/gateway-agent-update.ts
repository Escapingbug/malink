import { z } from 'zod'
import { gatewayReleaseStateEntrySchema } from './gateway-release.js'
import { pairingPublicKeySchema } from './pairing.js'
import { signatureSchema } from './schema.js'

const opaqueId = z.string().min(1).max(256)
const timestamp = z.number().int().nonnegative()
const releaseId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u)
const sha256 = z.string().regex(/^[0-9a-f]{64}$/u)

export const gatewayAgentUpdatePromptSchema = z
  .object({
    kind: z.literal('malink.gateway.agent-update'),
    version: z.literal(1),
    releaseId,
    versionName: z.string().min(1).max(128),
    buildId: opaqueId,
    publishedAt: timestamp,
    platform: z.literal('darwin'),
    repository: z
      .object({
        url: z.url().max(2_048).refine(isCredentialFreeHttpsUrl, {
          message: 'Gateway Agent updates require a credential-free HTTPS Git URL',
        }),
        commit: z.string().regex(/^[0-9a-f]{40}$/u),
      })
      .strict(),
    prompt: z.string().min(1).max(64 * 1024),
    stateCatalog: z.array(gatewayReleaseStateEntrySchema).min(1).max(256),
  })
  .strict()
  .superRefine((update, context) => {
    const stateIds = update.stateCatalog.map(entry => entry.id)
    if (new Set(stateIds).size !== stateIds.length) {
      context.addIssue({
        code: 'custom',
        path: ['stateCatalog'],
        message: 'Gateway Agent update state catalog IDs must be unique',
      })
    }
  })

export type GatewayAgentUpdatePrompt = z.infer<typeof gatewayAgentUpdatePromptSchema>

export const signedGatewayAgentUpdatePromptSchema = z
  .object({
    update: gatewayAgentUpdatePromptSchema,
    signer: pairingPublicKeySchema,
    signature: signatureSchema,
  })
  .strict()

export type SignedGatewayAgentUpdatePrompt = z.infer<
  typeof signedGatewayAgentUpdatePromptSchema
>

export const gatewayAgentUpdateChannelSchema = z
  .object({
    kind: z.literal('malink.gateway.agent-update-channel'),
    version: z.literal(1),
    channelId: releaseId,
    generation: z.number().int().nonnegative(),
    publishedAt: timestamp,
    release: z
      .object({
        releaseId,
        buildId: opaqueId,
        sha256,
      })
      .strict(),
    mirrors: z
      .array(z.url().max(2_048).refine(isCredentialFreeHttpsBaseUrl, {
        message: 'Gateway update mirrors require a credential-free HTTPS base URL',
      }))
      .min(1)
      .max(8),
  })
  .strict()
  .superRefine((channel, context) => {
    if (new Set(channel.mirrors).size !== channel.mirrors.length) {
      context.addIssue({
        code: 'custom',
        path: ['mirrors'],
        message: 'Gateway update mirror URLs must be unique',
      })
    }
  })

export type GatewayAgentUpdateChannel = z.infer<typeof gatewayAgentUpdateChannelSchema>

export const signedGatewayAgentUpdateChannelSchema = z
  .object({
    channel: gatewayAgentUpdateChannelSchema,
    signer: pairingPublicKeySchema,
    signature: signatureSchema,
  })
  .strict()

export type SignedGatewayAgentUpdateChannel = z.infer<
  typeof signedGatewayAgentUpdateChannelSchema
>

function isCredentialFreeHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:'
      && !url.username
      && !url.password
      && !url.search
      && !url.hash
  } catch {
    return false
  }
}

function isCredentialFreeHttpsBaseUrl(value: string): boolean {
  if (!isCredentialFreeHttpsUrl(value)) return false
  return new URL(value).pathname.endsWith('/')
}
