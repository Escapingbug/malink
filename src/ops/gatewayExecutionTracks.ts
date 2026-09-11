import { z } from 'zod'
import { AtomicJsonFile } from '@malink/security/node'
import { resolve } from 'node:path'
import { acquireGatewayDataDirectoryLock } from '@/gateway/matrix/gatewayDataDirectoryLock'

const release = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u)
export const gatewayExecutionTracksStateSchema = z.object({
  version: z.literal(1),
  gatewayNodeId: z.string().min(1),
  dataDirectory: z.string().min(1),
  generation: z.number().int().nonnegative(),
  activeRelease: release,
  standbyRelease: release.optional(),
  phase: z.enum(['steady', 'releasing', 'activating', 'attention']),
  targetRelease: release.optional(),
  forwardOnly: z.literal(true).optional(),
  backupPath: z.string().min(1).optional(),
  targetWriteStarted: z.literal(true).optional(),
  error: z.string().optional(),
  updatedAt: z.number().int().nonnegative().optional(),
}).strict()
export type GatewayExecutionTracksState = z.infer<typeof gatewayExecutionTracksStateSchema>

export interface GatewayExecutionTrackHost {
  /** Verify signer/seal even when the target's state catalog differs. */
  validateForwardRelease?(releaseId: string, dataDirectory: string): Promise<void>
  backupStoppedState?(state: GatewayExecutionTracksState): Promise<string>
  /** Returns false when a durable Host reload has been requested. */
  prepareForwardHost?(state: GatewayExecutionTracksState): Promise<boolean>
  /** Read-only compatibility check, not an Agent trial or writable data migration. */
  validateRelease(releaseId: string, dataDirectory: string): Promise<void>
  /** A standby owns no Matrix sync, business store, outbox, or Agent execution. */
  ensureStandby(releaseId: string): Promise<void>
  retireStandby?(releaseId: string): Promise<void>
  /** Return only when all writers and child execution have relinquished the directory. */
  releaseExecution(releaseId: string): Promise<void>
  /** Idempotent start; must acquire the existing Gateway data-directory lock. */
  activate(releaseId: string, dataDirectory: string, gatewayNodeId: string): Promise<void>
  /** Check actual build, stable node identity and writable-directory ownership. */
  verifyActive(releaseId: string, dataDirectory: string, gatewayNodeId: string): Promise<void>
}

/** Local supervisor authority only. No state snapshots, node rotation, or automatic rollback. */
export class GatewayExecutionTracks {
  private readonly file: AtomicJsonFile<GatewayExecutionTracksState>
  private chain: Promise<unknown> = Promise.resolve()
  private readonly controlLockDirectory: string

  constructor(path: string, private readonly initial: GatewayExecutionTracksState,
    private readonly host: GatewayExecutionTrackHost) {
    gatewayExecutionTracksStateSchema.parse(initial)
    this.file = new AtomicJsonFile(path)
    this.controlLockDirectory = `${resolve(path)}.controller`
  }

  status(): Promise<GatewayExecutionTracksState> {
    return this.file.transaction(() => structuredClone(this.initial), raw => {
      const state = this.validate(raw)
      return { changed: false, result: structuredClone(state) }
    })
  }

  /** A signed user action must supply the generation it displayed. */
  select(releaseId: string, generation: number): Promise<GatewayExecutionTracksState> {
    return this.requestSelection(releaseId, generation, false)
  }

  /** Persist selection before the command sender is stopped by its own request. */
  scheduleSelection(releaseId: string, generation: number, allowForwardOnly = false): Promise<GatewayExecutionTracksState> {
    return this.requestSelection(releaseId, generation, true, allowForwardOnly)
  }

