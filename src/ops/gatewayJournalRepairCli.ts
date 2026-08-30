import { execFile } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { GatewayAdminClient, type GatewayAdminStatus } from '../gateway/admin/index.js'
import type { GatewayUpdateStatus } from '@malink/protocol'
import { GatewayUpdateSupervisorClient } from './gatewayUpdateSupervisorServer.js'
import { acquireGatewayDataDirectoryLock } from '../gateway/matrix/gatewayDataDirectoryLock.js'
import {
  planMlp3CommandJournalRepair,
  repairMlp3CommandJournal,
  type Mlp3CommandJournalRepairResult,
} from '../gateway/matrix/mlp3CommandJournalRepair.js'

export type GatewayJournalDiagnosis = {
  journalPath: string
  state: 'clean' | 'repairable'
  duplicateTerminals: ReturnType<typeof planMlp3CommandJournalRepair>['duplicateTerminals']
  removedLines: number[]
}

export type GatewayJournalRecoveryResult = {
  state: 'recovered'
  repair: Mlp3CommandJournalRepairResult
  gateway: GatewayAdminStatus
  supervisor?: GatewayUpdateStatus
}

export interface GatewayJournalRepairCliDependencies {
  platform?: NodeJS.Platform
  uid?: number
  launchctl?: (arguments_: readonly string[]) => Promise<void>
  waitForGateway?: (socketPath: string, timeoutMs: number) => Promise<GatewayAdminStatus>
  acknowledgeRecovery?: (socketPath: string) => Promise<GatewayUpdateStatus>
}

export async function runGatewayJournalRepairCli(
  argv: readonly string[],
  dependencies: GatewayJournalRepairCliDependencies = {},
): Promise<GatewayJournalDiagnosis | GatewayJournalRecoveryResult> {
  const normalizedArgv = argv[0] === '--' ? argv.slice(1) : argv
  const [command, ...arguments_] = normalizedArgv
  const dataDirectory = resolve(requiredArgument(arguments_, 'data-dir'))
  const journalPath = join(dataDirectory, 'gateway-replay.jsonl.v3-commands.jsonl')
  const plan = planMlp3CommandJournalRepair(await readFile(journalPath, 'utf8'))
  const diagnosis: GatewayJournalDiagnosis = {
    journalPath,
    state: plan.duplicateTerminals.length > 0 ? 'repairable' : 'clean',
    duplicateTerminals: plan.duplicateTerminals,
    removedLines: plan.removedLines,
  }
  if (command === 'diagnose') return diagnosis
  if (command !== 'recover') {
    throw new Error(`Unsupported Gateway journal repair command: ${command ?? '(missing)'}`)
  }
  if (diagnosis.state !== 'repairable') {
    throw new Error('The Gateway command journal does not need duplicate-terminal repair')
  }
  if ((dependencies.platform ?? process.platform) !== 'darwin') {
    throw new Error('Automatic Gateway journal recovery currently requires macOS launchd')
  }
  const serviceLabel = requiredServiceLabel(arguments_)
  const configuredLaunchAgentPath = requiredArgument(arguments_, 'launch-agent')
  if (!isAbsolute(configuredLaunchAgentPath)) {
    throw new Error('--launch-agent must be an absolute path')
  }
  const launchAgentPath = resolve(configuredLaunchAgentPath)
  if (!(await stat(launchAgentPath)).isFile()) {
    throw new Error('--launch-agent must identify an existing LaunchAgent plist')
  }
  const adminSocketPath = resolve(
    optionalArgument(arguments_, 'admin-socket') ?? join(dataDirectory, 'admin.sock'),
  )
  const timeoutMs = optionalPositiveInteger(arguments_, 'health-timeout-ms') ?? 180_000
  const domain = `gui/${dependencies.uid ?? process.getuid?.() ?? 0}`
  const target = `${domain}/${serviceLabel}`
  const launchctl = dependencies.launchctl ?? runLaunchctl
  const waitForGateway = dependencies.waitForGateway ?? waitForGatewayHealth
  let stopped = false
  try {
    await launchctl(['bootout', target]).catch(error => {
      if (!serviceMissing(error)) throw error
    })
    stopped = true
    const lock = await acquireGatewayDataDirectoryLock(dataDirectory)
    let repair: Mlp3CommandJournalRepairResult
    try {
      // Re-read only after launchd has stopped the Gateway. The repair refuses
      // ambiguous conflicts and always writes a byte-for-byte backup first.
      repair = await repairMlp3CommandJournal(journalPath)
    } finally {
      await lock.release()
    }
    await launchctl(['bootstrap', domain, launchAgentPath])
    await launchctl(['kickstart', '-k', target])
    stopped = false
    const gateway = await waitForGateway(adminSocketPath, timeoutMs)
    const supervisorSocketPath = optionalArgument(arguments_, 'supervisor-socket')
    const supervisor = supervisorSocketPath
      ? await (dependencies.acknowledgeRecovery
          ? dependencies.acknowledgeRecovery(resolve(supervisorSocketPath))
          : new GatewayUpdateSupervisorClient(resolve(supervisorSocketPath), 30_000)
            .acknowledgeGatewayRecovery())
      : undefined
    return { state: 'recovered', repair, gateway, ...(supervisor ? { supervisor } : {}) }
  } finally {
    if (stopped) {
      await launchctl(['bootstrap', domain, launchAgentPath]).catch(() => undefined)
      await launchctl(['kickstart', '-k', target]).catch(() => undefined)
    }
  }
}

