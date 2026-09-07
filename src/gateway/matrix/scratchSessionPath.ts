import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'

/**
 * Scratch session paths are derived from the data-store location and session
 * identity. They must be recalculated whenever state moves to another data
 * root instead of being treated as portable persisted identity.
 */
export function scratchSessionDirectory(anchorPath: string, sessionId: string): string {
  const component = createHash('sha256')
    .update(`malink-scratch-session\0${sessionId}`)
    .digest('hex')
  return join(resolve(dirname(anchorPath), 'scratch-sessions'), component)
}
