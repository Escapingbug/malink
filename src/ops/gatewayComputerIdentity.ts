import { randomUUID } from 'node:crypto'
import { AtomicJsonFile } from '@malink/security/node'

interface GatewayComputerIdentityState {
  version: 1
  computerId: string
  createdAt: number
}

/** Stable host identity shared by successive active/candidate deployments. */
export class FileGatewayComputerIdentityStore {
  private readonly file: AtomicJsonFile<GatewayComputerIdentityState>

  constructor(path: string) {
    this.file = new AtomicJsonFile(path)
  }

  loadOrCreate(now = Date.now()): Promise<GatewayComputerIdentityState> {
    const candidate: GatewayComputerIdentityState = {
      version: 1,
      computerId: randomUUID(),
      createdAt: now,
    }
    return this.file.transaction(() => candidate, state => {
      validateState(state)
      return {
        result: structuredClone(state),
        changed: state === candidate,
      }
    })
  }
}

function validateState(state: GatewayComputerIdentityState): void {
  if (
    state.version !== 1
    || typeof state.computerId !== 'string'
    || !state.computerId
    || state.computerId.length > 256
    || !Number.isSafeInteger(state.createdAt)
    || state.createdAt < 0
  ) throw new Error('Gateway computer identity is invalid')
}
