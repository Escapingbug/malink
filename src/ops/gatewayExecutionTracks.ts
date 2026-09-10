import { z } from 'zod'
import { AtomicJsonFile } from '@malink/security/node'

const release = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u)
const stateSchema = z.object({
  version: z.literal(1),
  gatewayNodeId: z.string().min(1),
  dataDirectory: z.string().min(1),
  generation: z.number().int().nonnegative(),
  activeRelease: release,
  standbyRelease: release.optional(),
  phase: z.enum(['steady', 'releasing', 'activating', 'attention']),
  targetRelease: release.optional(),
  error: z.string().optional(),
}).strict()
export type GatewayExecutionTracksState = z.infer<typeof stateSchema>

export interface GatewayExecutionTrackHost {
  /** Read-only compatibility check, not an Agent trial or writable data migration. */
  validateRelease(releaseId: string, dataDirectory: string): Promise<void>
  /** A standby owns no Matrix sync, business store, outbox, or Agent execution. */
  ensureStandby(releaseId: string): Promise<void>
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

  constructor(path: string, private readonly initial: GatewayExecutionTracksState,
    private readonly host: GatewayExecutionTrackHost) {
    stateSchema.parse(initial)
    this.file = new AtomicJsonFile(path)
  }

  status(): Promise<GatewayExecutionTracksState> {
    return this.file.transaction(() => structuredClone(this.initial), raw => {
      const state = this.validate(raw)
      return { changed: false, result: structuredClone(state) }
    })
  }

  /** A signed user action must supply the generation it displayed. */
  select(releaseId: string, generation: number): Promise<GatewayExecutionTracksState> {
    return this.serialize(async () => {
      release.parse(releaseId)
      const current = await this.status()
      if (current.generation !== generation) throw new Error('Version selection changed; refresh before selecting again')
      if (current.phase !== 'steady' && current.phase !== 'attention') throw new Error('An execution handoff is still running')
      if (current.phase === 'attention' && releaseId !== current.activeRelease && releaseId !== current.targetRelease) {
        throw new Error('Resolve the interrupted handoff before adding another version')
      }
      if (releaseId === current.activeRelease && current.phase === 'steady') return current
      await this.host.validateRelease(releaseId, current.dataDirectory)
      await this.host.ensureStandby(releaseId)
      // Persist intent before stopping the current owner. Competing selectors
      // cannot each grant a different writer, even across supervisor instances.
      const intent = await this.file.transaction(() => structuredClone(this.initial), raw => {
        const state = this.validate(raw)
        if (state.generation !== generation || state.phase !== current.phase) throw new Error('Execution handoff already changed')
        const otherRelease = state.phase === 'attention' && releaseId === state.activeRelease
          ? state.targetRelease! : state.activeRelease
        Object.assign(raw, { generation: generation + 1, activeRelease: otherRelease,
          targetRelease: releaseId, phase: 'releasing' })
        delete raw.error
        return { changed: true, result: structuredClone(raw) }
      })
      return this.complete(intent)
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

  private async complete(state: GatewayExecutionTracksState): Promise<GatewayExecutionTracksState> {
    const target = state.targetRelease
    if (!target) throw new Error('Execution handoff target is missing')
    try {
      await this.host.validateRelease(target, state.dataDirectory)
      // Idempotent even after an interrupted activation. The adapter must never
      // terminate a different version merely because a shared PID file changed.
      await this.host.releaseExecution(state.activeRelease)
      // A failed or interrupted activation may have left the target owning the
      // stores. Relinquish both known tracks before granting either one again.
      await this.host.releaseExecution(target)
      state.phase = 'activating'
      await this.save(state)
      await this.host.activate(target, state.dataDirectory, state.gatewayNodeId)
      await this.host.verifyActive(target, state.dataDirectory, state.gatewayNodeId)
      await this.host.ensureStandby(state.activeRelease)
      const completed: GatewayExecutionTracksState = {
        version: 1, gatewayNodeId: state.gatewayNodeId, dataDirectory: state.dataDirectory,
        generation: state.generation, activeRelease: target, standbyRelease: state.activeRelease, phase: 'steady',
      }
      await this.save(completed)
      return completed
    } catch (error) {
      state.phase = 'attention'
      state.error = error instanceof Error ? error.message : String(error)
      await this.save(state)
      throw error
    }
  }

  private validate(raw: GatewayExecutionTracksState): GatewayExecutionTracksState {
    const state = stateSchema.parse(raw)
    if (state.gatewayNodeId !== this.initial.gatewayNodeId || state.dataDirectory !== this.initial.dataDirectory) {
      throw new Error('Execution tracks cannot change Gateway identity or business data directory')
    }
    if (state.phase !== 'steady' && !state.targetRelease) throw new Error('Execution handoff target is missing')
    return state
  }

  private save(next: GatewayExecutionTracksState): Promise<void> {
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
    const next = this.chain.then(operation, operation)
    this.chain = next.catch(() => undefined)
    return next
  }
}
