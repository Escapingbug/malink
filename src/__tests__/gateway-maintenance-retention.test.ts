import { describe, expect, it } from 'vitest'
import { MatrixMlp3GatewayRunner } from '@/gateway/matrix/mlp3Gateway'

function archiveGuard(phase: string, failStatus = false) {
  const runner = Object.assign(Object.create(MatrixMlp3GatewayRunner.prototype), {
    config: { gatewayNodeId: 'old' },
    dependencies: { gatewayUpdateSupervisor: {
      deploymentStatus: async () => {
        if (failStatus) throw new Error('supervisor unavailable')
        return { phase, active: { gatewayNodeId: 'old' } }
      },
      status: async () => ({ phase: 'committed', maintenanceSessionId: 'gateway-update-test' }),
    } },
  }) as MatrixMlp3GatewayRunner
  return (id: string, title?: string) => runner['assertMaintenanceSessionCanBeArchived'](id, title)
}

describe('old Gateway repair session retention', () => {
  it.each(['preparing', 'trial', 'draining', 'transferring', 'committing', 'discarding', 'repair_required'])(
    'rejects legacy auto-archive during %s despite a committed installer', async phase => {
      await expect(archiveGuard(phase)('gateway-update-test')).rejects.toThrow('retained')
    },
  )
  it('also protects a replacement repair session', async () => {
    await expect(archiveGuard('trial')('new-session', 'Gateway update repair · update-1'))
      .rejects.toThrow('retained')
  })
  it('does not block unrelated user sessions', async () => {
    await expect(archiveGuard('trial')('ordinary-session', 'User work')).resolves.toBeUndefined()
  })
  it('fails closed if supervisor state cannot be read', async () => {
    await expect(archiveGuard('trial', true)('gateway-update-test')).rejects.toThrow('unavailable')
  })
  it('allows cleanup after the deployment recovery window closes', async () => {
    await expect(archiveGuard('steady')('gateway-update-test')).resolves.toBeUndefined()
  })
})
