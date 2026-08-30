import { lstat } from 'node:fs/promises'
import { GatewayAdminClient } from './client.js'
import type { GatewayAdminStatus } from './types.js'

export interface GatewayAdminSocketGuardDependencies {
  inspect?: () => Promise<'missing' | 'socket' | 'other'>
  status?: () => Promise<GatewayAdminStatus>
}

export async function assertGatewayAdminSocketUnclaimed(
  socketPath: string,
  dependencies: GatewayAdminSocketGuardDependencies = {},
): Promise<void> {
  const kind = dependencies.inspect
    ? await dependencies.inspect()
    : await inspectSocketPath(socketPath)
  if (kind === 'missing') return
  if (kind !== 'socket') {
    throw new Error(
      `The Malink Gateway admin path exists but is not a Unix socket: ${socketPath}`,
    )
  }
  let status: GatewayAdminStatus
  try {
    status = await (dependencies.status
      ? dependencies.status()
      : new GatewayAdminClient({ socketPath, timeoutMs: 1_500 }).status())
  } catch (error) {
    if (socketIsStale(error)) return
    throw new Error(
      `The existing Malink Gateway admin socket at ${socketPath} could not be verified. `
      + 'Refusing to start another process against the same production state.',
      { cause: error },
    )
  }
  throw new Error(
    `Another Malink Gateway process (${status.pid}) is already running as ${status.gatewayName}. `
    + 'Candidate validation must use the supervisor finish command instead of starting '
    + 'ops/matrix-local-gateway.js.',
  )
}

async function inspectSocketPath(path: string): Promise<'missing' | 'socket' | 'other'> {
  try {
    return (await lstat(path)).isSocket() ? 'socket' : 'other'
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'
    throw error
  }
}

function socketIsStale(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code
    ?? ((error as Error & { cause?: NodeJS.ErrnoException }).cause?.code)
  return code === 'ENOENT' || code === 'ECONNREFUSED'
}
