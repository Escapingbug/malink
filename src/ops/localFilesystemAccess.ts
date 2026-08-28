import { spawn } from 'node:child_process'
import { isAbsolute, resolve } from 'node:path'

export type LocalDirectoryProbeState =
  | 'ready'
  | 'missing'
  | 'not_directory'
  | 'denied'
  | 'timeout'
  | 'error'

export interface LocalDirectoryProbeResult {
  version: 1
  path: string
  state: LocalDirectoryProbeState
  exists?: boolean
  code?: string
  detail?: string
}

export interface LocalDirectoryProbeOptions {
  allowCreate?: boolean
  timeoutMs?: number
  nodeExecutable?: string
}

export class LocalFilesystemAccessError extends Error {
  readonly commandCode: string
  readonly retryable: boolean

  constructor(
    readonly result: LocalDirectoryProbeResult,
  ) {
    const permissionRequired = result.state === 'denied' || result.state === 'timeout'
    const message = permissionRequired
      ? `The Gateway could not verify access to ${result.path}. On the Mac, grant Full Disk Access to Malink Gateway Host, then retry.`
      : result.state === 'missing'
        ? `Project working directory does not exist: ${result.path}`
        : result.state === 'not_directory'
          ? `Project working directory is not a directory: ${result.path}`
          : `The Gateway could not validate project directory ${result.path}: ${result.detail ?? result.code ?? 'unknown error'}`
    super(message)
    this.name = 'LocalFilesystemAccessError'
    this.commandCode = permissionRequired
      ? 'local_permission_required'
      : result.state === 'missing'
        ? 'project_directory_missing'
        : result.state === 'not_directory'
          ? 'project_directory_invalid'
          : 'local_filesystem_error'
    this.retryable = result.state !== 'not_directory'
  }
}

const DEFAULT_PROBE_TIMEOUT_MS = 10_000
const MAX_PROBE_OUTPUT_BYTES = 32 * 1024

const DIRECTORY_PROBE_SOURCE = String.raw`
import { access, mkdtemp, rm, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, join } from 'node:path'

const target = process.argv[1]
const allowCreate = process.argv[2] === 'create'
const output = value => process.stdout.write(JSON.stringify({ version: 1, path: target, ...value }))

async function nearestExistingDirectory(path) {
  let current = path
  while (true) {
    try {
      const details = await stat(current)
      if (!details.isDirectory()) {
        output({ state: 'not_directory', detail: 'The nearest existing path is not a directory' })
        process.exitCode = 4
        return null
      }
      return current
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      const parent = dirname(current)
      if (parent === current) throw error
      current = parent
    }
  }
}

try {
  let exists = true
  try {
    const details = await stat(target)
    if (!details.isDirectory()) {
      output({ state: 'not_directory' })
      process.exitCode = 4
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    exists = false
  }
  if (process.exitCode === undefined) {
    if (!exists && !allowCreate) {
      output({ state: 'missing' })
      process.exitCode = 3
    } else {
      const probeRoot = exists ? target : await nearestExistingDirectory(target)
      if (probeRoot) {
        await access(probeRoot, constants.R_OK | constants.W_OK | constants.X_OK)
        const temporary = await mkdtemp(join(probeRoot, '.malink-access-probe-'))
        await rm(temporary, { recursive: true, force: true })
        output({ state: 'ready', exists })
      }
    }
  }
} catch (error) {
  const code = typeof error?.code === 'string' ? error.code : undefined
  output({
    state: code === 'EACCES' || code === 'EPERM' ? 'denied' : 'error',
    ...(code ? { code } : {}),
    detail: error instanceof Error ? error.message.slice(0, 2048) : String(error).slice(0, 2048),
  })
  process.exitCode = code === 'EACCES' || code === 'EPERM' ? 5 : 6
}
`

export async function probeLocalDirectoryAccess(
  pathInput: string,
  options: LocalDirectoryProbeOptions = {},
): Promise<LocalDirectoryProbeResult> {
  if (!isAbsolute(pathInput)) throw new Error('Filesystem probe path must be absolute')
  const path = resolve(pathInput)
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000) {
    throw new RangeError('Filesystem probe timeout must be between 100 and 120000 milliseconds')
  }
  const executable = options.nodeExecutable ?? process.execPath
  return new Promise((resolveProbe, reject) => {
    const child = spawn(executable, [
      '--input-type=module',
      '--eval',
      DIRECTORY_PROBE_SOURCE,
      '--',
      path,
      options.allowCreate === false ? 'existing' : 'create',
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0)
    let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0)
    let timedOut = false
    let outputOverflow = false
    const timeout = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)
    const append = (
      current: Buffer<ArrayBufferLike>,
      chunk: Buffer<ArrayBufferLike>,
    ): Buffer<ArrayBufferLike> => {
      const next = Buffer.concat([current, chunk])
      if (next.length > MAX_PROBE_OUTPUT_BYTES) {
        outputOverflow = true
        child.kill('SIGKILL')
        return next.subarray(0, MAX_PROBE_OUTPUT_BYTES)
      }
      return next
    }
    child.stdout.on('data', (chunk: Buffer) => { stdout = append(stdout, chunk) })
    child.stderr.on('data', (chunk: Buffer) => { stderr = append(stderr, chunk) })
    child.once('error', error => {
      clearTimeout(timeout)
      reject(error)
    })
    child.once('close', () => {
      clearTimeout(timeout)
      if (timedOut) {
        resolveProbe({ version: 1, path, state: 'timeout' })
        return
      }
      if (outputOverflow) {
        resolveProbe({
          version: 1,
          path,
          state: 'error',
          detail: 'Filesystem probe produced too much output',
        })
        return
      }
      try {
        const parsed = JSON.parse(stdout.toString('utf8')) as Partial<LocalDirectoryProbeResult>
        if (
          parsed.version !== 1
          || parsed.path !== path
          || !isProbeState(parsed.state)
        ) {
          throw new Error('Filesystem probe returned an invalid result')
        }
        resolveProbe({
          version: 1,
          path,
          state: parsed.state,
          ...(parsed.exists === undefined ? {} : { exists: parsed.exists }),
          ...(parsed.code ? { code: parsed.code.slice(0, 128) } : {}),
          ...(parsed.detail ? { detail: parsed.detail.slice(0, 2_048) } : {}),
        })
      } catch (error) {
        resolveProbe({
          version: 1,
          path,
          state: 'error',
          detail: stderr.toString('utf8').trim().slice(0, 2_048)
            || (error instanceof Error ? error.message : String(error)),
        })
      }
    })
  })
}

export async function assertLocalDirectoryAccess(
  path: string,
  options: LocalDirectoryProbeOptions = {},
): Promise<{ path: string; exists: boolean }> {
  const result = await probeLocalDirectoryAccess(path, options)
  if (result.state !== 'ready') throw new LocalFilesystemAccessError(result)
  return { path: result.path, exists: result.exists === true }
}

function isProbeState(value: unknown): value is LocalDirectoryProbeState {
  return value === 'ready'
    || value === 'missing'
    || value === 'not_directory'
    || value === 'denied'
    || value === 'timeout'
    || value === 'error'
}
