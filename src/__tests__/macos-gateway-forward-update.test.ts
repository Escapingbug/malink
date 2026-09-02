import { describe, expect, it } from 'vitest'
import type { GatewayAdminStatus } from '../gateway/admin/types.js'
import { waitForGatewayForwardUpdateIdle } from '../../scripts/macos-gateway-forward-update.js'

describe('macOS Gateway forward-only idle gate', () => {
  it('waits for active work and then requires consecutive stable idle samples', async () => {
    let now = 10_000
    const statuses = [
      gatewayStatus({ activeTurns: 1, lastMatrixSyncAt: now }),
      gatewayStatus({ lastMatrixSyncAt: now }),
      gatewayStatus({ lastMatrixSyncAt: now }),
      gatewayStatus({ lastMatrixSyncAt: now }),
    ]
    let calls = 0

    const result = await waitForGatewayForwardUpdateIdle({
      adminSocketPath: '/tmp/gateway.sock',
      expectedBuildId: 'gateway-current',
      timeoutMs: 10_000,
      stableSamples: 3,
      sampleIntervalMs: 100,
    }, {
      now: () => now,
      sleep: async milliseconds => { now += milliseconds },
      status: async () => statuses[Math.min(calls++, statuses.length - 1)]!,
    })

    expect(result.buildId).toBe('gateway-current')
    expect(calls).toBe(4)
  })

  it('restarts the stable sample count when the Gateway runtime changes', async () => {
    let now = 20_000
    const statuses = [
      gatewayStatus({ runtimeEpoch: 'epoch-a', pid: 10, lastMatrixSyncAt: now }),
      gatewayStatus({ runtimeEpoch: 'epoch-b', pid: 11, lastMatrixSyncAt: now }),
      gatewayStatus({ runtimeEpoch: 'epoch-b', pid: 11, lastMatrixSyncAt: now }),
    ]
    let calls = 0

    await waitForGatewayForwardUpdateIdle({
      adminSocketPath: '/tmp/gateway.sock',
      timeoutMs: 10_000,
      stableSamples: 2,
      sampleIntervalMs: 100,
    }, {
      now: () => now,
      sleep: async milliseconds => { now += milliseconds },
      status: async () => statuses[Math.min(calls++, statuses.length - 1)]!,
    })

    expect(calls).toBe(3)
  })

  it('fails before activation when durable work never drains', async () => {
    let now = 30_000

    await expect(waitForGatewayForwardUpdateIdle({
      adminSocketPath: '/tmp/gateway.sock',
      timeoutMs: 200,
      stableSamples: 2,
      sampleIntervalMs: 100,
    }, {
      now: () => now,
      sleep: async milliseconds => { now += milliseconds },
      status: async () => gatewayStatus({
        unfinishedCommands: 1,
        lastMatrixSyncAt: now,
      }),
    })).rejects.toThrow('unfinished journal commands: 1')
  })

  it('stops immediately if another release changed the active build', async () => {
    await expect(waitForGatewayForwardUpdateIdle({
      adminSocketPath: '/tmp/gateway.sock',
      expectedBuildId: 'gateway-current',
      timeoutMs: 10_000,
    }, {
      status: async () => gatewayStatus({ buildId: 'gateway-other' }),
    })).rejects.toThrow('Gateway build changed to gateway-other')
  })
})

function gatewayStatus(
  overrides: Partial<GatewayAdminStatus> = {},
): GatewayAdminStatus {
  return {
    version: 1,
    gatewayId: 'workspace-1',
    workspaceId: 'workspace-1',
    gatewayNodeId: 'node-1',
    gatewayShortId: 'short-1',
    gatewayName: 'Gateway',
    state: 'running',
    pid: 10,
    startedAt: 1,
    activeDeviceCount: 1,
    openInvitationCount: 0,
    buildId: 'gateway-current',
    runtimeEpoch: 'epoch-a',
    activeTurns: 0,
    activeCommands: 0,
    unfinishedCommands: 0,
    pendingOutboxDeliveries: 0,
    pendingInboxEvents: 0,
    matrixReady: true,
    lastMatrixSyncAt: 10_000,
    ...overrides,
  }
}
