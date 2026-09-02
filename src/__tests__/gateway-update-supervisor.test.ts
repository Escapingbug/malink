import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  canonicalJsonBytes,
  type GatewayAgentUpdateChannel,
  type GatewayAgentUpdatePrompt,
  type GatewayReleaseManifest,
  type PairingPublicKey,
  type SignedGatewayAgentUpdateChannel,
  type SignedGatewayAgentUpdatePrompt,
  type SignedGatewayReleaseManifest,
} from '@malink/protocol'
import {
  base64UrlEncode,
  generateDeviceKeyPair,
  toArrayBuffer,
  webCrypto,
} from '@malink/security'
import { GatewayUpdateSupervisor } from '@/ops/gatewayUpdateSupervisor'
import {
  GatewayUpdateSupervisorClient,
  startGatewayUpdateSupervisorServer,
} from '@/ops/gatewayUpdateSupervisorServer'
import { runGatewayAgentUpdateCli } from '@/ops/gatewayAgentUpdateCli'
import { GATEWAY_STATE_CATALOG } from '@/gateway/matrix/stateUpgradeCatalog'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path =>
    rm(path, { recursive: true, force: true })))
})

describe('GatewayUpdateSupervisor', () => {
  it('serves validated status and staging operations over the owner Unix socket', async () => {
    const fixture = await releaseFixture()
    const supervisor = new GatewayUpdateSupervisor(fixture.config, {
      fetch: fixture.fetch,
    })
    await supervisor.initialize()
    const server = await startGatewayUpdateSupervisorServer({
      socketPath: join(fixture.installRoot, 'supervisor.sock'),
      supervisor,
    })
    try {
      const client = new GatewayUpdateSupervisorClient(server.socketPath, 5_000)
      await expect(client.status()).resolves.toMatchObject({
        phase: 'idle',
        currentBuildId: 'build-1',
      })
      await expect(client.acknowledgeGatewayRecovery()).resolves.toMatchObject({
        phase: 'idle',
        currentBuildId: 'build-1',
      })
      await expect(client.stage('release-2')).resolves.toMatchObject({
        phase: 'staged',
        releaseId: 'release-2',
        targetBuildId: 'build-2',
      })
      await expect(client.scheduleApply('release-2', true)).resolves.toMatchObject({
        phase: 'scheduled',
        releaseId: 'release-2',
      })
    } finally {
      await server.stop()
      await supervisor.stop()
    }
  })

  it('classifies an unpublished Prompt as deterministic instead of retryable', async () => {
    const fixture = await agentUpdateFixture()
    const supervisor = new GatewayUpdateSupervisor(fixture.config, {
      fetch: async () => new Response('missing', { status: 404 }),
    })
    await supervisor.initialize()
    const server = await startGatewayUpdateSupervisorServer({
      socketPath: join(fixture.installRoot, 'supervisor.sock'),
      supervisor,
    })
    try {
      const client = new GatewayUpdateSupervisorClient(server.socketPath, 5_000)
      const failure = await client.stage('release-2').catch(error => error as {
        commandCode?: string
        retryable?: boolean
        message?: string
      })
      expect(failure).toMatchObject({
        commandCode: 'gateway_update_release_unavailable',
        retryable: false,
        message: 'Gateway Agent update Prompt returned HTTP 404',
      })
      await expect(client.status()).resolves.toMatchObject({
        phase: 'failed',
        releaseId: 'release-2',
        detail: 'Gateway Agent update Prompt returned HTTP 404',
      })
    } finally {
      await server.stop()
      await supervisor.stop()
    }
  })

  it('offers a later retry after bounded transient Prompt failures are exhausted', async () => {
    const fixture = await agentUpdateFixture()
    const supervisor = new GatewayUpdateSupervisor(fixture.config, {
      fetch: async () => new Response('temporarily unavailable', { status: 503 }),
      sleep: async () => undefined,
    })
    await supervisor.initialize()
    const server = await startGatewayUpdateSupervisorServer({
      socketPath: join(fixture.installRoot, 'supervisor.sock'),
      supervisor,
    })
    try {
      const client = new GatewayUpdateSupervisorClient(server.socketPath, 5_000)
      const failure = await client.stage('release-2').catch(error => error as {
        commandCode?: string
        retryable?: boolean
      })
      expect(failure).toMatchObject({
        commandCode: 'gateway_update_transient_failure',
        retryable: true,
      })
    } finally {
      await server.stop()
      await supervisor.stop()
    }
  })

  it('does not expose manual retry after repeated release integrity failures', async () => {
    const fixture = await agentUpdateFixture()
    const supervisor = {
      async stage() {
        throw new Error('Gateway release file runtime/node failed integrity verification')
      },
    } as unknown as GatewayUpdateSupervisor
    const server = await startGatewayUpdateSupervisorServer({
      socketPath: join(fixture.installRoot, 'supervisor.sock'),
      supervisor,
    })
    try {
      const client = new GatewayUpdateSupervisorClient(server.socketPath, 5_000)
      const failure = await client.stage('release-2').catch(error => error as {
        commandCode?: string
        retryable?: boolean
      })
      expect(failure).toMatchObject({
        commandCode: 'gateway_update_invalid_release',
        retryable: false,
      })
    } finally {
      await server.stop()
    }
  })

  it('stages signed files and schedules an independently owned activation', async () => {
    const fixture = await releaseFixture()
    const activate = vi.fn(async () => undefined)
    const supervisor = new GatewayUpdateSupervisor({
      ...fixture.config,
      activationDelayMs: 0,
      probationMs: 0,
    }, {
      fetch: fixture.fetch,
      activate,
    })
    await supervisor.initialize()

    await expect(supervisor.stage('release-2')).resolves.toMatchObject({
      phase: 'staged',
      releaseId: 'release-2',
      targetBuildId: 'build-2',
    })
    await expect(readFile(
      join(fixture.installRoot, 'releases', 'release-2', 'ops', 'matrix-local-gateway.js'),
      'utf8',
    )).resolves.toBe('// gateway release 2\n')

    await expect(supervisor.scheduleApply('release-2')).resolves.toMatchObject({
      phase: 'scheduled',
      previousReleaseId: 'release-1',
    })
    await vi.waitFor(async () => {
      expect(await supervisor.status()).toMatchObject({
        phase: 'committed',
        currentBuildId: 'build-2',
      })
    })
    expect(activate).toHaveBeenCalledWith(expect.objectContaining({
      releaseDirectory: join(fixture.installRoot, 'releases', 'release-2'),
      expectedBuildId: 'build-2',
      requireDeepHealth: true,
    }))
  })

  it('runs a signed Prompt through an Agent workspace and seals only the local result', async () => {
    const fixture = await agentUpdateFixture()
    const activate = vi.fn(async () => undefined)
    const requestedUrls: string[] = []
    const fetchMock = vi.fn(async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      requestedUrls.push(String(input))
      return fixture.fetch(input, init)
    }) as unknown as typeof fetch
    const supervisor = new GatewayUpdateSupervisor({
      ...fixture.config,
      activationDelayMs: 0,
      probationMs: 0,
    }, { fetch: fetchMock, activate })
    await supervisor.initialize()
    const server = await startGatewayUpdateSupervisorServer({
      socketPath: join(fixture.installRoot, 'supervisor.sock'),
      supervisor,
    })
    try {
      const client = new GatewayUpdateSupervisorClient(server.socketPath, 5_000)
      await expect(client.stage('release-2')).resolves.toMatchObject({
        phase: 'agent_required',
        releaseId: 'release-2',
        targetBuildId: 'build-2',
      })
      expect(requestedUrls).toEqual([
        'https://updates.example.test/agent-prompts/release-2.json',
      ])
      const instruction = await client.agentInstruction('release-2')
      expect(instruction).toMatchObject({
        releaseId: 'release-2',
        buildId: 'build-2',
        repository: {
          url: 'https://github.com/Escapingbug/malink.git',
          commit: '0123456789abcdef0123456789abcdef01234567',
        },
      })
      expect(instruction.submitCommand).toContain('gatewayAgentUpdateCli.js')
      expect(instruction.submitCommand).toContain(' finish ')
      expect(instruction.submitCommand).toContain(server.socketPath)
      await expect(client.beginAgentUpdate(
        'release-2',
        'maintenance-1',
        'stage-command-1',
      )).resolves.toMatchObject({
        started: true,
        status: {
          phase: 'agent_running',
          maintenanceSessionId: 'maintenance-1',
        },
      })
      await expect(client.beginAgentUpdate(
        'release-2',
        'maintenance-1',
        'stage-command-2',
      )).resolves.toMatchObject({
        started: false,
        status: {
          phase: 'agent_running',
          maintenanceSessionId: 'maintenance-1',
        },
      })

      await writeFile(
        join(instruction.candidateDirectory, 'ops', 'matrix-local-gateway.js'),
        '// Agent-built Gateway release 2\n',
      )
      await writeFile(
        join(instruction.candidateDirectory, 'ops', 'gatewayUpdateSupervisorMain.js'),
        '// Agent-built supervisor release 2\n',
      )
      await writeFile(
        join(instruction.candidateDirectory, 'ops', 'gatewayAgentUpdateCli.js'),
        '// Agent-built update CLI release 2\n',
      )
      await writeFile(
        join(instruction.candidateDirectory, 'ops', 'gatewayJournalRepairCli.js'),
        '// Agent-built journal repair CLI release 2\n',
      )
      await writeFile(
        join(instruction.candidateDirectory, 'mcp', 'stdio.js'),
        '// Agent-built MCP release 2\n',
      )
      await expect(runGatewayAgentUpdateCli([
        'finish',
        '--socket', server.socketPath,
        '--release-id', 'release-2',
      ])).resolves.toMatchObject({
        phase: 'staged',
        maintenanceSessionId: 'maintenance-1',
      })
      await writeFile(
        join(instruction.candidateDirectory, 'ops', 'matrix-local-gateway.js'),
        '// candidate changed after sealing\n',
      )
      await expect(readFile(
        join(fixture.installRoot, 'releases', 'release-2', 'ops', 'matrix-local-gateway.js'),
        'utf8',
      )).resolves.toBe('// Agent-built Gateway release 2\n')

      await expect(client.scheduleApply('release-2')).resolves.toMatchObject({
        phase: 'scheduled',
        previousReleaseId: 'release-1',
      })
      await vi.waitFor(async () => {
        expect(await client.status()).toMatchObject({
          phase: 'committed',
          currentBuildId: 'build-2',
          maintenanceSessionId: 'maintenance-1',
        })
      })
      expect(activate).toHaveBeenCalledWith(expect.objectContaining({
        releaseDirectory: join(fixture.installRoot, 'releases', 'release-2'),
        expectedBuildId: 'build-2',
      }))
    } finally {
      await server.stop()
      await supervisor.stop()
    }
  })

  it('pins a signed update channel and fails over between its release mirrors', async () => {
    const fixture = await agentUpdateFixture()
    const signedChannel = await signAgentUpdateChannel(fixture, {
      generation: 7,
      mirrors: [
        'https://one.example.test/gateway-agent-updates/',
        'https://two.example.test/gateway-agent-updates/',
      ],
    })
    const requestedUrls: string[] = []
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      requestedUrls.push(url)
      if (url === 'https://bootstrap.example.test/channels/stable.json') {
        return new Response(JSON.stringify(signedChannel), { status: 200 })
      }
      if (url.startsWith('https://one.example.test/')) {
        return new Response('temporarily unavailable', { status: 503 })
      }
      return fixture.fetch(input, init)
    }) as unknown as typeof fetch
    const supervisor = new GatewayUpdateSupervisor({
      ...fixture.config,
      agentChannelUrl: 'https://bootstrap.example.test/channels/stable.json',
    }, {
      fetch: fetchMock,
      sleep: async () => undefined,
    })
    await supervisor.initialize()

    await expect(supervisor.stage('release-2')).resolves.toMatchObject({
      phase: 'agent_required',
      releaseId: 'release-2',
      targetBuildId: 'build-2',
    })
    expect(requestedUrls[0]).toBe('https://bootstrap.example.test/channels/stable.json')
    expect(requestedUrls).toContain(
      'https://two.example.test/gateway-agent-updates/releases/release-2.json',
    )
    const state = JSON.parse(await readFile(
      join(fixture.installRoot, 'supervisor-state.json'),
      'utf8',
    )) as { agentChannel?: SignedGatewayAgentUpdateChannel }
    expect(state.agentChannel?.channel).toEqual(signedChannel.channel)
  })

  it('rejects a channel rollback after persisting a newer signed generation', async () => {
    const fixture = await agentUpdateFixture()
    const newer = await signAgentUpdateChannel(fixture, { generation: 8 })
    const older = await signAgentUpdateChannel(fixture, {
      generation: 7,
      releaseId: 'release-1',
      buildId: 'build-1',
    })
    let advertised = newer
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith('/channels/stable.json')) {
        return new Response(JSON.stringify(advertised), { status: 200 })
      }
      return fixture.fetch(input, init)
    }) as unknown as typeof fetch
    const supervisor = new GatewayUpdateSupervisor({
      ...fixture.config,
      agentChannelUrl: 'https://bootstrap.example.test/channels/stable.json',
    }, { fetch: fetchMock })
    await supervisor.initialize()
    await supervisor.stage('release-2')

    advertised = older
    await expect(supervisor.stage('release-1')).rejects.toThrow(
      /targets release-2, not release-1/u,
    )
    const state = JSON.parse(await readFile(
      join(fixture.installRoot, 'supervisor-state.json'),
      'utf8',
    )) as { agentChannel?: SignedGatewayAgentUpdateChannel }
    expect(state.agentChannel?.channel.generation).toBe(8)
  })

  it('migrates a legacy rd Prompt bootstrap to the signed GitHub Pages channel', async () => {
    const fixture = await agentUpdateFixture()
    const signedChannel = await signAgentUpdateChannel(fixture, {
      generation: 9,
      mirrors: ['https://escapingbug.github.io/malink/gateway-agent-updates/'],
    })
    const requestedUrls: string[] = []
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      requestedUrls.push(url)
      if (url === 'https://escapingbug.github.io/malink/gateway-agent-updates/channels/stable.json') {
        return new Response(JSON.stringify(signedChannel), { status: 200 })
      }
      if (url === 'https://rd.anciety.my.id/gateway-agent-updates/channels/stable.json') {
        return new Response('not mirrored yet', { status: 404 })
      }
      return fixture.fetch(input, init)
    }) as unknown as typeof fetch
    const supervisor = new GatewayUpdateSupervisor({
      ...fixture.config,
      agentPromptBaseUrl: 'https://rd.anciety.my.id/gateway-agent-updates/releases/',
    }, { fetch: fetchMock })
    await supervisor.initialize()

    await expect(supervisor.stage('release-2')).resolves.toMatchObject({
      phase: 'agent_required',
    })
    expect(requestedUrls).toContain(
      'https://escapingbug.github.io/malink/gateway-agent-updates/releases/release-2.json',
    )
    expect(requestedUrls).not.toContain(
      'https://rd.anciety.my.id/gateway-agent-updates/releases/release-2.json',
    )
  })

  it('does not replay the old rd Prompt path when migration channel verification fails', async () => {
    const fixture = await agentUpdateFixture()
    const requestedUrls: string[] = []
    const supervisor = new GatewayUpdateSupervisor({
      ...fixture.config,
      agentPromptBaseUrl: 'https://rd.anciety.my.id/gateway-agent-updates/releases/',
    }, {
      fetch: async input => {
        requestedUrls.push(String(input))
        return new Response('missing', { status: 404 })
      },
    })
    await supervisor.initialize()

    await expect(supervisor.stage('release-2')).rejects.toThrow(
      /update channel returned HTTP 404/u,
    )
    expect(requestedUrls).not.toContain(
      'https://rd.anciety.my.id/gateway-agent-updates/releases/release-2.json',
    )
  })

  it('statically checks Agent candidate entrypoints without executing them', async () => {
    const fixture = await agentUpdateFixture()
    const supervisor = new GatewayUpdateSupervisor(fixture.config, { fetch: fixture.fetch })
    await supervisor.initialize()
    await supervisor.stage('release-2')
    const instruction = await supervisor.agentInstruction('release-2')
    const executionMarker = join(fixture.installRoot, 'candidate-executed')
    await writeFile(
      join(instruction.candidateDirectory, 'ops', 'matrix-local-gateway.js'),
      `import { writeFile } from 'node:fs/promises'; await writeFile(${JSON.stringify(executionMarker)}, 'unsafe');\n`,
    )

    await expect(supervisor.submitAgentRelease('release-2')).resolves.toMatchObject({
      phase: 'staged',
    })
    await expect(readFile(executionMarker, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects invalid Agent candidate JavaScript through the finish boundary', async () => {
    const fixture = await agentUpdateFixture()
    const supervisor = new GatewayUpdateSupervisor(fixture.config, { fetch: fixture.fetch })
    await supervisor.initialize()
    await supervisor.stage('release-2')
    const instruction = await supervisor.agentInstruction('release-2')
    await writeFile(
      join(instruction.candidateDirectory, 'ops', 'matrix-local-gateway.js'),
      'const invalid = ;\n',
    )

    await expect(supervisor.submitAgentRelease('release-2')).rejects.toThrow(
      /failed static validation: ops\/matrix-local-gateway\.js/u,
    )
    await expect(supervisor.status()).resolves.toMatchObject({ phase: 'failed' })
  })

  it('converges a stale maintenance phase when the signed target is already installed', async () => {
    const fixture = await agentUpdateFixture()
    const supervisor = new GatewayUpdateSupervisor(fixture.config, { fetch: fixture.fetch })
    await supervisor.initialize()
    await supervisor.stage('release-2')
    const instruction = await supervisor.agentInstruction('release-2')
    await supervisor.beginAgentUpdate('release-2', 'maintenance-1', 'stage-command-1')
    await writeFile(
      join(instruction.candidateDirectory, 'ops', 'matrix-local-gateway.js'),
      '// Agent-built Gateway release 2\n',
    )
    await writeFile(
      join(instruction.candidateDirectory, 'ops', 'gatewayUpdateSupervisorMain.js'),
      '// Agent-built supervisor release 2\n',
    )
    await writeFile(
      join(instruction.candidateDirectory, 'ops', 'gatewayAgentUpdateCli.js'),
      '// Agent-built update CLI release 2\n',
    )
    await writeFile(
      join(instruction.candidateDirectory, 'ops', 'gatewayJournalRepairCli.js'),
      '// Agent-built journal repair CLI release 2\n',
    )
    await writeFile(
      join(instruction.candidateDirectory, 'mcp', 'stdio.js'),
      '// Agent-built MCP release 2\n',
    )
    await supervisor.submitAgentRelease('release-2')

    const statePath = join(fixture.installRoot, 'supervisor-state.json')
    const state = JSON.parse(await readFile(statePath, 'utf8')) as {
      status: { phase: string; detail?: string }
      agentOwnerCommandId?: string
    }
    state.status.phase = 'agent_running'
    state.status.detail = 'A stale maintenance process still appears to be running'
    state.agentOwnerCommandId = 'stage-command-1'
    await writeFile(statePath, `${JSON.stringify(state)}\n`)
    await rm(join(fixture.installRoot, 'current'))
    await symlink(
      join(fixture.installRoot, 'releases', 'release-2'),
      join(fixture.installRoot, 'current'),
    )

    await expect(supervisor.status()).resolves.toMatchObject({
      phase: 'committed',
      releaseId: 'release-2',
      targetBuildId: 'build-2',
      currentBuildId: 'build-2',
      maintenanceSessionId: 'maintenance-1',
    })
    const converged = JSON.parse(await readFile(statePath, 'utf8')) as {
      status: { phase: string; detail?: string }
      agentOwnerCommandId?: string
    }
    expect(converged.status.phase).toBe('committed')
    expect(converged.status.detail).toBeUndefined()
    expect(converged.agentOwnerCommandId).toBeUndefined()
  })

  it('acknowledges a healthy rollback after local journal repair', async () => {
    const fixture = await agentUpdateFixture()
    const now = 10_000
    const supervisor = new GatewayUpdateSupervisor({
      ...fixture.config,
      syncFreshnessMs: 5_000,
    }, {
      fetch: fixture.fetch,
      now: () => now,
      gatewayHealth: async () => ({
        version: 1,
        gatewayId: 'workspace-1',
        workspaceId: 'workspace-1',
        gatewayNodeId: 'node-1',
        gatewayShortId: 'NODE1',
        gatewayName: 'Test Gateway',
        state: 'running',
        pid: 123,
        startedAt: 1,
        activeDeviceCount: 1,
        openInvitationCount: 0,
        buildId: 'build-1',
        matrixReady: true,
        lastMatrixSyncAt: now - 1,
      }),
    })
    await supervisor.initialize()
    await supervisor.stage('release-2')
    const statePath = join(fixture.installRoot, 'supervisor-state.json')
    const state = JSON.parse(await readFile(statePath, 'utf8')) as {
      status: { phase: string; detail?: string }
    }
    state.status.phase = 'repair_required'
    state.status.detail = 'Activation and rollback health checks failed'
    await writeFile(statePath, `${JSON.stringify(state)}\n`)

    await expect(supervisor.acknowledgeGatewayRecovery()).resolves.toMatchObject({
      phase: 'rolled_back',
      currentBuildId: 'build-1',
      targetBuildId: 'build-2',
      detail: 'Gateway health was verified after local repair; the previous build remains active',
    })
  })

  it('converges a stale repair state when status proves the rollback healthy', async () => {
    const fixture = await agentUpdateFixture()
    const now = 10_000
    const supervisor = new GatewayUpdateSupervisor({
      ...fixture.config,
      syncFreshnessMs: 5_000,
    }, {
      fetch: fixture.fetch,
      now: () => now,
      gatewayHealth: async () => ({
        version: 1,
        gatewayId: 'workspace-1',
        workspaceId: 'workspace-1',
        gatewayNodeId: 'node-1',
        gatewayShortId: 'NODE1',
        gatewayName: 'Test Gateway',
        state: 'running',
        pid: 123,
        startedAt: 1,
        activeDeviceCount: 1,
        openInvitationCount: 0,
        buildId: 'build-1',
        matrixReady: true,
        lastMatrixSyncAt: now - 1,
      }),
    })
    await supervisor.initialize()
    await supervisor.stage('release-2')
    const statePath = join(fixture.installRoot, 'supervisor-state.json')
    const state = JSON.parse(await readFile(statePath, 'utf8')) as {
      status: { phase: string; detail?: string }
    }
    state.status.phase = 'repair_required'
    state.status.detail = 'Rollback health result arrived after the activation deadline'
    await writeFile(statePath, `${JSON.stringify(state)}\n`)

    await expect(supervisor.status()).resolves.toMatchObject({
      phase: 'rolled_back',
      currentBuildId: 'build-1',
      targetBuildId: 'build-2',
      detail: 'Gateway health was verified after local repair; the previous build remains active',
    })
  })

  it('copies and seals empty regular dependency files', async () => {
    const fixture = await agentUpdateFixture({ emptyAuxiliaryFile: true })
    const supervisor = new GatewayUpdateSupervisor(fixture.config, { fetch: fixture.fetch })
    await supervisor.initialize()

    await expect(supervisor.stage('release-2')).resolves.toMatchObject({
      phase: 'agent_required',
    })
    const instruction = await supervisor.agentInstruction('release-2')
    const emptyFile = join(
      'node_modules',
      'matrix-js-sdk',
      'lib',
      '@types',
      'another-json.d.js',
    )
    await expect(readFile(join(instruction.candidateDirectory, emptyFile))).resolves.toHaveLength(0)

    await expect(supervisor.submitAgentRelease('release-2')).resolves.toMatchObject({
      phase: 'staged',
    })
    await expect(readFile(
      join(fixture.installRoot, 'releases', 'release-2', emptyFile),
    )).resolves.toHaveLength(0)
    const seal = JSON.parse(await readFile(
      join(fixture.installRoot, 'releases', 'release-2', 'release-seal.json'),
      'utf8',
    )) as { files: Array<{ path: string; size: number; sha256: string }> }
    expect(seal.files).toContainEqual({
      path: emptyFile,
      size: 0,
      sha256: createHash('sha256').update('').digest('hex'),
    })
  })

  it('rejects an empty Agent-built supervisor entrypoint', async () => {
    const fixture = await agentUpdateFixture()
    const supervisor = new GatewayUpdateSupervisor(fixture.config, { fetch: fixture.fetch })
    await supervisor.initialize()
    await supervisor.stage('release-2')
    const instruction = await supervisor.agentInstruction('release-2')
    await writeFile(
      join(instruction.candidateDirectory, 'ops', 'gatewayUpdateSupervisorMain.js'),
      '',
    )

    await expect(supervisor.submitAgentRelease('release-2')).rejects.toThrow(
      /release entrypoint is empty: ops\/gatewayUpdateSupervisorMain\.js/u,
    )
    await expect(supervisor.status()).resolves.toMatchObject({ phase: 'failed' })
  })

  it('rejects a tampered Agent update Prompt before creating an Agent workspace', async () => {
    const fixture = await agentUpdateFixture({ tamperPrompt: true })
    const supervisor = new GatewayUpdateSupervisor(fixture.config, { fetch: fixture.fetch })
    await supervisor.initialize()

    await expect(supervisor.stage('release-2')).rejects.toThrow(/signature is invalid/u)
    await expect(supervisor.status()).resolves.toMatchObject({ phase: 'failed' })
    await expect(supervisor.agentInstruction('release-2')).rejects.toThrow(/not prepared/u)
  })

  it('lets only the owning command fail or restart a maintenance Agent', async () => {
    const fixture = await agentUpdateFixture()
    const supervisor = new GatewayUpdateSupervisor(fixture.config, { fetch: fixture.fetch })
    await supervisor.initialize()
    await supervisor.stage('release-2')

    await expect(supervisor.beginAgentUpdate(
      'release-2',
      'maintenance-1',
      'stage-command-1',
    )).resolves.toMatchObject({ started: true })
    await expect(supervisor.failAgentUpdate(
      'release-2',
      'stage-command-2',
      'not the owner',
    )).resolves.toMatchObject({ phase: 'agent_running' })
    await expect(supervisor.failAgentUpdate(
      'release-2',
      'stage-command-1',
      'Agent process failed',
    )).resolves.toMatchObject({
      phase: 'failed',
      detail: 'Agent process failed',
    })

    await expect(supervisor.stage('release-2')).resolves.toMatchObject({
      phase: 'agent_required',
    })
    await expect(supervisor.beginAgentUpdate(
      'release-2',
      'maintenance-1',
      'stage-command-2',
    )).resolves.toMatchObject({ started: true })
  })

  it('reuses verified active-release files and downloads only changed files', async () => {
    const fixture = await releaseFixture()
    const requestedUrls: string[] = []
    const logs: string[] = []
    const fetchMock = vi.fn(async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      requestedUrls.push(String(input))
      return fixture.fetch(input, init)
    }) as unknown as typeof fetch
    const supervisor = new GatewayUpdateSupervisor(fixture.config, {
      fetch: fetchMock,
      onLog: message => logs.push(message),
    })
    await supervisor.initialize()

    await expect(supervisor.stage('release-2')).resolves.toMatchObject({ phase: 'staged' })

    expect(requestedUrls).toEqual([
      'https://updates.example.test/manifests/release-2.json',
      'https://updates.example.test/gateway.js',
      'https://updates.example.test/mcp.js',
      'https://updates.example.test/supervisor.js',
    ])
    expect(logs).toContain(
      '[gateway-update] staged release-2: reused 1 files (10 bytes), '
      + 'downloaded 3 files (69 bytes)',
    )

    const stagedRuntime = join(
      fixture.installRoot,
      'releases',
      'release-2',
      'runtime',
      'node',
    )
    await writeFile(stagedRuntime, '#!/bin/changed\n')
    await expect(readFile(
      join(fixture.installRoot, 'releases', 'release-1', 'runtime', 'node'),
      'utf8',
    )).resolves.toBe('#!/bin/sh\n')
  })

  it('downloads a signed file when the active-release copy has the wrong hash', async () => {
    const fixture = await releaseFixture()
    await writeFile(
      join(fixture.installRoot, 'releases', 'release-1', 'runtime', 'node'),
      '#!/bin/xx\n',
      { mode: 0o755 },
    )
    const requestedUrls: string[] = []
    const fetchMock = vi.fn(async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      requestedUrls.push(String(input))
      return fixture.fetch(input, init)
    }) as unknown as typeof fetch
    const supervisor = new GatewayUpdateSupervisor(fixture.config, { fetch: fetchMock })
    await supervisor.initialize()

    await expect(supervisor.stage('release-2')).resolves.toMatchObject({ phase: 'staged' })
    expect(requestedUrls).toContain('https://updates.example.test/runtime-node')
    await expect(readFile(
      join(fixture.installRoot, 'releases', 'release-2', 'runtime', 'node'),
      'utf8',
    )).resolves.toBe('#!/bin/sh\n')
  })

  it('does not reuse a symbolic link from the active release', async () => {
    const fixture = await releaseFixture()
    const activeRuntime = join(
      fixture.installRoot,
      'releases',
      'release-1',
      'runtime',
      'node',
    )
    const externalRuntime = join(fixture.installRoot, 'external-runtime')
    await writeFile(externalRuntime, '#!/bin/sh\n', { mode: 0o755 })
    await rm(activeRuntime)
    await symlink(externalRuntime, activeRuntime)
    const requestedUrls: string[] = []
    const fetchMock = vi.fn(async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      requestedUrls.push(String(input))
      return fixture.fetch(input, init)
    }) as unknown as typeof fetch
    const supervisor = new GatewayUpdateSupervisor(fixture.config, { fetch: fetchMock })
    await supervisor.initialize()

    await expect(supervisor.stage('release-2')).resolves.toMatchObject({ phase: 'staged' })
    expect(requestedUrls).toContain('https://updates.example.test/runtime-node')
  })

  it('requests identity encoding and verifies a transparently decoded response body', async () => {
    const fixture = await releaseFixture()
    const artifactRequests: RequestInit[] = []
    const fetchMock = vi.fn(async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const response = await fixture.fetch(input, init)
      if (String(input).endsWith('/release-2.json')) return response
      artifactRequests.push(init ?? {})
      return new Response(await response.arrayBuffer(), {
        status: response.status,
        headers: {
          'content-encoding': 'gzip',
          // Fetch exposes the encoded transfer length after decoding the body.
          'content-length': '1',
        },
      })
    }) as unknown as typeof fetch
    const supervisor = new GatewayUpdateSupervisor(fixture.config, { fetch: fetchMock })
    await supervisor.initialize()

    await expect(supervisor.stage('release-2')).resolves.toMatchObject({ phase: 'staged' })
    expect(artifactRequests).toHaveLength(3)
    for (const request of artifactRequests) {
      expect(new Headers(request.headers).get('accept-encoding')).toBe('identity')
    }
  })

  it('retries transient manifest and artifact download failures', async () => {
    const fixture = await releaseFixture()
    const failures = new Map<string, number>()
    const logs: string[] = []
    const fetchMock = vi.fn(async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url = String(input)
      const attempts = failures.get(url) ?? 0
      failures.set(url, attempts + 1)
      if (attempts === 0 && url.endsWith('/release-2.json')) {
        throw new TypeError('fetch failed')
      }
      if (attempts === 0 && url.endsWith('/gateway.js')) {
        return new Response('temporarily unavailable', { status: 503 })
      }
      return fixture.fetch(input, init)
    }) as unknown as typeof fetch
    const supervisor = new GatewayUpdateSupervisor(fixture.config, {
      fetch: fetchMock,
      sleep: async () => undefined,
      onLog: message => logs.push(message),
    })
    await supervisor.initialize()

    await expect(supervisor.stage('release-2')).resolves.toMatchObject({ phase: 'staged' })
    expect(logs).toContain(
      '[gateway-update] manifest download failed transiently; '
      + 'retrying in 250ms: fetch failed',
    )
    expect(logs).toContain(
      '[gateway-update] file ops/matrix-local-gateway.js download failed transiently; '
      + 'retrying in 250ms: Gateway release file ops/matrix-local-gateway.js returned HTTP 503',
    )
  })

  it('records an automatic rollback outcome without losing the previous target', async () => {
    const fixture = await releaseFixture()
    const supervisor = new GatewayUpdateSupervisor({
      ...fixture.config,
      activationDelayMs: 0,
    }, {
      fetch: fixture.fetch,
      activate: async () => {
        throw new Error('activation failed and was rolled back: unhealthy')
      },
    })
    await supervisor.initialize()
    await supervisor.stage('release-2')
    await supervisor.scheduleApply('release-2')

    await vi.waitFor(async () => {
      expect(await supervisor.status()).toMatchObject({
        phase: 'rolled_back',
        previousReleaseId: 'release-1',
      })
    })
  })

  it('rechecks every staged file before scheduling activation', async () => {
    const fixture = await releaseFixture()
    const supervisor = new GatewayUpdateSupervisor({
      ...fixture.config,
      activationDelayMs: 60_000,
    }, { fetch: fixture.fetch })
    await supervisor.initialize()
    await supervisor.stage('release-2')
    await writeFile(
      join(fixture.installRoot, 'releases', 'release-2', 'ops', 'matrix-local-gateway.js'),
      '// gateway release X\n',
    )

    await expect(supervisor.scheduleApply('release-2')).rejects.toThrow(
      /failed integrity verification/u,
    )
    await expect(supervisor.status()).resolves.toMatchObject({ phase: 'staged' })
  })

  it('treats a signed release for the already active build as an idempotent commit', async () => {
    const fixture = await releaseFixture({ reuseActiveBuildId: true })
    const supervisor = new GatewayUpdateSupervisor(fixture.config, {
      fetch: fixture.fetch,
    })
    await supervisor.initialize()

    await expect(supervisor.stage('release-2')).resolves.toMatchObject({
      phase: 'committed',
      releaseId: 'release-2',
      currentBuildId: 'build-1',
      targetBuildId: 'build-1',
    })
  })

  it('deduplicates concurrent PWA attempts after a release is staged or scheduled', async () => {
    const fixture = await releaseFixture()
    const supervisor = new GatewayUpdateSupervisor({
      ...fixture.config,
      activationDelayMs: 60_000,
    }, { fetch: fixture.fetch })
    await supervisor.initialize()

    await supervisor.stage('release-2')
    await expect(supervisor.stage('release-2')).resolves.toMatchObject({ phase: 'staged' })
    await supervisor.scheduleApply('release-2')
    await expect(supervisor.scheduleApply('release-2')).resolves.toMatchObject({
      phase: 'scheduled',
      releaseId: 'release-2',
    })
    await expect(supervisor.stage('release-2')).resolves.toMatchObject({
      phase: 'scheduled',
      releaseId: 'release-2',
    })
    await supervisor.stop()
  })

  it('requires explicit confirmation and a stopped-state backup for a protected migration', async () => {
    const fixture = await releaseFixture({ protectedSchemaIncrease: true })
    const backupForwardOnlyState = vi.fn(async () => join(fixture.installRoot, 'backups', 'verified'))
    const activate = vi.fn(async options => {
      await options.onGatewayStopped?.()
    })
    const supervisor = new GatewayUpdateSupervisor({
      ...fixture.config,
      activationDelayMs: 0,
      probationMs: 0,
    }, {
      fetch: fixture.fetch,
      activate,
      backupForwardOnlyState,
    })
    await supervisor.initialize()

    await expect(supervisor.stage('release-2')).resolves.toMatchObject({
      phase: 'staged',
      activationMode: 'forward-only',
      detail: expect.stringContaining('Forward-only update staged.'),
    })
    await expect(supervisor.scheduleApply('release-2')).rejects.toThrow(
      /requires explicit forward-only activation confirmation/u,
    )
    await expect(supervisor.scheduleApply('release-2', true)).resolves.toMatchObject({
      phase: 'scheduled',
      detail: expect.stringContaining('back up protected state'),
    })
    await vi.waitFor(async () => {
      expect(await supervisor.status()).toMatchObject({
        phase: 'committed',
        currentBuildId: 'build-2',
      })
    })
    expect(activate).toHaveBeenCalledWith(expect.objectContaining({
      rollbackMode: 'disabled',
      onGatewayStopped: expect.any(Function),
    }))
    expect(backupForwardOnlyState).toHaveBeenCalledWith(expect.objectContaining({
      releaseId: 'release-2',
      targetBuildId: 'build-2',
      currentBuildId: 'build-1',
    }))
  })

  it('stages a new protected store instead of pretending automatic rollback is safe', async () => {
    const fixture = await releaseFixture({ protectedStateAddition: true })
    const supervisor = new GatewayUpdateSupervisor(fixture.config, {
      fetch: fixture.fetch,
    })
    await supervisor.initialize()

    await expect(supervisor.stage('release-2')).resolves.toMatchObject({
      phase: 'staged',
      activationMode: 'forward-only',
      detail: expect.stringContaining('Forward-only update staged.'),
    })
    await expect(supervisor.scheduleApply('release-2')).rejects.toThrow(
      /automatic rollback will be disabled/u,
    )
    await expect(supervisor.status()).resolves.toMatchObject({ phase: 'staged' })
  })

  it('never guesses rollback after a forward-only activation is interrupted', async () => {
    const fixture = await releaseFixture({ protectedSchemaIncrease: true })
    const first = new GatewayUpdateSupervisor({
      ...fixture.config,
      activationDelayMs: 60_000,
    }, { fetch: fixture.fetch })
    await first.initialize()
    await first.stage('release-2')
    await first.scheduleApply('release-2', true)
    await first.stop()

    const statePath = join(fixture.installRoot, 'supervisor-state.json')
    const state = JSON.parse(await readFile(statePath, 'utf8')) as {
      status: { phase: string }
      activationMode?: string
    }
    state.status.phase = 'activating'
    delete state.activationMode
    delete (state.status as { activationMode?: string }).activationMode
    await writeFile(statePath, `${JSON.stringify(state)}\n`)
    const activate = vi.fn(async () => undefined)
    const recovered = new GatewayUpdateSupervisor(fixture.config, { activate })

    await recovered.initialize()

    expect(activate).not.toHaveBeenCalled()
    await expect(recovered.status()).resolves.toMatchObject({
      phase: 'repair_required',
      activationMode: 'forward-only',
      detail: expect.stringContaining('Automatic rollback remains disabled'),
    })
  })

  it('proves the previous build and deep Matrix health after an interrupted activation', async () => {
    const fixture = await releaseFixture()
    const first = new GatewayUpdateSupervisor({
      ...fixture.config,
      activationDelayMs: 60_000,
    }, { fetch: fixture.fetch })
    await first.initialize()
    await first.stage('release-2')
    await first.scheduleApply('release-2')
    await first.stop()

    const statePath = join(fixture.installRoot, 'supervisor-state.json')
    const state = JSON.parse(await readFile(statePath, 'utf8')) as {
      status: { phase: string }
    }
    state.status.phase = 'activating'
    await writeFile(statePath, `${JSON.stringify(state)}\n`)
    const activate = vi.fn(async () => undefined)
    const recovered = new GatewayUpdateSupervisor(fixture.config, { activate })

    await recovered.initialize()

    expect(activate).toHaveBeenCalledWith(expect.objectContaining({
      releaseDirectory: join(fixture.installRoot, 'releases', 'release-1'),
      expectedBuildId: 'build-1',
      requireDeepHealth: true,
    }))
    await expect(recovered.status()).resolves.toMatchObject({ phase: 'rolled_back' })
  })
})

