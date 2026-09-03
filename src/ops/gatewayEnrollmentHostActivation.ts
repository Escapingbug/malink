import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import {
  access,
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  stat,
} from 'node:fs/promises'
import { constants } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { GatewayAdminClient, type GatewayAdminStatus } from '../gateway/admin/index.js'

const GATEWAY_LAUNCH_AGENT_NAMES = [
  'io.malink.gateway.plist',
  'com.malink.matrix-gateway.plist',
] as const
const SUPERVISOR_LAUNCH_AGENT_NAMES = [
  'io.malink.gateway-update-supervisor.plist',
] as const

export interface GatewayEnrollmentHostActivationResult {
  state: 'activated' | 'manual'
  dataDirectory: string
  adminSocketPath: string
  launchAgentPath?: string
  serviceLabel?: string
  detail?: string
}

export interface GatewayEnrollmentHostActivationDependencies {
  platform?: NodeJS.Platform
  homeDirectory?: string
  uid?: number
  launchctl?: (arguments_: readonly string[]) => Promise<void>
  isServiceLoaded?: (service: string) => Promise<boolean>
  readStatus?: (socketPath: string) => Promise<GatewayAdminStatus>
  sleep?: (milliseconds: number) => Promise<void>
}

/**
 * Connect the completed enrollment directory to an installed macOS Gateway
 * Host. The old directory is never removed. Both LaunchAgent plists are
 * restored and the former Gateway is restarted if the replacement cannot
 * prove Matrix-ready health.
 */
