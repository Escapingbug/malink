import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FileGatewayIdentityStore } from '@/gateway/pairing'
import {
  inspectGatewayDeploymentSlot,
  macosGatewayCandidateAdminSocketPath,
  MacosGatewayBlueGreenHost,
} from '@/ops/macosGatewayBlueGreenHost'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path =>
    rm(path, { recursive: true, force: true })))
})

describe('MacosGatewayBlueGreenHost', () => {
  it('treats a discarded already-cleaned candidate as success', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'malink-blue-green-idempotent-discard-'))
    temporaryDirectories.push(directory)
    const host = new MacosGatewayBlueGreenHost({
      installRoot: join(directory, 'install'),
      activeDataDirectory: join(directory, 'active'),
      activeAdminSocketPath: join(directory, 'active.sock'),
      activeLaunchAgentPath: join(directory, 'active.plist'),
      activeServiceLabel: 'id.my.anciety.malink.test',
      updateSocketPath: join(directory, 'update.sock'),
      platform: 'darwin',
    })

    await expect(host.discardCandidate({
      updateId: 'update-1',
      computerId: 'computer-1',
      generation: 0,
      active: {
        gatewayNodeId: 'gateway-old',
        buildId: 'build-old',
        projectCount: 1,
        sessionCount: 1,
      },
      candidate: {
        gatewayNodeId: 'gateway-new',
        releaseId: 'release-new',
        buildId: 'build-new',
        projectCount: 0,
        sessionCount: 0,
      },
    })).resolves.toBeUndefined()
  })

  it('keeps candidate admin sockets within the macOS Unix path limit', () => {
    const updateId = 'b8de49e1-ed61-4544-b229-8127fd2ed14c'
    const installRoot = '/Users/user/.local/share/malink-matrix'
    const legacyPath = join(installRoot, 'deployments', updateId, 'candidate-admin.sock')
    const socketPath = macosGatewayCandidateAdminSocketPath(installRoot, updateId)

    expect(Buffer.byteLength(legacyPath)).toBeGreaterThan(103)
    expect(Buffer.byteLength(socketPath)).toBeLessThanOrEqual(103)
    expect(socketPath).toMatch(/\/run\/[a-f0-9]{20}\.sock$/u)
  })

  it('inspects the exact active deployment identity, projects, and sessions', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'malink-blue-green-slot-'))
    temporaryDirectories.push(directory)
    await new FileGatewayIdentityStore(join(directory, 'gateway-identity.json'))
      .loadOrCreate('workspace-1', 1)
    await writeFile(join(directory, 'gateway-projects.json'), `${JSON.stringify({
      version: 1,
      gatewayNodeId: 'workspace-1',
      projects: [
        { projectId: 'project-1' },
        { projectId: 'project-2' },
      ],
    })}\n`, { mode: 0o600 })
    await writeFile(
      join(directory, 'gateway-replay.jsonl.v3-runtime-state.json'),
      `${JSON.stringify({
        version: 3,
        workspaceId: 'workspace-1',
        projects: {
          '!one:example.org': { sessions: [{ id: 'session-1' }] },
          '!two:example.org': { sessions: [{ id: 'session-2' }, { id: 'session-3' }] },
        },
      })}\n`,
      { mode: 0o600 },
    )

    await expect(inspectGatewayDeploymentSlot({
      dataDirectory: directory,
      releaseId: 'release-1',
      buildId: 'build-1',
    })).resolves.toEqual({
      gatewayNodeId: 'workspace-1',
      releaseId: 'release-1',
      buildId: 'build-1',
      projectCount: 2,
      sessionCount: 3,
    })
  })

  it('refuses to host launchd deployments on another platform', () => {
    expect(() => new MacosGatewayBlueGreenHost({
      installRoot: '/tmp/malink-test-install',
      activeDataDirectory: '/tmp/malink-test-data',
      activeAdminSocketPath: '/tmp/malink-test-admin.sock',
      activeLaunchAgentPath: '/tmp/malink-test.plist',
      activeServiceLabel: 'id.my.anciety.malink.test',
      updateSocketPath: '/tmp/malink-test-update.sock',
      platform: 'linux',
    })).toThrow('requires macOS launchd')
  })
})
