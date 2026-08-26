import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pairingPublicKeySchema } from '@malink/protocol'
import { GatewayUpdateSupervisor } from './gatewayUpdateSupervisor.js'
import { startGatewayUpdateSupervisorServer } from './gatewayUpdateSupervisorServer.js'

const installRoot = requiredEnvironment('MALINK_GATEWAY_INSTALL_ROOT')
const signer = pairingPublicKeySchema.parse(JSON.parse(await readFile(
  requiredEnvironment('MALINK_GATEWAY_RELEASE_SIGNER_FILE'),
  'utf8',
)))
const supervisor = new GatewayUpdateSupervisor({
  installRoot,
  manifestBaseUrl: optionalEnvironment('MALINK_GATEWAY_RELEASE_MANIFEST_BASE_URL'),
  agentPromptBaseUrl: optionalEnvironment('MALINK_GATEWAY_AGENT_UPDATE_PROMPT_BASE_URL'),
  trustedSigner: signer,
  launchAgentPath: requiredEnvironment('MALINK_GATEWAY_LAUNCH_AGENT'),
  serviceLabel: requiredEnvironment('MALINK_GATEWAY_SERVICE_LABEL'),
  gatewayAdminSocketPath: requiredEnvironment('MALINK_GATEWAY_ADMIN_SOCKET'),
  updateSocketPath: optionalEnvironment('MALINK_GATEWAY_UPDATE_SOCKET'),
  currentBuildId: process.env.MALINK_GATEWAY_BUILD_ID,
  activationDelayMs: optionalDuration('MALINK_GATEWAY_UPDATE_ACTIVATION_DELAY_MS', 5_000),
  healthTimeoutMs: optionalDuration('MALINK_GATEWAY_UPDATE_HEALTH_TIMEOUT_MS', 180_000),
  probationMs: optionalDuration('MALINK_GATEWAY_UPDATE_PROBATION_MS', 60_000),
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
  onCommitted: () => {
    // launchd restarts this independent service from the newly active current
    // release, so supervisor fixes take effect without touching Gateway state.
    const reload = setTimeout(() => process.exit(0), 250)
    reload.unref?.()
  },
})
await supervisor.initialize()
const server = await startGatewayUpdateSupervisorServer({
  socketPath: process.env.MALINK_GATEWAY_UPDATE_SOCKET
    ?? join(installRoot, 'update-supervisor.sock'),
  supervisor,
  onLog: message => process.stderr.write(`${message}\n`),
})
process.stdout.write(`Gateway update supervisor listening on ${server.socketPath}\n`)

let stopping = false
const stop = (): void => {
  if (stopping) return
  stopping = true
  void server.stop()
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
