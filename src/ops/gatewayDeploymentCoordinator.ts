import { randomUUID } from 'node:crypto'
import {
  gatewayDeploymentSlotSchema,
  gatewayDeploymentStatusSchema,
  type GatewayDeploymentSlot,
  type GatewayDeploymentStatus,
} from '@malink/protocol'
import { AtomicJsonFile } from '@malink/security/node'

interface GatewayDeploymentCoordinatorState {
  version: 1
  status: GatewayDeploymentStatus
  commitStarted?: boolean
  scheduledPromotion?: {
    updateId: string
    mode: 'when_idle' | 'force'
    scheduledAt: number
  }
}

export interface GatewayDeploymentCoordinatorConfig {
  statePath: string
  computerId: string
  active: GatewayDeploymentSlot
  promotionDelayMs?: number
}

export interface GatewayDeploymentTransition {
  updateId: string
  computerId: string
  generation: number
  active: GatewayDeploymentSlot
  candidate: GatewayDeploymentSlot
}

export interface GatewayDeploymentCoordinatorDependencies {
  now?: () => number
  createId?: () => string
  prepareCandidate?: (
    transition: GatewayDeploymentTransition,
  ) => Promise<GatewayDeploymentSlot>
  discardCandidate?: (transition: GatewayDeploymentTransition) => Promise<void>
  drainDeployments?: (
    transition: GatewayDeploymentTransition & { mode: 'when_idle' | 'force' },
  ) => Promise<{
    activeTurns?: number
    active?: GatewayDeploymentSlot
    candidate?: GatewayDeploymentSlot
  } | void>
  transferState?: (
    transition: GatewayDeploymentTransition,
  ) => Promise<GatewayDeploymentSlot>
  commitCandidate?: (transition: GatewayDeploymentTransition) => Promise<void>
  rollbackPreCommit?: (transition: GatewayDeploymentTransition) => Promise<{
    active?: GatewayDeploymentSlot
    candidate?: GatewayDeploymentSlot
  } | void>
  recoverPreparation?: (
    transition: GatewayDeploymentTransition,
  ) => Promise<GatewayDeploymentSlot | null>
  recoverCommit?: (
    transition: GatewayDeploymentTransition,
  ) => Promise<'committed' | 'not_committed' | 'unknown'>
}

export class GatewayDeploymentCoordinator {
  private readonly stateFile: AtomicJsonFile<GatewayDeploymentCoordinatorState>
  private requestChain: Promise<void> = Promise.resolve()
  private promotionTimer: ReturnType<typeof setTimeout> | null = null
  private promotionOperation: Promise<void> | null = null

  constructor(
    private readonly config: GatewayDeploymentCoordinatorConfig,
    private readonly dependencies: GatewayDeploymentCoordinatorDependencies = {},
  ) {
    gatewayDeploymentSlotSchema.parse(config.active)
    if (!config.computerId.trim()) throw new TypeError('Gateway computer ID is required')
    this.stateFile = new AtomicJsonFile(config.statePath)
  }

  async initialize(): Promise<void> {
    await this.serialize(async () => {
      const state = await this.readState()
      const transition = transitionFromStatus(state.status)
      if (
        state.status.phase === 'steady'
        || state.status.phase === 'trial'
      ) return
      if (state.status.phase === 'repair_required') {
        if (!transition) return
        if (state.commitStarted) {
          await this.recoverCommit(state.status, transition)
        } else {
          await this.rollbackToTrial(
            state.status,
            transition,
            'Interrupted pre-commit repair was rolled back to trial',
          )
        }
        return
      }
      if (state.status.phase === 'draining' && state.scheduledPromotion) {
        this.armPromotion(state.scheduledPromotion.scheduledAt)
        return
      }
      if (state.status.phase === 'preparing') {
        if (!transition || !this.dependencies.recoverPreparation) {
          await this.markRepairRequired(
            state.status,
            'Candidate preparation was interrupted and cannot be reconciled automatically',
          )
          return
        }
        try {
          const candidate = await this.dependencies.recoverPreparation(transition)
          if (!candidate) {
            await this.returnToSteady(state.status, 'Interrupted candidate preparation was removed')
            return
          }
          assertPreparedCandidate(transition, candidate)
          await this.writeStatus({
            ...state.status,
            phase: 'trial',
            candidate,
            detail: 'Candidate recovered and is ready for user-directed trial work',
            updatedAt: this.now(),
          })
        } catch (error) {
          await this.markRepairRequired(
            state.status,
            `Interrupted candidate preparation recovery failed: ${formatError(error)}`,
          )
        }
        return
      }
      if (state.status.phase === 'discarding') {
        if (!transition || !this.dependencies.discardCandidate) {
          await this.markRepairRequired(
            state.status,
            'Candidate discard was interrupted and cannot be reconciled automatically',
          )
          return
        }
        try {
          await this.dependencies.discardCandidate(transition)
          await this.returnToSteady(state.status, 'Interrupted candidate discard completed')
        } catch (error) {
          await this.markRepairRequired(
            state.status,
            `Interrupted candidate discard recovery failed: ${formatError(error)}`,
          )
        }
        return
      }
      if (!transition) {
        await this.markRepairRequired(
          state.status,
          'Interrupted Gateway deployment transaction has no complete binding',
        )
        return
      }
      if (state.status.phase === 'committing' || state.commitStarted) {
        await this.recoverCommit(state.status, transition)
        return
      }
      await this.rollbackToTrial(
        state.status,
        transition,
        'Interrupted pre-commit switch was rolled back to trial',
      )
    })
  }

