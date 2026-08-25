import {
  canonicalJsonBytes,
  mlp3ProjectKeyGrantEnvelopeSchema,
  mlp3ProjectKeyGrantPlaintextSchema,
  type Mlp3ProjectKeyGrantEnvelope,
  type Mlp3ProjectKeyGrantPlaintext,
} from '@malink/protocol'
import {
  base64UrlDecode,
  base64UrlEncode,
  isCryptoKey,
  publicKeyId,
  toArrayBuffer,
  webCrypto,
} from './encoding.js'
import { SecurityError } from './errors.js'

const signatureDomain = 'malink.project-key-grant-envelope.signature.v3'
const kdfDomain = 'malink.project-key-grant-envelope.kdf.v3'
const ecdsa: EcdsaParams = { name: 'ECDSA', hash: 'SHA-256' }

export interface Mlp3KeyGrantBindings {
  grantId: string
  workspaceId: string
  projectId: string
  roomId: string
  deviceId: string
  certificateId: string
  senderKeyId: string
  recipientKeyId: string
}

export async function sealMlp3ProjectKeyGrant(options: {
  plaintext: Mlp3ProjectKeyGrantPlaintext
  bindings: Mlp3KeyGrantBindings
  senderPrivateKey: CryptoKey | JsonWebKey
  recipientPublicKey: CryptoKey | JsonWebKey
}): Promise<Mlp3ProjectKeyGrantEnvelope> {
  await assertSealKeys(options)
  const plaintext = mlp3ProjectKeyGrantPlaintextSchema.parse(options.plaintext)
  assertPlaintextBindings(plaintext, options.bindings)
  const nonce = webCrypto().getRandomValues(new Uint8Array(12))
  const header = {
    kind: 'malink.project-key-grant-envelope' as const,
    version: 3 as const,
    ...options.bindings,
    nonce: base64UrlEncode(nonce),
  }
  const ciphertext = await webCrypto().subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: toArrayBuffer(nonce),
      additionalData: toArrayBuffer(canonicalJsonBytes(header)),
      tagLength: 128,
    },
    await deriveKey(options.senderPrivateKey, options.recipientPublicKey, options.bindings),
    toArrayBuffer(canonicalJsonBytes(plaintext)),
  )
  const envelope = { ...header, ciphertext: base64UrlEncode(new Uint8Array(ciphertext)) }
  const signature = await webCrypto().subtle.sign(
    ecdsa,
    await importEcdsaPrivateKey(options.senderPrivateKey),
    toArrayBuffer(canonicalJsonBytes({ domain: signatureDomain, envelope })),
  )
  return mlp3ProjectKeyGrantEnvelopeSchema.parse({
    envelope,
    signature: {
      algorithm: 'ES256',
      keyId: options.bindings.senderKeyId,
      value: base64UrlEncode(new Uint8Array(signature)),
    },
  })
}

export async function openMlp3ProjectKeyGrant(
  input: unknown,
  options: {
    expected: Mlp3KeyGrantBindings
    recipientPrivateKey: CryptoKey | JsonWebKey
    senderPublicKey: CryptoKey | JsonWebKey
  },
): Promise<Mlp3ProjectKeyGrantPlaintext> {
  const signed = mlp3ProjectKeyGrantEnvelopeSchema.parse(input)
  for (const field of Object.keys(options.expected) as Array<keyof Mlp3KeyGrantBindings>) {
    if (signed.envelope[field] !== options.expected[field]) {
      throw new SecurityError(
        'binding_mismatch',
        `Malink project key grant ${field} binding does not match`,
      )
    }
  }
  await assertOpenKeys(options)
  const valid = await webCrypto().subtle.verify(
    ecdsa,
    await importEcdsaPublicKey(options.senderPublicKey),
    toArrayBuffer(base64UrlDecode(signed.signature.value)),
    toArrayBuffer(canonicalJsonBytes({ domain: signatureDomain, envelope: signed.envelope })),
  )
  if (signed.signature.keyId !== options.expected.senderKeyId || !valid) {
    throw new SecurityError('invalid_signature', 'Malink project key grant signature is invalid')
  }
  const { ciphertext, ...header } = signed.envelope
  let parsed: unknown
  try {
    const plaintext = await webCrypto().subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: toArrayBuffer(base64UrlDecode(header.nonce)),
        additionalData: toArrayBuffer(canonicalJsonBytes(header)),
        tagLength: 128,
      },
      await deriveKey(options.recipientPrivateKey, options.senderPublicKey, options.expected),
      toArrayBuffer(base64UrlDecode(ciphertext)),
    )
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext))
  } catch {
    throw new SecurityError('invalid_signature', 'Malink project key grant authentication failed')
  }
  const plaintext = mlp3ProjectKeyGrantPlaintextSchema.parse(parsed)
  assertPlaintextBindings(plaintext, options.expected)
  return plaintext
}

