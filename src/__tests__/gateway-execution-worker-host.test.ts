import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { GatewayExecutionWorkerHost } from '@/ops/gatewayExecutionWorkerHost'
import { GatewayExecutionTracks } from '@/ops/gatewayExecutionTracks'

it('keeps standby controllers alive and selects old software after default startup failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'track-worker-'))
  await writeFile(join(root, 'business.json'), JSON.stringify({ results: ['retained'], starts: [] }))
  const host = new GatewayExecutionWorkerHost({
    dataDirectory: root, gatewayNodeId: 'stable-node', adminSocket: join(root, 'admin.sock'),
    workerFile: resolve('src/ops/gatewayExecutionTrackWorker.ts'), workerExecArgv: ['--import', 'tsx'],
    resolveRelease: async id => ({ releaseId: id, buildId: id, executable: process.execPath,
      arguments: id === 'broken' ? ['--eval', 'process.exit(1)']
        : ['--import', 'tsx', resolve('src/__tests__/fixtures/execution-track-child.ts')],
      cwd: process.cwd(), environment: { ...process.env, MALINK_GATEWAY_ADMIN_SOCKET: join(root, 'admin.sock') },
    }), log() {},
  })
  const tracks = new GatewayExecutionTracks(join(root, 'tracks.json'), {
    version: 1, generation: 0, gatewayNodeId: 'stable-node', dataDirectory: root,
    activeRelease: 'old', phase: 'steady',
  }, host)
  try {
    await host.ensureStandby('old')
    expect(JSON.parse(await readFile(join(root, 'business.json'), 'utf8')).starts).toEqual([])
    await tracks.startDefault()
    await expect(tracks.select('broken', 0)).rejects.toThrow()
    expect((await tracks.status()).phase).toBe('attention')
    await tracks.select('old', 1)
    await host.verifyActive('old')
    expect(JSON.parse(await readFile(join(root, 'business.json'), 'utf8')))
      .toEqual({ results: ['retained'], starts: ['old', 'old'] })
  } finally {
    await host.stop()
    await rm(root, { recursive: true, force: true })
  }
}, 20000)
