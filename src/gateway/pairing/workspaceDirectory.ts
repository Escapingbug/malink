import { randomUUID } from 'node:crypto'
import {
  canonicalJson,
  signedWorkspaceGatewayDirectorySchema,
  workspaceGatewayDescriptorSchema,
  type MatrixTransportBinding,
  type SignedWorkspaceGatewayDirectory,
  type WorkspaceGatewayDescriptor,
  type WorkspaceProjectRoute,
} from '@malink/protocol'
import {
  exportPairingPublicKey,
  signWorkspaceGatewayDirectory,
  verifyWorkspaceGatewayDirectory,
} from '@malink/security'
import { AtomicJsonFile, type FileStoreOptions } from '@malink/security/node'
import type { GatewayPairingIdentity } from './identityStore.js'

interface WorkspaceDirectoryState {
  version: 1
  workspaceId: string
  clientMatrixUserId?: string
  revision: number
  gateways: Record<string, WorkspaceGatewayDescriptor>
  removedGatewayNodeIds?: string[]
  signed?: SignedWorkspaceGatewayDirectory
}

export class FileWorkspaceGatewayDirectory {
  private readonly file: AtomicJsonFile<WorkspaceDirectoryState>

  constructor(
    path: string,
    private readonly identity: GatewayPairingIdentity,
    options: FileStoreOptions = {},
  ) {
    this.file = new AtomicJsonFile(path, options)
  }

  /**
   * Establishes the client Matrix identity once. Changing it is a migration,
   * never an incidental consequence of replacing a local credential file.
   */
  async setClientMatrixUserId(userId: string): Promise<void> {
    const normalized = requireMatrixUserId(userId)
    await this.file.transaction(
      () => initialState(this.identity.workspaceId),
      state => {
        validateState(state, this.identity.workspaceId)
        if (state.clientMatrixUserId === normalized) {
          return { result: undefined, changed: false }
        }
        if (state.clientMatrixUserId) {
          throw new Error(
            `Workspace client Matrix identity is already ${state.clientMatrixUserId}`,
          )
        }
        state.clientMatrixUserId = normalized
        state.revision += 1
        state.signed = undefined
        return { result: undefined, changed: true }
      },
    )
  }

  async publishLocal(
    gatewayName: string,
    transport: MatrixTransportBinding,
    now = Date.now(),
    projects: readonly WorkspaceProjectRoute[] = [],
    runtime: { computerName?: string; buildId?: string; onlineUpdate?: true } = {},
  ): Promise<SignedWorkspaceGatewayDirectory> {
    const publicKey = await exportPairingPublicKey(this.identity.keys.publicKey)
    const normalizedProjects = [...projects]
      .map(project => structuredClone(project))
      .sort((left, right) =>
        left.projectId.localeCompare(right.projectId)
        || left.roomId.localeCompare(right.roomId))
    const result = await this.file.transaction(
      () => initialState(this.identity.workspaceId),
      state => {
        validateState(state, this.identity.workspaceId)
        if (state.removedGatewayNodeIds?.includes(this.identity.gatewayNodeId)) {
          throw new Error('This Gateway node was removed from the Workspace directory')
        }
        const nextDescriptor = {
          gatewayNodeId: this.identity.gatewayNodeId,
          workspaceId: this.identity.workspaceId,
          gatewayName,
          ...(runtime.computerName ? { computerName: runtime.computerName } : {}),
          ...(runtime.buildId ? { buildId: runtime.buildId } : {}),
          ...(runtime.onlineUpdate ? { onlineUpdate: true as const } : {}),
          transport,
          publicKey,
          ...(normalizedProjects.length > 0 ? { projects: normalizedProjects } : {}),
        }
        const previous = state.gateways[nextDescriptor.gatewayNodeId]
        const changed = !previous
          || canonicalJson(descriptorSemantics(previous)) !== canonicalJson(nextDescriptor)
        if (changed) {
          state.gateways[nextDescriptor.gatewayNodeId] = {
            ...nextDescriptor,
            issuedAt: now,
          }
          state.revision += 1
          state.signed = undefined
        }
        const needsSigning = changed || state.signed?.directory.revision !== state.revision
        return {
          result: needsSigning ? undefined : structuredClone(state.signed),
          changed,
        }
      },
    )
    return this.verifyStored(result ?? await this.signCurrent(now))
  }

