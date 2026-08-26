import { createHash, randomUUID } from 'node:crypto'
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
} from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import {
  canonicalJson,
  canonicalJsonBytes,
  gatewayUpdateStatusSchema,
  signedGatewayReleaseManifestSchema,
  type GatewayReleaseManifest,
  type GatewayUpdateStatus,
  type PairingPublicKey,
  type SignedGatewayReleaseManifest,
} from '@malink/protocol'
import {
  base64UrlDecode,
  publicKeyId,
  toArrayBuffer,
  webCrypto,
} from '@malink/security'
import { AtomicJsonFile } from '@malink/security/node'
import {
  activateMacosGatewayRelease,
  validateMacosGatewayRelease,
  type MacosGatewayReleaseOptions,
} from './macosGatewayRelease.js'
import { GATEWAY_STATE_CATALOG } from '@/gateway/matrix/stateUpgradeCatalog'

interface GatewayUpdateSupervisorState {
  version: 1
  status: GatewayUpdateStatus
  staged?: SignedGatewayReleaseManifest
  previousTarget?: string
  scheduledAt?: number
}

export interface GatewayUpdateSupervisorConfig {
  installRoot: string
  manifestBaseUrl: string
  trustedSigner: PairingPublicKey
  launchAgentPath: string
  serviceLabel: string
  gatewayAdminSocketPath: string
  currentBuildId?: string
  activationDelayMs?: number
  healthTimeoutMs?: number
  probationMs?: number
  syncFreshnessMs?: number
  manifestFetchTimeoutMs?: number
  fileFetchTimeoutMs?: number
}

export interface GatewayUpdateSupervisorDependencies {
  fetch?: typeof fetch
  now?: () => number
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>
  activate?: (options: MacosGatewayReleaseOptions) => Promise<void>
  onCommitted?: () => void | Promise<void>
  onLog?: (message: string) => void
}

export class GatewayUpdateSupervisor {
  private readonly installRoot: string
  private readonly releasesRoot: string
  private readonly stateFile: AtomicJsonFile<GatewayUpdateSupervisorState>
  private timer: ReturnType<typeof setTimeout> | null = null
  private activation: Promise<void> | null = null
  private requestChain: Promise<void> = Promise.resolve()

  constructor(
    private readonly config: GatewayUpdateSupervisorConfig,
    private readonly dependencies: GatewayUpdateSupervisorDependencies = {},
  ) {
    this.installRoot = resolve(config.installRoot)
    this.releasesRoot = join(this.installRoot, 'releases')
    this.stateFile = new AtomicJsonFile(join(this.installRoot, 'supervisor-state.json'))
    const manifestBase = new URL(config.manifestBaseUrl)
    if (
      (manifestBase.protocol !== 'https:' && !isLoopbackHttp(manifestBase))
      || manifestBase.username
      || manifestBase.password
      || manifestBase.search
      || manifestBase.hash
    ) {
      throw new Error('Gateway release manifest base must be credential-free HTTPS')
    }
  }

  async initialize(): Promise<void> {
    await mkdir(this.releasesRoot, { recursive: true, mode: 0o700 })
    const state = await this.readState()
    if (state.status.phase === 'scheduled' && state.scheduledAt !== undefined) {
      this.armActivation(state.scheduledAt)
      return
    }
    if (state.status.phase === 'activating' || state.status.phase === 'probation') {
      await this.recoverInterruptedActivation(state)
    }
  }

  async status(): Promise<GatewayUpdateStatus> {
    const installedBuildId = await this.installedBuildId()
    return this.stateFile.transaction(defaultState, state => {
      validateState(state)
      const changed = installedBuildId !== undefined
        && state.status.currentBuildId !== installedBuildId
        && ['idle', 'staging', 'staged', 'failed'].includes(state.status.phase)
      if (changed) state.status.currentBuildId = installedBuildId
      return { result: structuredClone(state.status), changed }
    })
  }

  async stage(releaseId: string): Promise<GatewayUpdateStatus> {
    return this.serializeRequest(() => this.stageOnce(releaseId))
  }

