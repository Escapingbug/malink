import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  canonicalJson,
  canonicalJsonBytes,
  pairingPublicKeySchema,
  signedGatewayAgentUpdatePromptSchema,
  type PairingPublicKey,
  type SignedGatewayAgentUpdatePrompt,
} from '@malink/protocol'
import {
  base64UrlDecode,
  publicKeyId,
  toArrayBuffer,
  webCrypto,
} from '@malink/security'
import { createGatewayForwardOnlyBackup } from '../src/ops/gatewayForwardOnlyBackup.js'
import { activateMacosGatewayRelease } from '../src/ops/macosGatewayRelease.js'
import { GatewayAdminClient } from '../src/gateway/admin/client.js'
import type { GatewayAdminStatus } from '../src/gateway/admin/types.js'
import { GatewayUpdateSupervisorClient } from '../src/ops/gatewayUpdateSupervisorServer.js'
import { GATEWAY_STATE_CATALOG } from '../src/gateway/matrix/stateUpgradeCatalog.js'

const DEFAULT_IDLE_TIMEOUT_MS = 15 * 60_000
const DEFAULT_IDLE_SAMPLE_INTERVAL_MS = 1_000
const DEFAULT_IDLE_STABLE_SAMPLES = 3

/**
 * Local, external bootstrap for a Gateway release that changes protected state.
 * The Gateway is stopped before a verified backup is taken. Once the target may
 * have opened the state, this command never starts the previous binary.
 */
export async function runMacosGatewayForwardUpdate(): Promise<void> {
  if (process.platform !== 'darwin') {
    throw new Error('Gateway forward-only update requires macOS')
  }
  const installRoot = resolve(requiredArgument('install-root'))
  const candidateDirectory = resolve(requiredArgument('release'))
  const dataDirectory = resolve(requiredArgument('data-dir'))
  const signedPrompt = await verifySignedPrompt(
    resolve(requiredArgument('prompt-file')),
    resolve(optionalArgument('signer-file') ?? join(installRoot, 'release-signer.json')),
  )
  const releaseId = signedPrompt.update.releaseId
  const targetBuildId = signedPrompt.update.buildId
  const currentBuildId = optionalArgument('current-build-id')
  if ((currentBuildId?.length ?? 0) > 256) {
    throw new Error('Gateway build ID is invalid')
  }
  assertOptionalMatch('release-id', releaseId)
  assertOptionalMatch('target-build-id', targetBuildId)
  await verifyTargetCheckoutAndBundles(candidateDirectory, signedPrompt)
  const releaseDirectory = await stagePreparedRelease(
    candidateDirectory,
    installRoot,
    signedPrompt,
  )
  const supervisorServiceLabel = requiredArgument('supervisor-service-label')
  const supervisorSocket = resolve(
    optionalArgument('supervisor-socket') ?? join(installRoot, 'update-supervisor.sock'),
  )
  const previousTarget = await readlink(join(installRoot, 'current'))
  let backupPath: string | undefined

  await waitForGatewayForwardUpdateIdle({
    adminSocketPath: resolve(requiredArgument('admin-socket')),
    ...(currentBuildId ? { expectedBuildId: currentBuildId } : {}),
    timeoutMs: optionalNumberArgument('idle-timeout-ms') ?? DEFAULT_IDLE_TIMEOUT_MS,
    syncFreshnessMs: optionalNumberArgument('sync-freshness-ms') ?? 45_000,
  })
  process.stdout.write('Gateway remained fully idle and Matrix-synchronized; starting activation.\n')

  await activateMacosGatewayRelease({
    releaseDirectory,
    installRoot,
    launchAgentPath: resolve(requiredArgument('launch-agent')),
    serviceLabel: requiredArgument('service-label'),
    adminSocketPath: resolve(requiredArgument('admin-socket')),
    expectedBuildId: targetBuildId,
    rollbackBuildId: currentBuildId,
    requireDeepHealth: true,
    healthTimeoutMs: optionalNumberArgument('health-timeout-ms') ?? 180_000,
    // Keep the offline/manual recovery path consistent with the supervisor:
    // callers may explicitly request a stability trial, but it is never an
    // implicit cost of activation.
    probationMs: optionalNumberArgument('probation-ms') ?? 0,
    syncFreshnessMs: optionalNumberArgument('sync-freshness-ms') ?? 45_000,
    rollbackMode: 'disabled',
    onGatewayStopped: async () => {
      backupPath = await createGatewayForwardOnlyBackup({
        dataDirectory,
        installRoot,
        releaseId,
        targetBuildId,
        ...(currentBuildId ? { currentBuildId } : {}),
        previousTarget,
        createdAt: Date.now(),
      })
      process.stdout.write(`Verified stopped-state backup: ${backupPath}\n`)
    },
  })

  await kickstartLaunchAgent(supervisorServiceLabel)
  await reconcileSupervisor(supervisorSocket, releaseId, targetBuildId)
  process.stdout.write(
    `Matrix Gateway ${targetBuildId} is healthy; the new supervisor records the release as committed.\n`
    + `Forward-only backup retained at ${backupPath ?? '(unavailable)'}.\n`,
  )
}

