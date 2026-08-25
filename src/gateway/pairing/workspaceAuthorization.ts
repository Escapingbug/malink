import {
  signedWorkspaceDeviceGrantSchema,
  signedWorkspaceDeviceRevocationSchema,
  type SignedWorkspaceDeviceGrant,
  type SignedWorkspaceDeviceRevocation,
} from '@malink/protocol'
import {
  signWorkspaceDeviceGrant,
  verifyWorkspaceDeviceGrant,
  verifyWorkspaceDeviceRevocation,
} from '@malink/security'
import { AtomicJsonFile, type FileStoreOptions } from '@malink/security/node'
import type { GatewayPairingIdentity } from './identityStore.js'
import type { FileTrustedDeviceRegistry } from './registry.js'

interface WorkspaceAuthorizationState {
  version: 1
  workspaceId: string
  grants: Record<string, SignedWorkspaceDeviceGrant>
  revocations: Record<string, SignedWorkspaceDeviceRevocation>
}

/**
 * Portable Workspace device authorization shared by trusted Gateway nodes.
 * Matrix transports the signed documents, but only the Workspace root key can
 * add or revoke authority.
 */
export class FileWorkspaceDeviceAuthorization {
  private readonly file: AtomicJsonFile<WorkspaceAuthorizationState>

  constructor(
    path: string,
    private readonly identity: GatewayPairingIdentity,
    options: FileStoreOptions = {},
  ) {
    this.file = new AtomicJsonFile(path, options)
  }

  async mergeGrant(input: unknown, now = Date.now()): Promise<boolean> {
    const signed = signedWorkspaceDeviceGrantSchema.parse(input)
    await verifyWorkspaceDeviceGrant(signed, this.identity.keys.publicKey, {
      workspaceId: this.identity.workspaceId,
      now,
    })
    const key = authorizationKey(signed.grant.deviceId, signed.grant.certificateId)
    return this.file.transaction(
      () => initialState(this.identity.workspaceId),
      state => {
        validateState(state, this.identity.workspaceId)
        const existing = state.grants[key]
        if (existing && JSON.stringify(existing) !== JSON.stringify(signed)) {
          throw new Error('Workspace device grant is immutable')
        }
        if (existing) return { result: false, changed: false }
        state.grants[key] = structuredClone(signed)
        return { result: true, changed: true }
      },
    )
  }

  async mergeRevocation(input: unknown): Promise<boolean> {
    const signed = signedWorkspaceDeviceRevocationSchema.parse(input)
    await verifyWorkspaceDeviceRevocation(
      signed,
      this.identity.keys.publicKey,
      this.identity.workspaceId,
    )
    const key = authorizationKey(
      signed.revocation.deviceId,
      signed.revocation.certificateId,
    )
    return this.file.transaction(
      () => initialState(this.identity.workspaceId),
      state => {
        validateState(state, this.identity.workspaceId)
        const existing = state.revocations[key]
        if (existing && JSON.stringify(existing) !== JSON.stringify(signed)) {
          throw new Error('Workspace device revocation is immutable')
        }
        if (existing) return { result: false, changed: false }
        state.revocations[key] = structuredClone(signed)
        return { result: true, changed: true }
      },
    )
  }

  async activeGrants(now = Date.now()): Promise<SignedWorkspaceDeviceGrant[]> {
    const active = await this.file.transaction(
      () => initialState(this.identity.workspaceId),
      state => {
        validateState(state, this.identity.workspaceId)
        const active = Object.entries(state.grants)
          .filter(([key, value]) =>
            value.grant.expiresAt > now && state.revocations[key] === undefined,
          )
          .map(([, value]) => structuredClone(value))
          .sort((left, right) =>
            left.grant.deviceId.localeCompare(right.grant.deviceId) ||
            right.grant.issuedAt - left.grant.issuedAt,
          )
        const latest = new Map<string, SignedWorkspaceDeviceGrant>()
        for (const grant of active) {
          if (!latest.has(grant.grant.deviceId)) latest.set(grant.grant.deviceId, grant)
        }
        return { result: [...latest.values()], changed: false }
      },
    )
    for (const grant of active) {
      await verifyWorkspaceDeviceGrant(grant, this.identity.keys.publicKey, {
        workspaceId: this.identity.workspaceId,
        now,
      })
    }
    return active
  }