  async merge(input: unknown): Promise<SignedWorkspaceGatewayDirectory> {
    const signed = signedWorkspaceGatewayDirectorySchema.parse(input)
    await verifyWorkspaceGatewayDirectory(signed, this.identity.keys.publicKey, {
      workspaceId: this.identity.workspaceId,
    })
    const result = await this.file.transaction(
      () => initialState(this.identity.workspaceId),
      state => {
        validateState(state, this.identity.workspaceId)
        if (signed.directory.revision < state.revision) {
          throw new Error('Workspace Gateway directory revision rolled back')
        }
        if (
          state.clientMatrixUserId
          && signed.directory.clientMatrixUserId !== state.clientMatrixUserId
        ) {
          throw new Error('Workspace client Matrix identity cannot change or be removed')
        }
        const clientMatrixUserId =
          state.clientMatrixUserId ?? signed.directory.clientMatrixUserId
        const removed = new Set([
          ...(state.removedGatewayNodeIds ?? []),
          ...(signed.directory.removedGatewayNodeIds ?? []),
        ])
        const merged = { ...state.gateways }
        for (const gatewayNodeId of removed) delete merged[gatewayNodeId]
        for (const gateway of signed.directory.gateways) {
          if (removed.has(gateway.gatewayNodeId)) continue
          const current = merged[gateway.gatewayNodeId]
          // Every Gateway is the sole runtime authority for its own node
          // descriptor. Another node may relay an older signed copy, but it
          // must never overwrite the local build, routes, or transport merely
          // because that copy was republished with a later timestamp.
          merged[gateway.gatewayNodeId] = current
            ? gateway.gatewayNodeId === this.identity.gatewayNodeId
              ? current
              : preferredGatewayDescriptor(current, gateway)
            : gateway
        }
        const mergedGateways = Object.values(merged).sort((a, b) =>
          a.gatewayNodeId.localeCompare(b.gatewayNodeId))
        const currentGateways = Object.values(state.gateways).sort((a, b) =>
          a.gatewayNodeId.localeCompare(b.gatewayNodeId))
        const incomingGateways = [...signed.directory.gateways].sort((a, b) =>
          a.gatewayNodeId.localeCompare(b.gatewayNodeId))
        const incomingMatchesCurrent =
          canonicalJson(currentGateways) === canonicalJson(incomingGateways) &&
          state.clientMatrixUserId === signed.directory.clientMatrixUserId &&
          JSON.stringify([...(state.removedGatewayNodeIds ?? [])].sort()) === JSON.stringify(
            [...(signed.directory.removedGatewayNodeIds ?? [])].sort(),
          )
        const incomingContainsUnion =
          canonicalJson(mergedGateways) === canonicalJson(incomingGateways) &&
          clientMatrixUserId === signed.directory.clientMatrixUserId &&
          JSON.stringify([...removed].sort()) === JSON.stringify(
            [...(signed.directory.removedGatewayNodeIds ?? [])].sort(),
          )
        if (signed.directory.revision === state.revision && state.signed &&
            canonicalJson(state.signed) === canonicalJson(signed)) {
          return { result: structuredClone(state.signed), changed: false }
        }
        if (signed.directory.revision === state.revision && incomingMatchesCurrent) {
          if (!state.signed) {
            state.signed = signed
            return { result: structuredClone(signed), changed: true }
          }
          if (canonicalJson(state.signed) <= canonicalJson(signed)) {
            return { result: structuredClone(state.signed), changed: false }
          }
          // Clients reject different documents at one immutable revision. The
          // deterministic loser therefore advances once and republishes.
          state.revision += 1
          state.signed = undefined
          return { result: undefined, changed: true }
        }
        state.gateways = merged
        state.clientMatrixUserId = clientMatrixUserId
        state.removedGatewayNodeIds = [...removed].sort()
        if (incomingContainsUnion && signed.directory.revision > state.revision) {
          state.revision = signed.directory.revision
          state.signed = signed
          return { result: structuredClone(signed), changed: true }
        }
        state.revision = Math.max(state.revision, signed.directory.revision) + 1
        state.signed = undefined
        return { result: undefined, changed: true }
      },
    )
    return this.verifyStored(result ?? await this.signCurrent())
  }

