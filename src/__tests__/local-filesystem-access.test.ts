import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  LocalFilesystemAccessError,
  assertLocalDirectoryAccess,
  probeLocalDirectoryAccess,
} from '@/ops/localFilesystemAccess'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory =>
    rm(directory, { recursive: true, force: true }),
  ))
})

describe('local filesystem access probe', () => {
  it('checks read, write, and traversal access without changing the target', async () => {
    const directory = await temporaryDirectory()

    await expect(probeLocalDirectoryAccess(directory)).resolves.toEqual({
      version: 1,
      path: directory,
      state: 'ready',
      exists: true,
    })
  })

  it('checks the nearest parent when a new project directory may be created', async () => {
    const directory = await temporaryDirectory()
    const target = join(directory, 'new', 'project')

    await expect(probeLocalDirectoryAccess(target)).resolves.toEqual({
      version: 1,
      path: target,
      state: 'ready',
      exists: false,
    })
    await expect(probeLocalDirectoryAccess(target, { allowCreate: false })).resolves.toEqual({
      version: 1,
      path: target,
      state: 'missing',
    })
  })

  it('rejects files and relative paths as project directories', async () => {
    const directory = await temporaryDirectory()
    const file = join(directory, 'project.txt')
    await writeFile(file, 'not a directory', 'utf8')

    await expect(probeLocalDirectoryAccess(file)).resolves.toMatchObject({
      path: file,
      state: 'not_directory',
    })
    await expect(probeLocalDirectoryAccess('relative/project')).rejects.toThrow(
      'Filesystem probe path must be absolute',
    )
  })

  it('kills a blocked probe at the hard timeout', async () => {
    const directory = await temporaryDirectory()
    const executable = join(directory, 'blocked-node')
    await writeFile(executable, '#!/bin/sh\nexec /bin/sleep 5\n', 'utf8')
    await chmod(executable, 0o755)
    const startedAt = Date.now()

    await expect(probeLocalDirectoryAccess(directory, {
      nodeExecutable: executable,
      timeoutMs: 100,
    })).resolves.toEqual({
      version: 1,
      path: directory,
      state: 'timeout',
    })
    expect(Date.now() - startedAt).toBeLessThan(2_000)
  })

  it('turns blocked access into a retryable protocol-facing error', async () => {
    const directory = await temporaryDirectory()
    const missing = join(directory, 'missing')

    await expect(assertLocalDirectoryAccess(missing, { allowCreate: false }))
      .rejects.toMatchObject({
        name: 'LocalFilesystemAccessError',
        commandCode: 'project_directory_missing',
        retryable: true,
      })
    const timeout = new LocalFilesystemAccessError({
      version: 1,
      path: '/Users/alice/Documents/project',
      state: 'timeout',
    })
    expect(timeout).toMatchObject({
      commandCode: 'local_permission_required',
      retryable: true,
    })
    expect(timeout.message).toContain('Malink Gateway Host')
  })
})

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'malink-filesystem-probe-'))
  temporaryDirectories.push(directory)
  return directory
}