async function releaseFixture(options: {
  protectedSchemaIncrease?: boolean
  protectedStateAddition?: boolean
  reuseActiveBuildId?: boolean
} = {}) {
  const installRoot = await temporaryDirectory()
  const releasesRoot = join(installRoot, 'releases')
  const oldRelease = join(releasesRoot, 'release-1')
  await mkdir(join(oldRelease, 'runtime'), { recursive: true })
  await mkdir(join(oldRelease, 'ops'), { recursive: true })
  await mkdir(join(oldRelease, 'mcp'), { recursive: true })
  await writeFile(join(oldRelease, 'runtime', 'node'), '#!/bin/sh\n', { mode: 0o755 })
  await writeFile(join(oldRelease, 'ops', 'matrix-local-gateway.js'), '// old\n')
  await writeFile(join(oldRelease, 'mcp', 'stdio.js'), '// old mcp\n')
  await symlink(oldRelease, join(installRoot, 'current'))
  const launchAgentPath = join(installRoot, 'gateway.plist')
  await writeFile(launchAgentPath, `<string>${join(installRoot, 'current')}</string>`)

  const runtime = new TextEncoder().encode('#!/bin/sh\n')
  const entrypoint = new TextEncoder().encode('// gateway release 2\n')
  const mcpEntrypoint = new TextEncoder().encode('// mcp release 2\n')
  const supervisorEntrypoint = new TextEncoder().encode('// update supervisor release 2\n')
  const keys = await generateDeviceKeyPair()
  const signer: PairingPublicKey = {
    version: 1,
    algorithm: 'ES256',
    keyId: keys.keyId,
    publicKey: keys.publicJwk as PairingPublicKey['publicKey'],
  }
  const stateCatalog = GATEWAY_STATE_CATALOG.map((entry, index) => ({
    id: entry.id,
    stateClass: entry.stateClass,
    schemaVersion: entry.schemaVersion + (
      options.protectedSchemaIncrease
      && index === 0
      && (entry.stateClass === 'security-critical' || entry.stateClass === 'durable-command')
        ? 1
        : 0
    ),
  }))
  if (options.protectedStateAddition) {
    stateCatalog.push({
      id: 'future-command-store',
      stateClass: 'durable-command',
      schemaVersion: 1,
    })
  }
  const manifest: GatewayReleaseManifest = {
    kind: 'malink.gateway.release',
    version: 1,
    releaseId: 'release-2',
    versionName: '2.0.0',
    buildId: options.reuseActiveBuildId ? 'build-1' : 'build-2',
    publishedAt: 42,
    platform: 'darwin',
    architecture: process.arch as 'arm64' | 'x64',
    runtimePath: 'runtime/node',
    entrypointPath: 'ops/matrix-local-gateway.js',
    supervisorEntrypointPath: 'ops/gatewayUpdateSupervisorMain.js',
    files: [
      releaseFile('runtime/node', 'https://updates.example.test/runtime-node', runtime, true),
      releaseFile(
        'ops/matrix-local-gateway.js',
        'https://updates.example.test/gateway.js',
        entrypoint,
      ),
      releaseFile(
        'mcp/stdio.js',
        'https://updates.example.test/mcp.js',
        mcpEntrypoint,
      ),
      releaseFile(
        'ops/gatewayUpdateSupervisorMain.js',
        'https://updates.example.test/supervisor.js',
        supervisorEntrypoint,
      ),
    ],
    stateCatalog,
  }
  const signature = await webCrypto().subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    keys.privateKey,
    toArrayBuffer(canonicalJsonBytes(manifest)),
  )
  const signed: SignedGatewayReleaseManifest = {
    manifest,
    signer,
    signature: {
      algorithm: 'ES256',
      keyId: keys.keyId,
      value: base64UrlEncode(new Uint8Array(signature)),
    },
  }
  const bodies = new Map<string, Uint8Array>([
    ['https://updates.example.test/runtime-node', runtime],
    ['https://updates.example.test/gateway.js', entrypoint],
    ['https://updates.example.test/mcp.js', mcpEntrypoint],
    ['https://updates.example.test/supervisor.js', supervisorEntrypoint],
  ])
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = String(input)
    if (url.endsWith('/release-2.json')) {
      return new Response(JSON.stringify(signed), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    const body = bodies.get(url)
    if (!body) return new Response('missing', { status: 404 })
    return new Response(toArrayBuffer(body), {
      status: 200,
      headers: { 'content-length': body.byteLength.toString() },
    })
  }) as unknown as typeof fetch

  return {
    installRoot,
    fetch: fetchMock,
    config: {
      installRoot,
      manifestBaseUrl: 'https://updates.example.test/manifests/',
      trustedSigner: signer,
      launchAgentPath,
      serviceLabel: 'com.malink.gateway.test',
      gatewayAdminSocketPath: join(installRoot, 'gateway.sock'),
      currentBuildId: 'build-1',
    },
  }
}

