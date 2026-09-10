import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { GatewayExecutionTracks, type GatewayExecutionTrackHost } from '@/ops/gatewayExecutionTracks'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'tracks-'))
  directories.push(root)
  const dataDirectory = join(root, 'business')
  const initial = { version: 1 as const, generation: 0, gatewayNodeId: 'stable-node', dataDirectory,
    activeRelease: 'old', phase: 'steady' as const }
  let owner: string | undefined = 'old'
  let failure: string | undefined
  let activationGate: Promise<void> | undefined
  const data = { sessions: ['existing'], results: ['first'], commands: ['command-1'] }
  const calls: string[] = []
  const host: GatewayExecutionTrackHost = {
    async validateRelease(release) { calls.push(`validate:${release}`); if (failure === 'compatibility') throw new Error('incompatible') },
    async ensureStandby(release) { calls.push(`standby:${release}`); if (failure === `standby:${release}`) throw new Error('standby damaged') },
    async releaseExecution(release) {
      calls.push(`release:${release}`)
      if (failure === 'release') throw new Error('writer still alive')
      if (owner === release) owner = undefined
    },
    async activate(release, path, node) {
      expect(path).toBe(dataDirectory); expect(node).toBe('stable-node')
      expect(owner === undefined || owner === release).toBe(true)
      calls.push(`activate:${release}`)
      await activationGate
      if (failure === 'activate') throw new Error('cannot start')
      owner = release
    },
    async verifyActive(release) { expect(owner).toBe(release) },
  }
  const path = join(root, 'tracks.json')
  return { tracks: new GatewayExecutionTracks(path, initial, host),
    reopen: () => new GatewayExecutionTracks(path, initial, host), data, calls,
    owner: () => owner, fail: (value?: string) => { failure = value },
    gate: (value: Promise<void>) => { activationGate = value } }
}

it('changes only software execution and retains new conversations and command results on return', async () => {
  const f = await fixture()
  await f.tracks.select('new', 0)
  f.data.sessions.push('created-under-new')
  f.data.results.push('completed-under-new')
  f.data.commands.push('command-2')
  const state = await f.tracks.select('old', 1)
  expect(state.activeRelease).toBe('old')
  expect(state.standbyRelease).toBe('new')
  expect(state.gatewayNodeId).toBe('stable-node')
  expect(f.data).toEqual({ sessions: ['existing', 'created-under-new'], results: ['first', 'completed-under-new'], commands: ['command-1', 'command-2'] })
  expect(f.calls.indexOf('release:old')).toBeLessThan(f.calls.indexOf('activate:new'))
})

it('checks compatibility before disturbing a working owner', async () => {
  const f = await fixture(); f.fail('compatibility')
  await expect(f.tracks.select('new', 0)).rejects.toThrow('incompatible')
  expect(f.owner()).toBe('old')
  expect((await f.tracks.status()).phase).toBe('steady')
})

it('starts the default even when the previous version cannot become standby', async () => {
  const f = await fixture()
  await f.tracks.select('new', 0)
  f.fail('standby:old')
  await f.reopen().startDefault()
  expect(f.owner()).toBe('new')
  expect(await f.tracks.status()).toMatchObject({ phase: 'steady', activeRelease: 'new', error: expect.stringContaining('previous version is unavailable') })
})

it('records the verified new owner even if retaining the previous controller fails', async () => {
  const f = await fixture()
  f.fail('standby:old')
  const state = await f.tracks.select('new', 0)
  expect(state).toMatchObject({ phase: 'steady', activeRelease: 'new', standbyRelease: 'old', error: expect.stringContaining('previous version is unavailable') })
  expect(f.owner()).toBe('new')
})

it('never starts another writer when the old owner cannot release', async () => {
  const f = await fixture(); f.fail('release')
  await expect(f.tracks.select('new', 0)).rejects.toThrow('writer still alive')
  expect(f.calls).not.toContain('activate:new')
  expect((await f.tracks.status()).phase).toBe('attention')
})

it('recovers persisted intent after restart instead of inventing a rollback', async () => {
  const f = await fixture(); f.fail('activate')
  await expect(f.tracks.select('new', 0)).rejects.toThrow('cannot start')
  f.fail()
  const status = await f.reopen().resume()
  expect(status.activeRelease).toBe('new')
  expect(status.generation).toBe(1)
})

it('rejects stale buttons and serializes competing selections', async () => {
  const f = await fixture()
  const outcomes = await Promise.allSettled([f.tracks.select('new', 0), f.tracks.select('other', 0)])
  expect(outcomes.map(value => value.status)).toEqual(['fulfilled', 'rejected'])
  expect(f.owner()).toBe('new')
})

it('allows explicit old-version selection after failed new-version activation', async () => {
  const f = await fixture(); f.fail('activate')
  await expect(f.tracks.select('new', 0)).rejects.toThrow('cannot start')
  f.fail()
  const state = await f.reopen().select('old', 1)
  expect(state.phase).toBe('steady')
  expect(state.activeRelease).toBe('old')
  expect(state.standbyRelease).toBe('new')
  expect(f.owner()).toBe('old')
})

it('excludes another supervisor from resuming an in-flight activation', async () => {
  const f = await fixture()
  let unblock!: () => void
  f.gate(new Promise<void>(resolve => { unblock = resolve }))
  const selection = f.tracks.select('new', 0)
  try {
    await expect.poll(() => f.calls.includes('activate:new')).toBe(true)
    await expect(f.reopen().resume()).rejects.toThrow('already owns')
    expect(f.calls.filter(call => call === 'activate:new')).toHaveLength(1)
  } finally {
    unblock()
    await selection
  }
  expect((await f.reopen().resume()).activeRelease).toBe('new')
})
