import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GatewayDeploymentSlot } from '@malink/protocol'
import {
  GatewayDeploymentCoordinator,
  type GatewayDeploymentCoordinatorDependencies,
} from '@/ops/gatewayDeploymentCoordinator'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path =>
    rm(path, { recursive: true, force: true })))
})

const active: GatewayDeploymentSlot = {
  gatewayNodeId: 'gateway-old',
  releaseId: 'release-old',
  buildId: 'build-old',
  projectCount: 2,
  sessionCount: 4,
}

describe('GatewayDeploymentCoordinator', () => {
  it('restores the retained version after cancelling the next update', async () => {
    const rotateRecovery = vi.fn(async () => {})
    const restoreRecovery = vi.fn(async () => {})
    const fixture = await coordinatorFixture({
      retainedRecovery: async transition => ({ ...transition.active, projectId: 'repair-project', retainedAt: 100 }),
      rotateRecovery,
      restoreRecovery,
    })
    await fixture.coordinator.initialize()
    const first = await fixture.coordinator.prepare({ releaseId: 'new', buildId: 'new', candidateGatewayNodeId: 'new' })
    await fixture.coordinator.promote(first.updateId!, 'when_idle')
    const second = await fixture.coordinator.prepare({ releaseId: 'third', buildId: 'third', candidateGatewayNodeId: 'third' })
    expect(rotateRecovery).toHaveBeenCalledOnce()
    expect(second.recovery).toBeUndefined()
    const discarded = await fixture.coordinator.discard(second.updateId!)
    expect(restoreRecovery).toHaveBeenCalledOnce()
    expect(discarded).toMatchObject({ phase: 'steady', active: { gatewayNodeId: 'new' }, recovery: { gatewayNodeId: 'gateway-old' } })
  })

  it('restores the retained version when rotation fails before preparation', async () => {
    const restoreRecovery = vi.fn(async () => {})
    const fixture = await coordinatorFixture({
      retainedRecovery: async transition => ({ ...transition.active, projectId: 'repair-project', retainedAt: 100 }),
      rotateRecovery: async () => { throw new Error('Recovery is busy') },
      restoreRecovery,
    })
    await fixture.coordinator.initialize()
    const first = await fixture.coordinator.prepare({ releaseId: 'new', buildId: 'new', candidateGatewayNodeId: 'new' })
    await fixture.coordinator.promote(first.updateId!, 'when_idle')
    await expect(fixture.coordinator.prepare({ releaseId: 'third', buildId: 'third' })).rejects.toThrow('Recovery is busy')
    expect(restoreRecovery).toHaveBeenCalledOnce()
    expect((await fixture.coordinator.status()).recovery?.gatewayNodeId).toBe('gateway-old')
  })

  it('retains only a host-verified old repair slot and blocks unsafe replacement', async () => {
    const fixture = await coordinatorFixture({
      retainedRecovery: async transition => ({ ...transition.active, projectId: 'repair-project', retainedAt: 100 }),
    })
    await fixture.coordinator.initialize()
    const trial = await fixture.coordinator.prepare({ releaseId: 'release-new', buildId: 'build-new', candidateGatewayNodeId: 'gateway-new' })
    const promoted = await fixture.coordinator.promote(trial.updateId!, 'when_idle')
    expect(promoted).toMatchObject({ phase: 'steady', active: { gatewayNodeId: 'gateway-new' },
      recovery: { gatewayNodeId: 'gateway-old', buildId: 'build-old', projectId: 'repair-project' } })
    await expect(fixture.coordinator.prepare({ releaseId: 'third', buildId: 'third' })).rejects.toThrow('safely rotated')
    expect((await fixture.coordinator.status()).recovery?.gatewayNodeId).toBe('gateway-old')
  })
  it('prepares one real candidate and rejects a third deployment', async () => {
    const fixture = await coordinatorFixture({
      prepareCandidate: async transition => ({
        ...transition.candidate,
        projectCount: 1,
        sessionCount: 1,
      }),
    })
    await fixture.coordinator.initialize()

    const trial = await fixture.coordinator.prepare({
      releaseId: 'release-new',
      buildId: 'build-new',
      candidateGatewayNodeId: 'gateway-new',
    })
    expect(trial).toMatchObject({
      phase: 'trial',
      maxDeployments: 2,
      active: { gatewayNodeId: 'gateway-old' },
      candidate: {
        gatewayNodeId: 'gateway-new',
        projectCount: 1,
        sessionCount: 1,
      },
    })

    await expect(fixture.coordinator.prepare({
      releaseId: 'release-third',
      buildId: 'build-third',
      candidateGatewayNodeId: 'gateway-third',
    })).rejects.toThrow('already has a candidate Gateway')
  })

  it('serializes concurrent prepare requests at the two-deployment limit', async () => {
    let releasePreparation!: () => void
    const prepared = new Promise<void>(resolve => { releasePreparation = resolve })
    const fixture = await coordinatorFixture({
      prepareCandidate: async transition => {
        await prepared
        return transition.candidate
      },
    })
    await fixture.coordinator.initialize()

    const first = fixture.coordinator.prepare({
      releaseId: 'release-new',
      buildId: 'build-new',
      candidateGatewayNodeId: 'gateway-new',
    })
    const second = fixture.coordinator.prepare({
      releaseId: 'release-third',
      buildId: 'build-third',
      candidateGatewayNodeId: 'gateway-third',
    })
    releasePreparation()

    await expect(first).resolves.toMatchObject({ phase: 'trial' })
    await expect(second).rejects.toThrow('already has a candidate Gateway')
  })

  it('promotes all source and candidate work as one generation', async () => {
    const phases: string[] = []
    const fixture = await coordinatorFixture({
      prepareCandidate: async transition => ({
        ...transition.candidate,
        projectCount: 1,
        sessionCount: 2,
      }),
      drainDeployments: async transition => {
        phases.push('drain')
        return {
          activeTurns: 0,
          active: {
            ...transition.active,
            projectCount: 3,
            sessionCount: 5,
          },
          candidate: {
            ...transition.candidate,
            projectCount: 2,
            sessionCount: 3,
          },
        }
      },
      transferState: async transition => {
        phases.push('transfer')
        return {
          ...transition.candidate,
          projectCount: transition.active.projectCount + transition.candidate.projectCount,
          sessionCount: transition.active.sessionCount + transition.candidate.sessionCount,
        }
      },
      commitCandidate: async () => { phases.push('commit') },
    })
    await fixture.coordinator.initialize()
    const trial = await fixture.coordinator.prepare({
      releaseId: 'release-new',
      buildId: 'build-new',
      candidateGatewayNodeId: 'gateway-new',
    })

    const promoted = await fixture.coordinator.promote(trial.updateId!, 'when_idle')

    expect(phases).toEqual(['drain', 'transfer', 'commit'])
    expect(promoted).toMatchObject({
      phase: 'steady',
      generation: 1,
      active: {
        gatewayNodeId: 'gateway-new',
        projectCount: 5,
        sessionCount: 8,
      },
    })
    expect(promoted).not.toHaveProperty('candidate')
    expect(promoted).not.toHaveProperty('updateId')
  })

  it('returns the signed draining phase before a scheduled promotion starts', async () => {
    let releaseDrain!: () => void
    const drainReleased = new Promise<void>(resolve => { releaseDrain = resolve })
    const drainStarted = vi.fn(async () => {
      await drainReleased
      return { activeTurns: 0 }
    })
    const fixture = await coordinatorFixture({
      drainDeployments: drainStarted,
    }, 0)
    await fixture.coordinator.initialize()
    const trial = await fixture.coordinator.prepare({
      releaseId: 'release-new',
      buildId: 'build-new',
      candidateGatewayNodeId: 'gateway-new',
    })

    const scheduled = await fixture.coordinator.schedulePromote(
      trial.updateId!,
      'when_idle',
    )

    expect(scheduled.phase).toBe('draining')
    await vi.waitFor(() => expect(drainStarted).toHaveBeenCalledOnce())
    expect((await fixture.coordinator.status()).phase).toBe('draining')
    releaseDrain()
    await vi.waitFor(async () => {
      expect((await fixture.coordinator.status()).phase).toBe('steady')
    })
    await fixture.coordinator.stop()
  })

  it('rolls a pre-commit transfer failure back to the unchanged trial', async () => {
    const rollback = vi.fn(async () => undefined)
    const fixture = await coordinatorFixture({
      transferState: async () => { throw new Error('handoff hash mismatch') },
      rollbackPreCommit: rollback,
    })
    await fixture.coordinator.initialize()
    const trial = await fixture.coordinator.prepare({
      releaseId: 'release-new',
      buildId: 'build-new',
      candidateGatewayNodeId: 'gateway-new',
    })

    await expect(fixture.coordinator.promote(trial.updateId!, 'when_idle'))
      .rejects.toThrow('handoff hash mismatch')
    expect(rollback).toHaveBeenCalledOnce()
    await expect(fixture.coordinator.status()).resolves.toMatchObject({
      phase: 'trial',
      generation: 0,
      active: { gatewayNodeId: 'gateway-old' },
      candidate: { gatewayNodeId: 'gateway-new' },
    })
  })

  it('fences an ambiguous commit instead of starting either generation', async () => {
    const fixture = await coordinatorFixture({
      commitCandidate: async () => { throw new Error('publication disconnected') },
      recoverCommit: async () => 'unknown',
    })
    await fixture.coordinator.initialize()
    const trial = await fixture.coordinator.prepare({
      releaseId: 'release-new',
      buildId: 'build-new',
      candidateGatewayNodeId: 'gateway-new',
    })

    await expect(fixture.coordinator.promote(trial.updateId!, 'force'))
      .rejects.toThrow('publication disconnected')
    await expect(fixture.coordinator.status()).resolves.toMatchObject({
      phase: 'repair_required',
      generation: 0,
      detail: expect.stringContaining('execution remains fenced'),
    })
  })

  it('finishes an interrupted committed transaction without replaying transfer', async () => {
    const fixture = await coordinatorFixture({ recoverCommit: async () => 'committed' })
    await writeFile(fixture.statePath, `${JSON.stringify({
      version: 1,
      status: {
        version: 1,
        strategy: 'blue-green-v1',
        maxDeployments: 2,
        computerId: 'computer-1',
        generation: 5,
        phase: 'committing',
        active,
        candidate: {
          gatewayNodeId: 'gateway-new',
          releaseId: 'release-new',
          buildId: 'build-new',
          projectCount: 3,
          sessionCount: 6,
        },
        updateId: 'update-1',
        updatedAt: 10,
      },
      commitStarted: true,
    })}\n`, { mode: 0o600 })

    await fixture.coordinator.initialize()

    await expect(fixture.coordinator.status()).resolves.toMatchObject({
      phase: 'steady',
      generation: 6,
      active: { gatewayNodeId: 'gateway-new' },
    })
    const persisted = JSON.parse(await readFile(fixture.statePath, 'utf8'))
    expect(persisted).not.toHaveProperty('commitStarted')
  })

  it('automatically retries a persisted pre-commit repair on startup', async () => {
    const rollbackPreCommit = vi.fn(async transition => ({
      active: transition.active,
      candidate: transition.candidate,
    }))
    const fixture = await coordinatorFixture({ rollbackPreCommit })
    await writeFile(fixture.statePath, `${JSON.stringify({
      version: 1,
      status: {
        version: 1,
        strategy: 'blue-green-v1',
        maxDeployments: 2,
        computerId: 'computer-1',
        generation: 0,
        phase: 'repair_required',
        active,
        candidate: {
          gatewayNodeId: 'gateway-new',
          releaseId: 'release-new',
          buildId: 'build-new',
          projectCount: 1,
          sessionCount: 0,
        },
        updateId: 'update-1',
        detail: 'pre-commit rollback was interrupted',
        updatedAt: 10,
      },
    })}\n`, { mode: 0o600 })

    await fixture.coordinator.initialize()

    expect(rollbackPreCommit).toHaveBeenCalledOnce()
    await expect(fixture.coordinator.status()).resolves.toMatchObject({
      phase: 'trial',
      active: { gatewayNodeId: 'gateway-old' },
      candidate: { gatewayNodeId: 'gateway-new' },
    })
  })

  it('reconciles a steady deployment after an external release activation', async () => {
    const fixture = await coordinatorFixture()
    await writeFile(fixture.statePath, `${JSON.stringify({
      version: 1,
      status: {
        version: 1,
        strategy: 'blue-green-v1',
        maxDeployments: 2,
        computerId: 'computer-1',
        generation: 3,
        phase: 'steady',
        active: {
          ...active,
          releaseId: 'release-stale',
          buildId: 'build-stale',
          projectCount: 9,
          sessionCount: 12,
        },
        detail: 'Candidate Gateway was discarded',
        updatedAt: 10,
      },
    })}\n`, { mode: 0o600 })

    await fixture.coordinator.initialize()

    await expect(fixture.coordinator.status()).resolves.toMatchObject({
      phase: 'steady',
      generation: 4,
      active,
      detail: 'Active Gateway reconciled with the installed release',
    })
  })

  it('refreshes steady slot counts without inventing a deployment generation', async () => {
    const fixture = await coordinatorFixture()
    await writeFile(fixture.statePath, `${JSON.stringify({
      version: 1,
      status: {
        version: 1,
        strategy: 'blue-green-v1',
        maxDeployments: 2,
        computerId: 'computer-1',
        generation: 3,
        phase: 'steady',
        active: {
          ...active,
          projectCount: 9,
          sessionCount: 12,
        },
        updatedAt: 10,
      },
    })}\n`, { mode: 0o600 })

    await fixture.coordinator.initialize()

    await expect(fixture.coordinator.status()).resolves.toMatchObject({
      phase: 'steady',
      generation: 3,
      active,
    })
  })

  it('discards only candidate state and keeps the active generation', async () => {
    const discardCandidate = vi.fn(async () => undefined)
    const fixture = await coordinatorFixture({ discardCandidate })
    await fixture.coordinator.initialize()
    const trial = await fixture.coordinator.prepare({
      releaseId: 'release-new',
      buildId: 'build-new',
      candidateGatewayNodeId: 'gateway-new',
    })

    const steady = await fixture.coordinator.discard(trial.updateId!)

    expect(discardCandidate).toHaveBeenCalledOnce()
    expect(steady).toMatchObject({
      phase: 'steady',
      generation: 0,
      active: { gatewayNodeId: 'gateway-old' },
    })
    expect(steady).not.toHaveProperty('candidate')
  })
})

async function coordinatorFixture(
  dependencies: GatewayDeploymentCoordinatorDependencies = {},
  promotionDelayMs?: number,
): Promise<{
  coordinator: GatewayDeploymentCoordinator
  statePath: string
}> {
  const directory = await mkdtemp(join(tmpdir(), 'malink-gateway-deployment-'))
  temporaryDirectories.push(directory)
  const statePath = join(directory, 'deployment-state.json')
  return {
    statePath,
    coordinator: new GatewayDeploymentCoordinator({
      statePath,
      computerId: 'computer-1',
      active,
      ...(promotionDelayMs === undefined ? {} : { promotionDelayMs }),
    }, dependencies),
  }
}
