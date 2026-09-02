import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readlink, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createGatewayForwardOnlyBackup,
  type GatewayForwardOnlyBackupManifest,
} from '@/ops/gatewayForwardOnlyBackup'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path =>
    rm(path, { recursive: true, force: true })))
})

describe('Gateway forward-only backup', () => {
  it('copies, hashes, and records stopped Gateway state without following symlinks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'malink-forward-backup-'))
    temporaryDirectories.push(root)
    const dataDirectory = join(root, 'gateway-data')
    const installRoot = join(root, 'install')
    await mkdir(join(dataDirectory, 'nested'), { recursive: true })
    await writeFile(join(dataDirectory, 'journal.jsonl'), '{"command":"one"}\n', { mode: 0o600 })
    await writeFile(join(dataDirectory, 'nested', 'state.db'), 'sqlite-state', { mode: 0o700 })
    await symlink('journal.jsonl', join(dataDirectory, 'journal-current'))

    const backup = await createGatewayForwardOnlyBackup({
      dataDirectory,
      installRoot,
      releaseId: 'release-2',
      targetBuildId: 'build-2',
      currentBuildId: 'build-1',
      previousTarget: join(installRoot, 'releases', 'release-1'),
      createdAt: 42,
    })
    const manifest = JSON.parse(await readFile(
      join(backup, 'backup-manifest.json'),
      'utf8',
    )) as GatewayForwardOnlyBackupManifest

    expect(manifest).toMatchObject({
      version: 1,
      releaseId: 'release-2',
      targetBuildId: 'build-2',
      currentBuildId: 'build-1',
      createdAt: 42,
      links: [{ path: 'journal-current', target: 'journal.jsonl' }],
    })
    expect(manifest.files).toEqual([
      {
        path: 'journal.jsonl',
        size: 18,
        sha256: sha256('{"command":"one"}\n'),
      },
      {
        path: 'nested/state.db',
        size: 12,
        sha256: sha256('sqlite-state'),
        executable: true,
      },
    ])
    expect(await readFile(join(backup, 'gateway-data', 'nested', 'state.db'), 'utf8'))
      .toBe('sqlite-state')
    expect(await readlink(join(backup, 'gateway-data', 'journal-current'))).toBe('journal.jsonl')
    expect((await stat(join(backup, 'backup-manifest.json'))).mode & 0o777).toBe(0o600)
  })
})

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
