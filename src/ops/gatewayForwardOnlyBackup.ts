import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
} from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'

export type GatewayForwardOnlyBackupInput = {
  dataDirectory: string
  installRoot: string
  releaseId: string
  targetBuildId: string
  currentBuildId?: string
  previousTarget: string
  createdAt: number
}

export type GatewayForwardOnlyBackupManifest = {
  version: 1
  releaseId: string
  targetBuildId: string
  currentBuildId?: string
  previousTarget: string
  createdAt: number
  dataDirectoryName: string
  files: Array<{ path: string; size: number; sha256: string; executable?: true }>
  links: Array<{ path: string; target: string }>
  skippedSpecialPaths: string[]
}

/**
 * Copies and verifies stopped Gateway state before a forward-only activation.
 * Unix sockets are recorded but not copied; every regular file is hashed on
 * both sides before the backup is accepted.
 */
export async function createGatewayForwardOnlyBackup(
  input: GatewayForwardOnlyBackupInput,
): Promise<string> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(input.releaseId)) {
    throw new Error('Gateway backup release ID is invalid')
  }
  const dataDirectory = await realpath(resolve(input.dataDirectory))
  const dataMetadata = await lstat(dataDirectory)
  if (!dataMetadata.isDirectory() || dataMetadata.isSymbolicLink()) {
    throw new Error('Gateway data backup source must be a real directory')
  }
  const backupRoot = resolve(input.installRoot, 'backups')
  if (backupRoot === dataDirectory || backupRoot.startsWith(`${dataDirectory}${sep}`)) {
    throw new Error('Gateway backup destination cannot be inside the data directory')
  }
  const component = `${input.releaseId}-${input.createdAt}-${randomUUID()}`
  const destination = join(backupRoot, component)
  const destinationData = join(destination, 'gateway-data')
  await mkdir(destinationData, { recursive: true, mode: 0o700 })
  const manifest: GatewayForwardOnlyBackupManifest = {
    version: 1,
    releaseId: input.releaseId,
    targetBuildId: input.targetBuildId,
    ...(input.currentBuildId ? { currentBuildId: input.currentBuildId } : {}),
    previousTarget: input.previousTarget,
    createdAt: input.createdAt,
    dataDirectoryName: basename(dataDirectory),
    files: [],
    links: [],
    skippedSpecialPaths: [],
  }
  try {
    await copyAndVerifyDirectory(dataDirectory, destinationData, manifest)
    manifest.files.sort((left, right) => left.path.localeCompare(right.path))
    manifest.links.sort((left, right) => left.path.localeCompare(right.path))
    manifest.skippedSpecialPaths.sort((left, right) => left.localeCompare(right))
    await writeDurableJson(join(destination, 'backup-manifest.json'), manifest)
    await syncDirectory(destination)
    await syncDirectory(backupRoot)
    return destination
  } catch (error) {
    await rm(destination, { recursive: true, force: true })
    throw error
  }
}

async function copyAndVerifyDirectory(
  sourceRoot: string,
  destinationRoot: string,
  manifest: GatewayForwardOnlyBackupManifest,
): Promise<void> {
  const visit = async (sourceDirectory: string, destinationDirectory: string): Promise<void> => {
    const entries = await readdir(sourceDirectory, { withFileTypes: true })
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const source = join(sourceDirectory, entry.name)
      const path = relative(sourceRoot, source).split(sep).join('/')
      const destination = join(destinationRoot, ...path.split('/'))
      const metadata = await lstat(source)
      if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
        await mkdir(destination, { mode: metadata.mode & 0o777 })
        await visit(source, destination)
        await syncDirectory(destination)
        continue
      }
      if (metadata.isSymbolicLink()) {
        const target = await readlink(source)
        await symlink(target, destination)
        if (await readlink(destination) !== target) {
          throw new Error(`Gateway backup symbolic link verification failed: ${path}`)
        }
        manifest.links.push({ path, target })
        continue
      }
      if (!metadata.isFile()) {
        manifest.skippedSpecialPaths.push(path)
        continue
      }
      await copyFile(source, destination)
      await chmod(destination, metadata.mode & 0o777)
      const [sourceHash, destinationHash] = await Promise.all([
        hashFile(source),
        hashFile(destination),
      ])
      if (sourceHash !== destinationHash) {
        throw new Error(`Gateway backup integrity verification failed: ${path}`)
      }
      const handle = await open(destination, 'r')
      try {
        await handle.sync()
      } finally {
        await handle.close()
      }
      manifest.files.push({
        path,
        size: metadata.size,
        sha256: sourceHash,
        ...((metadata.mode & 0o111) !== 0 ? { executable: true as const } : {}),
      })
    }
  }
  await visit(sourceRoot, destinationRoot)
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256')
  const stream = createReadStream(path)
  for await (const chunk of stream) hash.update(chunk)
  return hash.digest('hex')
}

async function writeDurableJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.next.${process.pid}.${randomUUID()}`
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const handle = await open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
  await syncDirectory(dirname(path))
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}
