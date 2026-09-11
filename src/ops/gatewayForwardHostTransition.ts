import { copyFile, mkdir, open, readlink, realpath, rename, symlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { AtomicJsonFile } from '@malink/security/node'
import { acquireGatewayDataDirectoryLock } from '@/gateway/matrix/gatewayDataDirectoryLock'
import { createGatewayForwardOnlyBackup } from './gatewayForwardOnlyBackup'
import type { GatewayExecutionTracksState } from './gatewayExecutionTracks'

/** Only invoked after every known business writer has stopped. */
export async function backupExecutionTrackState(installRoot: string, state: GatewayExecutionTracksState,
  targetBuildId: string): Promise<string> {
  if (!state.targetRelease || !state.forwardOnly) throw new Error('Confirmed incompatible upgrade intent is required')
  const lock = await acquireGatewayDataDirectoryLock(state.dataDirectory)
  try {
    const backup = await createGatewayForwardOnlyBackup({ dataDirectory: state.dataDirectory, installRoot,
      releaseId: state.targetRelease, targetBuildId, previousTarget: `releases/${state.activeRelease}`, createdAt: Date.now() })
    for (const name of ['execution-tracks.json', 'execution-tracks-config.json']) {
      await copyFile(join(installRoot, name), join(backup, name))
      const handle = await open(join(backup, name), 'r')
      try { await handle.sync() } finally { await handle.close() }
    }
    const recovery = new AtomicJsonFile<Record<string, unknown>>(join(backup, 'execution-recovery.json'))
    await recovery.transaction(() => ({}), value => {
      Object.assign(value, { version: 1, gatewayNodeId: state.gatewayNodeId, dataDirectory: state.dataDirectory,
        sourceRelease: state.activeRelease, targetRelease: state.targetRelease, generation: state.generation,
        instruction: 'Stop the Host before any local restore. Never run the previous release on current upgraded data. Restore the verified backup into a separate directory for inspection; preserve current data before replacing anything.' })
      return { changed: true, result: undefined }
    })
    return backup
  } finally { await lock.release() }
}

/** Pins the next launchd supervisor without starting any business executable.
 * The durable tracks intent survives the old supervisor process exiting. */
export async function pinForwardGatewayHost(input: {
  installRoot: string; targetRelease: string; targetDirectory: string;
  runningHostEntrypoint: string; requestReload(): void;
}): Promise<boolean> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(input.targetRelease)
    || resolve(input.targetDirectory) !== resolve(input.installRoot, 'releases', input.targetRelease)) {
    throw new Error('Forward Host target must be an admitted installed release')
  }
  const targetEntrypoint = await realpath(join(input.targetDirectory, 'ops/gatewayUpdateSupervisorMain.js'))
  if (input.runningHostEntrypoint === targetEntrypoint) return true
  const configuration = new AtomicJsonFile<Record<string, unknown>>(join(input.installRoot, 'execution-tracks-config.json'))
  await configuration.transaction(() => { throw new Error('Execution tracks configuration is missing') }, value => {
    value.defaultRelease = input.targetRelease
    delete value.previousRelease
    return { changed: true, result: undefined }
  })
  await mkdir(input.installRoot, { recursive: true })
  const current = join(input.installRoot, 'current')
  // Require the existing layout to be a symlink, not an unrelated directory.
  await readlink(current)
  const temporary = join(input.installRoot, `.forward-current-${randomUUID()}`)
  await symlink(`releases/${input.targetRelease}`, temporary)
  await rename(temporary, current)
  const directory = await open(input.installRoot, 'r')
  try { await directory.sync() } finally { await directory.close() }
  input.requestReload()
  return false
}
