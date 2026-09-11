import { execFile } from 'node:child_process'
import { readFile, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { z } from 'zod'
import { GatewayExecutionTracks } from './gatewayExecutionTracks'
import { GatewayExecutionWorkerHost } from './gatewayExecutionWorkerHost'
import type { GatewayUpdateSupervisor } from './gatewayUpdateSupervisor'
import { acquireGatewayDataDirectoryLock } from '@/gateway/matrix/gatewayDataDirectoryLock'
import { inspectGatewayDeploymentSlot } from './macosGatewayBlueGreenHost'
import type { GatewayDeploymentStatus } from '@malink/protocol'
import { backupExecutionTrackState, pinForwardGatewayHost } from './gatewayForwardHostTransition'
import { verifyGatewayForwardOnlyBackup } from './gatewayForwardOnlyBackup'

const execute = promisify(execFile)
const configuration = z.object({
  version: z.literal(1), gatewayNodeId: z.string().min(1),
  defaultRelease: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
  previousRelease: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/).optional(),
  controlProjectId: z.string().min(1),
  computerId: z.string().min(1),
  controlGatewayNodeId: z.string().min(1),
  controlReleaseId: z.string().min(1),
  controlBuildId: z.string().min(1),
}).strict()

export async function initializeGatewayExecutionTracks(input: {
  installRoot: string; dataDirectory: string; adminSocket: string;
  launchAgentPath: string; serviceLabel: string; supervisor: GatewayUpdateSupervisor;
  requestSupervisorReload?: () => void;
  log(message: string): void;
}): Promise<{ tracks: GatewayExecutionTracks; workers: GatewayExecutionWorkerHost; controlProjectId: string;
  deploymentStatus(): Promise<GatewayDeploymentStatus> } | undefined> {
  let raw: string
  try { raw = await readFile(join(input.installRoot, 'execution-tracks-config.json'), 'utf8') } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  if (process.platform !== 'darwin') throw new Error('Execution track launchd migration requires macOS')
  const config = configuration.parse(JSON.parse(raw))
  // Capture before current is repointed; resolving it later would mistake the
  // still-running old Host for the newly installed target.
  const runningHostEntrypoint = await realpath(process.argv[1]!)
  let legacyGeneration = 0
  try {
    const legacy = JSON.parse(await readFile(join(input.installRoot, 'deployment-state.json'), 'utf8'))
    legacyGeneration = z.number().int().nonnegative().parse(legacy.status.generation)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const plist = JSON.parse((await execute('/usr/bin/plutil', ['-convert', 'json', '-o', '-', input.launchAgentPath])).stdout)
  const environment = plist.EnvironmentVariables as NodeJS.ProcessEnv
  const executable = plist.ProgramArguments?.[0]
  if (typeof executable !== 'string' || !executable.startsWith('/')) throw new Error('Stable Gateway Host executable is missing')
  const resolveRelease = async (id: string, forward = false) => {
      if (forward && resolve(process.argv[1]!) !== resolve(input.installRoot, 'current/ops/gatewayUpdateSupervisorMain.js')) {
        throw new Error('Incompatible upgrade requires a stable current-linked Host; update the local Host launch configuration first')
      }
      const release = await input.supervisor.admitExecutionRelease(id, forward)
      return { releaseId: id, buildId: release.buildId, executable,
        arguments: [join(release.directory, 'ops/matrix-local-gateway.js')], cwd: input.installRoot,
        environment: { ...environment, MALINK_GATEWAY_ADMIN_SOCKET: input.adminSocket,
          MALINK_GATEWAY_BLUE_GREEN: '0', MALINK_MATRIX_FIXTURE: join(input.dataDirectory, 'matrix-fixture.json'),
          MALINK_MATRIX_GATEWAY_SESSION_FILE: join(input.dataDirectory, 'matrix-session.json') },
      }
  }
  const workers = new GatewayExecutionWorkerHost({
    dataDirectory: input.dataDirectory, gatewayNodeId: config.gatewayNodeId, adminSocket: input.adminSocket,
    resolveRelease: id => resolveRelease(id),
    resolveForwardRelease: id => resolveRelease(id, true),
    backupStoppedState: async state => {
      const release = await input.supervisor.admitExecutionRelease(state.targetRelease!, true)
      return backupExecutionTrackState(input.installRoot, state, release.buildId)
    },
    prepareForwardHost: async state => {
      if (!input.requestSupervisorReload) throw new Error('Independent supervisor reload is unavailable')
      if (!state.backupPath || !resolve(state.backupPath).startsWith(`${resolve(input.installRoot, 'backups')}/`)) throw new Error('Verified local backup is required')
      await verifyGatewayForwardOnlyBackup(state.backupPath)
      const release = await input.supervisor.admitExecutionRelease(state.targetRelease!, true)
      return pinForwardGatewayHost({ installRoot: input.installRoot, targetRelease: state.targetRelease!,
        targetDirectory: release.directory, runningHostEntrypoint, requestReload: input.requestSupervisorReload })
    }, log: input.log,
  })
  const tracks = new GatewayExecutionTracks(join(input.installRoot, 'execution-tracks.json'), {
    version: 1, gatewayNodeId: config.gatewayNodeId, dataDirectory: input.dataDirectory,
    generation: 0, activeRelease: config.defaultRelease, standbyRelease: config.previousRelease,
    phase: 'activating', targetRelease: config.defaultRelease,
  }, workers)
  // Admission occurs before disabling the legacy automatic spawn authority.
  const state = await tracks.status()
  await input.supervisor.admitExecutionRelease(state.targetRelease ?? state.activeRelease, state.forwardOnly === true)
  const service = `gui/${process.getuid!()}/${input.serviceLabel}`
  let loaded = true
  try { await execute('/bin/launchctl', ['print', service]) } catch (error) {
    const detail = String((error as { stderr?: string }).stderr ?? '')
    if (!/Could not find service|Could not find specified service/i.test(detail)) throw error
    loaded = false
  }
  if (loaded) {
    // The caller must stop/settle live work before migrating an existing service.
    const { GatewayAdminClient } = await import('@/gateway/admin')
    await new GatewayAdminClient({ socketPath: input.adminSocket, timeoutMs: 30_000 }).sealForDeployment('when_idle')
    await execute('/bin/launchctl', ['disable', service])
    await execute('/bin/launchctl', ['bootout', service])
  } else {
    await execute('/bin/launchctl', ['disable', service])
  }
  const deadline = Date.now() + 45_000
  for (;;) {
    try {
      const lock = await acquireGatewayDataDirectoryLock(input.dataDirectory)
      await lock.release(); break
    } catch (error) {
      if (Date.now() >= deadline) throw error
      await new Promise(resolve => setTimeout(resolve, 250))
    }
  }
  // Keep the independent control receiver reachable even when business startup
  // fails. The persisted attention state permits explicit user selection.
  void tracks.startDefault().catch(error => input.log(`[execution-tracks] startup needs attention: ${error instanceof Error ? error.message : String(error)}`))
  return { tracks, workers, controlProjectId: config.controlProjectId, async deploymentStatus() {
    const state = await tracks.status()
    const active = await inspectGatewayDeploymentSlot({ dataDirectory: input.dataDirectory,
      releaseId: state.activeRelease, buildId: input.supervisor.executionBuildId(state.activeRelease) ?? state.activeRelease })
    return { version: 1, strategy: 'blue-green-v1', maxDeployments: 2,
      computerId: config.computerId, generation: legacyGeneration + 1 + state.generation,
      phase: state.phase === 'attention' ? 'repair_required' : 'steady', active,
      recovery: { gatewayNodeId: config.controlGatewayNodeId, buildId: config.controlBuildId,
        releaseId: config.controlReleaseId, projectId: config.controlProjectId,
        projectCount: 1, sessionCount: 0, retainedAt: state.updatedAt ?? 0 },
      detail: state.error ?? 'Version control remains available independently of the selected business runtime.',
      updatedAt: state.updatedAt ?? 0,
    }
  } }
}
