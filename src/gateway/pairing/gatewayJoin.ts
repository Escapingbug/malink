import { randomUUID } from 'node:crypto'
import {
  canonicalJson,
  signedWorkspaceDeviceGrantSchema,
  signedWorkspaceDeviceRevocationSchema,
  signedWorkspaceGatewayDirectorySchema,
  type SignedWorkspaceDeviceGrant,
  type SignedWorkspaceDeviceRevocation,
  type SignedWorkspaceGatewayDirectory,
} from '@malink/protocol'
import {
  importDeviceKeyPair,
  verifyWorkspaceDeviceGrant,
  verifyWorkspaceDeviceRevocation,
  verifyWorkspaceGatewayDirectory,
  type SerializedDeviceKeyPair,
} from '@malink/security'
import type { FileGatewayIdentityStore, GatewayPairingIdentity } from './identityStore.js'

const PREFIX = 'malink://gateway-join#data='
const MAX_LIFETIME_MS = 10 * 60_000
const MAX_AUTHORIZATION_DOCUMENTS = 256
const MAX_INVITATION_LINK_CHARS = 2 * 1024 * 1024

export interface GatewayJoinInvitation {
  version: 1
  invitationId: string
  workspaceId: string
  workspaceKeyPair: SerializedDeviceKeyPair
  directory?: SignedWorkspaceGatewayDirectory
  deviceGrants?: SignedWorkspaceDeviceGrant[]
  deviceRevocations?: SignedWorkspaceDeviceRevocation[]
  issuedAt: number
  expiresAt: number
}

/**
 * A deliberately high-authority bearer invitation. The payload contains the
 * shared Workspace signing key and must only be shown locally or inside MLP
 * application encryption. URL fragments keep it out of HTTP request logs.
 */
export function createGatewayJoinInvitation(
  identity: GatewayPairingIdentity,
  directory?: SignedWorkspaceGatewayDirectory,
  now = Date.now(),
  lifetimeMs = 5 * 60_000,
  authorization: {
    grants?: readonly SignedWorkspaceDeviceGrant[]
    revocations?: readonly SignedWorkspaceDeviceRevocation[]
  } = {},
): { invitation: GatewayJoinInvitation; link: string } {
  if (!Number.isSafeInteger(lifetimeMs) || lifetimeMs < 30_000 || lifetimeMs > MAX_LIFETIME_MS) {
    throw new RangeError('Gateway join invitation lifetime must be between 30 seconds and 10 minutes')
  }
  if ((authorization.grants?.length ?? 0) > MAX_AUTHORIZATION_DOCUMENTS ||
      (authorization.revocations?.length ?? 0) > MAX_AUTHORIZATION_DOCUMENTS) {
    throw new RangeError('Gateway join invitation contains too many authorization documents')
  }
  const invitation: GatewayJoinInvitation = {
    version: 1,
    invitationId: randomUUID(),
    workspaceId: identity.workspaceId,
    workspaceKeyPair: identity.serialized,
    ...(directory ? { directory: signedWorkspaceGatewayDirectorySchema.parse(directory) } : {}),
    ...(authorization.grants?.length
      ? { deviceGrants: authorization.grants.map(value => signedWorkspaceDeviceGrantSchema.parse(value)) }
      : {}),
    ...(authorization.revocations?.length
      ? { deviceRevocations: authorization.revocations.map(value =>
        signedWorkspaceDeviceRevocationSchema.parse(value)) }
      : {}),
    issuedAt: now,
    expiresAt: now + lifetimeMs,
  }
  const link = `${PREFIX}${encode(canonicalJson(invitation))}`
  if (link.length > MAX_INVITATION_LINK_CHARS) {
    throw new RangeError('Gateway join invitation is too large')
  }
  return { invitation, link }
}

