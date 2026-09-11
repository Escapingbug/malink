import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { AtomicJsonFile } from '@malink/security/node'
import { pairingPublicKeySchema } from '@malink/protocol'
import { GatewayAdminClient } from '@/gateway/admin/client'
import { acquireGatewayDataDirectoryLock } from '@/gateway/matrix/gatewayDataDirectoryLock'
import { GatewayUpdateSupervisor } from './gatewayUpdateSupervisor'
import { gatewayExecutionTracksStateSchema, type GatewayExecutionTracksState } from './gatewayExecutionTracks'
import { backupExecutionTrackState, pinForwardGatewayHost } from './gatewayForwardHostTransition'

const execute = promisify(execFile)

/** One-time owner-local entry for Hosts predating the online forward-only path.
 * Run from the sealed target using a known-working absolute Node executable.
 * It never interrupts Agent work or starts an old reader on upgraded data. */
export async function bootstrapGatewayForwardUpgrade(installRoot: string, releaseId: string, confirmed: boolean): Promise<void> {
  if (!confirmed) throw new Error('Explicit --allow-forward-only confirmation is required; Agent connectivity may be lost')
  if (process.platform !== 'darwin') throw new Error('Local Host bootstrap currently requires macOS')
  const root = resolve(installRoot)
  const plistPath = join(homedir(), 'Library/LaunchAgents/io.malink.gateway-update-supervisor.plist')
  const plist = JSON.parse((await execute('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plistPath])).stdout)
  const env = plist.EnvironmentVariables
  if (!env || resolve(env.MALINK_GATEWAY_INSTALL_ROOT ?? '') !== root
    || plist.ProgramArguments?.[1] !== join(root, 'current/ops/gatewayUpdateSupervisorMain.js')
    || !/^[A-Za-z0-9._-]+$/.test(plist.Label ?? '')) throw new Error('Unsupported stable Host launch configuration')
  const statePath = join(root, 'execution-tracks.json')
  const controller = await acquireGatewayDataDirectoryLock(`${statePath}.controller`)
  let controllerReleased = false
  try {
    const current = gatewayExecutionTracksStateSchema.parse(JSON.parse(await readFile(statePath, 'utf8')))
    if (current.phase !== 'steady' || current.activeRelease === releaseId) throw new Error('Bootstrap requires a steady, different active release; use status/resume for an interrupted upgrade')
    if (resolve(current.dataDirectory) !== resolve(env.MALINK_GATEWAY_DATA_DIR ?? '')) throw new Error('Business data binding differs from the Host configuration')
    const supervisor = new GatewayUpdateSupervisor({ installRoot: root, executionTracksEnabled: true,
      agentChannelUrl: env.MALINK_GATEWAY_AGENT_UPDATE_CHANNEL_URL,
      agentPromptBaseUrl: env.MALINK_GATEWAY_AGENT_UPDATE_PROMPT_BASE_URL,
      manifestBaseUrl: env.MALINK_GATEWAY_RELEASE_MANIFEST_BASE_URL,
      trustedSigner: pairingPublicKeySchema.parse(JSON.parse(await readFile(env.MALINK_GATEWAY_RELEASE_SIGNER_FILE, 'utf8'))),
      launchAgentPath: env.MALINK_GATEWAY_LAUNCH_AGENT, serviceLabel: env.MALINK_GATEWAY_SERVICE_LABEL,
      gatewayAdminSocketPath: env.MALINK_GATEWAY_ADMIN_SOCKET, gatewayDataDirectory: current.dataDirectory })
    const target = await supervisor.admitExecutionRelease(releaseId, true)
    // Admission precedes fencing; draining is never replaced by forced killing.
    await new GatewayAdminClient({ socketPath: env.MALINK_GATEWAY_ADMIN_SOCKET, timeoutMs: 15 * 60_000 }).sealForDeployment('when_idle')
    const service = `gui/${process.getuid!()}/${plist.Label}`
    await execute('/bin/launchctl', ['bootout', service])
    const deadline = Date.now() + 45_000
    for (;;) {
      try {
        const lock = await acquireGatewayDataDirectoryLock(current.dataDirectory)
        await lock.release(); break
      } catch (error) {
        if (Date.now() >= deadline) throw error
        await new Promise(resolveWait => setTimeout(resolveWait, 250))
      }
    }
    const intent: GatewayExecutionTracksState = { version: 1, gatewayNodeId: current.gatewayNodeId,
      dataDirectory: current.dataDirectory, generation: current.generation + 1, activeRelease: current.activeRelease,
      targetRelease: releaseId, phase: 'releasing', forwardOnly: true, updatedAt: Date.now() }
    intent.backupPath = await backupExecutionTrackState(root, intent, target.buildId)
    process.stdout.write(`Verified stopped-state backup: ${intent.backupPath}\n`)
    await new AtomicJsonFile<GatewayExecutionTracksState>(statePath).transaction(() => { throw new Error('Missing execution state') }, raw => {
      const observed = gatewayExecutionTracksStateSchema.parse(raw)
      if (observed.generation !== current.generation || observed.phase !== 'steady') throw new Error('Execution state changed during bootstrap')
      for (const key of Object.keys(raw)) delete (raw as Record<string, unknown>)[key]
      Object.assign(raw, intent)
      return { changed: true, result: undefined }
    })
    await pinForwardGatewayHost({ installRoot: root, targetRelease: releaseId, targetDirectory: target.directory,
      runningHostEntrypoint: await realpath(process.argv[1]!), requestReload() {} })
    await controller.release()
    controllerReleased = true
    await execute('/bin/launchctl', ['bootstrap', `gui/${process.getuid!()}`, plistPath])
    await execute('/bin/launchctl', ['kickstart', service])
    process.stdout.write('Independent Host started. Use status/resume to verify the target; bootstrap is not a health confirmation.\n')
  } finally { if (!controllerReleased) await controller.release() }
}