  async isActive(deviceId: string, now = Date.now()): Promise<boolean> {
    return (await this.activeGrants(now)).some(value => value.grant.deviceId === deviceId)
  }

  async findRevocation(
    deviceId: string,
    certificateId: string,
  ): Promise<SignedWorkspaceDeviceRevocation | undefined> {
    const revocation = await this.file.transaction(
      () => initialState(this.identity.workspaceId),
      state => {
        validateState(state, this.identity.workspaceId)
        const value = state.revocations[authorizationKey(deviceId, certificateId)]
        return {
          result: value ? structuredClone(value) : undefined,
          changed: false,
        }
      },
    )
    if (revocation) {
      await verifyWorkspaceDeviceRevocation(
        revocation,
        this.identity.keys.publicKey,
        this.identity.workspaceId,
      )
    }
    return revocation
  }

  async revocations(): Promise<SignedWorkspaceDeviceRevocation[]> {
    const revocations = await this.file.transaction(
      () => initialState(this.identity.workspaceId),
      state => {
        validateState(state, this.identity.workspaceId)
        return {
          result: Object.values(state.revocations).map(value => structuredClone(value)),
          changed: false,
        }
      },
    )
    for (const revocation of revocations) {
      await verifyWorkspaceDeviceRevocation(
        revocation,
        this.identity.keys.publicKey,
        this.identity.workspaceId,
      )
    }
    return revocations
  }
}

/**
 * Converts a legacy local pairing certificate into the equivalent portable
 * Workspace grant. Every authority-bearing field and the expiry are copied
 * exactly, so upgrading does not widen an existing client's authorization.
 */
export async function ensurePortableWorkspaceGrant(
  identity: GatewayPairingIdentity,
  registry: FileTrustedDeviceRegistry,
  deviceId: string,
): Promise<SignedWorkspaceDeviceGrant> {
  const record = await registry.get(deviceId)
  if (!record || record.status !== 'active') {
    throw new Error(`Active trusted device is unavailable: ${deviceId}`)
  }
  if (record.workspaceGrant) return record.workspaceGrant
  const certificate = record.certificate.certificate
  if (
    certificate.gatewayId !== identity.workspaceId ||
    certificate.gatewayKeyId !== identity.keys.keyId
  ) throw new Error('Pairing certificate belongs to another Workspace authority')
  const grant = await signWorkspaceDeviceGrant({
    kind: 'malink.workspace.device-grant',
    version: 1,
    grantId: `legacy-${certificate.certificateId}`,
    workspaceId: identity.workspaceId,
    certificateId: certificate.certificateId,
    deviceId: certificate.deviceId,
    deviceName: certificate.deviceName,
    deviceKey: certificate.deviceKey,
    deviceTransport: certificate.deviceTransport,
    allowedOperations: certificate.allowedOperations,
    issuedAt: certificate.issuedAt,
    expiresAt: certificate.expiresAt,
  }, identity.keys.privateKey, identity.keys.keyId)
  return registry.attachWorkspaceGrant(deviceId, grant)
}

function authorizationKey(deviceId: string, certificateId: string): string {
  return `${deviceId}\u0000${certificateId}`
}

function initialState(workspaceId: string): WorkspaceAuthorizationState {
  return { version: 1, workspaceId, grants: {}, revocations: {} }
}

function validateState(state: WorkspaceAuthorizationState, workspaceId: string): void {
  if (
    state.version !== 1 || state.workspaceId !== workspaceId ||
    !state.grants || typeof state.grants !== 'object' ||
    !state.revocations || typeof state.revocations !== 'object'
  ) throw new TypeError('Workspace device authorization state is invalid')
  for (const [key, value] of Object.entries(state.grants)) {
    const grant = signedWorkspaceDeviceGrantSchema.parse(value)
    if (key !== authorizationKey(grant.grant.deviceId, grant.grant.certificateId)) {
      throw new TypeError('Workspace device grant key is invalid')
    }
  }
  for (const [key, value] of Object.entries(state.revocations)) {
    const revocation = signedWorkspaceDeviceRevocationSchema.parse(value)
    if (key !== authorizationKey(
      revocation.revocation.deviceId,
      revocation.revocation.certificateId,
    )) throw new TypeError('Workspace device revocation key is invalid')
  }
}
