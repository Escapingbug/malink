import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  canonicalJsonBytes,
  type GatewayReleaseManifest,
  type PairingPublicKey,
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
      await expect(client.stage('release-2')).resolves.toMatchObject({
        phase: 'staged',
        releaseId: 'release-2',
        targetBuildId: 'build-2',
      })
    } finally {
      await server.stop()
      await supervisor.stop()
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

  it('requires a new build identity so health cannot mistake the old process for the target', async () => {
    const fixture = await releaseFixture({ reuseActiveBuildId: true })
    const supervisor = new GatewayUpdateSupervisor(fixture.config, {
      fetch: fixture.fetch,
    })
    await supervisor.initialize()

    await expect(supervisor.stage('release-2')).rejects.toThrow(
      /reuses the active build ID build-1/u,
    )
  })

  it('rejects a protected state migration that makes automatic rollback unsafe', async () => {
    const fixture = await releaseFixture({ protectedSchemaIncrease: true })
    const supervisor = new GatewayUpdateSupervisor(fixture.config, {
      fetch: fixture.fetch,
    })
    await supervisor.initialize()

    await expect(supervisor.stage('release-2')).rejects.toThrow(/automatic rollback is unsafe/u)
    await expect(supervisor.status()).resolves.toMatchObject({ phase: 'failed' })
  })

  it('rejects a new protected state that the rollback release cannot resume', async () => {
    const fixture = await releaseFixture({ protectedStateAddition: true })
    const supervisor = new GatewayUpdateSupervisor(fixture.config, {
      fetch: fixture.fetch,
    })
    await supervisor.initialize()

    await expect(supervisor.stage('release-2')).rejects.toThrow(
      /introduces protected state future-command-store; automatic rollback is unsafe/u,
    )
    await expect(supervisor.status()).resolves.toMatchObject({ phase: 'failed' })
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
  await writeFile(join(oldRelease, 'runtime', 'node'), '#!/bin/sh\n', { mode: 0o755 })
  await writeFile(join(oldRelease, 'ops', 'matrix-local-gateway.js'), '// old\n')
  await symlink(oldRelease, join(installRoot, 'current'))
  const launchAgentPath = join(installRoot, 'gateway.plist')
  await writeFile(launchAgentPath, `<string>${join(installRoot, 'current')}</string>`)

  const runtime = new TextEncoder().encode('#!/bin/sh\n')
  const entrypoint = new TextEncoder().encode('// gateway release 2\n')
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