export async function activateEnrolledGatewayHost(
  input: {
    dataDirectory: string
    fixturePath: string
    gatewayNodeId: string
    gatewayLaunchAgentPath?: string
    supervisorLaunchAgentPath?: string
    healthTimeoutMs?: number
  },
  dependencies: GatewayEnrollmentHostActivationDependencies = {},
): Promise<GatewayEnrollmentHostActivationResult> {
  const dataDirectory = resolve(input.dataDirectory)
  const fixturePath = resolve(input.fixturePath)
  const adminSocketPath = join(dataDirectory, 'admin.sock')
  await requireFile(join(dataDirectory, 'gateway-identity.json'), 'Gateway identity')
  await requireFile(fixturePath, 'Gateway Matrix configuration')
  const gatewayLoginUser = await enrolledGatewayLoginUser(dataDirectory, fixturePath)
  if ((dependencies.platform ?? process.platform) !== 'darwin') {
    return {
      state: 'manual',
      dataDirectory,
      adminSocketPath,
      detail: 'Automatic Gateway Host activation currently requires macOS launchd.',
    }
  }

  const homeDirectory = dependencies.homeDirectory ?? homedir()
  const launchAgentsDirectory = join(homeDirectory, 'Library', 'LaunchAgents')
  const gatewayLaunchAgentPath = await findLaunchAgent(
    input.gatewayLaunchAgentPath,
    launchAgentsDirectory,
    GATEWAY_LAUNCH_AGENT_NAMES,
    'matrix-local-gateway.js',
  )
  if (!gatewayLaunchAgentPath) {
    return {
      state: 'manual',
      dataDirectory,
      adminSocketPath,
      detail: 'No installed Malink Gateway LaunchAgent was found.',
    }
  }

  const originalGatewayPlist = await readFile(gatewayLaunchAgentPath, 'utf8')
  const gatewayServiceLabel = requirePlistString(originalGatewayPlist, 'Label')
  const previousDataDirectory = plistEnvironmentString(
    originalGatewayPlist,
    'MALINK_MATRIX_DATA_DIR',
  )
  const previousAdminSocket = plistEnvironmentString(
    originalGatewayPlist,
    'MALINK_GATEWAY_ADMIN_SOCKET',
  ) ?? (previousDataDirectory ? join(previousDataDirectory, 'admin.sock') : undefined)
  if (previousAdminSocket && resolve(previousAdminSocket) !== adminSocketPath) {
    await requireIdleGateway(previousAdminSocket, dependencies.readStatus)
  }

  const supervisorLaunchAgentPath = await findLaunchAgent(
    input.supervisorLaunchAgentPath,
    launchAgentsDirectory,
    SUPERVISOR_LAUNCH_AGENT_NAMES,
    'gatewayUpdateSupervisorMain.js',
  )
  const originalSupervisorPlist = supervisorLaunchAgentPath
    ? await readFile(supervisorLaunchAgentPath, 'utf8')
    : undefined
  const supervisorServiceLabel = originalSupervisorPlist
    ? requirePlistString(originalSupervisorPlist, 'Label')
    : undefined

  const nextGatewayPlist = setPlistEnvironmentStrings(originalGatewayPlist, {
    MALINK_MATRIX_DATA_DIR: dataDirectory,
    MALINK_MATRIX_FIXTURE: fixturePath,
    MALINK_GATEWAY_ADMIN_SOCKET: adminSocketPath,
    MALINK_MATRIX_GATEWAY_USER: gatewayLoginUser,
  })
  const nextSupervisorPlist = originalSupervisorPlist
    ? setPlistEnvironmentStrings(originalSupervisorPlist, {
        MALINK_GATEWAY_DATA_DIR: dataDirectory,
        MALINK_GATEWAY_ADMIN_SOCKET: adminSocketPath,
      })
    : undefined
  const launchctl = dependencies.launchctl ?? runLaunchctl
  const isServiceLoaded = dependencies.isServiceLoaded ?? launchAgentIsLoaded
  const sleep = dependencies.sleep ?? (milliseconds =>
    new Promise(resolveDelay => setTimeout(resolveDelay, milliseconds)))
  const uid = dependencies.uid ?? process.getuid?.() ?? 0
  const readStatus = dependencies.readStatus ?? (socketPath =>
    new GatewayAdminClient({ socketPath, timeoutMs: 2_000 }).status())

  await mkdir(dirname(gatewayLaunchAgentPath), { recursive: true })
  try {
    if (nextSupervisorPlist && supervisorLaunchAgentPath && supervisorServiceLabel) {
      await atomicWrite(supervisorLaunchAgentPath, nextSupervisorPlist)
      await restartLaunchAgent(
        supervisorServiceLabel,
        supervisorLaunchAgentPath,
        uid,
        launchctl,
        isServiceLoaded,
        sleep,
      )
    }
    await atomicWrite(gatewayLaunchAgentPath, nextGatewayPlist)
    await restartLaunchAgent(
      gatewayServiceLabel,
      gatewayLaunchAgentPath,
      uid,
      launchctl,
      isServiceLoaded,
      sleep,
    )
    await waitForGatewayHealth(
      () => readStatus(adminSocketPath),
      input.gatewayNodeId,
      input.healthTimeoutMs ?? 60_000,
      sleep,
    )
  } catch (activationError) {
    let rollbackError: unknown
    try {
      if (originalSupervisorPlist && supervisorLaunchAgentPath && supervisorServiceLabel) {
        await atomicWrite(supervisorLaunchAgentPath, originalSupervisorPlist)
        await restartLaunchAgent(
          supervisorServiceLabel,
          supervisorLaunchAgentPath,
          uid,
          launchctl,
          isServiceLoaded,
          sleep,
        )
      }
      await atomicWrite(gatewayLaunchAgentPath, originalGatewayPlist)
      await restartLaunchAgent(
        gatewayServiceLabel,
        gatewayLaunchAgentPath,
        uid,
        launchctl,
        isServiceLoaded,
        sleep,
      )
    } catch (error) {
      rollbackError = error
    }
    throw new Error(
      `Gateway enrollment completed, but Gateway Host activation failed: `
      + `${formatError(activationError)}. `
      + (rollbackError
        ? `Restoring the previous Gateway Host configuration also failed: ${formatError(rollbackError)}`
        : 'The previous Gateway Host configuration was restored.'),
      { cause: activationError },
    )
  }

  return {
    state: 'activated',
    dataDirectory,
    adminSocketPath,
    launchAgentPath: gatewayLaunchAgentPath,
    serviceLabel: gatewayServiceLabel,
  }
}