  async remove(
    gatewayNodeId: string,
    now = Date.now(),
  ): Promise<SignedWorkspaceGatewayDirectory> {
    if (!gatewayNodeId || gatewayNodeId.length > 512) {
      throw new TypeError('Gateway node ID is invalid')
    }
    if (gatewayNodeId === this.identity.gatewayNodeId) {
      throw new Error('A Gateway cannot remove its own node identity')
    }
    const result = await this.file.transaction(
      () => initialState(this.identity.workspaceId),
      state => {
        validateState(state, this.identity.workspaceId)
        const removed = new Set(state.removedGatewayNodeIds ?? [])
        if (removed.has(gatewayNodeId)) {
          return {
            result: state.signed?.directory.revision === state.revision
              ? structuredClone(state.signed)
              : undefined,
            changed: false,
          }
        }
        if (!state.gateways[gatewayNodeId]) {
          throw new Error(`Unknown Workspace Gateway node: ${gatewayNodeId}`)
        }
        delete state.gateways[gatewayNodeId]
        removed.add(gatewayNodeId)
        state.removedGatewayNodeIds = [...removed].sort()
        state.revision += 1
        state.signed = undefined
        return { result: undefined, changed: true }
      },
    )
    return this.verifyStored(result ?? await this.signCurrent(now))
  }

  async load(): Promise<SignedWorkspaceGatewayDirectory | undefined> {
    const current = await this.file.transaction(
      () => initialState(this.identity.workspaceId),
      state => {
        validateState(state, this.identity.workspaceId)
        return {
          result: {
            revision: state.revision,
            signed: state.signed ? structuredClone(state.signed) : undefined,
          },
          changed: false,
        }
      },
    )
    if (current.signed?.directory.revision === current.revision) {
      return this.verifyStored(current.signed)
    }
    return this.verifyStored(await this.signCurrent())
  }

  private async signCurrent(now = Date.now()): Promise<SignedWorkspaceGatewayDirectory> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const draft = await this.file.transaction(
        () => initialState(this.identity.workspaceId),
        state => {
          validateState(state, this.identity.workspaceId)
          return {
            result: {
              revision: state.revision,
              clientMatrixUserId: state.clientMatrixUserId,
              gateways: Object.values(state.gateways).sort((a, b) =>
                a.gatewayNodeId.localeCompare(b.gatewayNodeId)),
              removedGatewayNodeIds: [...(state.removedGatewayNodeIds ?? [])].sort(),
              existing: state.signed ? structuredClone(state.signed) : undefined,
            },
            changed: false,
          }
        },
      )
      if (draft.existing?.directory.revision === draft.revision) {
        return this.verifyStored(draft.existing)
      }
      const signed = await signWorkspaceGatewayDirectory({
        kind: 'malink.workspace.gateway-directory',
        version: 1,
        directoryId: randomUUID(),
        workspaceId: this.identity.workspaceId,
        ...(draft.clientMatrixUserId
          ? { clientMatrixUserId: draft.clientMatrixUserId }
          : {}),
        revision: draft.revision,
        gateways: draft.gateways,
        ...(draft.removedGatewayNodeIds.length > 0
          ? { removedGatewayNodeIds: draft.removedGatewayNodeIds }
          : {}),
        issuedAt: now,
      }, this.identity.keys.privateKey, this.identity.keys.keyId)
      const committed = await this.file.transaction(
        () => initialState(this.identity.workspaceId),
        state => {
          validateState(state, this.identity.workspaceId)
          if (state.revision !== draft.revision) {
            return { result: undefined, changed: false }
          }
          state.signed = signed
          return { result: structuredClone(signed), changed: true }
        },
      )
      if (committed) return committed
    }
    throw new Error('Workspace Gateway directory kept changing while it was being signed')
  }

  private async verifyStored(
    signed: SignedWorkspaceGatewayDirectory,
  ): Promise<SignedWorkspaceGatewayDirectory> {
    await verifyWorkspaceGatewayDirectory(signed, this.identity.keys.publicKey, {
      workspaceId: this.identity.workspaceId,
    })
    return signed
  }
}

