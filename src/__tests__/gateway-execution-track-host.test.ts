import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { GatewayExecutionTrackProcessHost } from '@/ops/gatewayExecutionTrackHost'
import { GatewayExecutionTracks } from '@/ops/gatewayExecutionTracks'

it('switches real processes over one locked current business directory, including return to old software', async () => {
  const root = await mkdtemp(join(tmpdir(), 'track-process-'))
  await writeFile(join(root, 'business.json'), JSON.stringify({ sessions: ['conversation'], results: ['original-result'], starts: [] }))
  const host = new GatewayExecutionTrackProcessHost(root, {
    async resolveRelease(releaseId) { return { releaseId, buildId: releaseId,
      executable: process.execPath,
      arguments: ['--import', 'tsx', resolve('src/__tests__/fixtures/execution-track-child.ts')],
      // This fixture reads health from a temporary file. Never let a test
      // child bind an admin socket inherited from the live Gateway Agent.
      cwd: process.cwd(), environment: { ...process.env, MALINK_GATEWAY_ADMIN_SOCKET: undefined } } },
    async validateCompatibility() {},
    async readHealth() { return JSON.parse(await readFile(join(root, 'health.json'), 'utf8')) },
    async drain() {}, log() {}, timeoutMs: 5000,
  })
  try {
    await host.validateRelease('old', root)
    await host.activate('old', root, 'stable-node')
    const tracks = new GatewayExecutionTracks(join(root, 'tracks.json'), {
      version: 1, generation: 0, gatewayNodeId: 'stable-node', dataDirectory: root,
      activeRelease: 'old', phase: 'steady',
    }, host)
    await tracks.select('new', 0)
    const latest = JSON.parse(await readFile(join(root, 'business.json'), 'utf8'))
    latest.results.push('new-result')
    latest.sessions.push('new-conversation')
    await writeFile(join(root, 'business.json'), JSON.stringify(latest))
    await tracks.select('old', 1)
    const actual = JSON.parse(await readFile(join(root, 'business.json'), 'utf8'))
    expect(actual.starts).toEqual(['old', 'new', 'old'])
    expect(actual.results).toEqual(['original-result', 'new-result'])
    expect(actual.sessions).toEqual(['conversation', 'new-conversation'])
    const lock = JSON.parse(await readFile(join(root, 'gateway-instance.lock'), 'utf8'))
    expect(lock.pid).toBeGreaterThan(0)
  } finally {
    await host.releaseExecution('new')
    await host.releaseExecution('old')
    await rm(root, { recursive: true, force: true })
  }
}, 20000)