async function agentUpdateFixture(options: {
  tamperPrompt?: boolean
  emptyAuxiliaryFile?: boolean
} = {}) {
  const installRoot = await temporaryDirectory()
  const oldRelease = join(installRoot, 'releases', 'release-1')
  await mkdir(join(oldRelease, 'runtime'), { recursive: true })
  await mkdir(join(oldRelease, 'ops'), { recursive: true })
  await mkdir(join(oldRelease, 'mcp'), { recursive: true })
  await writeFile(join(oldRelease, 'runtime', 'node'), '#!/bin/sh\n', { mode: 0o755 })
  await writeFile(join(oldRelease, 'mcp', 'stdio.js'), '// old MCP\n')
  await writeFile(join(oldRelease, 'ops', 'matrix-local-gateway.js'), '// old Gateway\n')
  await writeFile(
    join(oldRelease, 'ops', 'gatewayUpdateSupervisorMain.js'),
    '// old supervisor\n',
  )
  await writeFile(join(oldRelease, 'ops', 'gatewayAgentUpdateCli.js'), '// old CLI\n')
  await writeFile(
    join(oldRelease, 'ops', 'gatewayJournalRepairCli.js'),
    '// old journal repair CLI\n',
  )
  if (options.emptyAuxiliaryFile) {
    const typesDirectory = join(
      oldRelease,
      'node_modules',
      'matrix-js-sdk',
      'lib',
      '@types',
    )
    await mkdir(typesDirectory, { recursive: true })
    await writeFile(join(typesDirectory, 'another-json.d.js'), '')
  }
  await symlink(oldRelease, join(installRoot, 'current'))
  const launchAgentPath = join(installRoot, 'gateway.plist')
  await writeFile(launchAgentPath, `<string>${join(installRoot, 'current')}</string>`)

  const keys = await generateDeviceKeyPair()
  const signer: PairingPublicKey = {
    version: 1,
    algorithm: 'ES256',
    keyId: keys.keyId,
    publicKey: keys.publicJwk as PairingPublicKey['publicKey'],
  }
  const update: GatewayAgentUpdatePrompt = {
    kind: 'malink.gateway.agent-update',
    version: 1,
    releaseId: 'release-2',
    versionName: '2.0.0',
    buildId: 'build-2',
    publishedAt: 42,
    platform: 'darwin',
    repository: {
      url: 'https://github.com/Escapingbug/malink.git',
      commit: '0123456789abcdef0123456789abcdef01234567',
    },
    prompt: 'Build, test, and place the exact Gateway release in the candidate directory.',
    stateCatalog: GATEWAY_STATE_CATALOG.map(({ id, stateClass, schemaVersion }) => ({
      id,
      stateClass,
      schemaVersion,
    })),
  }
  const signature = await webCrypto().subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    keys.privateKey,
    toArrayBuffer(canonicalJsonBytes(update)),
  )
  const signed: SignedGatewayAgentUpdatePrompt = {
    update: options.tamperPrompt
      ? { ...update, prompt: `${update.prompt} Tampered.` }
      : update,
    signer,
    signature: {
      algorithm: 'ES256',
      keyId: keys.keyId,
      value: base64UrlEncode(new Uint8Array(signature)),
    },
  }
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    if (!String(input).endsWith('/release-2.json')) {
      return new Response('missing', { status: 404 })
    }
    return new Response(JSON.stringify(signed), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch
  return {
    installRoot,
    fetch: fetchMock,
    keys,
    signed,
    config: {
      installRoot,
      agentPromptBaseUrl: 'https://updates.example.test/agent-prompts/',
      trustedSigner: signer,
      launchAgentPath,
      serviceLabel: 'com.malink.gateway.test',
      gatewayAdminSocketPath: join(installRoot, 'gateway.sock'),
      updateSocketPath: join(installRoot, 'supervisor.sock'),
      currentBuildId: 'build-1',
    },
  }
}