  private requestSelection(releaseId: string, generation: number, deferred: boolean, allowForwardOnly = false): Promise<GatewayExecutionTracksState> {
    return this.serialize(async () => {
      release.parse(releaseId)
      const current = await this.status()
      if (current.generation !== generation) throw new Error('Version selection changed; refresh before selecting again')
      if (current.phase !== 'steady' && current.phase !== 'attention') throw new Error('An execution handoff is still running')
      if (current.phase === 'attention' && current.forwardOnly) {
        if (releaseId !== current.targetRelease) throw new Error('Incompatible upgrade cannot switch to an older reader; retry the target or use local backup recovery')
        // Keep the original backup and write boundary when retrying.
        return deferred ? current : this.complete(current)
      }
      if (current.phase === 'attention' && releaseId !== current.activeRelease && releaseId !== current.targetRelease && releaseId !== current.standbyRelease) {
        throw new Error('Resolve the interrupted handoff before adding another version')
      }
      if (releaseId === current.activeRelease && current.phase === 'steady') return current
      if (allowForwardOnly) {
        if (!this.host.validateForwardRelease || !this.host.backupStoppedState || !this.host.prepareForwardHost) {
          throw new Error('This Host must be upgraded locally before it can perform an incompatible upgrade')
        }
        await this.host.validateForwardRelease(releaseId, current.dataDirectory)
      } else await this.host.validateRelease(releaseId, current.dataDirectory)
      if (current.phase === 'steady' && current.standbyRelease && current.standbyRelease !== releaseId) {
        if (!this.host.retireStandby) throw new Error('Host cannot safely replace the previous standby')
        await this.host.retireStandby(current.standbyRelease)
      }
      await this.host.ensureStandby(releaseId)
      // Persist intent before stopping the current owner. Competing selectors
      // cannot each grant a different writer, even across supervisor instances.
      const intent = await this.file.transaction(() => structuredClone(this.initial), raw => {
        const state = this.validate(raw)
        if (state.generation !== generation || state.phase !== current.phase) throw new Error('Execution handoff already changed')
        const otherRelease = state.phase === 'attention' && releaseId === state.activeRelease
          ? state.targetRelease! : state.activeRelease
        Object.assign(raw, { generation: generation + 1, updatedAt: Date.now(), activeRelease: otherRelease,
          targetRelease: releaseId, phase: 'releasing' })
        delete raw.forwardOnly
        delete raw.backupPath
        delete raw.targetWriteStarted
        if (allowForwardOnly) raw.forwardOnly = true
        delete raw.error
        return { changed: true, result: structuredClone(raw) }
      })
      return deferred ? intent : this.complete(intent)
    })
  }

  /** Resume persisted intent; never infer permission to restore an older data snapshot. */
  resume(): Promise<GatewayExecutionTracksState> {
    return this.serialize(async () => {
      const state = await this.status()
      if (state.phase === 'steady') return state
      return this.complete(state)
    })
  }

  async startDefault(): Promise<void> {
    return this.serialize(async () => {
      const state = await this.status()
      if (state.phase !== 'steady') { await this.complete(state); return }
      state.phase = 'activating'
      state.targetRelease = state.activeRelease
      await this.save(state)
      try {
        await this.host.validateRelease(state.activeRelease, state.dataDirectory)
        await this.host.ensureStandby(state.activeRelease)
        await this.host.activate(state.activeRelease, state.dataDirectory, state.gatewayNodeId)
        await this.host.verifyActive(state.activeRelease, state.dataDirectory, state.gatewayNodeId)
        state.phase = 'steady'
        delete state.targetRelease
        delete state.error
        await this.save(state)
      } catch (error) {
        state.phase = 'attention'; state.targetRelease = state.activeRelease
        state.error = error instanceof Error ? error.message : String(error)
        await this.save(state)
        throw error
      }
      await this.prepareOptionalStandby(state)
    })
  }

