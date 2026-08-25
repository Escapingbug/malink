import {
  canonicalJsonBytes,
  mlp3ContentEnvelopeSchema,
  mlp3PlaintextSchema,
  type Mlp3ContentEnvelope,
  type Mlp3Plaintext,
} from '@malink/protocol'
import {
  base64UrlDecode,
  base64UrlEncode,
  toArrayBuffer,
  webCrypto,
} from './encoding.js'
import { SecurityError } from './errors.js'

export interface Mlp3EnvelopeBindings {
  roomId: string
  projectId: string
  keyId: string
}

export interface SealMlp3EnvelopeOptions extends Mlp3EnvelopeBindings {
  plaintext: Mlp3Plaintext
  projectKey: Uint8Array | CryptoKey
  logicalEventId: string
}

export interface OpenMlp3EnvelopeOptions extends Mlp3EnvelopeBindings {
  projectKey: Uint8Array | CryptoKey
}

export function generateMlp3ProjectKey(): Uint8Array {
  return webCrypto().getRandomValues(new Uint8Array(32))
}

export async function sealMlp3Envelope(
  options: SealMlp3EnvelopeOptions,
): Promise<Mlp3ContentEnvelope> {
  const nonce = webCrypto().getRandomValues(new Uint8Array(12))
  const header = {
    kind: 'malink.project-envelope' as const,
    version: 3 as const,
    roomId: options.roomId,
    projectId: options.projectId,
    keyId: options.keyId,
    logicalEventId: options.logicalEventId,
    nonce: base64UrlEncode(nonce),
  }
  const plaintext = mlp3PlaintextSchema.parse(options.plaintext)
  const ciphertext = await webCrypto().subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: toArrayBuffer(nonce),
      additionalData: toArrayBuffer(canonicalJsonBytes(header)),
      tagLength: 128,
    },
    await importProjectKey(options.projectKey, ['encrypt']),
    toArrayBuffer(canonicalJsonBytes(plaintext)),
  )
  return mlp3ContentEnvelopeSchema.parse({
    ...header,
    ciphertext: base64UrlEncode(new Uint8Array(ciphertext)),
  })
}

export async function openMlp3Envelope(
  input: unknown,
  options: OpenMlp3EnvelopeOptions,
): Promise<{ plaintext: Mlp3Plaintext; envelope: Mlp3ContentEnvelope }> {
  const envelope = mlp3ContentEnvelopeSchema.parse(input)
  for (const field of ['roomId', 'projectId', 'keyId'] as const) {
    if (envelope[field] !== options[field]) {
      throw new SecurityError(
        'binding_mismatch',
        `MLP/3 envelope ${field} binding does not match`,
      )
    }
  }
  const { ciphertext, ...header } = envelope
  let parsed: unknown
  try {
    const bytes = await webCrypto().subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: toArrayBuffer(base64UrlDecode(envelope.nonce)),
        additionalData: toArrayBuffer(canonicalJsonBytes(header)),
        tagLength: 128,
      },
      await importProjectKey(options.projectKey, ['decrypt']),
      toArrayBuffer(base64UrlDecode(ciphertext)),
    )
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    throw new SecurityError(
      'invalid_signature',
      'MLP/3 project envelope authentication failed',
    )
  }
  return {
    plaintext: mlp3PlaintextSchema.parse(parsed),
    envelope,
  }
}

async function importProjectKey(
  value: Uint8Array | CryptoKey,
  usages: KeyUsage[],
): Promise<CryptoKey> {
  if (!(value instanceof Uint8Array)) {
    if (
      value.algorithm.name !== 'AES-GCM'
      || !usages.every(usage => value.usages.includes(usage))
    ) {
      throw new SecurityError(
        'key_mismatch',
        'Malink project key does not allow the required AES-GCM operation',
      )
    }
    return value
  }
  if (value.byteLength !== 32) {
    throw new SecurityError(
      'key_mismatch',
      'Malink project key must contain exactly 32 bytes',
    )
  }
  return webCrypto().subtle.importKey(
    'raw',
    toArrayBuffer(value),
    { name: 'AES-GCM' },
    false,
    usages,
  )
}

