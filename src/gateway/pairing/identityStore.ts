import { chmod } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import {
  exportDeviceKeyPair,
  generateDeviceKeyPair,
  importDeviceKeyPair,
  type DeviceKeyPair,
  type SerializedDeviceKeyPair,
} from '@malink/security'
import { AtomicJsonFile, type FileStoreOptions } from '@malink/security/node'

export interface GatewayIdentityState {
  version: 1 | 2
  gatewayId: string
  workspaceId?: string
  gatewayNodeId?: string
  createdAt: number
  keyPair: SerializedDeviceKeyPair
}

export interface GatewayPairingIdentity {
  /** Compatibility alias: MLP/3 currently names the Workspace trust domain gatewayId. */
  gatewayId: string
  workspaceId: string
  gatewayNodeId: string
  createdAt: number
  keys: DeviceKeyPair
  serialized: SerializedDeviceKeyPair
}

export class FileGatewayIdentityStore {
  private readonly file: AtomicJsonFile<GatewayIdentityState>

  constructor(
    private readonly path: string,
    options: FileStoreOptions = {},
  ) {
    this.file = new AtomicJsonFile(path, options)
  }

  async loadOrCreate(
    gatewayId: string = randomUUID(),
    now = Date.now(),
  ): Promise<GatewayPairingIdentity> {
    const generated = await generateDeviceKeyPair()
    const candidate: GatewayIdentityState = {
      version: 1,
      gatewayId,
      createdAt: now,
      keyPair: await exportDeviceKeyPair(generated),
    }
    const stored = await this.file.transaction(
      () => candidate,
      (state) => {
        validateIdentityState(state)
        return { result: structuredClone(state), changed: state === candidate }
      },
    )
    if (process.platform !== 'win32') await chmod(this.path, 0o600)
    return {
      gatewayId: stored.gatewayId,
      workspaceId: stored.workspaceId ?? stored.gatewayId,
      gatewayNodeId: stored.gatewayNodeId ?? stored.gatewayId,
      createdAt: stored.createdAt,
      keys: await importDeviceKeyPair(stored.keyPair),
      serialized: stored.keyPair,
    }
  }

  async loadExisting(): Promise<GatewayPairingIdentity> {
    const stored = await this.file.transaction(
      () => { throw new Error('Gateway identity does not exist') },
      state => {
        validateIdentityState(state)
        return { result: structuredClone(state), changed: false }
      },
    )
    return {
      gatewayId: stored.gatewayId,
      workspaceId: stored.workspaceId ?? stored.gatewayId,
      gatewayNodeId: stored.gatewayNodeId ?? stored.gatewayId,
      createdAt: stored.createdAt,
      keys: await importDeviceKeyPair(stored.keyPair),
      serialized: stored.keyPair,
    }
  }

  async joinWorkspace(
    workspaceId: string,
    workspaceKeyPair: SerializedDeviceKeyPair,
    gatewayNodeId: string = randomUUID(),
    now = Date.now(),
  ): Promise<GatewayPairingIdentity> {
    const candidate: GatewayIdentityState = {
      version: 2,
      gatewayId: workspaceId,
      workspaceId,
      gatewayNodeId,
      createdAt: now,
      keyPair: workspaceKeyPair,
    }
    const stored = await this.file.transaction(
      () => candidate,
      state => {
        validateIdentityState(state)
        const storedWorkspaceId = state.workspaceId ?? state.gatewayId
        if (state !== candidate && storedWorkspaceId !== workspaceId) {
          throw new Error('Gateway is already joined to another Malink Workspace')
        }
        return { result: structuredClone(state), changed: state === candidate }
      },
    )
    if (process.platform !== 'win32') await chmod(this.path, 0o600)
    return {
      gatewayId: stored.gatewayId,
      workspaceId: stored.workspaceId ?? stored.gatewayId,
      gatewayNodeId: stored.gatewayNodeId ?? stored.gatewayId,
      createdAt: stored.createdAt,
      keys: await importDeviceKeyPair(stored.keyPair),
      serialized: stored.keyPair,
    }
  }
}

function validateIdentityState(value: GatewayIdentityState): void {
  if (
    (value.version !== 1 && value.version !== 2) ||
    typeof value.gatewayId !== 'string' ||
    !value.gatewayId ||
    !Number.isSafeInteger(value.createdAt) ||
    value.createdAt < 0
  ) {
    throw new TypeError('Gateway identity state is invalid')
  }
  if (
    value.version === 2 &&
    (typeof value.workspaceId !== 'string' || !value.workspaceId ||
      typeof value.gatewayNodeId !== 'string' || !value.gatewayNodeId)
  ) throw new TypeError('Gateway Workspace identity state is invalid')
}