async function signAgentUpdateChannel(
  fixture: Awaited<ReturnType<typeof agentUpdateFixture>>,
  options: {
    generation: number
    releaseId?: string
    buildId?: string
    mirrors?: string[]
  },
): Promise<SignedGatewayAgentUpdateChannel> {
  const channel: GatewayAgentUpdateChannel = {
    kind: 'malink.gateway.agent-update-channel',
    version: 1,
    channelId: 'stable',
    generation: options.generation,
    publishedAt: 42,
    release: {
      releaseId: options.releaseId ?? fixture.signed.update.releaseId,
      buildId: options.buildId ?? fixture.signed.update.buildId,
      sha256: createHash('sha256')
        .update(canonicalJsonBytes(fixture.signed))
        .digest('hex'),
    },
    mirrors: options.mirrors ?? ['https://updates.example.test/gateway-agent-updates/'],
  }
  const signature = await webCrypto().subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    fixture.keys.privateKey,
    toArrayBuffer(canonicalJsonBytes(channel)),
  )
  return {
    channel,
    signer: fixture.signed.signer,
    signature: {
      algorithm: 'ES256',
      keyId: fixture.signed.signer.keyId,
      value: base64UrlEncode(new Uint8Array(signature)),
    },
  }
}

function releaseFile(
  path: string,
  url: string,
  body: Uint8Array,
  executable = false,
): GatewayReleaseManifest['files'][number] {
  return {
    path,
    url,
    size: body.byteLength,
    sha256: createHash('sha256').update(body).digest('hex'),
    ...(executable ? { executable: true } : {}),
  }
}

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'malink-gateway-update-supervisor-'))
  temporaryDirectories.push(path)
  return path
}
