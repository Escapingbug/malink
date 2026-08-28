import { spawn } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { GatewayAdminClient } from '../src/gateway/admin/client.js'
import {
  defaultMacosGatewayHostAppPath,
  macosGatewayHostExecutablePath,
  validateInstalledMacosGatewayHost,
} from '../src/ops/macosGatewayHost.js'

interface DoctorOptions {
  gatewayHostApp: string
  gatewayLaunchAgent: string
  gatewayAdminSocket: string
  paths: string[]
  timeoutMs: number
}

export interface MacosGatewayHostDoctorResult {
  hostApp: string
  hostExecutable: string
  gatewayPid: number
  gatewayBuildId?: string
  ready: boolean
  paths: Array<{
    path: string
    state: string
    exists?: boolean
    code?: string
    detail?: string
  }>
}

export async function doctorMacosGatewayHost(
  options: DoctorOptions,
): Promise<MacosGatewayHostDoctorResult> {
  if (process.platform !== 'darwin') throw new Error('Gateway Host doctor requires macOS')
  const hostApp = resolve(options.gatewayHostApp)
  const hostExecutable = macosGatewayHostExecutablePath(hostApp)
  await validateInstalledMacosGatewayHost(hostApp)
  const configuredExecutable = (await commandOutput('/usr/libexec/PlistBuddy', [
    '-c',
    'Print :ProgramArguments:0',
    resolve(options.gatewayLaunchAgent),
  ])).trim()
  if (configuredExecutable !== hostExecutable) {
    throw new Error(
      `Gateway LaunchAgent does not use the stable permission host: ${configuredExecutable}`,
    )
  }
  const requestTimeoutMs = options.paths.length === 0
    ? 30 * 60_000
    : Math.min(
        30 * 60_000,
        options.timeoutMs * options.paths.length + 5_000,
      )
  const client = new GatewayAdminClient({
    socketPath: resolve(options.gatewayAdminSocket),
    timeoutMs: requestTimeoutMs,
  })
  const status = await client.status()
  if (status.state !== 'running') {
    throw new Error(`Gateway is not running: ${status.state}`)
  }
  const preflight = await client.preflightFilesystem({
    ...(options.paths.length > 0 ? { paths: options.paths.map(path => resolve(path)) } : {}),
    allowCreate: false,
    timeoutMs: options.timeoutMs,
  })
  return {
    hostApp,
    hostExecutable,
    gatewayPid: status.pid,
    ...(status.buildId ? { gatewayBuildId: status.buildId } : {}),
    ready: preflight.ready,
    paths: preflight.results,
  }
}

function parseArguments(argv: readonly string[]): DoctorOptions {
  const values = new Map<string, string>()
  const paths: string[] = []
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!
    const value = argv[index + 1]
    if (!argument.startsWith('--') || !value || value.startsWith('--')) {
      throw new Error(`Invalid doctor argument near ${argument}`)
    }
    if (argument === '--path') paths.push(resolve(value))
    else values.set(argument.slice(2), value)
    index += 1
  }
  const timeoutMs = Number(values.get('timeout-ms') ?? 120_000)
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000) {
    throw new Error('--timeout-ms must be an integer between 100 and 120000')
  }
  return {
    gatewayHostApp: resolve(
      values.get('gateway-host-app') ?? defaultMacosGatewayHostAppPath(),
    ),
    gatewayLaunchAgent: resolve(
      values.get('gateway-launch-agent')
        ?? join(homedir(), 'Library', 'LaunchAgents', 'io.malink.gateway.plist'),
    ),
    gatewayAdminSocket: resolve(
      values.get('gateway-admin-socket')
        ?? process.env.MALINK_GATEWAY_ADMIN_SOCKET
        ?? join(homedir(), '.malink', 'gateway', 'admin.sock'),
    ),
    paths,
    timeoutMs,
  }
}

function commandOutput(command: string, arguments_: readonly string[]): Promise<string> {
  return new Promise((resolveCommand, reject) => {
    const child = spawn(command, [...arguments_], { stdio: ['ignore', 'pipe', 'pipe'] })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
    child.once('error', reject)
    child.once('close', code => {
      if (code === 0) resolveCommand(Buffer.concat(stdout).toString('utf8'))
      else reject(new Error(
        `${command} exited with ${code}: ${Buffer.concat(stderr).toString('utf8').trim()}`,
      ))
    })
  })
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  const result = await doctorMacosGatewayHost(parseArguments(process.argv.slice(2)))
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  if (!result.ready) {
    throw new Error(
      'Gateway Host is not ready for unattended remote access. Grant Full Disk Access locally, then run the doctor again.',
    )
  }
}

function isDirectRun(moduleUrl: string, argumentPath: string | undefined): boolean {
  if (!argumentPath) return false
  const modulePath = fileURLToPath(moduleUrl)
  try {
    return realpathSync(modulePath) === realpathSync(resolve(argumentPath))
  } catch {
    return modulePath === resolve(argumentPath)
  }
}
