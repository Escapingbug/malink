import { createProviderInstance, getProvider } from '@/providers/registry'

/** Catalogs need not have an ACP connection. Probe with an independent instance. */
export async function probeProviderForkCapability(id: string, cwd: string, log: (message: string) => void): Promise<boolean> {
  const catalog = getProvider(id)
  if (!catalog?.supportsSessionFork) return false
  if (catalog.isReady()) return catalog.supportsSessionFork()
  const probe = createProviderInstance(id)
  if (!probe) return false
  try {
    probe.prepareWorkingDirectory?.(cwd)
    return probe.probeSessionFork ? await probe.probeSessionFork() : probe.supportsSessionFork?.() === true
  } catch (error) {
    log(`Native fork capability probe failed for ${id}: ${error instanceof Error ? error.message : String(error)}`)
    return false
  } finally {
    if (probe !== catalog) await probe.destroy?.().catch(error => {
      log(`Native fork probe cleanup failed for ${id}: ${error instanceof Error ? error.message : String(error)}`)
    })
  }
}