function descriptorSemantics(
  descriptor: WorkspaceGatewayDescriptor,
): Omit<WorkspaceGatewayDescriptor, 'issuedAt'> {
  const { issuedAt: _issuedAt, ...semantics } = descriptor
  return semantics
}

function initialState(workspaceId: string): WorkspaceDirectoryState {
  return { version: 1, workspaceId, revision: 0, gateways: {}, removedGatewayNodeIds: [] }
}

function preferredGatewayDescriptor(
  left: WorkspaceGatewayDescriptor,
  right: WorkspaceGatewayDescriptor,
): WorkspaceGatewayDescriptor {
  if (left.issuedAt !== right.issuedAt) return left.issuedAt > right.issuedAt ? left : right
  return canonicalJson(left) <= canonicalJson(right) ? left : right
}

function validateState(state: WorkspaceDirectoryState, workspaceId: string): void {
  if (
    state.version !== 1 || state.workspaceId !== workspaceId ||
    (state.clientMatrixUserId !== undefined
      && requireMatrixUserId(state.clientMatrixUserId) !== state.clientMatrixUserId) ||
    !Number.isSafeInteger(state.revision) || state.revision < 0 ||
    !state.gateways || typeof state.gateways !== 'object' ||
    Object.keys(state.gateways).length > 256 ||
    (state.removedGatewayNodeIds !== undefined &&
      (!Array.isArray(state.removedGatewayNodeIds) ||
        state.removedGatewayNodeIds.length > 256 ||
        new Set(state.removedGatewayNodeIds).size !== state.removedGatewayNodeIds.length))
  ) throw new TypeError('Workspace Gateway directory state is invalid')
  const removed = new Set(state.removedGatewayNodeIds ?? [])
  for (const [gatewayNodeId, value] of Object.entries(state.gateways)) {
    const gateway = workspaceGatewayDescriptorSchema.parse(value)
    if (
      gatewayNodeId !== gateway.gatewayNodeId || gateway.workspaceId !== workspaceId ||
      removed.has(gatewayNodeId)
    ) throw new TypeError('Workspace Gateway directory entry is invalid')
  }
  if (state.signed) {
    const signed = signedWorkspaceGatewayDirectorySchema.parse(state.signed)
    if (
      signed.directory.workspaceId !== workspaceId ||
      signed.directory.clientMatrixUserId !== state.clientMatrixUserId ||
      signed.directory.revision > state.revision
    ) throw new TypeError('Workspace Gateway signed directory state is invalid')
    if (signed.directory.revision === state.revision) {
      const gateways = Object.values(state.gateways).sort((a, b) =>
        a.gatewayNodeId.localeCompare(b.gatewayNodeId))
      const signedGateways = [...signed.directory.gateways].sort((a, b) =>
        a.gatewayNodeId.localeCompare(b.gatewayNodeId))
      if (
        canonicalJson(gateways) !== canonicalJson(signedGateways) ||
        JSON.stringify([...(state.removedGatewayNodeIds ?? [])].sort()) !== JSON.stringify(
          [...(signed.directory.removedGatewayNodeIds ?? [])].sort(),
        )
      ) throw new TypeError('Workspace Gateway signed directory content is inconsistent')
    }
  }
}

function requireMatrixUserId(value: string): string {
  const normalized = value.trim()
  if (
    normalized !== value
    || value.length > 512
    || !/^@[^:\s]+:[^\s]+$/u.test(value)
  ) throw new TypeError('Workspace client Matrix user ID is invalid')
  return normalized
}