  private async complete(state: GatewayExecutionTracksState): Promise<GatewayExecutionTracksState> {
    const target = state.targetRelease
    if (!target) throw new Error('Execution handoff target is missing')
    try {
      if (state.forwardOnly) {
        if (!this.host.validateForwardRelease || !this.host.backupStoppedState || !this.host.prepareForwardHost) {
          throw new Error('Incompatible upgrade requires a capable Host; use local recovery')
        }
        await this.host.validateForwardRelease(target, state.dataDirectory)
      } else await this.host.validateRelease(target, state.dataDirectory)
      // Idempotent even after an interrupted activation. The adapter must never
      // terminate a different version merely because a shared PID file changed.
      await this.host.releaseExecution(state.activeRelease)
      // A failed or interrupted activation may have left the target owning the
      // stores. Relinquish both known tracks before granting either one again.
      await this.host.releaseExecution(target)
      if (state.forwardOnly) {
        if (!state.backupPath) {
          if (state.targetWriteStarted) throw new Error('Original backup is missing; refusing to back up already-upgraded data')
          state.backupPath = await this.host.backupStoppedState!(structuredClone(state))
          await this.save(state)
        }
        // Move to the target-pinned supervisor before opening its data format.
        // A new Host resumes this same persisted intent, never a fresh upgrade.
        if (!await this.host.prepareForwardHost!(structuredClone(state))) return state
        state.targetWriteStarted = true
        delete state.standbyRelease
        await this.save(state)
      }
      state.phase = 'activating'
      await this.save(state)
      await this.host.activate(target, state.dataDirectory, state.gatewayNodeId)
      await this.host.verifyActive(target, state.dataDirectory, state.gatewayNodeId)
      const completed: GatewayExecutionTracksState = {
        version: 1, gatewayNodeId: state.gatewayNodeId, dataDirectory: state.dataDirectory,
        generation: state.generation, activeRelease: target,
        ...(state.forwardOnly ? { forwardOnly: true as const, backupPath: state.backupPath, targetWriteStarted: true as const }
          : target !== state.activeRelease ? { standbyRelease: state.activeRelease }
          : state.standbyRelease ? { standbyRelease: state.standbyRelease } : {}), phase: 'steady',
      }
      await this.save(completed)
      await this.prepareOptionalStandby(completed)
      return completed
    } catch (error) {
      state.phase = 'attention'
      state.error = error instanceof Error ? error.message : String(error)
      await this.save(state)
      throw error
    }
  }

  private async prepareOptionalStandby(state: GatewayExecutionTracksState): Promise<void> {
    if (!state.standbyRelease) return
    try {
      await this.host.ensureStandby(state.standbyRelease)
      delete state.error
    } catch (error) {
      // A verified business writer remains the active version. Never describe
      // its successful activation as a failed handoff because standby failed.
      state.error = `The default version is running, but the previous version is unavailable: ${error instanceof Error ? error.message : String(error)}`
    }
    await this.save(state)
  }

  private validate(raw: GatewayExecutionTracksState): GatewayExecutionTracksState {
    const state = gatewayExecutionTracksStateSchema.parse(raw)
    if (state.gatewayNodeId !== this.initial.gatewayNodeId || state.dataDirectory !== this.initial.dataDirectory) {
      throw new Error('Execution tracks cannot change Gateway identity or business data directory')
    }
    if (state.phase !== 'steady' && !state.targetRelease) throw new Error('Execution handoff target is missing')
    if ((state.backupPath || state.targetWriteStarted) && !state.forwardOnly) throw new Error('Forward-only recovery metadata cannot grant compatible rollback')
    return state
  }

  private save(next: GatewayExecutionTracksState): Promise<void> {
    next.updatedAt = Date.now()
    this.validate(next)
    return this.file.transaction(() => structuredClone(this.initial), raw => {
      const current = this.validate(raw)
      if (current.generation !== next.generation) throw new Error('Execution handoff generation changed')
      for (const key of Object.keys(raw)) delete (raw as Record<string, unknown>)[key]
      Object.assign(raw, next)
      return { changed: true, result: undefined }
    })
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const guarded = async () => {
      // Atomic status writes alone do not protect external process operations:
      // another supervisor could resume the same generation concurrently.
      const lock = await acquireGatewayDataDirectoryLock(this.controlLockDirectory)
      try {
        return await operation()
      } finally {
        await lock.release()
      }
    }
    const next = this.chain.then(guarded, guarded)
    this.chain = next.catch(() => undefined)
    return next
  }
}