export interface GatewayForwardUpdateIdleOptions {
  adminSocketPath: string
  expectedBuildId?: string
  timeoutMs?: number
  syncFreshnessMs?: number
  stableSamples?: number
  sampleIntervalMs?: number
}

export interface GatewayForwardUpdateIdleDependencies {
  status?: () => Promise<GatewayAdminStatus>
  now?: () => number
  sleep?: (milliseconds: number) => Promise<void>
}

/**
 * Re-checks quiescence after the slow candidate verification and staging work.
 * The stable runtime identity requirement prevents samples from straddling an
 * unrelated Gateway restart. Activation follows immediately after this gate,
 * and SIGTERM closes the Gateway's command execution gate before shutdown.
 */
export async function waitForGatewayForwardUpdateIdle(
  options: GatewayForwardUpdateIdleOptions,
  dependencies: GatewayForwardUpdateIdleDependencies = {},
): Promise<GatewayAdminStatus> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS
  const syncFreshnessMs = options.syncFreshnessMs ?? 45_000
  const stableSamples = options.stableSamples ?? DEFAULT_IDLE_STABLE_SAMPLES
  const sampleIntervalMs = options.sampleIntervalMs ?? DEFAULT_IDLE_SAMPLE_INTERVAL_MS
  for (const [name, value, minimum] of [
    ['timeout', timeoutMs, 0],
    ['sync freshness', syncFreshnessMs, 0],
    ['stable samples', stableSamples, 1],
    ['sample interval', sampleIntervalMs, 0],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < minimum) {
      throw new Error(`Gateway forward-update ${name} is invalid`)
    }
  }
  const now = dependencies.now ?? Date.now
  const sleep = dependencies.sleep ?? (milliseconds =>
    new Promise(resolveDelay => setTimeout(resolveDelay, milliseconds)))
  const readStatus = dependencies.status ?? (() => new GatewayAdminClient({
    socketPath: options.adminSocketPath,
    timeoutMs: 5_000,
  }).status())
  const deadline = now() + timeoutMs
  let consecutive = 0
  let runtimeIdentity: string | null = null
  let lastReason = 'Gateway status was not sampled'

  while (true) {
    let status: GatewayAdminStatus | null = null
    try {
      status = await readStatus()
    } catch (error) {
      consecutive = 0
      runtimeIdentity = null
      lastReason = formatError(error)
    }
    if (status) {
      if (options.expectedBuildId && status.buildId !== options.expectedBuildId) {
        throw new Error(
          `Gateway build changed to ${status.buildId ?? '(missing)'} while waiting; `
          + `expected ${options.expectedBuildId}`,
        )
      }
      const reason = gatewayForwardUpdateBusyReason(status, now(), syncFreshnessMs)
      const identity = `${status.pid}\0${status.runtimeEpoch ?? ''}`
      if (reason === null) {
        if (identity !== runtimeIdentity) {
          runtimeIdentity = identity
          consecutive = 1
        } else {
          consecutive += 1
        }
        if (consecutive >= stableSamples) return status
        lastReason = `Gateway idle sample ${consecutive}/${stableSamples}`
      } else {
        consecutive = 0
        runtimeIdentity = identity
        lastReason = reason
      }
    }
    if (now() >= deadline) {
      throw new Error(
        `Gateway did not reach a stable idle checkpoint within ${timeoutMs}ms: ${lastReason}`,
      )
    }
    await sleep(Math.min(sampleIntervalMs, Math.max(0, deadline - now())))
  }
}