async function deriveKey(
  ownPrivateKey: CryptoKey | JsonWebKey,
  peerPublicKey: CryptoKey | JsonWebKey,
  bindings: Mlp3KeyGrantBindings,
): Promise<CryptoKey> {
  const shared = await webCrypto().subtle.deriveBits(
    { name: 'ECDH', public: await importEcdhPublicKey(peerPublicKey) },
    await importEcdhPrivateKey(ownPrivateKey),
    256,
  )
  const material = await webCrypto().subtle.importKey(
    'raw',
    shared,
    'HKDF',
    false,
    ['deriveKey'],
  )
  const salt = await webCrypto().subtle.digest(
    'SHA-256',
    toArrayBuffer(canonicalJsonBytes({
      domain: kdfDomain,
      workspaceId: bindings.workspaceId,
      projectId: bindings.projectId,
      senderKeyId: bindings.senderKeyId,
      recipientKeyId: bindings.recipientKeyId,
    })),
  )
  return webCrypto().subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt,
      info: toArrayBuffer(canonicalJsonBytes({
        roomId: bindings.roomId,
        deviceId: bindings.deviceId,
        certificateId: bindings.certificateId,
        grantId: bindings.grantId,
      })),
    },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

function assertPlaintextBindings(
  plaintext: Mlp3ProjectKeyGrantPlaintext,
  bindings: Mlp3KeyGrantBindings,
): void {
  for (const field of [
    'workspaceId',
    'projectId',
    'roomId',
    'deviceId',
    'certificateId',
  ] as const) {
    if (plaintext[field] !== bindings[field]) {
      throw new SecurityError(
        'binding_mismatch',
        `Malink project key grant plaintext ${field} does not match`,
      )
    }
  }
}

async function assertSealKeys(options: {
  bindings: Mlp3KeyGrantBindings
  senderPrivateKey: CryptoKey | JsonWebKey
  recipientPublicKey: CryptoKey | JsonWebKey
}): Promise<void> {
  if (await privateKeyId(options.senderPrivateKey) !== options.bindings.senderKeyId) {
    throw new SecurityError('key_mismatch', 'Malink key grant sender key is incorrect')
  }
  if (await publicKeyId(options.recipientPublicKey) !== options.bindings.recipientKeyId) {
    throw new SecurityError('key_mismatch', 'Malink key grant recipient key is incorrect')
  }
}

async function assertOpenKeys(options: {
  expected: Mlp3KeyGrantBindings
  recipientPrivateKey: CryptoKey | JsonWebKey
  senderPublicKey: CryptoKey | JsonWebKey
}): Promise<void> {
  if (await privateKeyId(options.recipientPrivateKey) !== options.expected.recipientKeyId) {
    throw new SecurityError('key_mismatch', 'Malink key grant recipient key is incorrect')
  }
  if (await publicKeyId(options.senderPublicKey) !== options.expected.senderKeyId) {
    throw new SecurityError('key_mismatch', 'Malink key grant sender key is incorrect')
  }
}

async function privateKeyId(key: CryptoKey | JsonWebKey): Promise<string> {
  const jwk = await exportJwk(key)
  return publicKeyId(publicPart(jwk))
}

async function importEcdhPrivateKey(key: CryptoKey | JsonWebKey): Promise<CryptoKey> {
  const jwk = await exportJwk(key)
  if (!jwk.d) throw new TypeError('Expected a P-256 private key')
  return webCrypto().subtle.importKey(
    'jwk',
    { ...publicPart(jwk), d: jwk.d },
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    ['deriveBits'],
  )
}

async function importEcdhPublicKey(key: CryptoKey | JsonWebKey): Promise<CryptoKey> {
  return webCrypto().subtle.importKey(
    'jwk',
    publicPart(await exportJwk(key)),
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  )
}

async function importEcdsaPrivateKey(key: CryptoKey | JsonWebKey): Promise<CryptoKey> {
  if (isCryptoKey(key) && key.algorithm.name === 'ECDSA' && key.usages.includes('sign')) return key
  const jwk = await exportJwk(key)
  if (!jwk.d) throw new TypeError('Expected a P-256 private key')
  return webCrypto().subtle.importKey(
    'jwk',
    { ...publicPart(jwk), d: jwk.d },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  )
}

async function importEcdsaPublicKey(key: CryptoKey | JsonWebKey): Promise<CryptoKey> {
  if (isCryptoKey(key) && key.algorithm.name === 'ECDSA' && key.usages.includes('verify')) return key
  return webCrypto().subtle.importKey(
    'jwk',
    publicPart(await exportJwk(key)),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify'],
  )
}

async function exportJwk(key: CryptoKey | JsonWebKey): Promise<JsonWebKey> {
  return isCryptoKey(key) ? webCrypto().subtle.exportKey('jwk', key) : structuredClone(key)
}

function publicPart(jwk: JsonWebKey): JsonWebKey {
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !jwk.x || !jwk.y) {
    throw new TypeError('Expected a P-256 key')
  }
  return { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, ext: true }
}

