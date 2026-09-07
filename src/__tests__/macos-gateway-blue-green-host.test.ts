import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
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
  it('never seals production when the disposable candidate cannot seal', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'malink-blue-green-seal-order-'))
    temporaryDirectories.push(directory)
    const installRoot = join(directory, 'install')
    await mkdir(installRoot, { recursive: true })
    const activeSocket = join(directory, 'active.sock')
    const candidateSocket = join(directory, 'candidate.sock')
    const sealed: string[] = []
    const sealForDeployment = vi.fn(async (socketPath: string) => {
      sealed.push(socketPath)
      if (socketPath === candidateSocket) throw new Error('candidate outbox is not drained')
    })
    const host = new MacosGatewayBlueGreenHost({
      installRoot,
      activeDataDirectory: join(directory, 'active'),
      activeAdminSocketPath: activeSocket,
      activeLaunchAgentPath: join(directory, 'active.plist'),
      activeServiceLabel: 'id.my.anciety.malink.test',
      updateSocketPath: join(directory, 'update.sock'),
      platform: 'darwin',
    }, {
      sealForDeployment,
      readStatus: async socketPath => gatewayStatus(
        socketPath === activeSocket ? 'gateway-old' : 'gateway-new',
        socketPath === activeSocket ? 'build-old' : 'build-new',
      ),
    })
    await writeFile(join(installRoot, 'deployment-host-state.json'), `${JSON.stringify({
      version: 1,
      deployment: {
        version: 1,
        phase: 'trial',
        updateId: 'update-1',
        sourceGatewayNodeId: 'gateway-old',
        candidateGatewayNodeId: 'gateway-new',
        workspaceId: 'workspace-1',
        releaseId: 'release-new',
        buildId: 'build-new',
        releaseDirectory: join(installRoot, 'releases', 'release-new'),
        candidateDirectory: join(installRoot, 'deployments', 'update-1', 'candidate-data'),
        candidateAdminSocket: candidateSocket,
        candidateLaunchAgent: join(installRoot, 'deployments', 'update-1', 'candidate.plist'),
        candidateServiceLabel: 'id.my.anciety.malink.test.candidate',
        sourceProjectCount: 1,
        sourceSessionCount: 2,
        candidateProjectCount: 1,
        candidateSessionCount: 0,
        updatedAt: Date.now(),
      },
    })}\n`, { mode: 0o600 })

    await expect(host.drainDeployments({
      updateId: 'update-1',
      computerId: 'computer-1',
      generation: 0,
      mode: 'when_idle',
      active: {
        gatewayNodeId: 'gateway-old',
        releaseId: 'release-old',
        buildId: 'build-old',
        projectCount: 1,
        sessionCount: 2,
      },
      candidate: {
        gatewayNodeId: 'gateway-new',
        releaseId: 'release-new',
        buildId: 'build-new',
        projectCount: 1,
        sessionCount: 0,
      },
    })).rejects.toThrow('candidate outbox is not drained')

    expect(sealed).toEqual([candidateSocket])
  })

  it('stops an idle legacy active Gateway and preserves its durable outbox for takeover', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'malink-blue-green-outbox-takeover-'))
    temporaryDirectories.push(directory)
    const installRoot = join(directory, 'install')
    const activeSocket = join(directory, 'active.sock')
    const candidateSocket = join(directory, 'candidate.sock')
    const activeLabel = 'id.my.anciety.malink.test'
    const candidateLabel = `${activeLabel}.candidate`
    await mkdir(installRoot, { recursive: true })
    const activeSeal = new Promise<void>(() => undefined)
    const sealForDeployment = vi.fn((socketPath: string) =>
      socketPath === activeSocket ? activeSeal : Promise.resolve())
    const launchctl = vi.fn(async () => undefined)
    const host = new MacosGatewayBlueGreenHost({
      installRoot,
      activeDataDirectory: join(directory, 'active'),
      activeAdminSocketPath: activeSocket,
      activeLaunchAgentPath: join(directory, 'active.plist'),
      activeServiceLabel: activeLabel,
      updateSocketPath: join(directory, 'update.sock'),
      durableQueueQuiescenceMs: 0,
      platform: 'darwin',
      uid: 501,
    }, {
      sealForDeployment,
      launchctl,
      isServiceLoaded: async () => false,
      readStatus: async socketPath => ({
        ...gatewayStatus(
          socketPath === activeSocket ? 'gateway-old' : 'gateway-new',
          socketPath === activeSocket ? 'build-old' : 'build-new',
        ),
        activeTurns: 0,
        activeCommands: 0,
        pendingOutboxDeliveries: socketPath === activeSocket ? 19 : 0,
        pendingInboxEvents: 0,
      }),
    })
    await writeHostState(installRoot, {
      activeSocket,
      candidateSocket,
      candidateLabel,
    })

    await expect(host.drainDeployments(deploymentTransition())).resolves.toMatchObject({
      active: { gatewayNodeId: 'gateway-old' },
      candidate: { gatewayNodeId: 'gateway-new' },
    })

    expect(sealForDeployment).toHaveBeenNthCalledWith(1, candidateSocket, 'when_idle')
    expect(sealForDeployment).toHaveBeenNthCalledWith(2, activeSocket, 'when_idle')
    expect(launchctl).toHaveBeenCalledWith(['bootout', `gui/501/${activeLabel}`])
  })

  it('does not take over an active Gateway with unprocessed inbox commands', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'malink-blue-green-inbox-fence-'))
    temporaryDirectories.push(directory)
    const installRoot = join(directory, 'install')
    const activeSocket = join(directory, 'active.sock')
    const candidateSocket = join(directory, 'candidate.sock')
    const candidateLabel = 'id.my.anciety.malink.test.candidate'
    await mkdir(installRoot, { recursive: true })
    const sealForDeployment = vi.fn(async () => undefined)
    const host = new MacosGatewayBlueGreenHost({
      installRoot,
      activeDataDirectory: join(directory, 'active'),
      activeAdminSocketPath: activeSocket,
      activeLaunchAgentPath: join(directory, 'active.plist'),
      activeServiceLabel: 'id.my.anciety.malink.test',
      updateSocketPath: join(directory, 'update.sock'),
      platform: 'darwin',
    }, {
      sealForDeployment,
      readStatus: async socketPath => ({
        ...gatewayStatus(
          socketPath === activeSocket ? 'gateway-old' : 'gateway-new',
          socketPath === activeSocket ? 'build-old' : 'build-new',
        ),
        pendingOutboxDeliveries: socketPath === activeSocket ? 19 : 0,
        pendingInboxEvents: socketPath === activeSocket ? 1 : 0,
      }),
    })
    await writeHostState(installRoot, {
      activeSocket,
      candidateSocket,
      candidateLabel,
    })

    await expect(host.drainDeployments(deploymentTransition())).rejects.toThrow(
      '1 inbox record(s) pending',
    )
    expect(sealForDeployment).toHaveBeenCalledTimes(1)
    expect(sealForDeployment).toHaveBeenCalledWith(candidateSocket, 'when_idle')
  })

  it('waits for launchd unload and leaves an already-healthy active Gateway running', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'malink-blue-green-launchd-rollback-'))
    temporaryDirectories.push(directory)
    const installRoot = join(directory, 'install')
    const activePlist = join(directory, 'active.plist')
    const activeSocket = join(directory, 'active.sock')
    const candidateSocket = join(directory, 'candidate.sock')
    const candidateLabel = 'id.my.anciety.malink.test.candidate'
    const candidateService = `gui/501/${candidateLabel}`
    await mkdir(installRoot, { recursive: true })
    await writeFile(activePlist, launchAgentPlist('id.my.anciety.malink.test'), 'utf8')
    let candidateLoaded = true
    let unloadPolls = 0
    const launchctlCalls: string[][] = []
    const sleep = vi.fn(async () => undefined)
    const host = new MacosGatewayBlueGreenHost({
      installRoot,
      activeDataDirectory: join(directory, 'active'),
      activeAdminSocketPath: activeSocket,
      activeLaunchAgentPath: activePlist,
      activeServiceLabel: 'id.my.anciety.malink.test',
      updateSocketPath: join(directory, 'update.sock'),
      platform: 'darwin',
      uid: 501,
    }, {
      sleep,
      launchctl: async arguments_ => {
        launchctlCalls.push([...arguments_])
        if (arguments_[0] === 'bootout' && arguments_[1] === candidateService) {
          // launchd may keep a job registered beyond the old two-second wait
          // while its process completes the configured graceful-exit window.
          if (candidateLoaded) unloadPolls = 25
          return
        }
        if (arguments_[0] === 'bootstrap') {
          if (candidateLoaded) throw new Error('bootstrap exited with 5')
          candidateLoaded = true
        }
      },
      isServiceLoaded: async service => {
        if (service !== candidateService) return true
        if (unloadPolls > 0) {
          unloadPolls -= 1
          if (unloadPolls === 0) candidateLoaded = false
        }
        return candidateLoaded
      },
      readStatus: async socketPath => gatewayStatus(
        socketPath === activeSocket ? 'gateway-old' : 'gateway-new',
        socketPath === activeSocket ? 'build-old' : 'build-new',
      ),
    })
    await writeFile(join(installRoot, 'deployment-host-state.json'), `${JSON.stringify({
      version: 1,
      deployment: {
        version: 1,
        phase: 'trial',
        updateId: 'update-1',
        sourceGatewayNodeId: 'gateway-old',
        candidateGatewayNodeId: 'gateway-new',
        workspaceId: 'workspace-1',
        releaseId: 'release-new',
        buildId: 'build-new',
        releaseDirectory: join(installRoot, 'releases', 'release-new'),
        candidateDirectory: join(installRoot, 'deployments', 'update-1', 'candidate-data'),
        candidateAdminSocket: candidateSocket,
        candidateLaunchAgent: join(installRoot, 'deployments', 'update-1', 'candidate.plist'),
        candidateServiceLabel: candidateLabel,
        sourceProjectCount: 1,
        sourceSessionCount: 2,
        candidateProjectCount: 1,
        candidateSessionCount: 0,
        updatedAt: Date.now(),
      },
    })}\n`, { mode: 0o600 })
    const transition = {
      updateId: 'update-1',
      computerId: 'computer-1',
      generation: 0,
      active: {
        gatewayNodeId: 'gateway-old',
        releaseId: 'release-old',
        buildId: 'build-old',
        projectCount: 1,
        sessionCount: 2,
      },
      candidate: {
        gatewayNodeId: 'gateway-new',
        releaseId: 'release-new',
        buildId: 'build-new',
        projectCount: 1,
        sessionCount: 0,
      },
    }

    await expect(host.rollbackPreCommit(transition)).resolves.toMatchObject({
      active: { gatewayNodeId: 'gateway-old' },
      candidate: { gatewayNodeId: 'gateway-new' },
    })

    expect(sleep).toHaveBeenCalled()
    expect(launchctlCalls.some(arguments_ =>
      arguments_.some(value => value.includes('id.my.anciety.malink.test'))
      && !arguments_.some(value => value.includes(candidateLabel))
    )).toBe(false)
    expect(launchctlCalls).toContainEqual(['bootstrap', 'gui/501', expect.any(String)])
    expect(launchctlCalls).toContainEqual(['kickstart', '-k', candidateService])
  })

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

