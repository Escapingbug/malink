import { execFile } from 'node:child_process'
import { copyFile, mkdir, readFile, readlink, rename, symlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'
import { pairingPublicKeySchema } from '@malink/protocol'
import { GatewayUpdateSupervisor } from '../src/ops/gatewayUpdateSupervisor'
import { acquireGatewayDataDirectoryLock } from '../src/gateway/matrix/gatewayDataDirectoryLock'

// Owner-only bootstrap from the previous blue/green repair route. No business
// snapshot is copied or restored. Normal later updates use the signed UI path.
const execute = promisify(execFile)
const releaseId = process.argv[2]
if (process.platform !== 'darwin' || !releaseId || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(releaseId)) {
  throw new Error('Usage (macOS owner): tsx scripts/migrate-gateway-execution-tracks.ts <sealed-release-id>')
}
const installRoot = join(homedir(), '.local/share/malink-matrix')
const supervisorPlist = join(homedir(), 'Library/LaunchAgents/io.malink.gateway-update-supervisor.plist')
const json = async (path: string) => JSON.parse(await readFile(path, 'utf8'))
const readPlist = async (path: string) => JSON.parse((await execute('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path])).stdout)
const plist = await readPlist(supervisorPlist)
const env = plist.EnvironmentVariables
const data = env.MALINK_GATEWAY_DATA_DIR
if (typeof data !== 'string' || !data.startsWith('/')) throw new Error('Stable business directory is missing')
const host = (await json(join(installRoot, 'deployment-host-state.json'))).deployment
if (host.phase !== 'ownership_committed' || !host.sourceArchiveDirectory || !host.recoveryRoomId
  || !host.recoveryProjectId || host.sourceArchiveDirectory === data) throw new Error('A separate committed repair route is required')
const archive = host.sourceArchiveDirectory as string
const catalog = await json(join(data, 'gateway-projects.json'))
const controlCatalog = await json(join(archive, 'gateway-projects.json'))
if (catalog.gatewayNodeId !== host.candidateGatewayNodeId
  || (controlCatalog.gatewayNodeId && controlCatalog.gatewayNodeId !== host.sourceGatewayNodeId)
  || controlCatalog.projects.length !== 1 || controlCatalog.projects[0].roomId !== host.recoveryRoomId) {
  throw new Error('Business/control identities or isolated repair room do not match the committed handoff')
}
const current = basename(await readlink(join(installRoot, 'current')))
const supervisor = new GatewayUpdateSupervisor({ installRoot, executionTracksEnabled: true,
  agentChannelUrl: env.MALINK_GATEWAY_AGENT_UPDATE_CHANNEL_URL,
  agentPromptBaseUrl: env.MALINK_GATEWAY_AGENT_UPDATE_PROMPT_BASE_URL,
  manifestBaseUrl: env.MALINK_GATEWAY_RELEASE_MANIFEST_BASE_URL,
  trustedSigner: pairingPublicKeySchema.parse(await json(env.MALINK_GATEWAY_RELEASE_SIGNER_FILE)),
  launchAgentPath: env.MALINK_GATEWAY_LAUNCH_AGENT, serviceLabel: env.MALINK_GATEWAY_SERVICE_LABEL,
  gatewayAdminSocketPath: env.MALINK_GATEWAY_ADMIN_SOCKET, gatewayDataDirectory: data })
const admitted = await supervisor.admitExecutionRelease(releaseId)
await supervisor.admitExecutionRelease(current)
await readFile(join(admitted.directory, 'ops/gatewayExecutionTrackWorker.js'))
const controlPlistPath = join(installRoot, 'deployments', host.updateId, 'recovery.plist')
const controlPlist = await readPlist(controlPlistPath)
if (controlPlist.EnvironmentVariables.MALINK_MATRIX_DATA_DIR !== archive) throw new Error('Control service does not use the isolated directory')
// Bootstrap requires a stopped business writer. Never forcibly stop live work.
const lock = await acquireGatewayDataDirectoryLock(data)
await lock.release()
const configurationPath = join(installRoot, 'execution-tracks-config.json')
try { await readFile(configurationPath); throw new Error('Execution tracks already configured; use signed version selection') }
catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
const backup = join(installRoot, 'execution-track-bootstrap', new Date().toISOString().replace(/[:.]/g, '-'))
await mkdir(backup, { recursive: true, mode: 0o700 })
await copyFile(controlPlistPath, join(backup, 'recovery.plist'))
await copyFile(join(archive, 'gateway-projects.json'), join(backup, 'control-projects.json'))
await writeFile(join(backup, 'previous-current.txt'), `${current}\n`, { mode: 0o600 })
const domain = `gui/${process.getuid!()}`
try { await execute('/bin/launchctl', ['bootout', `${domain}/${controlPlist.Label}`]) }
catch (error) {
  if (!/Could not find|No such process|No such file/i.test(String((error as { stderr?: string }).stderr))) throw error
}
const controlLock = await acquireGatewayDataDirectoryLock(archive)
try {
  await writeFile(join(archive, 'gateway-projects.json'), JSON.stringify({ ...controlCatalog,
    gatewayNodeId: host.sourceGatewayNodeId }), { mode: 0o600 })
  controlPlist.ProgramArguments[1] = join(admitted.directory, 'ops/matrix-local-gateway.js')
  controlPlist.RunAtLoad = true
  controlPlist.KeepAlive = true
  Object.assign(controlPlist.EnvironmentVariables, { MALINK_GATEWAY_BUILD_ID: admitted.buildId,
    MALINK_GATEWAY_EXECUTION_CONTROL_ONLY: '1', MALINK_GATEWAY_BLUE_GREEN: '0' })
  const temporary = `${controlPlistPath}.execution-tracks`
  await writeFile(temporary, JSON.stringify(controlPlist), { mode: 0o600 })
  await execute('/usr/bin/plutil', ['-convert', 'xml1', temporary])
  await rename(temporary, controlPlistPath)
  const computer = await json(join(installRoot, 'computer-identity.json'))
  await writeFile(configurationPath, JSON.stringify({ version: 1, gatewayNodeId: catalog.gatewayNodeId,
    defaultRelease: releaseId, previousRelease: current, controlProjectId: host.recoveryProjectId,
    computerId: computer.computerId, controlGatewayNodeId: host.sourceGatewayNodeId,
    controlReleaseId: releaseId, controlBuildId: admitted.buildId }), { mode: 0o600, flag: 'wx' })
  const temporaryLink = join(installRoot, `current-execution-${process.pid}`)
  await symlink(`releases/${releaseId}`, temporaryLink)
  await rename(temporaryLink, join(installRoot, 'current'))
} finally { await controlLock.release() }
await execute('/bin/launchctl', ['bootstrap', domain, controlPlistPath])
await execute('/bin/launchctl', ['kickstart', `${domain}/${controlPlist.Label}`])
await execute('/bin/launchctl', ['kickstart', '-k', `${domain}/${plist.Label}`])
process.stdout.write(`Execution tracks bootstrap requested. Verify both admin sockets and signed APK controls. Configuration backup: ${backup}\n`)
