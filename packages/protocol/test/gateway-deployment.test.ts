import { describe, expect, it } from 'vitest'
import {
  gatewayDeploymentStatusSchema,
  mlp3CommandSchema,
  mlp3EventSchema,
} from '../src/index.js'

const active = {
  gatewayNodeId: 'gateway-old',
  releaseId: 'release-old',
  buildId: 'build-old',
  projectCount: 2,
  sessionCount: 4,
}

describe('Gateway blue/green deployment protocol', () => {
  it('requires exactly one active deployment in steady state', () => {
    expect(gatewayDeploymentStatusSchema.parse({
      version: 1,
      strategy: 'blue-green-v1',
      maxDeployments: 2,
      computerId: 'computer-1',
      generation: 3,
      phase: 'steady',
      active,
      updatedAt: 10,
    }).active.gatewayNodeId).toBe('gateway-old')

    expect(() => gatewayDeploymentStatusSchema.parse({
      version: 1,
      strategy: 'blue-green-v1',
      maxDeployments: 2,
      computerId: 'computer-1',
      generation: 3,
      phase: 'steady',
      active,
      candidate: { ...active, gatewayNodeId: 'gateway-new' },
      updateId: 'update-1',
      updatedAt: 10,
    })).toThrow('steady computer')
  })

  it('binds every transient phase to one distinct candidate and update', () => {
    expect(gatewayDeploymentStatusSchema.parse({
      version: 1,
      strategy: 'blue-green-v1',
      maxDeployments: 2,
      computerId: 'computer-1',
      generation: 3,
      phase: 'trial',
      active,
      candidate: {
        gatewayNodeId: 'gateway-new',
        releaseId: 'release-new',
        buildId: 'build-new',
        projectCount: 1,
        sessionCount: 1,
      },
      updateId: 'update-1',
      updatedAt: 11,
    }).maxDeployments).toBe(2)

    expect(() => gatewayDeploymentStatusSchema.parse({
      version: 1,
      strategy: 'blue-green-v1',
      maxDeployments: 2,
      computerId: 'computer-1',
      generation: 3,
      phase: 'trial',
      active,
      candidate: { ...active },
      updateId: 'update-1',
      updatedAt: 11,
    })).toThrow('distinct Gateway node IDs')
  })

  it('adds explicit prepare, promote, discard, and deployment status operations', () => {
    const common = {
      kind: 'malink.command' as const,
      version: 3 as const,
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      deviceId: 'device-1',
      certificateId: 'certificate-1',
      createdAt: 1,
    }
    for (const [commandId, operation, payload] of [
      ['prepare-1', 'gateway.update.prepare', {
        operation: 'gateway.update.prepare', releaseId: 'release-new',
      }],
      ['promote-1', 'gateway.update.promote', {
        operation: 'gateway.update.promote', updateId: 'update-1', mode: 'when_idle',
      }],
      ['discard-1', 'gateway.update.discard', {
        operation: 'gateway.update.discard', updateId: 'update-1',
      }],
      ['status-1', 'gateway.deployment.status', {
        operation: 'gateway.deployment.status',
      }],
    ] as const) {
      expect(mlp3CommandSchema.parse({
        ...common,
        commandId,
        operation,
        payload,
      }).operation).toBe(operation)
    }
  })

  it('carries deployment state as a separately signed MLP/3 event', () => {
    expect(mlp3EventSchema.parse({
      kind: 'malink.event',
      version: 3,
      eventId: 'deployment-status-1',
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      occurredAt: 12,
      payload: {
        type: 'gateway.deployment.status',
        status: {
          version: 1,
          strategy: 'blue-green-v1',
          maxDeployments: 2,
          computerId: 'computer-1',
          generation: 3,
          phase: 'steady',
          active,
          updatedAt: 12,
        },
      },
    }).payload.type).toBe('gateway.deployment.status')
  })
})