  private async stageOnce(releaseId: string): Promise<GatewayUpdateStatus> {
    requireReleaseId(releaseId)
    const current = await this.readState()
    if (
      current.status.releaseId === releaseId
      && ['staged', 'scheduled', 'activating', 'probation', 'committed']
        .includes(current.status.phase)
    ) {
      return structuredClone(current.status)
    }
    if (
      current.status.phase === 'scheduled'
      || current.status.phase === 'activating'
      || current.status.phase === 'probation'
    ) {
      throw new Error(`Cannot stage a release while update is ${current.status.phase}`)
    }
    const updateId = randomUUID()
    const currentBuildId = await this.installedBuildId()
    await this.writeState(state => {
      state.status = {
        version: 1,
        phase: 'staging',
        updateId,
        releaseId,
        ...(currentBuildId ? { currentBuildId } : {}),
        updatedAt: this.now(),
      }
    })
    try {
      const signed = await this.fetchAndVerifyManifest(releaseId)
      if (currentBuildId && signed.manifest.buildId === currentBuildId) {
        return await this.writeState(state => {
          state.staged = undefined
          state.status = {
            version: 1,
            phase: 'committed',
            updateId,
            releaseId,
            targetBuildId: signed.manifest.buildId,
            currentBuildId,
            updatedAt: this.now(),
          }
        })
      }
      await this.stageManifest(signed)
      return await this.writeState(state => {
        state.staged = signed
        state.status = {
          version: 1,
          phase: 'staged',
          updateId,
          releaseId,
          targetBuildId: signed.manifest.buildId,
          ...(currentBuildId ? { currentBuildId } : {}),
          updatedAt: this.now(),
        }
      })
    } catch (error) {
      await this.writeState(state => {
        state.status = {
          version: 1,
          phase: 'failed',
          updateId,
          releaseId,
          detail: statusDetail(error),
          ...(currentBuildId ? { currentBuildId } : {}),
          updatedAt: this.now(),
        }
      })
      throw error
    }
  }

  async scheduleApply(releaseId: string): Promise<GatewayUpdateStatus> {
    return this.serializeRequest(() => this.scheduleApplyOnce(releaseId))
  }

  private async scheduleApplyOnce(releaseId: string): Promise<GatewayUpdateStatus> {
    requireReleaseId(releaseId)
    const stagedState = await this.readState()
    if (
      stagedState.status.releaseId === releaseId
      && ['scheduled', 'activating', 'probation', 'committed']
        .includes(stagedState.status.phase)
    ) {
      return structuredClone(stagedState.status)
    }
    if (!stagedState.staged || stagedState.staged.manifest.releaseId !== releaseId) {
      throw new Error(`Gateway release ${releaseId} is not staged`)
    }
    if (stagedState.status.phase !== 'staged') {
      throw new Error(`Cannot schedule a release while update is ${stagedState.status.phase}`)
    }
    const stagedDirectory = join(this.releasesRoot, releaseId)
    const installedManifest = signedGatewayReleaseManifestSchema.parse(JSON.parse(await readFile(
      join(stagedDirectory, 'release-manifest.json'),
      'utf8',
    )))
    if (canonicalJson(installedManifest) !== canonicalJson(stagedState.staged)) {
      throw new Error(`Staged Gateway release ${releaseId} manifest changed after verification`)
    }
    await verifyStagedManifest(
      stagedDirectory,
      stagedState.staged.manifest,
    )
    const currentLink = join(this.installRoot, 'current')
    const previousTarget = await readlink(currentLink)
    const previousReleaseId = basename(resolve(dirname(currentLink), previousTarget))
    const currentBuildId = await this.installedBuildId()
    const scheduledAt = this.now() + (this.config.activationDelayMs ?? 5_000)
    const status = await this.writeState(state => {
      if (!state.staged || state.staged.manifest.releaseId !== releaseId) {
        throw new Error(`Gateway release ${releaseId} is not staged`)
      }
      if (state.status.phase !== 'staged') {
        throw new Error(`Cannot schedule a release while update is ${state.status.phase}`)
      }
      state.previousTarget = previousTarget
      state.scheduledAt = scheduledAt
      state.status = {
        version: 1,
        phase: 'scheduled',
        updateId: state.status.updateId ?? randomUUID(),
        releaseId,
        targetBuildId: state.staged.manifest.buildId,
        ...(currentBuildId ? { currentBuildId } : {}),
        previousReleaseId,
        updatedAt: this.now(),
      }
    })
    this.armActivation(scheduledAt)
    return status
  }

