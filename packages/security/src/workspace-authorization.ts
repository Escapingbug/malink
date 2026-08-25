import {
  canonicalJsonBytes,
  signedWorkspaceDeviceGrantSchema,
  signedWorkspaceDeviceRevocationSchema,
  signedWorkspaceGatewayDirectorySchema,
  workspaceDeviceGrantSchema,
  workspaceDeviceRevocationSchema,
  workspaceGatewayDirectorySchema,
  type SignedWorkspaceDeviceGrant,
  type SignedWorkspaceDeviceRevocation,
  type SignedWorkspaceGatewayDirectory,
  type WorkspaceDeviceGrant,
  type WorkspaceDeviceRevocation,
  type WorkspaceGatewayDirectory,
} from '@malink/protocol'
import {
  base64UrlDecode,
  base64UrlEncode,
  isCryptoKey,
  publicKeyId,
  toArrayBuffer,
  webCrypto,
} from './encoding.js'
import { importPublicDeviceKey } from './device-keys.js'
import { SecurityError } from './errors.js'

const algorithm: EcdsaParams = { name: 'ECDSA', hash: 'SHA-256' }

export async function signWorkspaceDeviceGrant(
  input: WorkspaceDeviceGrant,
  privateKey: CryptoKey,
  keyId: string,
): Promise<SignedWorkspaceDeviceGrant> {
  const grant = workspaceDeviceGrantSchema.parse(input)
  return signedWorkspaceDeviceGrantSchema.parse({
    grant,
    signature: await signature('malink.workspace.device-grant.v1', grant, privateKey, keyId),
  })
}

export async function verifyWorkspaceDeviceGrant(
  input: unknown,
  workspacePublicKey: CryptoKey | JsonWebKey,
  bindings: { workspaceId: string; now?: number },
): Promise<WorkspaceDeviceGrant> {
  const signed = signedWorkspaceDeviceGrantSchema.parse(input)
  await verifySignature('malink.workspace.device-grant.v1', signed.grant, signed.signature, workspacePublicKey)
  if (signed.grant.workspaceId !== bindings.workspaceId) {
    throw new SecurityError('binding_mismatch', 'Device grant belongs to another workspace')
  }
  if (signed.grant.expiresAt <= (bindings.now ?? Date.now())) {
    throw new SecurityError('expired', 'Workspace device grant has expired')
  }
  return signed.grant
}

export async function signWorkspaceDeviceRevocation(
  input: WorkspaceDeviceRevocation,
  privateKey: CryptoKey,
  keyId: string,
): Promise<SignedWorkspaceDeviceRevocation> {
  const revocation = workspaceDeviceRevocationSchema.parse(input)
  return signedWorkspaceDeviceRevocationSchema.parse({
    revocation,
    signature: await signature('malink.workspace.device-revocation.v1', revocation, privateKey, keyId),
  })
}

export async function verifyWorkspaceDeviceRevocation(
  input: unknown,
  workspacePublicKey: CryptoKey | JsonWebKey,
  workspaceId: string,
): Promise<WorkspaceDeviceRevocation> {
  const signed = signedWorkspaceDeviceRevocationSchema.parse(input)
  await verifySignature(
    'malink.workspace.device-revocation.v1',
    signed.revocation,
    signed.signature,
    workspacePublicKey,
  )
  if (signed.revocation.workspaceId !== workspaceId) {
    throw new SecurityError('binding_mismatch', 'Device revocation belongs to another workspace')
  }
  return signed.revocation
}

export async function signWorkspaceGatewayDirectory(
  input: WorkspaceGatewayDirectory,
  privateKey: CryptoKey,
  keyId: string,
): Promise<SignedWorkspaceGatewayDirectory> {
  const directory = workspaceGatewayDirectorySchema.parse(input)
  return signedWorkspaceGatewayDirectorySchema.parse({
    directory,
    signature: await signature('malink.workspace.gateway-directory.v1', directory, privateKey, keyId),
  })
}

export async function verifyWorkspaceGatewayDirectory(
  input: unknown,
  workspacePublicKey: CryptoKey | JsonWebKey,
  bindings: { workspaceId: string; minimumRevision?: number },
): Promise<WorkspaceGatewayDirectory> {
  const signed = signedWorkspaceGatewayDirectorySchema.parse(input)
  await verifySignature(
    'malink.workspace.gateway-directory.v1',
    signed.directory,
    signed.signature,
    workspacePublicKey,
  )
  if (signed.directory.workspaceId !== bindings.workspaceId) {
    throw new SecurityError('binding_mismatch', 'Gateway directory belongs to another workspace')
  }
  if (
    bindings.minimumRevision !== undefined &&
    signed.directory.revision < bindings.minimumRevision
  ) {
    throw new SecurityError('replay', 'Gateway directory revision rolled back')
  }
  return signed.directory
}

async function signature(
  domain: string,
  document: unknown,
  privateKey: CryptoKey,
  keyId: string,
) {
  const value = await webCrypto().subtle.sign(
    algorithm,
    privateKey,
    toArrayBuffer(canonicalJsonBytes({ domain, document })),
  )
  return { algorithm: 'ES256' as const, keyId, value: base64UrlEncode(new Uint8Array(value)) }
}

async function verifySignature(
  domain: string,
  document: unknown,
  signatureValue: { keyId: string; value: string },
  publicKey: CryptoKey | JsonWebKey,
): Promise<void> {
  if (signatureValue.keyId !== await publicKeyId(publicKey)) {
    throw new SecurityError('key_mismatch', 'Workspace authorization signer is not the pinned key')
  }
  const key = isCryptoKey(publicKey) ? publicKey : await importPublicDeviceKey({
    version: 1,
    algorithm: 'ES256',
    keyId: signatureValue.keyId,
    publicKey,
  })
  const valid = await webCrypto().subtle.verify(
    algorithm,
    key,
    toArrayBuffer(base64UrlDecode(signatureValue.value)),
    toArrayBuffer(canonicalJsonBytes({ domain, document })),
  )
  if (!valid) throw new SecurityError('invalid_signature', 'Workspace authorization signature is invalid')
}
