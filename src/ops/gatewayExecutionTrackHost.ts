import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { GatewayExecutionTrackHost } from './gatewayExecutionTracks'

export interface GatewayTrackRelease {
  releaseId: string
  buildId: string
  executable: string
  arguments: string[]
  cwd: string
  environment: NodeJS.ProcessEnv
}

export interface GatewayTrackHealth {
  buildId: string
  gatewayNodeId: string
  matrixReady: boolean
  deploymentFenced: boolean
}

export interface GatewayTrackProcessDependencies {
  /** Resolve only admitted, immutable releases; must not download or mutate business state. */
  resolveRelease(releaseId: string): Promise<GatewayTrackRelease>
  /** Check the retained reader and selected writer against the current state catalog. */
  validateCompatibility(releaseId: string, dataDirectory: string): Promise<void>
  readHealth(): Promise<GatewayTrackHealth>
  /** Drain commands, flush stores and settle Agent execution before returning. */
  drain(releaseId: string): Promise<void>
  log(message: string): void
  timeoutMs?: number
  drainTimeoutMs?: number
}

/**
 * Process adapter for a stable Host owner. Never adopts a PID from disk or
 * changes data directories. On owner restart, callers must reconcile existing
 * launchd services before creating this adapter. It is not a second launchd
 * recovery authority.
 */
export class GatewayExecutionTrackProcessHost implements GatewayExecutionTrackHost {
  private readonly children = new Map<string, ChildProcess>()
  private readonly admitted = new Map<string, GatewayTrackRelease>()
  private readonly failures = new Map<string, string>()
  private readonly drains = new Map<string, Promise<void>>()
  private readonly timeoutMs: number
  private readonly dataDirectory: string

  constructor(dataDirectory: string, private readonly dependencies: GatewayTrackProcessDependencies) {
    this.dataDirectory = resolve(dataDirectory)
    this.timeoutMs = dependencies.timeoutMs ?? 30_000
  }

  async validateRelease(releaseId: string, dataDirectory: string): Promise<void> {
    this.requireDirectory(dataDirectory)
    const release = await bounded(this.dependencies.resolveRelease(releaseId), this.timeoutMs, 'Release admission')
    if (release.releaseId !== releaseId || !release.buildId || !release.executable.startsWith('/')) {
      throw new Error('Release admission returned a mismatched or unpinned executable')
    }
    await bounded(this.dependencies.validateCompatibility(releaseId, this.dataDirectory), this.timeoutMs, 'State compatibility check')
    this.admitted.set(releaseId, release)
  }

  async ensureStandby(releaseId: string): Promise<void> {
    // Standby is controlled by the stable Host, not a second business runtime.
    // The release stays admitted and callable without opening stores or Matrix.
    await this.validateRelease(releaseId, this.dataDirectory)
  }