  async stop(): Promise<void> {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    await this.requestChain
    await this.activation
  }

  private armActivation(scheduledAt: number): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      const activation = this.activateScheduled()
      const tracked = activation.catch(error => {
        this.log(`[gateway-update] activation failed: ${formatError(error)}`)
      }).finally(() => {
        if (this.activation === tracked) this.activation = null
      })
      this.activation = tracked
    }, Math.max(0, scheduledAt - this.now()))
    this.timer.unref?.()
  }

  private async activateScheduled(): Promise<void> {
    const state = await this.readState()
    if (state.status.phase !== 'scheduled' || !state.staged) return
    const manifest = state.staged.manifest
    const previousReleaseId = state.status.previousReleaseId
    await this.writeState(current => {
      current.status = {
        ...current.status,
        phase: 'activating',
        updatedAt: this.now(),
      }
    })
    try {
      const activate = this.dependencies.activate ?? (options =>
        activateMacosGatewayRelease(options, {
          onActivated: async () => {
            await this.writeState(current => {
              current.status = {
                ...current.status,
                phase: 'probation',
                updatedAt: this.now(),
              }
            })
          },
        }))
      await activate({
        releaseDirectory: join(this.releasesRoot, manifest.releaseId),
        installRoot: this.installRoot,
        launchAgentPath: this.config.launchAgentPath,
        serviceLabel: this.config.serviceLabel,
        adminSocketPath: this.config.gatewayAdminSocketPath,
        healthTimeoutMs: this.config.healthTimeoutMs ?? 60_000,
        expectedBuildId: manifest.buildId,
        ...(state.status.currentBuildId
          ? { rollbackBuildId: state.status.currentBuildId }
          : {}),
        requireDeepHealth: true,
        syncFreshnessMs: this.config.syncFreshnessMs ?? 45_000,
        probationMs: this.config.probationMs ?? 60_000,
      })
      await this.writeState(current => {
        current.scheduledAt = undefined
        current.previousTarget = undefined
        current.status = {
          version: 1,
          phase: 'committed',
          updateId: state.status.updateId,
          releaseId: manifest.releaseId,
          targetBuildId: manifest.buildId,
          currentBuildId: manifest.buildId,
          ...(previousReleaseId ? { previousReleaseId } : {}),
          updatedAt: this.now(),
        }
      })
      await Promise.resolve(this.dependencies.onCommitted?.()).catch(error => {
        this.log(`[gateway-update] post-commit supervisor reload failed: ${formatError(error)}`)
      })
    } catch (error) {
      const rolledBack = /rolled back/iu.test(formatError(error))
      await this.writeState(current => {
        current.scheduledAt = undefined
        current.status = {
          ...current.status,
          phase: rolledBack ? 'rolled_back' : 'repair_required',
          detail: statusDetail(error),
          updatedAt: this.now(),
        }
      })
      throw error
    }
  }

  private async recoverInterruptedActivation(state: GatewayUpdateSupervisorState): Promise<void> {
    if (!state.previousTarget) {
      await this.writeState(current => {
        current.status = {
          ...current.status,
          phase: 'repair_required',
          detail: 'Supervisor restarted during activation without a previous release target',
          updatedAt: this.now(),
        }
      })
      return
    }
    const previousDirectory = resolve(dirname(join(this.installRoot, 'current')), state.previousTarget)
    try {
      await (this.dependencies.activate ?? (options => activateMacosGatewayRelease(options)))({
        releaseDirectory: previousDirectory,
        installRoot: this.installRoot,
        launchAgentPath: this.config.launchAgentPath,
        serviceLabel: this.config.serviceLabel,
        adminSocketPath: this.config.gatewayAdminSocketPath,
        healthTimeoutMs: this.config.healthTimeoutMs ?? 60_000,
        ...(state.status.currentBuildId
          ? { expectedBuildId: state.status.currentBuildId }
          : {}),
        requireDeepHealth: true,
        syncFreshnessMs: this.config.syncFreshnessMs ?? 45_000,
      })
      await this.writeState(current => {
        current.status = {
          ...current.status,
          phase: 'rolled_back',
          detail: 'Supervisor restarted during activation and restored the previous release',
          updatedAt: this.now(),
        }
      })
    } catch (error) {
      await this.writeState(current => {
        current.status = {
          ...current.status,
          phase: 'repair_required',
          detail: statusDetail(`Interrupted activation recovery failed: ${formatError(error)}`),
          updatedAt: this.now(),
        }
      })
    }
  }

  private async fetchAndVerifyManifest(releaseId: string): Promise<SignedGatewayReleaseManifest> {
    const base = new URL(this.config.manifestBaseUrl.endsWith('/')
      ? this.config.manifestBaseUrl
      : `${this.config.manifestBaseUrl}/`)
    const url = new URL(`${encodeURIComponent(releaseId)}.json`, base)
    if (url.origin !== base.origin) throw new Error('Gateway release manifest escaped its origin')
    const text = await withFetchTimeout(
      this.config.manifestFetchTimeoutMs ?? 30_000,
      'Gateway release manifest download',
      signal => this.retryTransientFetch('manifest download', signal, async () => {
        const response = await (this.dependencies.fetch ?? fetch)(url, {
          signal,
          headers: { 'accept-encoding': 'identity' },
        })
        if (response.url && new URL(response.url).origin !== base.origin) {
          throw new Error('Gateway release manifest redirected to an untrusted origin')
        }
        if (!response.ok) {
          throw fetchStatusError('Gateway release manifest', response.status)
        }
        return readBoundedText(response, 1024 * 1024, 'Gateway release manifest')
      }),
    )
    let input: unknown
    try {
      input = JSON.parse(text)
    } catch (error) {
      throw new Error('Gateway release manifest is invalid JSON', { cause: error })
    }
    const signed = signedGatewayReleaseManifestSchema.parse(input)
    if (signed.manifest.releaseId !== releaseId) {
      throw new Error('Gateway release manifest ID does not match the request')
    }
    await this.verifyManifest(signed)
    return signed
  }

  private async verifyManifest(signed: SignedGatewayReleaseManifest): Promise<void> {
    const trustedKeyId = await publicKeyId(this.config.trustedSigner.publicKey)
    if (
      signed.signer.keyId !== trustedKeyId
      || signed.signature.keyId !== trustedKeyId
      || canonicalJson(signed.signer) !== canonicalJson(this.config.trustedSigner)
    ) {
      throw new Error('Gateway release manifest signer is not trusted')
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
      toArrayBuffer(canonicalJsonBytes(signed.manifest)),
    )
    if (!verified) throw new Error('Gateway release manifest signature is invalid')
    if (signed.manifest.platform !== 'darwin' || signed.manifest.architecture !== process.arch) {
      throw new Error(
        `Gateway release targets ${signed.manifest.platform}/${signed.manifest.architecture}, `
        + `not ${process.platform}/${process.arch}`,
      )
    }
    const manifestOrigin = new URL(this.config.manifestBaseUrl).origin
    for (const file of signed.manifest.files) {
      if (new URL(file.url).origin !== manifestOrigin) {
        throw new Error(`Gateway release file ${file.path} uses an untrusted origin`)
      }
    }
    assertRollbackCompatibleState(signed.manifest)
  }

  private async stageManifest(signed: SignedGatewayReleaseManifest): Promise<void> {
    const manifest = signed.manifest
    const destination = join(this.releasesRoot, manifest.releaseId)
    try {
      const current = signedGatewayReleaseManifestSchema.parse(JSON.parse(
        await readFile(join(destination, 'release-manifest.json'), 'utf8'),
      ))
      if (canonicalJson(current) !== canonicalJson(signed)) {
        throw new Error(`Installed Gateway release ${manifest.releaseId} is immutable`)
      }
      await verifyStagedManifest(destination, manifest)
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }

    const temporary = await mkdtemp(join(this.releasesRoot, `.stage-${manifest.releaseId}-`))
    try {
      for (const file of manifest.files) await this.downloadFile(file, temporary)
      await writeDurableFile(
        join(temporary, 'release-manifest.json'),
        `${JSON.stringify(signed)}\n`,
      )
      await verifyStagedManifest(temporary, manifest)
      await rename(temporary, destination)
      await syncDirectory(this.releasesRoot)
    } catch (error) {
      await rm(temporary, { recursive: true, force: true })
      throw error
    }
  }

  private async downloadFile(
    file: GatewayReleaseManifest['files'][number],
    root: string,
  ): Promise<void> {
    const destination = join(root, file.path)
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
    await withFetchTimeout(
      this.config.fileFetchTimeoutMs ?? 10 * 60_000,
      `Gateway release file ${file.path} download`,
      signal => this.retryTransientFetch(`file ${file.path} download`, signal, async () => {
        await rm(destination, { force: true })
        try {
          const response = await (this.dependencies.fetch ?? fetch)(file.url, {
            signal,
            headers: { 'accept-encoding': 'identity' },
          })
          if (response.url && new URL(response.url).origin !== new URL(file.url).origin) {
            throw new Error(`Gateway release file ${file.path} redirected to an untrusted origin`)
          }
          if (!response.ok) {
            throw fetchStatusError(`Gateway release file ${file.path}`, response.status)
          }
          if (!response.body) {
            throw new RetryableGatewayUpdateFetchError(
              `Gateway release file ${file.path} has no response body`,
            )
          }
          const advertisedLength = response.headers.get('content-length')
          const contentEncoding = response.headers.get('content-encoding')?.trim().toLowerCase()
          if (
            advertisedLength !== null
            && (!contentEncoding || contentEncoding === 'identity')
            && Number(advertisedLength) !== file.size
          ) {
            throw new RetryableGatewayUpdateFetchError(
              `Gateway release file ${file.path} has an unexpected length`,
            )
          }
          const handle = await open(destination, 'wx', 0o600)
          const reader = response.body.getReader()
          const hash = createHash('sha256')
          let bytes = 0
          try {
            while (true) {
              const { done, value } = await reader.read()
              if (done) break
              bytes += value.byteLength
              if (bytes > file.size) {
                throw new RetryableGatewayUpdateFetchError(
                  `Gateway release file ${file.path} is oversized`,
                )
              }
              hash.update(value)
              await writeAll(handle, value)
            }
            await handle.sync()
          } catch (error) {
            await reader.cancel().catch(() => undefined)
            throw error
          } finally {
            await handle.close()
            reader.releaseLock()
          }
          if (bytes !== file.size || hash.digest('hex') !== file.sha256) {
            throw new RetryableGatewayUpdateFetchError(
              `Gateway release file ${file.path} failed integrity verification`,
            )
          }
        } catch (error) {
          await rm(destination, { force: true })
          throw error
        }
      }),
    )
    await chmod(destination, file.executable ? 0o755 : 0o600)
  }

  private async retryTransientFetch<T>(
    label: string,
    signal: AbortSignal,
    operation: () => Promise<T>,
  ): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await operation()
      } catch (error) {
        if (
          signal.aborted
          || attempt >= 4
          || !isTransientGatewayUpdateFetchError(error)
        ) {
          throw error
        }
        const retryAfterMs = transientRetryDelay(attempt)
        this.log(
          `[gateway-update] ${label} failed transiently; `
          + `retrying in ${retryAfterMs}ms: ${formatError(error)}`,
        )
        await (this.dependencies.sleep ?? wait)(retryAfterMs, signal)
      }
    }
  }

  private readState(): Promise<GatewayUpdateSupervisorState> {
    return this.stateFile.transaction(defaultState, state => {
      validateState(state)
      return { result: structuredClone(state), changed: false }
    })
  }

  private writeState(
    mutate: (state: GatewayUpdateSupervisorState) => void,
  ): Promise<GatewayUpdateStatus> {
    return this.stateFile.transaction(defaultState, state => {
      validateState(state)
      mutate(state)
      validateState(state)
      return { result: structuredClone(state.status), changed: true }
    })
  }

  private now(): number {
    return this.dependencies.now?.() ?? Date.now()
  }

  private serializeRequest<T>(operation: () => Promise<T>): Promise<T> {
    const running = this.requestChain.then(operation, operation)
    this.requestChain = running.then(() => undefined, () => undefined)
    return running
  }

  private async installedBuildId(): Promise<string | undefined> {
    try {
      const signed = signedGatewayReleaseManifestSchema.parse(JSON.parse(await readFile(
        join(this.installRoot, 'current', 'release-manifest.json'),
        'utf8',
      )))
      return signed.manifest.buildId
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return this.config.currentBuildId
      throw new Error('The active Gateway release manifest is invalid', { cause: error })
    }
  }

  private log(message: string): void {
    this.dependencies.onLog?.(message)
  }
}

