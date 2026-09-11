import {
  canonicalJsonBytes, EXTENSION_CRYPTO_MAX_BYTES, extensionCiphertextSchema,
  extensionCryptoGrantSchema, extensionCryptoKeyRingSchema, extensionCryptoGrantRequestSchema,
  type ExtensionCiphertext, type ExtensionCryptoKeyRing, type ExtensionCryptoIdentity,
  type ExtensionCryptoGrant, type ExtensionCryptoGrantRequest,
} from '@malink/protocol'
import { base64UrlDecode, base64UrlEncode, toArrayBuffer, webCrypto } from './encoding.js'

const rsa = { name: 'RSA-OAEP', hash: 'SHA-256' }
const bytes = (value: Uint8Array) => toArrayBuffer(value)
const encode = base64UrlEncode
const decode = base64UrlDecode

export function generateExtensionCryptoKeyRing(extensionId: string): ExtensionCryptoKeyRing {
  return extensionCryptoKeyRingSchema.parse({
    version: 1, extensionId, cryptoDomainId: webCrypto().randomUUID(), activeEpoch: 1,
    keys: [{ epoch: 1, key: encode(webCrypto().getRandomValues(new Uint8Array(32))) }],
  })
}

/** Extension-scoped handle. No key export or arbitrary namespace selection. */
export class ExtensionCrypto {
  readonly identity: ExtensionCryptoIdentity
  readonly #ring: ExtensionCryptoKeyRing
  constructor(input: ExtensionCryptoKeyRing, expectedExtensionId: string) {
    this.#ring = extensionCryptoKeyRingSchema.parse(input)
    if (this.#ring.extensionId !== expectedExtensionId) throw new Error('Extension identity mismatch')
    this.identity = Object.freeze({ extensionId: this.#ring.extensionId,
      cryptoDomainId: this.#ring.cryptoDomainId, keyEpoch: this.#ring.activeEpoch })
  }
  async encrypt(plaintext: string): Promise<ExtensionCiphertext> {
    const data = new TextEncoder().encode(plaintext)
    if (data.length > EXTENSION_CRYPTO_MAX_BYTES) throw new Error('Extension plaintext is too large')
    const header = { kind: 'malink.extension-data' as const, version: 1 as const,
      ...this.identity, nonce: encode(webCrypto().getRandomValues(new Uint8Array(12))) }
    const ciphertext = await encrypt(data, this.key(this.identity.keyEpoch), header)
    return extensionCiphertextSchema.parse({ ...header, ciphertext })
  }
  async decrypt(input: unknown): Promise<string> {
    const envelope = extensionCiphertextSchema.parse(input)
    if (envelope.extensionId !== this.identity.extensionId
      || envelope.cryptoDomainId !== this.identity.cryptoDomainId) throw new Error('Extension identity mismatch')
    const { ciphertext, ...header } = envelope
    const data = await decrypt(ciphertext, this.key(envelope.keyEpoch), header)
    if (data.byteLength > EXTENSION_CRYPTO_MAX_BYTES) throw new Error('Extension plaintext is too large')
    return new TextDecoder('utf-8', { fatal: true }).decode(data)
  }
  private key(epoch: number): Uint8Array {
    const key = this.#ring.keys.find(candidate => candidate.epoch === epoch)
    if (!key) throw new Error('Extension key epoch is unavailable')
    return decode(key.key)
  }
}

/** Only the public request crosses MLP; the ephemeral private key stays in the host. */
export async function createExtensionCryptoGrantRequest(extensionId: string): Promise<{
  request: ExtensionCryptoGrantRequest
  accept(grant: unknown): Promise<ExtensionCrypto>
}> {
  const keys = await webCrypto().subtle.generateKey({ ...rsa, modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]) }, false, ['encrypt', 'decrypt'])
  const request = extensionCryptoGrantRequestSchema.parse({ operation: 'extension.crypto.grant',
    extensionId, requestId: webCrypto().randomUUID(),
    recipientPublicKey: encode(new Uint8Array(await webCrypto().subtle.exportKey('spki', keys.publicKey))) })
  let used = false
  return { request, async accept(input) {
    if (used) throw new Error('Extension grant request was already consumed')
    const grant = extensionCryptoGrantSchema.parse(input)
    if (grant.requestId !== request.requestId || grant.extensionId !== request.extensionId) {
      throw new Error('Extension grant binding mismatch')
    }
    const key = new Uint8Array(await webCrypto().subtle.decrypt(rsa, keys.privateKey, bytes(decode(grant.wrappedKey))))
    const { ciphertext, ...header } = grant
    const plaintext = await decrypt(ciphertext, key, header)
    const ring = extensionCryptoKeyRingSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext)))
    const handle = new ExtensionCrypto(ring, extensionId)
    used = true
    return handle
  } }
}

/** Call only after authenticating the exact grant request through MLP. */
export async function sealExtensionCryptoGrant(input: ExtensionCryptoKeyRing,
  rawRequest: ExtensionCryptoGrantRequest): Promise<ExtensionCryptoGrant> {
  const ring = extensionCryptoKeyRingSchema.parse(input)
  const request = extensionCryptoGrantRequestSchema.parse(rawRequest)
  if (ring.extensionId !== request.extensionId) throw new Error('Extension grant identity mismatch')
  const publicKey = await webCrypto().subtle.importKey('spki', bytes(decode(request.recipientPublicKey)), rsa, false, ['encrypt'])
  const algorithm = publicKey.algorithm as RsaHashedKeyAlgorithm
  if (algorithm.modulusLength !== 2048 || encode(algorithm.publicExponent) !== 'AQAB') {
    throw new Error('Extension recipient must use RSA-2048 with exponent 65537')
  }
  const key = webCrypto().getRandomValues(new Uint8Array(32))
  const wrappedKey = encode(new Uint8Array(await webCrypto().subtle.encrypt(rsa, publicKey, bytes(key))))
  const header = { kind: 'malink.extension-key-grant' as const, version: 1 as const,
    extensionId: request.extensionId, requestId: request.requestId, wrappedKey,
    nonce: encode(webCrypto().getRandomValues(new Uint8Array(12))) }
  return extensionCryptoGrantSchema.parse({ ...header, ciphertext: await encrypt(canonicalJsonBytes(ring), key, header) })
}

async function aes(key: Uint8Array): Promise<CryptoKey> {
  if (key.length !== 32) throw new Error('Invalid extension key')
  return webCrypto().subtle.importKey('raw', bytes(key), 'AES-GCM', false, ['encrypt', 'decrypt'])
}
async function encrypt(data: Uint8Array, key: Uint8Array, header: { nonce: string }): Promise<string> {
  return encode(new Uint8Array(await webCrypto().subtle.encrypt({ name: 'AES-GCM',
    iv: bytes(decode(header.nonce)), additionalData: bytes(canonicalJsonBytes(header)), tagLength: 128 },
  await aes(key), bytes(data))))
}
async function decrypt(ciphertext: string, key: Uint8Array, header: { nonce: string }): Promise<ArrayBuffer> {
  return webCrypto().subtle.decrypt({ name: 'AES-GCM', iv: bytes(decode(header.nonce)),
    additionalData: bytes(canonicalJsonBytes(header)), tagLength: 128 }, await aes(key), bytes(decode(ciphertext)))
}
