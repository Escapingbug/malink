import {
  canonicalJsonBytes,
  mlp3CommandSchema,
  mlp3CurrentPointerDocumentSchema,
  mlp3CurrentPointerSchema,
  mlp3EventSchema,
  commandSchema,
  eventSchema,
  signedCommandSchema,
  signedMlp3CommandSchema,
  signedMlp3EventSchema,
  signedEventSchema,
  type MalinkCommand,
  type MalinkEvent,
  type Mlp3Command,
  type Mlp3CurrentPointer,
  type Mlp3Event,
  type SignedMlp3Command,
  type SignedMlp3Event,
  type SignedCommand,
  type SignedEvent,
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

const algorithm: EcdsaParams = { name: 'ECDSA', hash: 'SHA-256' }

export interface DeviceKeyPair {
  keyId: string
  privateKey: CryptoKey
  publicKey: CryptoKey
  publicJwk: JsonWebKey
}

export async function generateDeviceKeyPair(): Promise<DeviceKeyPair> {
  const pair = (await webCrypto().subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair
  const publicJwk = await webCrypto().subtle.exportKey('jwk', pair.publicKey)
  return {
    keyId: await publicKeyId(publicJwk),
    privateKey: pair.privateKey,
    publicKey: pair.publicKey,
    publicJwk,
  }
}

async function importPublicKey(key: CryptoKey | JsonWebKey): Promise<CryptoKey> {
  if (isCryptoKey(key)) return key
  return webCrypto().subtle.importKey(
    'jwk',
    key,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify'],
  )
}

async function sign<T>(document: T, privateKey: CryptoKey): Promise<string> {
  const signature = await webCrypto().subtle.sign(
    algorithm,
    privateKey,
    toArrayBuffer(canonicalJsonBytes(document)),
  )
  return base64UrlEncode(new Uint8Array(signature))
}

async function verify<T>(
  document: T,
  signature: string,
  publicKey: CryptoKey | JsonWebKey,
): Promise<boolean> {
  return webCrypto().subtle.verify(
    algorithm,
    await importPublicKey(publicKey),
    toArrayBuffer(base64UrlDecode(signature)),
    toArrayBuffer(canonicalJsonBytes(document)),
  )
}

export async function signCommand(
  input: MalinkCommand,
  privateKey: CryptoKey,
  keyId: string,
): Promise<SignedCommand> {
  const command = commandSchema.parse(input)
  return {
    command,
    signature: {
      algorithm: 'ES256',
      keyId,
      value: await sign(command, privateKey),
    },
  }
}

export async function signEvent(
  input: MalinkEvent,
  privateKey: CryptoKey,
  keyId: string,
): Promise<SignedEvent> {
  const event = eventSchema.parse(input)
  return {
    event,
    signature: {
      algorithm: 'ES256',
      keyId,
      value: await sign(event, privateKey),
    },
  }
}

export async function signMlp3Command(
  input: Mlp3Command,
  privateKey: CryptoKey,
  keyId: string,
): Promise<SignedMlp3Command> {
  const command = mlp3CommandSchema.parse(input)
  return signedMlp3CommandSchema.parse({
    command,
    signature: {
      algorithm: 'ES256',
      keyId,
      value: await sign(command, privateKey),
    },
  })
}

export async function signMlp3Event(
  input: Mlp3Event,
  privateKey: CryptoKey,
  keyId: string,
): Promise<SignedMlp3Event> {
  const event = mlp3EventSchema.parse(input)
  return signedMlp3EventSchema.parse({
    event,
    signature: {
      algorithm: 'ES256',
      keyId,
      value: await sign(event, privateKey),
    },
  })
}

export interface Mlp3CommandBindings {
  workspaceId: string
  deviceId: string
  certificateId: string
  projectId?: string
  allowedOperations?: readonly Mlp3Command['operation'][]
}

/**
 * MLP/3 intentionally has no clock, sequence or global revision gate. The active
 * certificate and durable command-id ledger are its authorization boundary.
 */
export async function verifyMlp3Command(
  input: unknown,
  trustedDeviceKey: CryptoKey | JsonWebKey,
  bindings: Mlp3CommandBindings,
): Promise<Mlp3Command> {
  const signed = signedMlp3CommandSchema.parse(input)
  const expectedKeyId = await publicKeyId(trustedDeviceKey)
  if (signed.signature.keyId !== expectedKeyId) {
    throw new SecurityError('key_mismatch', 'Signature key is not the enrolled Malink device key')
  }
  if (!(await verify(signed.command, signed.signature.value, trustedDeviceKey))) {
    throw new SecurityError('invalid_signature', 'MLP/3 command signature is invalid')
  }
  const command = signed.command
  if (
    command.workspaceId !== bindings.workspaceId
    || command.deviceId !== bindings.deviceId
    || command.certificateId !== bindings.certificateId
    || (bindings.projectId !== undefined && command.projectId !== bindings.projectId)
    || (
      bindings.allowedOperations !== undefined
      && !bindings.allowedOperations.includes(command.operation)
    )
  ) {
    throw new SecurityError(
      'binding_mismatch',
      'MLP/3 command is not bound to the enrolled execution context',
    )
  }
  return command
}

export interface Mlp3EventBindings {
  workspaceId: string
  projectId?: string
}

export async function verifyMlp3Event(
  input: unknown,
  trustedGatewayKey: CryptoKey | JsonWebKey,
  bindings: Mlp3EventBindings,
): Promise<Mlp3Event> {
  const signed = signedMlp3EventSchema.parse(input)
  const expectedKeyId = await publicKeyId(trustedGatewayKey)
  if (signed.signature.keyId !== expectedKeyId) {
    throw new SecurityError('key_mismatch', 'Event is not signed by the enrolled Gateway key')
  }
  if (!(await verify(signed.event, signed.signature.value, trustedGatewayKey))) {
    throw new SecurityError('invalid_signature', 'MLP/3 event signature is invalid')
  }
  if (
    signed.event.workspaceId !== bindings.workspaceId
    || (bindings.projectId !== undefined && signed.event.projectId !== bindings.projectId)
  ) {
    throw new SecurityError(
      'binding_mismatch',
      'MLP/3 event is not bound to the expected workspace and project',
    )
  }
  return signed.event
}

export async function signMlp3Pointer(
  documentInput: Mlp3CurrentPointer['document'],
  privateKey: CryptoKey,
  keyId: string,
): Promise<Mlp3CurrentPointer> {
  const document = mlp3CurrentPointerDocumentSchema.parse(documentInput)
  return mlp3CurrentPointerSchema.parse({
    document,
    signature: {
      algorithm: 'ES256',
      keyId,
      value: await sign(document, privateKey),
    },
  })
}

export async function verifyMlp3Pointer(
  input: unknown,
  trustedGatewayKey: CryptoKey | JsonWebKey,
): Promise<Mlp3CurrentPointer['document']> {
  const pointer = mlp3CurrentPointerSchema.parse(input)
  const expectedKeyId = await publicKeyId(trustedGatewayKey)
  if (pointer.signature.keyId !== expectedKeyId) {
    throw new SecurityError('key_mismatch', 'Pointer is not signed by the enrolled Gateway key')
  }
  if (!(await verify(pointer.document, pointer.signature.value, trustedGatewayKey))) {
    throw new SecurityError('invalid_signature', 'MLP/3 state pointer signature is invalid')
  }
  return pointer.document
}

export interface CommandBindings {
  gatewayId: string
  deviceId: string
  conversationId?: string
  allowedOperations?: readonly MalinkCommand['operation'][]
}

export interface VerificationClock {
  now?: number
  maxFutureSkewMs?: number
  maxLifetimeMs?: number
  /**
   * Allows a caller with a durable execution ledger to authenticate an
   * expired command before deciding whether it is an exact, already-accepted
   * recovery. This must never be used to execute a new expired command.
   */
  allowExpired?: boolean
}

const DEFAULT_MAX_FUTURE_SKEW_MS = 30_000
const DEFAULT_MAX_LIFETIME_MS = 5 * 60_000

/**
 * Verifies an application-layer command using a locally pinned device key.
 * No Matrix sender, room membership, power level, or homeserver assertion is
 * accepted as authority.
 */
export async function verifyCommand(
  input: unknown,
  trustedDeviceKey: CryptoKey | JsonWebKey,
  bindings: CommandBindings,
  clock: VerificationClock = {},
): Promise<MalinkCommand> {
  const signed = signedCommandSchema.parse(input)
  const expectedKeyId = await publicKeyId(trustedDeviceKey)
  if (signed.signature.keyId !== expectedKeyId) {
    throw new SecurityError('key_mismatch', 'Signature key is not the locally pinned device key')
  }
  if (!(await verify(signed.command, signed.signature.value, trustedDeviceKey))) {
    throw new SecurityError('invalid_signature', 'Command signature is invalid')
  }

  const command = signed.command
  if (
    command.gatewayId !== bindings.gatewayId ||
    command.deviceId !== bindings.deviceId ||
    (bindings.conversationId !== undefined &&
      command.conversationId !== bindings.conversationId) ||
    (bindings.allowedOperations !== undefined &&
      !bindings.allowedOperations.includes(command.operation))
  ) {
    throw new SecurityError('binding_mismatch', 'Command is not bound to the expected execution context')
  }

  const now = clock.now ?? Date.now()
  if (!clock.allowExpired && command.expiresAt <= now) {
    throw new SecurityError('expired', 'Command has expired')
  }
  if (command.issuedAt > now + (clock.maxFutureSkewMs ?? DEFAULT_MAX_FUTURE_SKEW_MS)) {
    throw new SecurityError('issued_in_future', 'Command issue time is too far in the future')
  }
  if (command.expiresAt - command.issuedAt > (clock.maxLifetimeMs ?? DEFAULT_MAX_LIFETIME_MS)) {
    throw new SecurityError('lifetime_exceeded', 'Command validity window exceeds policy')
  }

  return command
}

export interface EventBindings {
  gatewayId: string
  conversationId: string
}

export async function verifyEvent(
  input: unknown,
  trustedGatewayKey: CryptoKey | JsonWebKey,
  bindings: EventBindings,
): Promise<MalinkEvent> {
  const signed = signedEventSchema.parse(input)
  const expectedKeyId = await publicKeyId(trustedGatewayKey)
  if (signed.signature.keyId !== expectedKeyId) {
    throw new SecurityError('key_mismatch', 'Signature key is not the locally pinned gateway key')
  }
  if (!(await verify(signed.event, signed.signature.value, trustedGatewayKey))) {
    throw new SecurityError('invalid_signature', 'Event signature is invalid')
  }
  if (
    signed.event.gatewayId !== bindings.gatewayId ||
    signed.event.conversationId !== bindings.conversationId
  ) {
    throw new SecurityError('binding_mismatch', 'Event is not bound to the expected context')
  }
  return signed.event
}