async function verifyStagedManifest(
  releaseDirectory: string,
  manifest: GatewayReleaseManifest,
): Promise<void> {
  await validateMacosGatewayRelease(releaseDirectory)
  const expected = new Map(manifest.files.map(file => [file.path, file]))
  const observed = new Set<string>()
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name)
      const path = relative(releaseDirectory, absolute).split(sep).join('/')
      if (entry.isSymbolicLink()) {
        throw new Error(`Staged Gateway release contains a symbolic link: ${path}`)
      }
      if (entry.isDirectory()) {
        const ownsExpectedFile = [...expected.keys()].some(candidate =>
          candidate.startsWith(`${path}/`))
        if (!ownsExpectedFile) {
          throw new Error(`Staged Gateway release contains an unexpected directory: ${path}`)
        }
        await visit(absolute)
        continue
      }
      if (!entry.isFile()) {
        throw new Error(`Staged Gateway release contains a non-regular file: ${path}`)
      }
      if (path === 'release-manifest.json') continue
      const file = expected.get(path)
      if (!file) throw new Error(`Staged Gateway release contains an unexpected file: ${path}`)
      const metadata = await lstat(absolute)
      if (metadata.size !== file.size) {
        throw new Error(`Staged Gateway release file ${path} has an unexpected size`)
      }
      if (file.executable === true && (metadata.mode & 0o111) === 0) {
        throw new Error(`Staged Gateway release file ${path} is not executable`)
      }
      if (await hashFile(absolute) !== file.sha256) {
        throw new Error(`Staged Gateway release file ${path} failed integrity verification`)
      }
      observed.add(path)
    }
  }
  await visit(releaseDirectory)
  for (const path of expected.keys()) {
    if (!observed.has(path)) throw new Error(`Staged Gateway release is missing file ${path}`)
  }
}

