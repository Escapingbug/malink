import { decodeDeviceInvitationLink, type GeneratedDeviceInvitation } from './pairing.js'

export const AUTHORIZATION_TRANSFER_KIND = 'malink.authorization-transfer' as const
export const AUTHORIZATION_TRANSFER_VERSION = 1 as const
export const AUTHORIZATION_TRANSFER_FILE_EXTENSION = '.malink-auth' as const
export const AUTHORIZATION_TRANSFER_MIME_TYPE =
  'application/vnd.malink.authorization+json' as const
export const MAX_AUTHORIZATION_TRANSFER_BYTES = 128 * 1024

type AuthorizationTransferDocument = {
  kind: typeof AUTHORIZATION_TRANSFER_KIND
  version: typeof AUTHORIZATION_TRANSFER_VERSION
  createdAt: number
  expiresAt: number
  invitation: string
}

/**
 * Wraps the existing signed, one-use device invitation for file transfer.
 * The file is a bearer credential, but it never contains a device private key
 * or a long-lived Matrix access token.
 */
export function serializeAuthorizationTransfer(
  invitation: GeneratedDeviceInvitation,
  now = Date.now(),
): string {
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new TypeError('The authorization file creation time is invalid.')
  }
  const verified = verifiedInvitation(invitation.link)
  if (verified.expiresAt !== invitation.expiresAt) {
    throw new Error('The authorization invitation expiry does not match its signed payload.')
  }
  if (verified.includesMatrixLogin !== invitation.includesMatrixLogin) {
    throw new Error('The authorization invitation login status does not match its payload.')
  }
  if (verified.expiresAt <= now) {
    throw new Error('This authorization invitation has expired. Create a new one.')
  }
  const document: AuthorizationTransferDocument = {
    kind: AUTHORIZATION_TRANSFER_KIND,
    version: AUTHORIZATION_TRANSFER_VERSION,
    createdAt: now,
    expiresAt: verified.expiresAt,
    invitation: invitation.link,
  }
  const serialized = `${JSON.stringify(document, null, 2)}\n`
  if (new TextEncoder().encode(serialized).byteLength > MAX_AUTHORIZATION_TRANSFER_BYTES) {
    throw new Error('The authorization file is too large.')
  }
  return serialized
}

export function parseAuthorizationTransfer(
  input: string,
  now = Date.now(),
): GeneratedDeviceInvitation {
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new TypeError('The authorization file check time is invalid.')
  }
  if (
    !input
    || new TextEncoder().encode(input).byteLength > MAX_AUTHORIZATION_TRANSFER_BYTES
  ) {
    throw new Error('The authorization file is empty or too large.')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(input)
  } catch (error) {
    throw new Error('The authorization file is not valid JSON.', { cause: error })
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('The authorization file must contain one object.')
  }
  const value = parsed as Record<string, unknown>
  const expectedKeys = ['createdAt', 'expiresAt', 'invitation', 'kind', 'version']
  if (
    Object.keys(value).sort().join('\0') !== expectedKeys.sort().join('\0')
    || value.kind !== AUTHORIZATION_TRANSFER_KIND
    || value.version !== AUTHORIZATION_TRANSFER_VERSION
    || typeof value.invitation !== 'string'
    || !Number.isSafeInteger(value.createdAt)
    || !Number.isSafeInteger(value.expiresAt)
  ) {
    throw new Error('The authorization file has an unsupported or invalid format.')
  }
  const verified = verifiedInvitation(value.invitation)
  const createdAt = value.createdAt as number
  if (createdAt < 0 || createdAt > verified.expiresAt) {
    throw new Error('The authorization file creation time is invalid.')
  }
  if (verified.expiresAt !== value.expiresAt) {
    throw new Error('The authorization file expiry does not match its signed invitation.')
  }
  if (verified.expiresAt <= now) {
    throw new Error('This authorization file has expired. Export a new one.')
  }
  return verified
}

function verifiedInvitation(link: string): GeneratedDeviceInvitation {
  const invitation = decodeDeviceInvitationLink(link)
  return {
    link,
    expiresAt: Math.min(
      invitation.offer.offer.expiresAt,
      invitation.matrixLogin?.expiresAt ?? Number.POSITIVE_INFINITY,
    ),
    includesMatrixLogin: invitation.matrixLogin !== undefined,
  }
}