  status(): Promise<GatewayDeploymentStatus> {
    return this.readState().then(state => structuredClone(state.status))
  }

  async stop(): Promise<void> {
    if (this.promotionTimer) clearTimeout(this.promotionTimer)
    this.promotionTimer = null
    await this.promotionOperation?.catch(() => undefined)
  }

  prepare(input: {
    releaseId: string
    buildId: string
    candidateGatewayNodeId?: string
  }): Promise<GatewayDeploymentStatus> {
    return this.serialize(async () => {
      const current = await this.readState()
      if (current.status.candidate) {
        if (
          current.status.candidate.releaseId === input.releaseId
          && current.status.phase === 'trial'
        ) return structuredClone(current.status)
        throw new Error(
          'This computer already has a candidate Gateway; discard it before preparing another',
        )
      }
      if (current.status.phase !== 'steady') {
        throw new Error(`Cannot prepare a Gateway candidate while ${current.status.phase}`)
      }
      const updateId = this.createId()
      const candidate: GatewayDeploymentSlot = gatewayDeploymentSlotSchema.parse({
        gatewayNodeId: input.candidateGatewayNodeId ?? this.createId(),
        releaseId: input.releaseId,
        buildId: input.buildId,
        projectCount: 0,
        sessionCount: 0,
      })
      if (candidate.gatewayNodeId === current.status.active.gatewayNodeId) {
        throw new Error('Candidate Gateway node ID matches the active deployment')
      }
      const preparing = await this.writeStatus({
        ...current.status,
        phase: 'preparing',
        candidate,
        updateId,
        detail: 'Preparing an isolated candidate Gateway; the active Gateway remains available',
        updatedAt: this.now(),
      })
      const transition = requireTransition(preparing)
      try {
        const prepared = this.dependencies.prepareCandidate
          ? await this.dependencies.prepareCandidate(transition)
          : candidate
        assertPreparedCandidate(transition, prepared)
        return await this.writeStatus({
          ...preparing,
          phase: 'trial',
          candidate: prepared,
          detail: 'Candidate Gateway is ready for user-directed trial work',
          updatedAt: this.now(),
        })
      } catch (error) {
        try {
          await this.dependencies.discardCandidate?.(transition)
          await this.returnToSteady(
            preparing,
            `Candidate preparation failed; active Gateway unchanged: ${formatError(error)}`,
          )
        } catch (cleanupError) {
          await this.markRepairRequired(
            preparing,
            `Candidate preparation failed (${formatError(error)}); cleanup also failed: `
              + formatError(cleanupError),
          )
        }
        throw error
      }
    })
  }

  discard(updateId: string): Promise<GatewayDeploymentStatus> {
    return this.serialize(async () => {
      const current = await this.readState()
      assertUpdate(current.status, updateId, ['trial'])
      const transition = requireTransition(current.status)
      const discarding = await this.writeStatus({
        ...current.status,
        phase: 'discarding',
        detail: 'Discarding only the candidate Gateway and its trial-owned work',
        updatedAt: this.now(),
      })
      try {
        await this.dependencies.discardCandidate?.(transition)
        return await this.returnToSteady(discarding, 'Candidate Gateway was discarded')
      } catch (error) {
        await this.writeStatus({
          ...discarding,
          phase: 'trial',
          detail: `Candidate discard failed; active Gateway unchanged: ${formatError(error)}`,
          updatedAt: this.now(),
        })
        throw error
      }
    })
  }

