import { randomUUID } from 'node:crypto'
import { canonicalJson, signedWorkspaceGatewayDirectorySchema, type SignedWorkspaceGatewayDirectory } from '@malink/protocol'
import {
  importDeviceKeyPair,
  verifyWorkspaceGatewayDirectory,
  type SerializedDeviceKeyPair,
} from '@malink/security'
import type { FileGatewayIdentityStore, GatewayPairingIdentity } from './identityStore.js'

const PREFIX = 'malink://gateway-join#data='
const MAX_LIFETIME_MS = 10 * 60_000

export interface GatewayJoinInvitation {
  version: 1
  invitationId: string
  workspaceId: string
  workspaceKeyPair: SerializedDeviceKeyPair
  directory?: SignedWorkspaceGatewayDirectory
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
): { invitation: GatewayJoinInvitation; link: string } {
  if (!Number.isSafeInteger(lifetimeMs) || lifetimeMs < 30_000 || lifetimeMs > MAX_LIFETIME_MS) {
    throw new RangeError('Gateway join invitation lifetime must be between 30 seconds and 10 minutes')
  }
  const invitation: GatewayJoinInvitation = {
    version: 1,
    invitationId: randomUUID(),
    workspaceId: identity.workspaceId,
    workspaceKeyPair: identity.serialized,
    ...(directory ? { directory: signedWorkspaceGatewayDirectorySchema.parse(directory) } : {}),
    issuedAt: now,
    expiresAt: now + lifetimeMs,
  }
  return { invitation, link: `${PREFIX}${encode(canonicalJson(invitation))}` }
}

export async function acceptGatewayJoinInvitation(
  store: FileGatewayIdentityStore,
  link: string,
  gatewayNodeId: string = randomUUID(),
  now = Date.now(),
): Promise<{ identity: GatewayPairingIdentity; directory?: SignedWorkspaceGatewayDirectory }> {
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
  return { identity, ...(invitation.directory ? { directory: invitation.directory } : {}) }
}

export function decodeGatewayJoinInvitation(link: string, now = Date.now()): GatewayJoinInvitation {
  if (!link.startsWith(PREFIX)) throw new TypeError('Invalid Malink Gateway join link')
  let value: unknown
  try {
    value = JSON.parse(decode(link.slice(PREFIX.length)))
  } catch (error) {
    throw new TypeError('Invalid Malink Gateway join payload', { cause: error })
  }
  if (!value || typeof value !== 'object') throw new TypeError('Invalid Malink Gateway join payload')
  const candidate = value as Partial<GatewayJoinInvitation>
  if (
    candidate.version !== 1 || typeof candidate.invitationId !== 'string' || !candidate.invitationId ||
    typeof candidate.workspaceId !== 'string' || !candidate.workspaceId ||
    !candidate.workspaceKeyPair || typeof candidate.issuedAt !== 'number' ||
    typeof candidate.expiresAt !== 'number' || candidate.expiresAt <= now ||
    candidate.expiresAt <= candidate.issuedAt || candidate.expiresAt - candidate.issuedAt > MAX_LIFETIME_MS
  ) throw new TypeError('Gateway join invitation is invalid or expired')
  return {
    version: 1,
    invitationId: candidate.invitationId,
    workspaceId: candidate.workspaceId,
    workspaceKeyPair: candidate.workspaceKeyPair,
    ...(candidate.directory
      ? { directory: signedWorkspaceGatewayDirectorySchema.parse(candidate.directory) }
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
