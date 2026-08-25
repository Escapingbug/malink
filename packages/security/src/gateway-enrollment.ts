import {
  canonicalJsonBytes,
  gatewayEnrollmentInvitationSchema,
  gatewayEnrollmentRequestSchema,
  signedGatewayEnrollmentInvitationSchema,
  signedGatewayEnrollmentRequestSchema,
  type GatewayEnrollmentInvitation,
  type GatewayEnrollmentRequest,
  type SignedGatewayEnrollmentInvitation,
  type SignedGatewayEnrollmentRequest,
} from '@malink/protocol'
import { importPublicDeviceKey } from './device-keys.js'
import {
  base64UrlDecode,
  base64UrlEncode,
  publicKeyId,
  sha256,
  toArrayBuffer,
  webCrypto,
} from './encoding.js'
import { SecurityError } from './errors.js'

const algorithm: EcdsaParams = { name: 'ECDSA', hash: 'SHA-256' }
const invitationDomain = 'malink.gateway.enrollment-invitation.v1'
const requestDomain = 'malink.gateway.enrollment-request.v1'
const MAX_LIFETIME_MS = 10 * 60_000
const FUTURE_SKEW_MS = 30_000

export async function signGatewayEnrollmentInvitation(
  input: GatewayEnrollmentInvitation,
  privateKey: CryptoKey,
  keyId: string,
): Promise<SignedGatewayEnrollmentInvitation> {
  const invitation = gatewayEnrollmentInvitationSchema.parse(input)
  if (invitation.workspaceKey.keyId !== keyId) {
    throw new SecurityError('key_mismatch', 'Gateway enrollment invitation signer is invalid')
  }
  return signedGatewayEnrollmentInvitationSchema.parse({
    invitation,
    signature: {
      algorithm: 'ES256',
      keyId,
      value: await sign(invitationDomain, invitation, privateKey),
    },
  })
}

export async function verifyGatewayEnrollmentInvitation(
  input: unknown,
  now = Date.now(),
): Promise<GatewayEnrollmentInvitation> {
  const signed = signedGatewayEnrollmentInvitationSchema.parse(input)
  assertWindow(signed.invitation, now)
  if (signed.signature.keyId !== signed.invitation.workspaceKey.keyId) {
    throw new SecurityError('key_mismatch', 'Gateway enrollment invitation key is invalid')
  }
  const publicKey = await importPublicDeviceKey(signed.invitation.workspaceKey)
  if (!(await verify(invitationDomain, signed.invitation, signed.signature.value, publicKey))) {
    throw new SecurityError('invalid_signature', 'Gateway enrollment invitation signature is invalid')
  }
  return signed.invitation
}

export async function signGatewayEnrollmentRequest(
  input: GatewayEnrollmentRequest,
  privateKey: CryptoKey,
  keyId: string,
): Promise<SignedGatewayEnrollmentRequest> {
  const request = gatewayEnrollmentRequestSchema.parse(input)
  if (request.gatewayKey.keyId !== keyId) {
    throw new SecurityError('key_mismatch', 'Gateway enrollment request signer is invalid')
  }
  return signedGatewayEnrollmentRequestSchema.parse({
    request,
    signature: {
      algorithm: 'ES256',
      keyId,
      value: await sign(requestDomain, request, privateKey),
    },
  })
}

export async function verifyGatewayEnrollmentRequest(
  input: unknown,
  expected: {
    enrollmentId: string
    workspaceId: string
    challenge: string
    now?: number
  },
): Promise<GatewayEnrollmentRequest> {
  const signed = signedGatewayEnrollmentRequestSchema.parse(input)
  assertWindow(signed.request, expected.now ?? Date.now())
  if (
    signed.request.enrollmentId !== expected.enrollmentId
    || signed.request.workspaceId !== expected.workspaceId
    || signed.request.challenge !== expected.challenge
  ) {
    throw new SecurityError('binding_mismatch', 'Gateway enrollment request binding is invalid')
  }
  if (signed.signature.keyId !== signed.request.gatewayKey.keyId) {
    throw new SecurityError('key_mismatch', 'Gateway enrollment request key is invalid')
  }
  const publicKey = await importPublicDeviceKey(signed.request.gatewayKey)
  if (!(await verify(requestDomain, signed.request, signed.signature.value, publicKey))) {
    throw new SecurityError('invalid_signature', 'Gateway enrollment request signature is invalid')
  }
  return signed.request
}

export async function gatewayEnrollmentVerificationCode(
  request: Pick<GatewayEnrollmentRequest, 'enrollmentId' | 'gatewayNodeId' | 'gatewayKey' | 'challenge'>,
): Promise<string> {
  const digest = base64UrlDecode(await sha256(canonicalJsonBytes({
    domain: 'malink.gateway.enrollment-verification.v1',
    enrollmentId: request.enrollmentId,
    gatewayNodeId: request.gatewayNodeId,
    gatewayKeyId: request.gatewayKey.keyId,
    challenge: request.challenge,
  })))
  const number = ((digest[0] ?? 0) << 16 | (digest[1] ?? 0) << 8 | (digest[2] ?? 0)) % 1_000_000
  const code = number.toString().padStart(6, '0')
  return `${code.slice(0, 3)}-${code.slice(3)}`
}

function assertWindow(value: { issuedAt: number; expiresAt: number }, now: number): void {
  if (
    value.expiresAt <= now
    || value.issuedAt > now + FUTURE_SKEW_MS
    || value.expiresAt - value.issuedAt > MAX_LIFETIME_MS
  ) {
    throw new SecurityError('expired', 'Gateway enrollment document is invalid or expired')
  }
}

async function sign(domain: string, document: unknown, privateKey: CryptoKey): Promise<string> {
  const signature = await webCrypto().subtle.sign(
    algorithm,
    privateKey,
    toArrayBuffer(canonicalJsonBytes({ domain, document })),
  )
  return base64UrlEncode(new Uint8Array(signature))
}

async function verify(
  domain: string,
  document: unknown,
  signature: string,
  publicKey: CryptoKey,
): Promise<boolean> {
  return webCrypto().subtle.verify(
    algorithm,
    publicKey,
    toArrayBuffer(base64UrlDecode(signature)),
    toArrayBuffer(canonicalJsonBytes({ domain, document })),
  )
}