  promote(
    updateId: string,
    mode: 'when_idle' | 'force',
  ): Promise<GatewayDeploymentStatus> {
    return this.serialize(async () => {
      const current = await this.readState()
      assertUpdate(current.status, updateId, ['trial'])
      let transition = requireTransition(current.status)
      const status = await this.writeStatus({
        ...current.status,
        phase: 'draining',
        detail: mode === 'force'
          ? 'Stopping active turns before switching all work'
          : 'Waiting for both Gateway deployments to become idle',
        updatedAt: this.now(),
      })
      return await this.performPromotion(status, transition, mode)
    })
  }

  schedulePromote(
    updateId: string,
    mode: 'when_idle' | 'force',
  ): Promise<GatewayDeploymentStatus> {
    return this.serialize(async () => {
      const current = await this.readState()
      if (
        current.status.phase === 'draining'
        && current.scheduledPromotion?.updateId === updateId
        && current.scheduledPromotion.mode === mode
      ) return structuredClone(current.status)
      assertUpdate(current.status, updateId, ['trial'])
      const scheduledAt = this.now() + (this.config.promotionDelayMs ?? 5_000)
      const status = await this.writeState(state => {
        state.status = gatewayDeploymentStatusSchema.parse({
          ...state.status,
          phase: 'draining',
          detail: mode === 'force'
            ? 'Promotion scheduled; active turns will be stopped before switching all work'
            : 'Promotion scheduled; waiting for both Gateway deployments to become idle',
          updatedAt: this.now(),
        })
        state.scheduledPromotion = { updateId, mode, scheduledAt }
        delete state.commitStarted
      })
      this.armPromotion(scheduledAt)
      return status
    })
  }

  private async performPromotion(
    initialStatus: GatewayDeploymentStatus,
    initialTransition: GatewayDeploymentTransition,
    mode: 'when_idle' | 'force',
  ): Promise<GatewayDeploymentStatus> {
      let transition = initialTransition
      let status = initialStatus
      try {
        const drained = await this.dependencies.drainDeployments?.({ ...transition, mode })
        const active = drained?.active ?? status.active
        const candidate = drained?.candidate ?? status.candidate
        assertMatchingSlot(transition.active, active, 'Drained active Gateway')
        if (!candidate) throw new Error('Drained Gateway deployment has no candidate')
        assertPreparedCandidate(transition, candidate)
        status = await this.writeStatus({
          ...status,
          phase: 'transferring',
          active,
          candidate,
          ...(drained?.activeTurns === undefined ? {} : { activeTurns: drained.activeTurns }),
          detail: 'Transferring all projects and persisted sessions to the candidate',
          updatedAt: this.now(),
        })
        transition = requireTransition(status)
        const transferred = this.dependencies.transferState
          ? await this.dependencies.transferState(transition)
          : transition.candidate
        assertPreparedCandidate(transition, transferred)
        status = await this.writeStatus({
          ...status,
          phase: 'committing',
          candidate: transferred,
          detail: 'Candidate accepted the complete handoff; committing all routes',
          updatedAt: this.now(),
        }, true)
        transition = requireTransition(status)
        await this.dependencies.commitCandidate?.(transition)
        return await this.finishCommit(status)
      } catch (error) {
        const latest = await this.readState()
        if (latest.commitStarted || latest.status.phase === 'committing') {
          await this.recoverCommitAfterFailure(latest.status, requireTransition(latest.status), error)
        } else {
          await this.rollbackToTrial(
            latest.status,
            requireTransition(latest.status),
            `Switch failed before commit; both prior Gateways restored: ${formatError(error)}`,
          )
        }
        throw error
      }
  }

  private armPromotion(scheduledAt: number): void {
    if (this.promotionTimer || this.promotionOperation) return
    const timer = setTimeout(() => {
      if (this.promotionTimer === timer) this.promotionTimer = null
      const operation = this.serialize(async () => {
        const state = await this.readState()
        const scheduled = state.scheduledPromotion
        if (!scheduled || state.status.phase !== 'draining') return
        await this.writeState(current => { delete current.scheduledPromotion })
        await this.performPromotion(
          state.status,
          requireTransition(state.status),
          scheduled.mode,
        )
      })
      const tracked = operation.then(() => undefined, error => {
        // performPromotion has already persisted trial or repair_required.
        // Preserve that semantic state; the caller can read the exact failure.
        void error
      }).finally(() => {
        if (this.promotionOperation === tracked) this.promotionOperation = null
      })
      this.promotionOperation = tracked
    }, Math.max(0, scheduledAt - this.now()))
    this.promotionTimer = timer
    timer.unref?.()
  }

