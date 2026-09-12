import { afterEach, expect, it, vi } from 'vitest'
import { clearProviderRegistryForTesting, registerProvider } from '@/providers/registry'
import { probeProviderForkCapability } from '@/gateway/matrix/providerForkCapability'
import type { AgentProvider } from '@/providers/provider'
afterEach(clearProviderRegistryForTesting)
it('discovers native forks even when the catalog instance was never connected', async () => {
  const catalog: AgentProvider = { name: 'probe', isReady: () => false, supportsSessionFork: () => false,
    getInitError: () => null, getAvailableModels: () => [], getAvailablePermissionModes: () => [],
    startQuery: vi.fn(() => { throw new Error('No query should run') }) }
  const probe = { ...catalog, probeSessionFork: vi.fn(async () => true), destroy: vi.fn(async () => undefined), prepareWorkingDirectory: vi.fn() }
  registerProvider(catalog, () => probe)
  await expect(probeProviderForkCapability('probe', '/repo', vi.fn())).resolves.toBe(true)
  expect(probe.probeSessionFork).toHaveBeenCalledOnce()
  expect(probe.prepareWorkingDirectory).toHaveBeenCalledWith('/repo')
  expect(probe.destroy).toHaveBeenCalledOnce()
  expect(catalog.startQuery).not.toHaveBeenCalled()
  probe.probeSessionFork.mockRejectedValue(new Error('Handshake unavailable'))
  const log = vi.fn()
  await expect(probeProviderForkCapability('probe', '/repo', log)).resolves.toBe(false)
  expect(log).toHaveBeenCalledWith(expect.stringContaining('Handshake unavailable'))
})
