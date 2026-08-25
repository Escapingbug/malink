import { randomUUID } from 'node:crypto'
import {
  signedWorkspaceGatewayDirectorySchema,
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
  revision: number
  gateways: Record<string, WorkspaceGatewayDescriptor>
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

  async publishLocal(
    gatewayName: string,
    transport: MatrixTransportBinding,
    now = Date.now(),
    projects: readonly WorkspaceProjectRoute[] = [],
  ): Promise<SignedWorkspaceGatewayDirectory> {
    const publicKey = await exportPairingPublicKey(this.identity.keys.publicKey)
    const result = await this.file.transaction(
      () => initialState(this.identity.workspaceId),
      state => {
        validateState(state, this.identity.workspaceId)
        const descriptor: WorkspaceGatewayDescriptor = {
          gatewayNodeId: this.identity.gatewayNodeId,
          workspaceId: this.identity.workspaceId,
          gatewayName,
          transport,
          publicKey,
          ...(projects.length > 0 ? { projects: structuredClone([...projects]) } : {}),
          issuedAt: now,
        }
        const previous = state.gateways[descriptor.gatewayNodeId]
        const changed = JSON.stringify(previous) !== JSON.stringify(descriptor)
        if (changed) {
          state.gateways[descriptor.gatewayNodeId] = descriptor
          state.revision += 1
        }
        const needsSigning = changed || state.signed?.directory.revision !== state.revision
        return {
          result: needsSigning ? undefined : structuredClone(state.signed),
          changed,
        }
      },
    )
    return result ?? this.signCurrent(now)
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
        const merged = { ...state.gateways }
        for (const gateway of signed.directory.gateways) merged[gateway.gatewayNodeId] = gateway
        const mergedGateways = Object.values(merged).sort((a, b) =>
          a.gatewayNodeId.localeCompare(b.gatewayNodeId))
        const incomingGateways = [...signed.directory.gateways].sort((a, b) =>
          a.gatewayNodeId.localeCompare(b.gatewayNodeId))
        const incomingContainsUnion =
          JSON.stringify(mergedGateways) === JSON.stringify(incomingGateways)
        if (signed.directory.revision === state.revision && state.signed &&
            JSON.stringify(state.signed) === JSON.stringify(signed)) {
          return { result: structuredClone(state.signed), changed: false }
        }
        state.gateways = merged
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
    return result ?? this.signCurrent()
  }

  async load(): Promise<SignedWorkspaceGatewayDirectory | undefined> {
    return this.file.transaction(
      () => initialState(this.identity.workspaceId),
      state => {
        validateState(state, this.identity.workspaceId)
        return { result: state.signed ? structuredClone(state.signed) : undefined, changed: false }
      },
    )
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
              gateways: Object.values(state.gateways).sort((a, b) =>
                a.gatewayNodeId.localeCompare(b.gatewayNodeId)),
              existing: state.signed ? structuredClone(state.signed) : undefined,
            },
            changed: false,
          }
        },
      )
      if (draft.existing?.directory.revision === draft.revision) return draft.existing
      const signed = await signWorkspaceGatewayDirectory({
        kind: 'malink.workspace.gateway-directory',
        version: 1,
        directoryId: randomUUID(),
        workspaceId: this.identity.workspaceId,
        revision: draft.revision,
        gateways: draft.gateways,
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
}

function initialState(workspaceId: string): WorkspaceDirectoryState {
  return { version: 1, workspaceId, revision: 0, gateways: {} }
}

function validateState(state: WorkspaceDirectoryState, workspaceId: string): void {
  if (
    state.version !== 1 || state.workspaceId !== workspaceId ||
    !Number.isSafeInteger(state.revision) || state.revision < 0 ||
    !state.gateways || typeof state.gateways !== 'object'
  ) throw new TypeError('Workspace Gateway directory state is invalid')
}