function gatewayForwardUpdateBusyReason(
  status: GatewayAdminStatus,
  now: number,
  syncFreshnessMs: number,
): string | null {
  if (status.state !== 'running') return `Gateway reported ${status.state}`
  if (!status.runtimeEpoch) return 'Gateway runtime epoch diagnostics are unavailable'
  for (const [label, value] of [
    ['active Agent turns', status.activeTurns],
    ['active commands', status.activeCommands],
    ['unfinished journal commands', status.unfinishedCommands],
    ['pending Matrix outbox deliveries', status.pendingOutboxDeliveries],
    ['pending Matrix inbox events', status.pendingInboxEvents],
  ] as const) {
    if (typeof value !== 'number') return `${label} diagnostics are unavailable`
    if (value !== 0) return `${label}: ${value}`
  }
  if (status.matrixReady !== true) return 'Gateway Matrix synchronization is not ready'
  if (typeof status.lastMatrixSyncAt !== 'number') {
    return 'Gateway Matrix synchronization timestamp is unavailable'
  }
  const syncAgeMs = Math.max(0, now - status.lastMatrixSyncAt)
  if (syncAgeMs > syncFreshnessMs) {
    return `Gateway Matrix synchronization is stale by ${syncAgeMs}ms`
  }
  return null
}

async function stagePreparedRelease(
  source: string,
  installRoot: string,
  signed: SignedGatewayAgentUpdatePrompt,
): Promise<string> {
  const releasesRoot = join(installRoot, 'releases')
  const destination = join(releasesRoot, signed.update.releaseId)
  await mkdir(releasesRoot, { recursive: true, mode: 0o700 })
  await assertRegularReleaseTree(source)
  if (source === destination) {
    await installVerifiedPrompt(destination, signed)
    return destination
  }
  try {
    await lstat(destination)
    throw new Error(
      `Immutable Gateway release already exists at ${destination}; `
      + 'pass that exact path as --release to resume it',
    )
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const temporary = await mkdtemp(join(releasesRoot, `.forward-${signed.update.releaseId}-`))
  try {
    let fileCount = 0
    let totalBytes = 0
    const visit = async (sourceDirectory: string, targetDirectory: string): Promise<void> => {
      for (const entry of await readdir(sourceDirectory, { withFileTypes: true })) {
        const sourcePath = join(sourceDirectory, entry.name)
        const targetPath = join(targetDirectory, entry.name)
        const path = relative(source, sourcePath).split(sep).join('/')
        const metadata = await lstat(sourcePath)
        if (metadata.isSymbolicLink()) {
          throw new Error(`Prepared Gateway candidate contains a symbolic link: ${path}`)
        }
        if (metadata.isDirectory()) {
          await mkdir(targetPath, { mode: metadata.mode & 0o777 })
          await visit(sourcePath, targetPath)
          continue
        }
        if (!metadata.isFile()) {
          throw new Error(`Prepared Gateway candidate contains a special file: ${path}`)
        }
        fileCount += 1
        totalBytes += metadata.size
        if (fileCount > 10_000 || totalBytes > 1024 * 1024 * 1024) {
          throw new Error('Prepared Gateway candidate exceeds the release size limit')
        }
        await copyFile(sourcePath, targetPath)
        await chmod(targetPath, metadata.mode & 0o777)
      }
    }
    await visit(source, temporary)
    await installVerifiedPrompt(temporary, signed)
    await rename(temporary, destination)
    return destination
  } catch (error) {
    await rm(temporary, { recursive: true, force: true })
    throw error
  }
}

async function assertRegularReleaseTree(root: string): Promise<void> {
  let fileCount = 0
  let totalBytes = 0
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name)
      const path = relative(root, absolute).split(sep).join('/')
      const metadata = await lstat(absolute)
      if (metadata.isSymbolicLink()) {
        throw new Error(`Prepared Gateway candidate contains a symbolic link: ${path}`)
      }
      if (metadata.isDirectory()) {
        await visit(absolute)
        continue
      }
      if (!metadata.isFile()) {
        throw new Error(`Prepared Gateway candidate contains a special file: ${path}`)
      }
      fileCount += 1
      totalBytes += metadata.size
      if (fileCount > 10_000 || totalBytes > 1024 * 1024 * 1024) {
        throw new Error('Prepared Gateway candidate exceeds the release size limit')
      }
    }
  }
  await visit(root)
}