  private async recoverCommitAfterFailure(
    status: GatewayDeploymentStatus,
    transition: GatewayDeploymentTransition,
    cause: unknown,
  ): Promise<void> {
    const result = await this.dependencies.recoverCommit?.(transition) ?? 'unknown'
    if (result === 'committed') {
      await this.finishCommit(status)
      return
    }
    if (result === 'not_committed') {
      await this.rollbackToTrial(
        status,
        transition,
        `Switch commit did not occur; prior Gateways restored: ${formatError(cause)}`,
      )
      return
    }
    await this.markRepairRequired(
      status,
      `Switch commit is ambiguous and execution remains fenced: ${formatError(cause)}`,
      true,
    )
  }

  private async recoverCommit(
    status: GatewayDeploymentStatus,
    transition: GatewayDeploymentTransition,
  ): Promise<void> {
    try {
      const result = await this.dependencies.recoverCommit?.(transition) ?? 'unknown'
      if (result === 'committed') {
        await this.finishCommit(status)
      } else if (result === 'not_committed') {
        await this.rollbackToTrial(
          status,
          transition,
          'Interrupted switch did not commit; prior Gateways restored',
        )
      } else {
        await this.markRepairRequired(
          status,
          'Interrupted switch has an ambiguous ownership commit; execution remains fenced',
          true,
        )
      }
    } catch (error) {
      await this.markRepairRequired(
        status,
        `Interrupted switch recovery failed: ${formatError(error)}`,
        true,
      )
    }
  }

  private async rollbackToTrial(
    status: GatewayDeploymentStatus,
    transition: GatewayDeploymentTransition,
    detail: string,
  ): Promise<GatewayDeploymentStatus> {
    try {
      const restored = await this.dependencies.rollbackPreCommit?.(transition)
      const active = restored?.active ?? status.active
      const candidate = restored?.candidate ?? status.candidate
      assertMatchingSlot(transition.active, active, 'Restored active Gateway')
      if (!candidate) throw new Error('Restored Gateway deployment has no candidate')
      assertPreparedCandidate(transition, candidate)
      return await this.writeStatus({
        ...status,
        phase: 'trial',
        active,
        candidate,
        activeTurns: undefined,
        detail,
        updatedAt: this.now(),
      }, false)
    } catch (error) {
      return await this.markRepairRequired(
        status,
        `${detail}; rollback failed: ${formatError(error)}`,
      )
    }
  }

  private finishCommit(status: GatewayDeploymentStatus): Promise<GatewayDeploymentStatus> {
    if (!status.candidate) throw new Error('Committed deployment has no candidate')
    return this.writeStatus({
      version: 1,
      strategy: 'blue-green-v1',
      maxDeployments: 2,
      computerId: status.computerId,
      generation: status.generation + 1,
      phase: 'steady',
      active: status.candidate,
      detail: 'All projects and sessions now use the promoted Gateway',
      updatedAt: this.now(),
    }, false)
  }

  private returnToSteady(
    status: GatewayDeploymentStatus,
    detail: string,
  ): Promise<GatewayDeploymentStatus> {
    return this.writeStatus({
      version: 1,
      strategy: 'blue-green-v1',
      maxDeployments: 2,
      computerId: status.computerId,
      generation: status.generation,
      phase: 'steady',
      active: status.active,
      detail,
      updatedAt: this.now(),
    }, false)
  }

  private markRepairRequired(
    status: GatewayDeploymentStatus,
    detail: string,
    commitStarted = false,
  ): Promise<GatewayDeploymentStatus> {
    return this.writeStatus({
      ...status,
      phase: 'repair_required',
      detail,
      updatedAt: this.now(),
    }, commitStarted)
  }

  private readState(): Promise<GatewayDeploymentCoordinatorState> {
    return this.stateFile.transaction(() => defaultState(this.config, this.now()), state => {
      validateCoordinatorState(state, this.config.computerId)
      return { result: structuredClone(state), changed: false }
    })
  }

  private writeStatus(
    statusInput: GatewayDeploymentStatus,
    commitStarted?: boolean,
  ): Promise<GatewayDeploymentStatus> {
    const status = gatewayDeploymentStatusSchema.parse(statusInput)
    return this.stateFile.transaction(() => defaultState(this.config, this.now()), state => {
      validateCoordinatorState(state, this.config.computerId)
      state.status = structuredClone(status)
      if (commitStarted === undefined) {
        if (status.phase !== 'committing' && status.phase !== 'repair_required') {
          delete state.commitStarted
        }
      } else if (commitStarted) {
        state.commitStarted = true
      } else {
        delete state.commitStarted
      }
      if (status.phase !== 'draining') delete state.scheduledPromotion
      validateCoordinatorState(state, this.config.computerId)
      return { result: structuredClone(state.status), changed: true }
    })
  }

