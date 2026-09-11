import { z } from 'zod'

export const EXTENSION_CRYPTO_MAX_BYTES = 128 * 1024
const id = z.string().min(1).max(256)
const b64 = z.string().regex(/^[A-Za-z0-9_-]+$/u)
export const extensionCryptoIdentitySchema = z.object({
  extensionId: id,
  cryptoDomainId: id,
  keyEpoch: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
}).strict()
export const extensionCryptoKeyRingSchema = z.object({
  version: z.literal(1),
  extensionId: id,
  cryptoDomainId: id,
  activeEpoch: z.number().int().positive(),
  keys: z.array(z.object({ epoch: z.number().int().positive(), key: b64.length(43) }).strict()).min(1).max(128),
}).strict().superRefine((ring, ctx) => {
  const epochs = ring.keys.map(key => key.epoch)
  if (new Set(epochs).size !== epochs.length || !epochs.includes(ring.activeEpoch)
    || Math.max(...epochs) !== ring.activeEpoch) {
    ctx.addIssue({ code: 'custom', message: 'Invalid extension key epochs' })
  }
})
export const extensionCiphertextSchema = extensionCryptoIdentitySchema.extend({
  kind: z.literal('malink.extension-data'),
  version: z.literal(1),
  nonce: b64.length(16),
  ciphertext: b64.min(22).max(Math.ceil((EXTENSION_CRYPTO_MAX_BYTES + 16) * 4 / 3)),
}).strict()
export const extensionCryptoGrantRequestSchema = z.object({
  operation: z.literal('extension.crypto.grant'),
  extensionId: id,
  requestId: id,
  recipientPublicKey: b64.min(100).max(600), // RSA-OAEP-256 2048-bit SPKI
}).strict()
export const extensionCryptoGrantSchema = z.object({
  kind: z.literal('malink.extension-key-grant'),
  version: z.literal(1),
  extensionId: id,
  requestId: id,
  wrappedKey: b64.length(342),
  nonce: b64.length(16),
  ciphertext: b64.min(22).max(32 * 1024),
}).strict()
export const extensionCryptoRequestSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('crypto.connect') }).strict(),
  z.object({ type: z.literal('crypto.encrypt'), plaintext: z.string().max(EXTENSION_CRYPTO_MAX_BYTES) }).strict(),
  z.object({ type: z.literal('crypto.decrypt'), ciphertext: extensionCiphertextSchema }).strict(),
])
export const extensionCryptoBridgeRequestSchema = z.object({
  protocol: z.literal('io.malink.client-integration'),
  version: z.literal(1),
  requestId: id,
  request: extensionCryptoRequestSchema,
}).strict()
export const extensionCryptoBridgeResponseSchema = z.object({
  protocol: z.literal('io.malink.client-integration'),
  version: z.literal(1),
  type: z.literal('crypto.result'),
  requestId: id,
  result: z.union([extensionCryptoIdentitySchema, extensionCiphertextSchema, z.string().max(EXTENSION_CRYPTO_MAX_BYTES)]).optional(),
  error: z.enum(['unavailable', 'denied', 'invalid_request', 'crypto_failed']).optional(),
}).strict().refine(value => (value.result === undefined) !== (value.error === undefined))
export type ExtensionCryptoIdentity = z.infer<typeof extensionCryptoIdentitySchema>
export type ExtensionCryptoKeyRing = z.infer<typeof extensionCryptoKeyRingSchema>
export type ExtensionCiphertext = z.infer<typeof extensionCiphertextSchema>
export type ExtensionCryptoGrantRequest = z.infer<typeof extensionCryptoGrantRequestSchema>
export type ExtensionCryptoGrant = z.infer<typeof extensionCryptoGrantSchema>
export type ExtensionCryptoRequest = z.infer<typeof extensionCryptoRequestSchema>
export type ExtensionCryptoResult = ExtensionCryptoIdentity | ExtensionCiphertext | string
