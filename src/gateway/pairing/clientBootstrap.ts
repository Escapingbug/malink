export type ClientMatrixLoginStatus =
  | 'ready'
  | 'unavailable'
  | 'identity-mismatch'

export interface GatewayClientBootstrapResolution {
  clientMatrixUserId: string
  clientMatrixLoginStatus: ClientMatrixLoginStatus
  requiresStartupPairing: boolean
}

/**
 * Resolves the fixed Workspace client identity independently from the
 * credential that can mint one-time Matrix logins. An enrolled Gateway has an
 * authenticated directory already, so a missing or stale local credential
 * must disable new client invitations rather than prevent the Gateway from
 * serving devices that the Workspace has already authorized.
 */
export function resolveGatewayClientBootstrap(input: {
  directoryClientMatrixUserId?: string
  credentialClientMatrixUserId?: string
  localActiveDeviceCount: number
  workspaceAuthorizedDeviceCount: number
}): GatewayClientBootstrapResolution {
  const directoryClientMatrixUserId = normalizeOptionalUserId(
    input.directoryClientMatrixUserId,
  )
  const credentialClientMatrixUserId = normalizeOptionalUserId(
    input.credentialClientMatrixUserId,
  )
  const clientMatrixUserId =
    directoryClientMatrixUserId ?? credentialClientMatrixUserId
  if (!clientMatrixUserId) {
    throw new Error(
      'The Workspace client Matrix identity is unavailable from both the '
      + 'signed Gateway directory and the local client credential',
    )
  }
  const clientMatrixLoginStatus = !credentialClientMatrixUserId
    ? 'unavailable' as const
    : credentialClientMatrixUserId === clientMatrixUserId
      ? 'ready' as const
      : 'identity-mismatch' as const
  const localActiveDeviceCount = requireCount(
    input.localActiveDeviceCount,
    'localActiveDeviceCount',
  )
  const workspaceAuthorizedDeviceCount = requireCount(
    input.workspaceAuthorizedDeviceCount,
    'workspaceAuthorizedDeviceCount',
  )
  return {
    clientMatrixUserId,
    clientMatrixLoginStatus,
    requiresStartupPairing:
      localActiveDeviceCount + workspaceAuthorizedDeviceCount === 0,
  }
}

function normalizeOptionalUserId(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const normalized = value.trim()
  if (
    normalized !== value
    || normalized.length > 512
    || !/^@[^:\s]+:[^\s]+$/u.test(normalized)
  ) {
    throw new TypeError('Workspace client Matrix user ID is invalid')
  }
  return normalized
}

function requireCount(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative integer`)
  }
  return value
}