export async function acceptGatewayJoinInvitation(
  store: FileGatewayIdentityStore,
  link: string,
  gatewayNodeId: string = randomUUID(),
  now = Date.now(),
): Promise<{
  identity: GatewayPairingIdentity
  directory?: SignedWorkspaceGatewayDirectory
  deviceGrants: SignedWorkspaceDeviceGrant[]
  deviceRevocations: SignedWorkspaceDeviceRevocation[]
}> {
  const invitation = decodeGatewayJoinInvitation(link, now)
  const keys = await importDeviceKeyPair(invitation.workspaceKeyPair)
  if (keys.keyId !== invitation.workspaceKeyPair.keyId) {
    throw new Error('Gateway join invitation Workspace key is invalid')
  }
  const identity = await store.joinWorkspace(
    invitation.workspaceId,
    invitation.workspaceKeyPair,
    gatewayNodeId,
    now,
  )
  if (invitation.directory) {
    await verifyWorkspaceGatewayDirectory(invitation.directory, identity.keys.publicKey, {
      workspaceId: identity.workspaceId,
    })
  }
  for (const grant of invitation.deviceGrants ?? []) {
    await verifyWorkspaceDeviceGrant(grant, identity.keys.publicKey, {
      workspaceId: identity.workspaceId,
      now,
    })
  }
  for (const revocation of invitation.deviceRevocations ?? []) {
    await verifyWorkspaceDeviceRevocation(
      revocation,
      identity.keys.publicKey,
      identity.workspaceId,
    )
  }
  return {
    identity,
    ...(invitation.directory ? { directory: invitation.directory } : {}),
    deviceGrants: invitation.deviceGrants ?? [],
    deviceRevocations: invitation.deviceRevocations ?? [],
  }
}

export function decodeGatewayJoinInvitation(link: string, now = Date.now()): GatewayJoinInvitation {
  if (!link.startsWith(PREFIX)) throw new TypeError('Invalid Malink Gateway join link')
  if (link.length > MAX_INVITATION_LINK_CHARS) {
    throw new TypeError('Gateway join invitation is too large')
  }
  let value: unknown
  try {
    value = JSON.parse(decode(link.slice(PREFIX.length)))
  } catch (error) {
    throw new TypeError('Invalid Malink Gateway join payload', { cause: error })
  }
  if (!value || typeof value !== 'object') throw new TypeError('Invalid Malink Gateway join payload')
  const candidate = value as Partial<GatewayJoinInvitation>
  if (
    candidate.version !== 1 || typeof candidate.invitationId !== 'string' ||
    candidate.invitationId.length < 1 || candidate.invitationId.length > 512 ||
    typeof candidate.workspaceId !== 'string' ||
    candidate.workspaceId.length < 1 || candidate.workspaceId.length > 512 ||
    !candidate.workspaceKeyPair || typeof candidate.issuedAt !== 'number' ||
    !Number.isSafeInteger(candidate.issuedAt) || typeof candidate.expiresAt !== 'number' ||
    !Number.isSafeInteger(candidate.expiresAt) || candidate.issuedAt < 0 ||
    candidate.expiresAt <= now ||
    candidate.expiresAt <= candidate.issuedAt || candidate.expiresAt - candidate.issuedAt > MAX_LIFETIME_MS
  ) throw new TypeError('Gateway join invitation is invalid or expired')
  if ((candidate.deviceGrants?.length ?? 0) > MAX_AUTHORIZATION_DOCUMENTS ||
      (candidate.deviceRevocations?.length ?? 0) > MAX_AUTHORIZATION_DOCUMENTS) {
    throw new TypeError('Gateway join invitation contains too many authorization documents')
  }
  return {
    version: 1,
    invitationId: candidate.invitationId,
    workspaceId: candidate.workspaceId,
    workspaceKeyPair: candidate.workspaceKeyPair,
    ...(candidate.directory
      ? { directory: signedWorkspaceGatewayDirectorySchema.parse(candidate.directory) }
      : {}),
    ...(candidate.deviceGrants
      ? {
          deviceGrants: candidate.deviceGrants.map(value =>
            signedWorkspaceDeviceGrantSchema.parse(value)),
        }
      : {}),
    ...(candidate.deviceRevocations
      ? {
          deviceRevocations: candidate.deviceRevocations.map(value =>
            signedWorkspaceDeviceRevocationSchema.parse(value)),
        }
      : {}),
    issuedAt: candidate.issuedAt,
    expiresAt: candidate.expiresAt,
  }
}

function encode(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url')
}

function decode(value: string): string {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new TypeError('Invalid base64url payload')
  return Buffer.from(value, 'base64url').toString('utf8')
}