function requiredArgument(argv: readonly string[], name: string): string {
  const value = optionalArgument(argv, name)
  if (!value) throw new Error(`Missing --${name}`)
  return value
}

function optionalArgument(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(`--${name}`)
  const value = index >= 0 ? argv[index + 1]?.trim() : undefined
  return value || undefined
}

function requiredServiceLabel(argv: readonly string[]): string {
  const value = requiredArgument(argv, 'service-label')
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u.test(value)) {
    throw new Error('--service-label is invalid')
  }
  return value
}

function optionalPositiveInteger(argv: readonly string[], name: string): number | undefined {
  const value = optionalArgument(argv, name)
  if (value === undefined) return undefined
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 10 * 60_000) {
    throw new Error(`--${name} must be an integer between 1 and 600000`)
  }
  return parsed
}

function runLaunchctl(arguments_: readonly string[]): Promise<void> {
  return new Promise((resolveRun, reject) => {
    execFile('/bin/launchctl', [...arguments_], {
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    }, (error, _stdout, stderr) => {
      if (error) {
        reject(new Error(stderr.trim() || error.message, { cause: error }))
      } else {
        resolveRun()
      }
    })
  })
}

async function waitForGatewayHealth(
  socketPath: string,
  timeoutMs: number,
): Promise<GatewayAdminStatus> {
  const deadline = Date.now() + timeoutMs
  let lastError = 'Gateway admin socket is not ready'
  while (Date.now() < deadline) {
    try {
      const status = await new GatewayAdminClient({
        socketPath,
        timeoutMs: 2_000,
      }).status()
      if (status.state === 'running' && status.matrixReady === true) return status
      lastError = `Gateway reported ${status.state}; Matrix ready=${String(status.matrixReady)}`
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
    await new Promise(resolveDelay => setTimeout(resolveDelay, 500))
  }
  throw new Error(`Gateway journal was repaired, but live health did not recover: ${lastError}`)
}

function serviceMissing(error: unknown): boolean {
  return /could not find service|no such process|service is not loaded/iu.test(
    error instanceof Error ? error.message : String(error),
  )
}

function isEntry(moduleUrl: string, argvPath: string | undefined): boolean {
  return Boolean(argvPath && moduleUrl === pathToFileURL(resolve(argvPath)).href)
}

if (isEntry(import.meta.url, process.argv[1])) {
  await runGatewayJournalRepairCli(process.argv.slice(2))
    .then(result => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch(error => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
      process.exitCode = 1
    })
}
