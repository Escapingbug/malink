import { readFile, readlink } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { pairingPublicKeySchema } from '@malink/protocol'
import { GatewayUpdateSupervisor } from './gatewayUpdateSupervisor.js'
import { startGatewayUpdateSupervisorServer } from './gatewayUpdateSupervisorServer.js'
import { FileGatewayComputerIdentityStore } from './gatewayComputerIdentity.js'
import { GatewayDeploymentCoordinator } from './gatewayDeploymentCoordinator.js'
import { requestMacosSupervisorReload } from './macosSupervisorReload.js'
import {
  inspectGatewayDeploymentSlot,
  MacosGatewayBlueGreenHost,
} from './macosGatewayBlueGreenHost.js'

const installRoot = requiredEnvironment('MALINK_GATEWAY_INSTALL_ROOT')
const signer = pairingPublicKeySchema.parse(JSON.parse(await readFile(
  requiredEnvironment('MALINK_GATEWAY_RELEASE_SIGNER_FILE'),
  'utf8',
)))
const gatewayAdminSocketPath = requiredEnvironment('MALINK_GATEWAY_ADMIN_SOCKET')
const gatewayDataDirectory = optionalEnvironment('MALINK_GATEWAY_DATA_DIR')
  ?? dirname(gatewayAdminSocketPath)
const updateSocketPath = process.env.MALINK_GATEWAY_UPDATE_SOCKET
  ?? join(installRoot, 'update-supervisor.sock')
const reloadSupervisor = (): void => {
  // A clean exit alone may remain pending in launchd's on-demand-only mode.
  // Explicitly reload only this service, never the business Gateway.
  const reload = setTimeout(() => requestMacosSupervisorReload(
    optionalEnvironment('MALINK_GATEWAY_UPDATE_SUPERVISOR_LABEL')
      ?? optionalEnvironment('XPC_SERVICE_NAME')
      ?? 'io.malink.gateway-update-supervisor',
  ), 250)
  reload.unref?.()
}
const supervisor = new GatewayUpdateSupervisor({
  installRoot,
  manifestBaseUrl: optionalEnvironment('MALINK_GATEWAY_RELEASE_MANIFEST_BASE_URL'),
  agentChannelUrl: optionalEnvironment('MALINK_GATEWAY_AGENT_UPDATE_CHANNEL_URL'),
  agentPromptBaseUrl: optionalEnvironment('MALINK_GATEWAY_AGENT_UPDATE_PROMPT_BASE_URL'),
  trustedSigner: signer,
  launchAgentPath: requiredEnvironment('MALINK_GATEWAY_LAUNCH_AGENT'),
  serviceLabel: requiredEnvironment('MALINK_GATEWAY_SERVICE_LABEL'),
  gatewayAdminSocketPath,
  gatewayDataDirectory,
  updateSocketPath,
  currentBuildId: process.env.MALINK_GATEWAY_BUILD_ID,
  activationDelayMs: optionalDuration('MALINK_GATEWAY_UPDATE_ACTIVATION_DELAY_MS', 5_000),
  restartDelayMs: optionalDuration('MALINK_GATEWAY_RESTART_DELAY_MS', 5_000),
  healthTimeoutMs: optionalDuration('MALINK_GATEWAY_UPDATE_HEALTH_TIMEOUT_MS', 180_000),
  restartHealthTimeoutMs: optionalDuration('MALINK_GATEWAY_RESTART_HEALTH_TIMEOUT_MS', 180_000),
  // The deep startup health check is mandatory. A longer stability trial is
  // optional because it delays completion and repeatedly exercises the live
  // Gateway; operators must opt in with an explicit non-zero duration.
  probationMs: optionalDuration('MALINK_GATEWAY_UPDATE_PROBATION_MS', 0),
  syncFreshnessMs: optionalDuration('MALINK_GATEWAY_UPDATE_SYNC_FRESHNESS_MS', 45_000),
  manifestFetchTimeoutMs: optionalDuration(
    'MALINK_GATEWAY_UPDATE_MANIFEST_TIMEOUT_MS',
    30_000,
  ),
  fileFetchTimeoutMs: optionalDuration(
    'MALINK_GATEWAY_UPDATE_FILE_TIMEOUT_MS',
    10 * 60_000,
  ),
}, {
  onLog: message => process.stderr.write(`${message}\n`),
  onCommitted: reloadSupervisor,
})
await supervisor.initialize()
const releaseStatus = await supervisor.status()
const activeBuildId = releaseStatus.currentBuildId
  ?? requiredEnvironment('MALINK_GATEWAY_BUILD_ID')