async function verifyTargetCheckoutAndBundles(
  releaseDirectory: string,
  signed: SignedGatewayAgentUpdatePrompt,
): Promise<void> {
  const expectedCatalog = GATEWAY_STATE_CATALOG.map(({ id, stateClass, schemaVersion }) => ({
    id,
    stateClass,
    schemaVersion,
  }))
  if (canonicalJson(signed.update.stateCatalog) !== canonicalJson(expectedCatalog)) {
    throw new Error('Signed Gateway Prompt state catalog does not match this target checkout')
  }
  const head = await capture('/usr/bin/git', ['rev-parse', 'HEAD'])
  if (head.trim() !== signed.update.repository.commit) {
    throw new Error('Target checkout does not match the signed Gateway Prompt commit')
  }
  const dirty = await capture('/usr/bin/git', ['status', '--porcelain', '--untracked-files=no'])
  if (dirty.trim()) throw new Error('Target checkout has tracked local changes')
  for (const [built, candidate] of [
    ['dist/ops/matrix-local-gateway.js', 'ops/matrix-local-gateway.js'],
    ['dist/ops/gatewayUpdateSupervisorMain.js', 'ops/gatewayUpdateSupervisorMain.js'],
    ['dist/ops/gatewayAgentUpdateCli.js', 'ops/gatewayAgentUpdateCli.js'],
    ['dist/ops/gatewayJournalRepairCli.js', 'ops/gatewayJournalRepairCli.js'],
    ['dist/mcp/stdio.js', 'mcp/stdio.js'],
  ] as const) {
    const [builtBytes, candidateBytes] = await Promise.all([
      readFile(resolve(built)),
      readFile(join(releaseDirectory, ...candidate.split('/'))),
    ])
    if (!builtBytes.equals(candidateBytes)) {
      throw new Error(`Prepared Gateway candidate does not contain target bundle ${candidate}`)
    }
  }
}

async function verifySignedPrompt(
  promptFile: string,
  signerFile: string,
): Promise<SignedGatewayAgentUpdatePrompt> {
  const [signed, trustedSigner] = await Promise.all([
    readFile(promptFile, 'utf8').then(value =>
      signedGatewayAgentUpdatePromptSchema.parse(JSON.parse(value))),
    readFile(signerFile, 'utf8').then(value =>
      pairingPublicKeySchema.parse(JSON.parse(value))),
  ])
  await verifyPromptSigner(signed, trustedSigner)
  return signed
}

async function verifyPromptSigner(
  signed: SignedGatewayAgentUpdatePrompt,
  trustedSigner: PairingPublicKey,
): Promise<void> {
  const trustedKeyId = await publicKeyId(trustedSigner.publicKey)
  if (
    signed.signer.keyId !== trustedKeyId
    || signed.signature.keyId !== trustedKeyId
    || canonicalJson(signed.signer) !== canonicalJson(trustedSigner)
  ) {
    throw new Error('Gateway Agent update Prompt signer is not trusted')
  }
  const key = await webCrypto().subtle.importKey(
    'jwk',
    signed.signer.publicKey,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify'],
  )
  const verified = await webCrypto().subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    toArrayBuffer(base64UrlDecode(signed.signature.value)),
    toArrayBuffer(canonicalJsonBytes(signed.update)),
  )
  if (!verified) throw new Error('Gateway Agent update Prompt signature is invalid')
}