  private writeState(
    mutate: (state: GatewayDeploymentCoordinatorState) => void,
  ): Promise<GatewayDeploymentStatus> {
    return this.stateFile.transaction(() => defaultState(this.config, this.now()), state => {
      validateCoordinatorState(state, this.config.computerId)
      mutate(state)
      validateCoordinatorState(state, this.config.computerId)
      return { result: structuredClone(state.status), changed: true }
    })
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const running = this.requestChain.then(operation, operation)
    this.requestChain = running.then(() => undefined, () => undefined)
    return running
  }

  private now(): number {
    return this.dependencies.now?.() ?? Date.now()
  }

  private createId(): string {
    return this.dependencies.createId?.() ?? randomUUID()
  }
}

function defaultState(
  config: GatewayDeploymentCoordinatorConfig,
  now: number,
): GatewayDeploymentCoordinatorState {
  return {
    version: 1,
    status: {
      version: 1,
      strategy: 'blue-green-v1',
      maxDeployments: 2,
      computerId: config.computerId,
      generation: 0,
      phase: 'steady',
      active: gatewayDeploymentSlotSchema.parse(config.active),
      updatedAt: now,
    },
  }
}

function validateCoordinatorState(
  state: GatewayDeploymentCoordinatorState,
  computerId: string,
): void {
  if (state.version !== 1) throw new Error('Unsupported Gateway deployment coordinator state')
  const status = gatewayDeploymentStatusSchema.parse(state.status)
  if (status.computerId !== computerId) {
    throw new Error('Gateway deployment state belongs to another computer')
  }
  if (state.commitStarted && !['committing', 'repair_required'].includes(status.phase)) {
    throw new Error('Gateway deployment commit marker has an invalid phase')
  }
  if (state.scheduledPromotion) {
    if (
      status.phase !== 'draining'
      || status.updateId !== state.scheduledPromotion.updateId
      || (state.scheduledPromotion.mode !== 'when_idle'
        && state.scheduledPromotion.mode !== 'force')
      || !Number.isSafeInteger(state.scheduledPromotion.scheduledAt)
      || state.scheduledPromotion.scheduledAt < 0
    ) throw new Error('Gateway deployment promotion schedule is invalid')
  }
}

function assertPreparedCandidate(
  transition: GatewayDeploymentTransition,
  candidateInput: GatewayDeploymentSlot,
): void {
  const candidate = gatewayDeploymentSlotSchema.parse(candidateInput)
  if (
    candidate.gatewayNodeId !== transition.candidate.gatewayNodeId
    || candidate.releaseId !== transition.candidate.releaseId
    || candidate.buildId !== transition.candidate.buildId
  ) throw new Error('Prepared candidate does not match the durable update transaction')
}

function assertMatchingSlot(
  expected: GatewayDeploymentSlot,
  actualInput: GatewayDeploymentSlot,
  label: string,
): void {
  const actual = gatewayDeploymentSlotSchema.parse(actualInput)
  if (
    actual.gatewayNodeId !== expected.gatewayNodeId
    || actual.releaseId !== expected.releaseId
    || actual.buildId !== expected.buildId
  ) throw new Error(`${label} does not match the durable update transaction`)
}

function assertUpdate(
  status: GatewayDeploymentStatus,
  updateId: string,
  phases: readonly GatewayDeploymentStatus['phase'][],
): void {
  if (!status.updateId || status.updateId !== updateId) {
    throw new Error('Gateway update ID does not match the active candidate')
  }
  if (!phases.includes(status.phase)) {
    throw new Error(`Gateway update ${updateId} is ${status.phase}`)
  }
}

function transitionFromStatus(
  status: GatewayDeploymentStatus,
): GatewayDeploymentTransition | null {
  if (!status.updateId || !status.candidate) return null
  return {
    updateId: status.updateId,
    computerId: status.computerId,
    generation: status.generation,
    active: structuredClone(status.active),
    candidate: structuredClone(status.candidate),
  }
}

function requireTransition(status: GatewayDeploymentStatus): GatewayDeploymentTransition {
  const transition = transitionFromStatus(status)
  if (!transition) throw new Error('Gateway deployment transaction is incomplete')
  return transition
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