const activeReleaseId = await currentReleaseId(installRoot)
const active = await inspectGatewayDeploymentSlot({
  dataDirectory: gatewayDataDirectory,
  ...(activeReleaseId ? { releaseId: activeReleaseId } : {}),
  buildId: activeBuildId,
})
const computer = await new FileGatewayComputerIdentityStore(
  join(installRoot, 'computer-identity.json'),
).loadOrCreate()
const blueGreenHost = new MacosGatewayBlueGreenHost({
  installRoot,
  activeDataDirectory: gatewayDataDirectory,
  activeAdminSocketPath: gatewayAdminSocketPath,
  activeLaunchAgentPath: requiredEnvironment('MALINK_GATEWAY_LAUNCH_AGENT'),
  activeServiceLabel: requiredEnvironment('MALINK_GATEWAY_SERVICE_LABEL'),
  updateSocketPath,
  healthTimeoutMs: optionalDuration('MALINK_GATEWAY_UPDATE_HEALTH_TIMEOUT_MS', 180_000),
  syncFreshnessMs: optionalDuration('MALINK_GATEWAY_UPDATE_SYNC_FRESHNESS_MS', 45_000),
}, {
  onCommitted: reloadSupervisor,
  onLog: message => process.stderr.write(`${message}\n`),
})
const deploymentCoordinator = new GatewayDeploymentCoordinator({
  statePath: join(installRoot, 'deployment-state.json'),
  computerId: computer.computerId,
  active,
  promotionDelayMs: optionalDuration('MALINK_GATEWAY_PROMOTION_DELAY_MS', 5_000),
}, {
  prepareCandidate: transition => blueGreenHost.prepareCandidate(transition),
  discardCandidate: transition => blueGreenHost.discardCandidate(transition),
  drainDeployments: transition => blueGreenHost.drainDeployments(transition),
  transferState: transition => blueGreenHost.transferState(transition),
  commitCandidate: transition => blueGreenHost.commitCandidate(transition),
  retainedRecovery: transition => blueGreenHost.retainedRecovery(transition),
  rotateRecovery: recovery => blueGreenHost.rotateRecovery(recovery),
  restoreRecovery: recovery => blueGreenHost.restoreRecovery(recovery),
  rollbackPreCommit: transition => blueGreenHost.rollbackPreCommit(transition),
  recoverPreparation: transition => blueGreenHost.recoverPreparation(transition),
  recoverCommit: transition => blueGreenHost.recoverCommit(transition),
})
await deploymentCoordinator.initialize()
const server = await startGatewayUpdateSupervisorServer({
  socketPath: updateSocketPath,
  supervisor,
  deploymentCoordinator,
  onLog: message => process.stderr.write(`${message}\n`),
})
process.stdout.write(`Gateway update supervisor listening on ${server.socketPath}\n`)

let stopping = false
const stop = (): void => {
  if (stopping) return
  stopping = true
  void server.stop()
    .then(() => deploymentCoordinator.stop())
    .then(() => supervisor.stop())
    .catch(error => {
      process.stderr.write(`[gateway-update-supervisor] shutdown failed: ${formatError(error)}\n`)
      process.exitCode = 1
    })
}
process.once('SIGINT', stop)
process.once('SIGTERM', stop)

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}

function optionalEnvironment(name: string): string | undefined {
  return process.env[name]?.trim() || undefined
}

function optionalDuration(name: string, fallback: number): number {
  const value = process.env[name]
  if (value === undefined) return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${name} is invalid`)
  return parsed
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function currentReleaseId(installRoot: string): Promise<string | undefined> {
  const current = join(installRoot, 'current')
  try {
    const target = await readlink(current)
    const releaseId = basename(resolve(dirname(current), target))
    return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(releaseId)
      ? releaseId
      : undefined
  } catch (error) {
    if (
      error instanceof Error
      && 'code' in error
      && (error as NodeJS.ErrnoException).code === 'ENOENT'
    ) return undefined
    throw error
  }
}
