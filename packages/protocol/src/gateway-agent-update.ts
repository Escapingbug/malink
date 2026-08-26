import { z } from 'zod'
import { gatewayReleaseStateEntrySchema } from './gateway-release.js'
import { pairingPublicKeySchema } from './pairing.js'
import { signatureSchema } from './schema.js'

const opaqueId = z.string().min(1).max(256)
const timestamp = z.number().int().nonnegative()
const releaseId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u)

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