function hashFile(path: string): Promise<string> {
  return new Promise((resolveHash, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.once('error', reject)
    stream.on('data', chunk => hash.update(chunk))
    stream.once('end', () => resolveHash(hash.digest('hex')))
  })
}

async function withFetchTimeout<T>(
  timeoutMs: number,
  label: string,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError(`${label} timeout must be positive`)
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  timer.unref?.()
  try {
    return await operation(controller.signal)
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`${label} timed out after ${timeoutMs}ms`)
    throw error
  } finally {
    clearTimeout(timer)
  }
}

class RetryableGatewayUpdateFetchError extends Error {}

function fetchStatusError(label: string, status: number): Error {
  const message = `${label} returned HTTP ${status}`
  return status === 408 || status === 425 || status === 429 || status >= 500
    ? new RetryableGatewayUpdateFetchError(message)
    : new Error(message)
}

function isTransientGatewayUpdateFetchError(error: unknown): boolean {
  return error instanceof RetryableGatewayUpdateFetchError
    || error instanceof TypeError
    || (error instanceof DOMException
      && (error.name === 'AbortError'
        || error.name === 'NetworkError'
        || error.name === 'TimeoutError'))
}

function transientRetryDelay(attempt: number): number {
  return Math.min(4_000, 250 * (2 ** attempt))
}

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolveWait, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new DOMException('The operation was aborted', 'AbortError'))
      return
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolveWait()
    }, milliseconds)
    timer.unref?.()
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(signal.reason ?? new DOMException('The operation was aborted', 'AbortError'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function defaultState(): GatewayUpdateSupervisorState {
  return {
    version: 1,
    status: { version: 1, phase: 'idle', updatedAt: 0 },
  }
}

function validateState(state: GatewayUpdateSupervisorState): void {
  if (state.version !== 1) throw new Error('Unsupported Gateway update supervisor state')
  gatewayUpdateStatusSchema.parse(state.status)
  if (state.staged) signedGatewayReleaseManifestSchema.parse(state.staged)
  if (state.previousTarget !== undefined && !state.previousTarget) {
    throw new Error('Gateway update supervisor previous target is invalid')
  }
  if (state.scheduledAt !== undefined && !Number.isSafeInteger(state.scheduledAt)) {
    throw new Error('Gateway update supervisor schedule is invalid')
  }
}

function assertRollbackCompatibleState(manifest: GatewayReleaseManifest): void {
  const currentCatalog = new Map(GATEWAY_STATE_CATALOG.map(entry => [entry.id, entry]))
  const target = new Map(manifest.stateCatalog.map(entry => [entry.id, entry]))
  for (const current of GATEWAY_STATE_CATALOG) {
    const next = target.get(current.id)
    if (!next) throw new Error(`Gateway release omits persistent state ${current.id}`)
    if (next.stateClass !== current.stateClass) {
      throw new Error(`Gateway release changes the safety class of ${current.id}`)
    }
    if (
      (current.stateClass === 'security-critical' || current.stateClass === 'durable-command')
      && next.schemaVersion !== current.schemaVersion
    ) {
      throw new Error(
        `Gateway release changes protected state ${current.id} from schema `
        + `${current.schemaVersion} to ${next.schemaVersion}; automatic rollback is unsafe`,
      )
    }
  }
  for (const next of manifest.stateCatalog) {
    if (currentCatalog.has(next.id)) continue
    if (next.stateClass === 'security-critical' || next.stateClass === 'durable-command') {
      throw new Error(
        `Gateway release introduces protected state ${next.id}; automatic rollback is unsafe`,
      )
    }
  }
}

function requireReleaseId(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value)) {
    throw new Error('Gateway release ID is invalid')
  }
}

