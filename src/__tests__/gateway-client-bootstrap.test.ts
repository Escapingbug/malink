import { describe, expect, it } from 'vitest'
import { resolveGatewayClientBootstrap } from '@/gateway/pairing'

describe('Gateway client bootstrap', () => {
  it('starts an enrolled Gateway from its signed client identity without a local credential', () => {
    expect(resolveGatewayClientBootstrap({
      directoryClientMatrixUserId: '@workspace-client:example.org',
      localActiveDeviceCount: 0,
      workspaceAuthorizedDeviceCount: 2,
    })).toEqual({
      clientMatrixUserId: '@workspace-client:example.org',
      clientMatrixLoginStatus: 'unavailable',
      requiresStartupPairing: false,
    })
  })

  it('ignores a stale credential instead of changing the signed Workspace identity', () => {
    expect(resolveGatewayClientBootstrap({
      directoryClientMatrixUserId: '@workspace-client:example.org',
      credentialClientMatrixUserId: '@legacy-client:example.org',
      localActiveDeviceCount: 0,
      workspaceAuthorizedDeviceCount: 1,
    })).toEqual({
      clientMatrixUserId: '@workspace-client:example.org',
      clientMatrixLoginStatus: 'identity-mismatch',
      requiresStartupPairing: false,
    })
  })

  it('uses a matching credential for new-client invitations', () => {
    expect(resolveGatewayClientBootstrap({
      directoryClientMatrixUserId: '@workspace-client:example.org',
      credentialClientMatrixUserId: '@workspace-client:example.org',
      localActiveDeviceCount: 1,
      workspaceAuthorizedDeviceCount: 0,
    })).toEqual({
      clientMatrixUserId: '@workspace-client:example.org',
      clientMatrixLoginStatus: 'ready',
      requiresStartupPairing: false,
    })
  })

  it('preserves credential bootstrap for a brand-new Workspace', () => {
    expect(resolveGatewayClientBootstrap({
      credentialClientMatrixUserId: '@workspace-client:example.org',
      localActiveDeviceCount: 0,
      workspaceAuthorizedDeviceCount: 0,
    })).toEqual({
      clientMatrixUserId: '@workspace-client:example.org',
      clientMatrixLoginStatus: 'ready',
      requiresStartupPairing: true,
    })
  })

  it('rejects a brand-new Workspace with no fixed client identity', () => {
    expect(() => resolveGatewayClientBootstrap({
      localActiveDeviceCount: 0,
      workspaceAuthorizedDeviceCount: 0,
    })).toThrow(/client Matrix identity is unavailable/u)
  })
})
