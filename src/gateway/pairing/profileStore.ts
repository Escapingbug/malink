import { AtomicJsonFile, type FileStoreOptions } from '@malink/security/node'

export interface GatewayNodeProfile {
  version: 1
  gatewayNodeId: string
  gatewayName: string
  computerName: string
  createdAt: number
  updatedAt: number
}

type StoredGatewayNodeProfile = Omit<GatewayNodeProfile, 'computerName'> & {
  /** Added after the initial profile format; absent records are upgraded in place. */
  computerName?: string
}

/** Durable, user-facing identity for one Gateway execution node. */
export class FileGatewayNodeProfileStore {
  private readonly file: AtomicJsonFile<StoredGatewayNodeProfile>

  constructor(
    path: string,
    private readonly gatewayNodeId: string,
    options: FileStoreOptions = {},
  ) {
    requireGatewayNodeId(gatewayNodeId)
    this.file = new AtomicJsonFile(path, options)
  }

  loadOrCreate(gatewayNameInput: string, now = Date.now()): Promise<GatewayNodeProfile> {
    requireTimestamp(now)
    const gatewayName = normalizeGatewayName(gatewayNameInput)
    const candidate: GatewayNodeProfile = {
      version: 1,
      gatewayNodeId: this.gatewayNodeId,
      gatewayName,
      computerName: gatewayName,
      createdAt: now,
      updatedAt: now,
    }
    return this.file.transaction(
      () => candidate,
      state => {
        validateGatewayNodeProfile(state, this.gatewayNodeId)
        const changed = state.computerName === undefined
        state.computerName ??= state.gatewayName
        return {
          result: gatewayNodeProfile(state),
          changed: state === candidate || changed,
        }
      },
    )
  }

  rename(gatewayNameInput: string, now = Date.now()): Promise<GatewayNodeProfile> {
    requireTimestamp(now)
    const gatewayName = normalizeGatewayName(gatewayNameInput)
    const candidate: GatewayNodeProfile = {
      version: 1,
      gatewayNodeId: this.gatewayNodeId,
      gatewayName,
      computerName: gatewayName,
      createdAt: now,
      updatedAt: now,
    }
    return this.file.transaction(
      () => candidate,
      state => {
        validateGatewayNodeProfile(state, this.gatewayNodeId)
        if (now < state.createdAt) {
          throw new RangeError('Gateway profile update time cannot precede its creation')
        }
        const created = state === candidate
        let changed = created || state.computerName === undefined
        state.computerName ??= state.gatewayName
        if (!created && state.gatewayName !== gatewayName) {
          state.gatewayName = gatewayName
          state.updatedAt = now
          changed = true
        }
        return {
          result: gatewayNodeProfile(state),
          changed,
        }
      },
    )
  }

  updateComputerName(computerNameInput: string, now = Date.now()): Promise<GatewayNodeProfile> {
    requireTimestamp(now)
    const computerName = normalizeComputerName(computerNameInput)
    const candidate: GatewayNodeProfile = {
      version: 1,
      gatewayNodeId: this.gatewayNodeId,
      gatewayName: computerName,
      computerName,
      createdAt: now,
      updatedAt: now,
    }
    return this.file.transaction(
      () => candidate,
      state => {
        validateGatewayNodeProfile(state, this.gatewayNodeId)
        if (now < state.createdAt) {
          throw new RangeError('Gateway profile update time cannot precede its creation')
        }
        const changed = state === candidate || state.computerName !== computerName
        state.computerName = computerName
        if (changed && state !== candidate) state.updatedAt = now
        return { result: gatewayNodeProfile(state), changed }
      },
    )
  }
}

export function gatewayNodeShortId(gatewayNodeId: string): string {
  requireGatewayNodeId(gatewayNodeId)
  const compact = gatewayNodeId.replace(/[^A-Za-z0-9]/gu, '')
  return (compact || gatewayNodeId).slice(-8).toUpperCase()
}

function validateGatewayNodeProfile(
  value: StoredGatewayNodeProfile,
  gatewayNodeId: string,
): void {
  if (
    value.version !== 1
    || value.gatewayNodeId !== gatewayNodeId
    || normalizeGatewayName(value.gatewayName) !== value.gatewayName
    || (value.computerName !== undefined
      && normalizeComputerName(value.computerName) !== value.computerName)
    || !Number.isSafeInteger(value.createdAt)
    || value.createdAt < 0
    || !Number.isSafeInteger(value.updatedAt)
    || value.updatedAt < value.createdAt
  ) throw new TypeError('Gateway node profile is invalid')
}

function gatewayNodeProfile(value: StoredGatewayNodeProfile): GatewayNodeProfile {
  return structuredClone({
    ...value,
    computerName: value.computerName ?? value.gatewayName,
  })
}

function normalizeGatewayName(value: string): string {
  if (typeof value !== 'string') throw new TypeError('Gateway name is required')
  const normalized = value.trim()
  if (!normalized || normalized.length > 128) {
    throw new TypeError('Gateway name must contain between 1 and 128 characters')
  }
  return normalized
}

function normalizeComputerName(value: string): string {
  if (typeof value !== 'string') throw new TypeError('Computer name is required')
  const normalized = value.trim()
  if (!normalized || normalized.length > 128) {
    throw new TypeError('Computer name must contain between 1 and 128 characters')
  }
  return normalized
}

function requireGatewayNodeId(value: string): void {
  if (typeof value !== 'string' || !value || value.length > 512) {
    throw new TypeError('Gateway node ID is invalid')
  }
}

function requireTimestamp(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError('Gateway profile timestamp is invalid')
  }
}