function isLoopbackHttp(url: URL): boolean {
  return url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost')
}

async function readBoundedText(
  response: Response,
  maximumBytes: number,
  label: string,
): Promise<string> {
  const advertisedLength = response.headers.get('content-length')
  if (advertisedLength !== null && Number(advertisedLength) > maximumBytes) {
    throw new Error(`${label} exceeds ${maximumBytes} bytes`)
  }
  if (!response.body) throw new Error(`${label} has no response body`)
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > maximumBytes) throw new Error(`${label} exceeds ${maximumBytes} bytes`)
      chunks.push(value)
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined)
    throw error
  } finally {
    reader.releaseLock()
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
}

async function writeAll(
  handle: import('node:fs/promises').FileHandle,
  value: Uint8Array,
): Promise<void> {
  let offset = 0
  while (offset < value.byteLength) {
    const { bytesWritten } = await handle.write(value, offset, value.byteLength - offset)
    if (bytesWritten < 1) throw new Error('Gateway release file write made no progress')
    offset += bytesWritten
  }
}

async function writeDurableFile(path: string, content: string): Promise<void> {
  const handle = await open(path, 'wx', 0o600)
  try {
    await writeAll(handle, new TextEncoder().encode(content))
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function statusDetail(error: unknown): string {
  return formatError(error).slice(0, 4_096) || 'Gateway update failed'
}
