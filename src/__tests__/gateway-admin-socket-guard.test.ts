import { describe, expect, it } from 'vitest'
import type { GatewayAdminStatus } from '@/gateway/admin'
import { assertGatewayAdminSocketUnclaimed } from '@/gateway/admin/gatewayAdminSocketGuard'

describe('Gateway admin socket startup guard', () => {
  it('rejects a candidate while an older Gateway owns the admin socket', async () => {
    await expect(assertGatewayAdminSocketUnclaimed('/gateway/admin.sock', {
      inspect: async () => 'socket',
      status: async () => status(),
    })).rejects.toThrow(/Another Malink Gateway process \(321\).*supervisor finish command/su)
  })

  it('allows a stale refused socket to proceed to the data-directory lock', async () => {
    const refused = Object.assign(new Error('connect refused'), { code: 'ECONNREFUSED' })
    await expect(assertGatewayAdminSocketUnclaimed('/gateway/admin.sock', {
      inspect: async () => 'socket',
      status: async () => Promise.reject(refused),
    })).resolves.toBeUndefined()
  })

  it('fails closed when an existing socket cannot be identified', async () => {
    await expect(assertGatewayAdminSocketUnclaimed('/gateway/admin.sock', {
      inspect: async () => 'socket',
      status: async () => Promise.reject(new Error('timed out')),
    })).rejects.toThrow(/Refusing to start another process/u)
  })
})

function status(): GatewayAdminStatus {
  return {
    version: 1,
    gatewayId: 'workspace-1',
    workspaceId: 'workspace-1',
    gatewayNodeId: 'node-1',
    gatewayShortId: 'NODE1',
    gatewayName: 'Existing Gateway',
    state: 'running',
    pid: 321,
    startedAt: 1,
    activeDeviceCount: 1,
    openInvitationCount: 0,
    matrixReady: true,
    lastMatrixSyncAt: 1,
  }
}