  async activate(releaseId: string, dataDirectory: string, gatewayNodeId: string): Promise<void> {
    this.requireDirectory(dataDirectory)
    if (this.drains.size > 0) throw new Error('Previous execution drain has not settled')
    const existing = this.children.get(releaseId)
    if (existing && existing.exitCode === null && existing.signalCode === null) return
    for (const [id, child] of this.children) {
      if (child.exitCode === null && child.signalCode === null) {
        throw new Error(`Release ${id} has not released execution`)
      }
    }
    const release = this.admitted.get(releaseId)
    if (!release) throw new Error('Selected release has not passed admission')
    this.failures.delete(releaseId)
    const child = spawn(release.executable, release.arguments, {
      cwd: release.cwd,
      env: { ...release.environment, MALINK_MATRIX_DATA_DIR: this.dataDirectory,
        MALINK_GATEWAY_BUILD_ID: release.buildId },
      // Dedicated process group lets release account for Agent descendants,
      // rather than mistaking the parent exit for complete relinquishment.
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    this.children.set(releaseId, child)
    child.stdout?.on('data', chunk => this.dependencies.log(`[track:${releaseId}] ${String(chunk)}`))
    child.stderr?.on('data', chunk => this.dependencies.log(`[track:${releaseId}] ${String(chunk)}`))
    child.on('error', error => { this.failures.set(releaseId, error.message) })
    child.once('exit', (code, signal) => {
      this.failures.set(releaseId, `Gateway exited (${code ?? signal ?? 'unknown'})`)
    })
    await new Promise<void>((resolveStarted, reject) => {
      child.once('spawn', resolveStarted)
      child.once('error', reject)
    })
    await this.verifyActive(releaseId, this.dataDirectory, gatewayNodeId)
  }

  async verifyActive(releaseId: string, dataDirectory: string, gatewayNodeId: string): Promise<void> {
    this.requireDirectory(dataDirectory)
    const deadline = Date.now() + this.timeoutMs
    let lastError = 'Gateway health has not arrived'
    do {
      const child = this.children.get(releaseId)
      if (!child?.pid || child.exitCode !== null || child.signalCode !== null || this.failures.has(releaseId)) {
        throw new Error(this.failures.get(releaseId) ?? 'Selected Gateway is not running')
      }
      try {
        const lock = JSON.parse(await readFile(join(this.dataDirectory, 'gateway-instance.lock'), 'utf8'))
        const health = await bounded(this.dependencies.readHealth(), Math.max(1, deadline - Date.now()), 'Gateway health check')
        if (lock.pid !== child.pid || health.buildId !== this.admitted.get(releaseId)?.buildId
          || health.gatewayNodeId !== gatewayNodeId || !health.matrixReady || health.deploymentFenced) {
          throw new Error('Gateway identity, release, readiness or writer ownership does not match')
        }
        return
      } catch (error) { lastError = error instanceof Error ? error.message : String(error) }
      await delay(50)
    } while (Date.now() < deadline)
    throw new Error(`Gateway activation timed out: ${lastError}`)
  }

  async releaseExecution(releaseId: string): Promise<void> {
    const child = this.children.get(releaseId)
    if (!child?.pid) return
    if (child.exitCode === null && child.signalCode === null) {
      // Failure to drain is not authorization to forcibly interrupt tasks.
      let drain = this.drains.get(releaseId)
      if (!drain) {
        drain = this.dependencies.drain(releaseId)
        this.drains.set(releaseId, drain)
        const current = drain
        void drain.then(() => {
          if (this.drains.get(releaseId) === current) this.drains.delete(releaseId)
        }, () => {
          if (this.drains.get(releaseId) === current) this.drains.delete(releaseId)
        })
      }
      // A timeout only ends this caller's wait. Keep tracking the underlying
      // drain so its late completion cannot affect a newly selected runtime.
      await bounded(drain, this.dependencies.drainTimeoutMs ?? this.timeoutMs, 'Gateway execution drain')
      signalGroup(child.pid, 'SIGTERM')
    }
    const deadline = Date.now() + this.timeoutMs
    while (groupAlive(child.pid)) {
      if (Date.now() >= deadline) throw new Error(`Release ${releaseId} still owns live processes; execution was not transferred`)
      await delay(50)
    }
    this.children.delete(releaseId)
  }

  private requireDirectory(directory: string): void {
    if (resolve(directory) !== this.dataDirectory) throw new Error('Cannot switch the business data directory')
  }

  /** Loss of the stable controller is a crash, not a new owner grant. */
  async controllerDisconnected(): Promise<void> {
    for (const child of this.children.values()) if (child.pid) signalGroup(child.pid, 'SIGTERM')
    const deadline = Date.now() + this.timeoutMs
    for (const child of this.children.values()) {
      if (!child.pid) continue
      while (groupAlive(child.pid) && Date.now() < deadline) await delay(50)
      if (groupAlive(child.pid)) signalGroup(child.pid, 'SIGKILL')
    }
  }
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try { process.kill(-pid, signal) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return
    if ((error as NodeJS.ErrnoException).code === 'EPERM' && !groupAlive(pid)) return
    throw error
  }
}
function groupAlive(pid: number): boolean {
  try { process.kill(-pid, 0); return true } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    if ((error as NodeJS.ErrnoException).code === 'EPERM' && process.platform === 'darwin') {
      // Hardened Host process-group probes can return EPERM after a clean
      // administrative shutdown. Confirm absence from the kernel process
      // table; permission denial alone never authorizes another writer.
      const groups = execFileSync('/bin/ps', ['-axo', 'pgid='], { encoding: 'utf8', timeout: 5000 })
      if (!groups.trim().split(/\s+/u).every(value => /^\d+$/u.test(value))) throw error
      return groups.trim().split(/\s+/u).some(value => Number(value) === pid)
    }
    throw error
  }
}
function delay(ms: number): Promise<void> { return new Promise(resolveDelay => setTimeout(resolveDelay, ms)) }
async function bounded<T>(operation: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out; no execution transfer was authorized`)), ms)
    })])
  } finally { if (timer) clearTimeout(timer) }
}