async function installVerifiedPrompt(
  releaseDirectory: string,
  signed: SignedGatewayAgentUpdatePrompt,
): Promise<void> {
  const destination = join(releaseDirectory, 'release-prompt.json')
  const content = `${JSON.stringify(signed)}\n`
  try {
    const existing = signedGatewayAgentUpdatePromptSchema.parse(JSON.parse(await readFile(
      destination,
      'utf8',
    )))
    if (canonicalJson(existing) !== canonicalJson(signed)) {
      throw new Error('Prepared Gateway candidate contains different release metadata')
    }
    return
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const temporary = `${destination}.next.${process.pid}.${randomUUID()}`
  await writeFile(temporary, content, { mode: 0o600, flag: 'wx' })
  try {
    await rename(temporary, destination)
  } finally {
    await rm(temporary, { force: true })
  }
}

function assertOptionalMatch(name: string, expected: string): void {
  const value = optionalArgument(name)
  if (value !== undefined && value !== expected) {
    throw new Error(`--${name} does not match the signed Gateway update Prompt`)
  }
}

async function reconcileSupervisor(
  socketPath: string,
  releaseId: string,
  targetBuildId: string,
): Promise<void> {
  const deadline = Date.now() + 30_000
  let lastError: unknown = new Error('The restarted update supervisor did not answer')
  while (Date.now() < deadline) {
    let status
    try {
      status = await new GatewayUpdateSupervisorClient(socketPath, 5_000).stage(releaseId)
    } catch (error) {
      const response = error as { commandCode?: unknown; retryable?: unknown }
      if (typeof response.commandCode === 'string' && response.retryable !== true) throw error
      lastError = error
      await new Promise(resolveDelay => setTimeout(resolveDelay, 250))
      continue
    }
    if (
      status.phase !== 'committed'
      || status.currentBuildId !== targetBuildId
      || status.targetBuildId !== targetBuildId
    ) {
      throw new Error(
        `Update supervisor reported ${status.phase} for build `
        + `${status.currentBuildId ?? '(missing)'}`,
      )
    }
    return
  }
  throw new Error(
    `Gateway is healthy, but the restarted update supervisor did not record the commit: `
    + `${formatError(lastError)}`,
    { cause: lastError },
  )
}

function requiredArgument(name: string): string {
  const value = optionalArgument(name)
  if (!value) throw new Error(`Missing --${name}`)
  return value
}

function optionalArgument(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  const value = index >= 0 ? process.argv[index + 1]?.trim() : undefined
  return value || undefined
}

function optionalNumberArgument(name: string): number | undefined {
  const value = optionalArgument(name)
  if (value === undefined) return undefined
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`--${name} is invalid`)
  return parsed
}

async function kickstartLaunchAgent(label: string): Promise<void> {
  const service = `gui/${process.getuid?.() ?? 0}/${label}`
  await new Promise<void>((resolveRun, reject) => {
    const child = spawn('/bin/launchctl', ['kickstart', '-k', service], {
      stdio: ['ignore', 'inherit', 'inherit'],
    })
    child.once('error', reject)
    child.once('exit', code => {
      if (code === 0) resolveRun()
      else reject(new Error(`launchctl kickstart ${service} exited with status ${code ?? 'unknown'}`))
    })
  })
}

function capture(command: string, arguments_: readonly string[]): Promise<string> {
  return new Promise((resolveCapture, reject) => {
    const child = spawn(command, arguments_, { stdio: ['ignore', 'pipe', 'pipe'] })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
    child.once('error', reject)
    child.once('exit', code => {
      if (code === 0) resolveCapture(Buffer.concat(stdout).toString('utf8'))
      else reject(new Error(
        `${command} exited with status ${code ?? 'unknown'}: `
        + `${Buffer.concat(stderr).toString('utf8').trim()}`,
      ))
    })
  })
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runMacosGatewayForwardUpdate()
}
