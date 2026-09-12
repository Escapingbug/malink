import { fork, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import type { GatewayExecutionTrackHost, GatewayExecutionTracksState } from './gatewayExecutionTracks'
import type { GatewayTrackRelease } from './gatewayExecutionTrackHost'

/** Two release-pinned standby controllers; one business writer at a time. */
export class GatewayExecutionWorkerHost implements GatewayExecutionTrackHost {
  private readonly workers = new Map<string, ChildProcess>()
  private readonly pending = new Map<number, { resolve(): void; reject(error: Error): void; worker: ChildProcess; timer: ReturnType<typeof setTimeout> }>()
  private sequence = 0
  private readonly forwardReleases = new Set<string>()
  constructor(private readonly config: {
    dataDirectory: string; gatewayNodeId: string; adminSocket: string;
    resolveRelease(id: string): Promise<GatewayTrackRelease>;
    resolveForwardRelease?(id: string): Promise<GatewayTrackRelease>;
    backupStoppedState?(state: GatewayExecutionTracksState): Promise<string>;
    prepareForwardHost?(state: GatewayExecutionTracksState): Promise<boolean>;
    workerFile?: string; workerExecArgv?: string[]; log(message: string): void;
  }) {}

  async validateForwardRelease(id: string, directory: string): Promise<void> {
    if (directory !== this.config.dataDirectory || !this.config.resolveForwardRelease
      || !this.config.backupStoppedState || !this.config.prepareForwardHost) throw new Error('Incompatible upgrade is unavailable on this Host')
    await this.config.resolveForwardRelease(id)
    this.forwardReleases.add(id)
  }
  async backupStoppedState(state: GatewayExecutionTracksState): Promise<string> {
    if (!this.config.backupStoppedState) throw new Error('Stopped-state backup is unavailable')
    return this.config.backupStoppedState(state)
  }
  async prepareForwardHost(state: GatewayExecutionTracksState): Promise<boolean> {
    if (!this.config.prepareForwardHost) throw new Error('Host migration is unavailable')
    return this.config.prepareForwardHost(state)
  }

  async validateRelease(id: string, directory: string): Promise<void> {
    if (directory !== this.config.dataDirectory) throw new Error('Cannot replace shared business state')
    await this.config.resolveRelease(id)
  }
  async ensureStandby(id: string): Promise<void> {
    if (this.workers.has(id)) return
    if (this.workers.size >= 2) throw new Error('Retire the unused standby before preparing a third version')
    const release = await (this.forwardReleases.has(id) ? this.config.resolveForwardRelease!(id) : this.config.resolveRelease(id))
    const worker = fork(this.config.workerFile ?? fileURLToPath(new URL('./gatewayExecutionTrackWorker.js', import.meta.url)), [], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'], execArgv: this.config.workerExecArgv ?? [],
    })
    this.workers.set(id, worker)
    worker.stdout?.on('data', chunk => this.config.log(String(chunk)))
    worker.stderr?.on('data', chunk => this.config.log(String(chunk)))
    const fail = (error: Error) => {
      if (this.workers.get(id) === worker) this.workers.delete(id)
      for (const [key, pending] of this.pending) if (pending.worker === worker) {
        clearTimeout(pending.timer); this.pending.delete(key); pending.reject(error)
      }
    }
    worker.on('error', fail)
    worker.on('exit', () => fail(new Error(`Version controller ${id} exited`)))
    worker.on('message', (raw: unknown) => {
      const message = raw as { id: number; ok?: boolean; error?: string }
      const pending = this.pending.get(message.id)
      if (!pending || pending.worker !== worker) return
      clearTimeout(pending.timer); this.pending.delete(message.id)
      if (message.ok) pending.resolve(); else pending.reject(new Error(message.error ?? 'Version controller failed'))
    })
    try {
      await this.request(worker, 'initialize', { release, dataDirectory: this.config.dataDirectory,
        gatewayNodeId: this.config.gatewayNodeId, adminSocket: this.config.adminSocket })
    } catch (error) {
      if (this.workers.get(id) === worker) this.workers.delete(id)
      if (worker.connected) worker.disconnect()
      throw error
    }
  }
  async activate(id: string, directory: string, node: string): Promise<void> {
    if (directory !== this.config.dataDirectory || node !== this.config.gatewayNodeId) throw new Error('Execution identity changed')
    await this.ensureStandby(id)
    await this.request(this.workers.get(id)!, 'activate')
  }
  async retireStandby(id: string): Promise<void> {
    const worker = this.workers.get(id)
    if (!worker) return
    await this.request(worker, 'release')
    await new Promise<void>(resolve => { worker.once('exit', () => resolve()); worker.disconnect() })
  }
  async releaseExecution(id: string): Promise<void> {
    const worker = this.workers.get(id)
    if (worker) await this.request(worker, 'release')
  }
  async verifyActive(id: string): Promise<void> {
    const worker = this.workers.get(id)
    if (!worker) throw new Error('Selected controller is unavailable')
    await this.request(worker, 'health')
  }
  async stop(): Promise<void> {
    const workers = [...this.workers.values()]
    await Promise.all(workers.map(worker => new Promise<void>(resolve => {
      if (worker.exitCode !== null || worker.signalCode !== null) { resolve(); return }
      worker.once('exit', () => resolve())
      if (worker.connected) worker.disconnect()
    })))
  }
  private request(worker: ChildProcess, operation: string, payload: Record<string, unknown> = {}): Promise<void> {
    const id = ++this.sequence
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Version controller ${operation} timed out`)) }, operation === 'release' ? 190_000 : 45_000)
      this.pending.set(id, { worker, resolve, reject, timer })
      worker.send({ id, operation, ...payload }, error => {
        if (error) { clearTimeout(timer); this.pending.delete(id); reject(error) }
      })
    })
  }
}