async function requireIdleGateway(
  socketPath: string,
  readStatus: GatewayEnrollmentHostActivationDependencies['readStatus'],
): Promise<void> {
  let status: GatewayAdminStatus
  try {
    status = await (readStatus
      ? readStatus(socketPath)
      : new GatewayAdminClient({ socketPath, timeoutMs: 2_000 }).status())
  } catch {
    return
  }
  const activeTurns = status.activeTurns ?? 0
  const activeCommands = status.activeCommands ?? 0
  const unfinishedCommands = status.unfinishedCommands ?? 0
  if (activeTurns === 0 && activeCommands === 0 && unfinishedCommands === 0) return
  throw new Error(
    `The existing Gateway Host is still working `
    + `(${activeTurns} active turn(s), ${activeCommands} active command(s), `
    + `${unfinishedCommands} unfinished command(s)). `
    + 'The new Gateway enrollment is complete, but activation was not attempted. '
    + 'Wait for the existing work to finish, then run gateway activate-host again.',
  )
}

async function findLaunchAgent(
  configuredPath: string | undefined,
  directory: string,
  names: readonly string[],
  requiredEntrypoint: string,
): Promise<string | undefined> {
  const candidates = configuredPath
    ? [resolve(configuredPath)]
    : names.map(name => join(directory, name))
  for (const candidate of candidates) {
    let content: string
    try {
      content = await readFile(candidate, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    if (content.includes(requiredEntrypoint)) return candidate
    if (configuredPath) {
      throw new Error(`Configured LaunchAgent does not run ${requiredEntrypoint}: ${candidate}`)
    }
  }
  return undefined
}

function setPlistEnvironmentStrings(
  plist: string,
  values: Readonly<Record<string, string>>,
): string {
  const environmentMarker = /<key>\s*EnvironmentVariables\s*<\/key>\s*<dict>/u.exec(plist)
  if (!environmentMarker || environmentMarker.index === undefined) {
    throw new Error('Gateway LaunchAgent has no EnvironmentVariables dictionary')
  }
  const bodyStart = environmentMarker.index + environmentMarker[0].length
  const bodyEnd = plist.indexOf('</dict>', bodyStart)
  if (bodyEnd < 0) throw new Error('Gateway LaunchAgent EnvironmentVariables are malformed')
  let body = plist.slice(bodyStart, bodyEnd)
  for (const [key, value] of Object.entries(values)) {
    const entry = new RegExp(
      `<key>\\s*${escapeRegExp(key)}\\s*<\\/key>\\s*<string>[\\s\\S]*?<\\/string>`,
      'u',
    )
    const replacement = `<key>${key}</key>\n    <string>${xml(value)}</string>`
    if (entry.test(body)) body = body.replace(entry, replacement)
    else body += `\n    ${replacement}`
  }
  return `${plist.slice(0, bodyStart)}${body}${plist.slice(bodyEnd)}`
}

function plistEnvironmentString(plist: string, key: string): string | undefined {
  const environmentMarker = /<key>\s*EnvironmentVariables\s*<\/key>\s*<dict>/u.exec(plist)
  if (!environmentMarker || environmentMarker.index === undefined) return undefined
  const bodyStart = environmentMarker.index + environmentMarker[0].length
  const bodyEnd = plist.indexOf('</dict>', bodyStart)
  if (bodyEnd < 0) return undefined
  return plistString(plist.slice(bodyStart, bodyEnd), key)
}

function requirePlistString(plist: string, key: string): string {
  const value = plistString(plist, key)
  if (!value) throw new Error(`Gateway LaunchAgent ${key} is unavailable`)
  return value
}

function plistString(plist: string, key: string): string | undefined {
  const match = new RegExp(
    `<key>\\s*${escapeRegExp(key)}\\s*<\\/key>\\s*<string>([\\s\\S]*?)<\\/string>`,
    'u',
  ).exec(plist)
  return match?.[1] ? unxml(match[1].trim()) : undefined
}

async function restartLaunchAgent(
  label: string,
  plistPath: string,
  uid: number,
  launchctl: (arguments_: readonly string[]) => Promise<void>,
  isServiceLoaded: (service: string) => Promise<boolean>,
  sleep: (milliseconds: number) => Promise<void>,
): Promise<void> {
  const domain = `gui/${uid}`
  const service = `${domain}/${label}`
  await launchctl(['bootout', service]).catch(async error => {
    if (await isServiceLoaded(service)) throw error
  })
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await launchctl(['bootstrap', domain, plistPath])
      await launchctl(['kickstart', '-k', service])
      return
    } catch (error) {
      if (attempt === 4) throw error
      await sleep(250 * (attempt + 1))
    }
  }
}

