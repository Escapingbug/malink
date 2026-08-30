import { randomUUID } from 'node:crypto'
import { link, mkdir, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

type GatewayDataDirectoryLockOwner = {
  version: 1
  pid: number
  token: string
  acquiredAt: number
}

export interface GatewayDataDirectoryLock {
  path: string
  release(): Promise<void>
}

export interface GatewayDataDirectoryLockDependencies {
  pid?: number
  now?: () => number
  token?: () => string
  isProcessAlive?: (pid: number) => boolean
}

export async function acquireGatewayDataDirectoryLock(
  dataDirectory: string,
  dependencies: GatewayDataDirectoryLockDependencies = {},
): Promise<GatewayDataDirectoryLock> {
  const root = resolve(dataDirectory)
  const path = `${root}/gateway-instance.lock`
  const pid = dependencies.pid ?? process.pid
  const token = dependencies.token?.() ?? randomUUID()
  const owner: GatewayDataDirectoryLockOwner = {
    version: 1,
    pid,
    token,
    acquiredAt: dependencies.now?.() ?? Date.now(),
  }
  const isProcessAlive = dependencies.isProcessAlive ?? processIsAlive
  await mkdir(root, { recursive: true, mode: 0o700 })

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const temporary = `${path}.${pid}.${token}.tmp`
    await writeFile(temporary, `${JSON.stringify(owner)}\n`, {
      mode: 0o600,
      flag: 'wx',
    })
    try {
      await link(temporary, path)
      await unlink(temporary)
      let released = false
      return {
        path,
        async release() {
          if (released) return
          released = true
          const current = await readOwner(path).catch(error => {
            if (isMissing(error)) return null
            throw error
          })
          if (current?.token === token && current.pid === pid) {
            await unlink(path).catch(error => {
              if (!isMissing(error)) throw error
            })
          }
        },
      }
    } catch (error) {
      await unlink(temporary).catch(() => undefined)
      if (!isExists(error)) throw error
    }

    const current = await readOwner(path).catch(error => {
      if (isMissing(error)) return null
      throw error
    })
    if (!current) continue
    if (isProcessAlive(current.pid)) {
      throw new Error(
        `Another Malink Gateway process (${current.pid}) already owns ${root}. `
        + 'Candidate validation must use the supervisor finish command instead of starting '
        + 'ops/matrix-local-gateway.js.',
      )
    }
    const stalePath = `${path}.stale.${current.pid}.${randomUUID()}`
    try {
      await rename(path, stalePath)
      await rm(stalePath, { force: true })
    } catch (error) {
      if (!isMissing(error)) throw error
    }
  }
  throw new Error(`Could not acquire the Malink Gateway data-directory lock at ${path}`)
}

async function readOwner(path: string): Promise<GatewayDataDirectoryLockOwner> {
  let value: unknown
  try {
    value = JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if (isMissing(error)) throw error
    throw new Error(
      `The Malink Gateway lock is corrupt at ${path}; inspect it before starting the Gateway.`,
      { cause: error },
    )
  }
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
    || (value as Partial<GatewayDataDirectoryLockOwner>).version !== 1
    || !Number.isSafeInteger((value as Partial<GatewayDataDirectoryLockOwner>).pid)
    || ((value as Partial<GatewayDataDirectoryLockOwner>).pid ?? 0) < 1
    || typeof (value as Partial<GatewayDataDirectoryLockOwner>).token !== 'string'
    || !(value as Partial<GatewayDataDirectoryLockOwner>).token
    || !Number.isSafeInteger((value as Partial<GatewayDataDirectoryLockOwner>).acquiredAt)
  ) {
    throw new Error(
      `The Malink Gateway lock is corrupt at ${path}; inspect it before starting the Gateway.`,
    )
  }
  return value as GatewayDataDirectoryLockOwner
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function isExists(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'EEXIST'
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT'
}
