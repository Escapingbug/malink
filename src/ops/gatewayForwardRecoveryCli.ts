import { readFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { gatewayExecutionTracksStateSchema } from './gatewayExecutionTracks'
import { GatewayUpdateSupervisorClient } from './gatewayUpdateSupervisorServer'
import { bootstrapGatewayForwardUpgrade } from './bootstrapGatewayForwardUpgrade'

/** Owner-local recovery; does not require Matrix, a browser or a running Agent.
 * No command restores data or starts a historical reader implicitly. */
export async function recoverGatewayForwardUpgrade(installRoot: string, action: 'status' | 'resume') {
  const root = resolve(installRoot)
  const state = gatewayExecutionTracksStateSchema.parse(JSON.parse(await readFile(join(root, 'execution-tracks.json'), 'utf8')))
  if (action === 'status') return state
  if (!state.forwardOnly || !state.targetRelease || state.phase === 'steady') {
    throw new Error('There is no interrupted incompatible upgrade to resume')
  }
  const client = new GatewayUpdateSupervisorClient(join(root, 'update-supervisor.sock'), 30_000)
  return client.scheduleApply(state.targetRelease, true, state.generation)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [action, installRoot, releaseId, confirmation] = process.argv.slice(2)
  if (action === 'bootstrap' && installRoot?.startsWith('/') && releaseId) {
    await bootstrapGatewayForwardUpgrade(installRoot, releaseId, confirmation === '--allow-forward-only')
  } else {
    if ((action !== 'status' && action !== 'resume') || !installRoot?.startsWith('/')) {
      throw new Error('Usage: gatewayForwardRecoveryCli.js <status|resume> <absolute-install-root>; or bootstrap <absolute-install-root> <sealed-release-id> --allow-forward-only')
    }
    process.stdout.write(`${JSON.stringify(await recoverGatewayForwardUpgrade(installRoot, action), null, 2)}\n`)
  }
}
