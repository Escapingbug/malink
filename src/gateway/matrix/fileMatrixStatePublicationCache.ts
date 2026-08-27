import { createHash } from 'node:crypto'
import { canonicalJson, type JsonValue } from '@malink/protocol'
import { AtomicJsonFile } from '@malink/security/node'

interface MatrixStatePublicationCacheState {
  version: 1
  entries: Record<string, string>
}

/**
 * Durable acknowledgement cache for root-signed Workspace Room State.
 *
 * The signed directory and authorization stores remain authoritative. This
 * cache only remembers that an exact semantic document was accepted by Matrix
 * so a Gateway restart does not rewrite it again.
 */
export class FileMatrixStatePublicationCache {
  private readonly file: AtomicJsonFile<MatrixStatePublicationCacheState>

  constructor(path: string) {
    this.file = new AtomicJsonFile(path)
  }

  async isPublished(
    roomId: string,
    eventType: string,
    stateKey: string,
    content: Record<string, unknown>,
  ): Promise<boolean> {
    const key = publicationKey(roomId, eventType, stateKey)
    const digest = contentDigest(content)
    return this.file.transaction(
      initialState,
      state => {
        validateState(state)
        return { result: state.entries[key] === digest, changed: false }
      },
    )
  }

  async markPublished(
    roomId: string,
    eventType: string,
    stateKey: string,
    content: Record<string, unknown>,
  ): Promise<void> {
    const key = publicationKey(roomId, eventType, stateKey)
    const digest = contentDigest(content)
    await this.file.transaction(
      initialState,
      state => {
        validateState(state)
        if (state.entries[key] === digest) {
          return { result: undefined, changed: false }
        }
        state.entries[key] = digest
        return { result: undefined, changed: true }
      },
    )
  }
}

function initialState(): MatrixStatePublicationCacheState {
  return { version: 1, entries: {} }
}

function publicationKey(roomId: string, eventType: string, stateKey: string): string {
  return createHash('sha256')
    .update(canonicalJson([roomId, eventType, stateKey]))
    .digest('base64url')
}

function contentDigest(content: Record<string, unknown>): string {
  return createHash('sha256')
    .update(canonicalJson(content as JsonValue))
    .digest('base64url')
}

function validateState(state: MatrixStatePublicationCacheState): void {
  if (
    state.version !== 1
    || !state.entries
    || typeof state.entries !== 'object'
    || Array.isArray(state.entries)
    || Object.keys(state.entries).length > 100_000
    || Object.entries(state.entries).some(([key, value]) =>
      !/^[A-Za-z0-9_-]{43}$/u.test(key) || !/^[A-Za-z0-9_-]{43}$/u.test(value))
  ) throw new Error('Invalid Matrix state publication cache')
}