function gatewayStatus(gatewayNodeId: string, buildId: string) {
  return {
    version: 1 as const,
    gatewayId: 'workspace-1',
    workspaceId: 'workspace-1',
    gatewayNodeId,
    gatewayShortId: gatewayNodeId,
    gatewayName: gatewayNodeId,
    state: 'running',
    pid: 1,
    startedAt: Date.now(),
    activeDeviceCount: 1,
    openInvitationCount: 0,
    buildId,
    projectCount: 1,
    sessionCount: gatewayNodeId === 'gateway-old' ? 2 : 0,
    shadowRoomCount: gatewayNodeId === 'gateway-new' ? 1 : 0,
    deploymentFenced: false,
    matrixReady: true,
    lastMatrixSyncAt: Date.now(),
  }
}

async function writeHostState(
  installRoot: string,
  input: { activeSocket: string; candidateSocket: string; candidateLabel: string },
): Promise<void> {
  await writeFile(join(installRoot, 'deployment-host-state.json'), `${JSON.stringify({
    version: 1,
    deployment: {
      version: 1,
      phase: 'trial',
      updateId: 'update-1',
      sourceGatewayNodeId: 'gateway-old',
      candidateGatewayNodeId: 'gateway-new',
      workspaceId: 'workspace-1',
      releaseId: 'release-new',
      buildId: 'build-new',
      releaseDirectory: join(installRoot, 'releases', 'release-new'),
      candidateDirectory: join(installRoot, 'deployments', 'update-1', 'candidate-data'),
      candidateAdminSocket: input.candidateSocket,
      candidateLaunchAgent: join(installRoot, 'deployments', 'update-1', 'candidate.plist'),
      candidateServiceLabel: input.candidateLabel,
      sourceProjectCount: 1,
      sourceSessionCount: 2,
      candidateProjectCount: 1,
      candidateSessionCount: 0,
      updatedAt: Date.now(),
    },
  })}\n`, { mode: 0o600 })
}

function deploymentTransition() {
  return {
    updateId: 'update-1',
    computerId: 'computer-1',
    generation: 0,
    mode: 'when_idle' as const,
    active: {
      gatewayNodeId: 'gateway-old',
      releaseId: 'release-old',
      buildId: 'build-old',
      projectCount: 1,
      sessionCount: 2,
    },
    candidate: {
      gatewayNodeId: 'gateway-new',
      releaseId: 'release-new',
      buildId: 'build-new',
      projectCount: 1,
      sessionCount: 0,
    },
  }
}

function launchAgentPlist(label: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array><string>/host</string><string>/old/ops/matrix-local-gateway.js</string></array>
  <key>EnvironmentVariables</key><dict></dict>
  <key>StandardOutPath</key><string>/tmp/gateway.log</string>
  <key>StandardErrorPath</key><string>/tmp/gateway.error.log</string>
</dict>
</plist>
`
}