async function waitForGatewayHealth(
  readStatus: () => Promise<GatewayAdminStatus>,
  gatewayNodeId: string,
  timeoutMs: number,
  sleep: (milliseconds: number) => Promise<void>,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown = new Error('Gateway health check did not run')
  do {
    try {
      const status = await readStatus()
      if (status.gatewayNodeId !== gatewayNodeId) {
        throw new Error(`Gateway Host reported another node: ${status.gatewayNodeId}`)
      }
      if (status.state !== 'running' || status.matrixReady !== true) {
        throw new Error(
          `Gateway Host reported ${status.state}; Matrix ready=${String(status.matrixReady)}`,
        )
      }
      return
    } catch (error) {
      lastError = error
    }
    await sleep(Math.min(500, Math.max(0, deadline - Date.now())))
  } while (Date.now() < deadline)
  throw new Error(`Gateway Host did not become Matrix-ready: ${formatError(lastError)}`)
}

async function requireFile(path: string, label: string): Promise<void> {
  const metadata = await stat(path).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`${label} is missing: ${path}`)
    }
    throw error
  })
  if (!metadata.isFile()) throw new Error(`${label} is not a regular file: ${path}`)
  await access(path, constants.R_OK)
}

async function enrolledGatewayLoginUser(
  dataDirectory: string,
  fixturePath: string,
): Promise<string> {
  const sessionPath = join(dataDirectory, 'matrix-session.json')
  await requireFile(sessionPath, 'Gateway Matrix session')
  let fixture: unknown
  let session: unknown
  try {
    [fixture, session] = await Promise.all([
      readFile(fixturePath, 'utf8').then(value => JSON.parse(value) as unknown),
      readFile(sessionPath, 'utf8').then(value => JSON.parse(value) as unknown),
    ])
  } catch (error) {
    throw new Error('Could not read the enrolled Gateway Matrix identity', {
      cause: error,
    })
  }
  const fixtureRecord = asRecord(fixture)
  const fixtureGateway = asRecord(fixtureRecord?.gateway)
  const sessionRecord = asRecord(session)
  const gatewayUserId = optionalString(fixtureGateway?.userId)
  const sessionUserId = optionalString(sessionRecord?.user_id)
  const loginUser = optionalString(sessionRecord?.loginUser)
  const fixtureHomeserver = normalizedOrigin(fixtureRecord?.homeserver)
  const sessionHomeserver = normalizedOrigin(sessionRecord?.homeserver)
  if (
    sessionRecord?.version !== 1
    || !gatewayUserId
    || !sessionUserId
    || sessionUserId !== gatewayUserId
    || !loginUser
    || loginUser.length > 512
    || /\s/u.test(loginUser)
    || !fixtureHomeserver
    || sessionHomeserver !== fixtureHomeserver
  ) {
    throw new Error(
      'The enrolled Gateway Matrix session does not match its enrollment configuration',
    )
  }
  return loginUser
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() === value && value
    ? value
    : undefined
}

function normalizedOrigin(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  try {
    return new URL(value).origin
  } catch {
    return undefined
  }
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const temporary = join(dirname(path), `.${randomUUID()}.malink-enrollment`)
  const mode = (await stat(path)).mode & 0o777
  const handle = await open(temporary, 'wx', mode)
  try {
    await handle.writeFile(content, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  await chmod(temporary, mode)
  await rename(temporary, path)
}

function runLaunchctl(arguments_: readonly string[]): Promise<void> {
  return new Promise((resolveRun, reject) => {
    const child = spawn('/bin/launchctl', arguments_, { stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', code => {
      if (code === 0) resolveRun()
      else reject(new Error(`launchctl ${arguments_.join(' ')} exited with ${code}`))
    })
  })
}

function launchAgentIsLoaded(service: string): Promise<boolean> {
  return new Promise(resolveStatus => {
    const child = spawn('/bin/launchctl', ['print', service], { stdio: 'ignore' })
    child.once('error', () => resolveStatus(false))
    child.once('exit', code => resolveStatus(code === 0))
  })
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

function xml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

function unxml(value: string): string {
  return value
    .replaceAll('&apos;', "'")
    .replaceAll('&quot;', '"')
    .replaceAll('&gt;', '>')
    .replaceAll('&lt;', '<')
    .replaceAll('&amp;', '&')
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
