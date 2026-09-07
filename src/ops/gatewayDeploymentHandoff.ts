import { createHash, randomUUID } from 'node:crypto'
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
} from 'node:fs/promises'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { canonicalJson, type JsonValue } from '@malink/protocol'
import { mergeMatrixMlp3OutboxWals } from '@/gateway/matrix/fileMatrixMlp3Outbox'

const PROJECT_CATALOG = 'gateway-projects.json'
const RUNTIME_STATE = 'gateway-replay.jsonl.v3-runtime-state.json'
const COMMAND_JOURNAL = 'gateway-replay.jsonl.v3-commands.sqlite'
const INBOX = 'gateway-replay.jsonl.v3-matrix-inbox.json'
const SHADOW_INBOX = 'gateway-replay.jsonl.v3-matrix-shadow-inbox.json'
const TIMELINE_KEYS = 'envelope-replay.json.v3-project-keys.json'
const ARTIFACTS = 'gateway-replay.jsonl.v3-artifacts.json'
const PROVIDER_HISTORY = 'gateway-replay.jsonl.v3-provider-history-snapshots.json'
const NATIVE_RELEASES = 'gateway-replay.jsonl.v3-client-releases.json'
const WEB_PUSH = 'gateway-replay.jsonl.v3-web-push.json'
const OUTBOX = 'envelope-replay.json.v3-outbox.jsonl'

const REPLAY_STORES = [
  'gateway-replay.jsonl',
  'envelope-replay.json',
  'pairing-replay.json',
  'gateway-enrollment-replay.json',
] as const

const EPHEMERAL_NAMES = new Set([
  'admin.sock',
  'gateway-instance.lock',
])

export interface GatewayDeploymentHandoffResult {
  targetDirectory: string
  manifestPath: string
  projectCount: number
  sessionCount: number
  fileCount: number
  digest: string
}

/**
 * Builds promoted state without modifying either deployment directory. Both
 * Gateways must have closed their writable stores before this function runs.
 */
export async function buildGatewayDeploymentHandoff(input: {
  sourceDirectory: string
  candidateDirectory: string
  transactionRoot: string
  updateId: string
  candidateGatewayNodeId: string
  workspaceId: string
  now?: number
}): Promise<GatewayDeploymentHandoffResult> {
  requireOpaqueSegment(input.updateId, 'Gateway update ID')
  const sourceDirectory = resolve(input.sourceDirectory)
  const candidateDirectory = resolve(input.candidateDirectory)
  const transactionRoot = resolve(input.transactionRoot)
  if (sourceDirectory === candidateDirectory) {
    throw new Error('Gateway handoff requires isolated source and candidate directories')
  }
  const targetDirectory = join(transactionRoot, input.updateId)
  if (dirname(targetDirectory) !== transactionRoot) {
    throw new Error('Gateway handoff target escaped its transaction root')
  }
  await rm(targetDirectory, { recursive: true, force: true })
  await mkdir(targetDirectory, { recursive: true, mode: 0o700 })
  try {
    await copyTree(candidateDirectory, targetDirectory)
    await mergeProjectCatalog(
      join(sourceDirectory, PROJECT_CATALOG),
      join(targetDirectory, PROJECT_CATALOG),
      input.candidateGatewayNodeId,
    )
    const counts = await mergeRuntimeState(
      join(sourceDirectory, RUNTIME_STATE),
      join(targetDirectory, RUNTIME_STATE),
      input.workspaceId,
    )
    await mergeCommandJournal(
      join(sourceDirectory, COMMAND_JOURNAL),
      join(targetDirectory, COMMAND_JOURNAL),
    )
    await mergeInboxFiles([
      join(sourceDirectory, INBOX),
      join(targetDirectory, INBOX),
      join(candidateDirectory, SHADOW_INBOX),
    ], join(targetDirectory, INBOX))
    await mergeMatrixMlp3OutboxWals([
      join(candidateDirectory, OUTBOX),
      join(sourceDirectory, OUTBOX),
    ], join(targetDirectory, OUTBOX))
    await writePrivateJson(join(targetDirectory, SHADOW_INBOX), {
      version: 1,
      records: {},
    })
    await writePrivateJson(join(targetDirectory, 'gateway-shadow-rooms.json'), [])
    await mergeTimelineKeys(
      join(sourceDirectory, TIMELINE_KEYS),
      join(targetDirectory, TIMELINE_KEYS),
    )
    for (const path of REPLAY_STORES) {
      await mergeReplayStores(join(sourceDirectory, path), join(targetDirectory, path))
    }
    await mergeRecordStore(
      join(sourceDirectory, ARTIFACTS),
      join(targetDirectory, ARTIFACTS),
      input.workspaceId,
      ['references', 'messages'],
    )
    await mergeRecordStore(
      join(sourceDirectory, PROVIDER_HISTORY),
      join(targetDirectory, PROVIDER_HISTORY),
      input.workspaceId,
      ['snapshots'],
    )
    await mergeNativeReleases(
      join(sourceDirectory, NATIVE_RELEASES),
      join(targetDirectory, NATIVE_RELEASES),
      input.workspaceId,
    )
    await mergeWebPush(
      join(sourceDirectory, WEB_PUSH),
      join(targetDirectory, WEB_PUSH),
    )
    for (const directory of [
      'gateway-replay.jsonl.v3-attachments',
      'scratch-sessions',
    ]) {
      await mergeTree(join(sourceDirectory, directory), join(targetDirectory, directory))
    }
    const files = await hashTree(targetDirectory)
    const digest = createHash('sha256')
      .update(canonicalJson(files as unknown as JsonValue))
      .digest('hex')
    const manifestPath = join(targetDirectory, 'gateway-handoff-manifest.json')
    await writePrivateJson(manifestPath, {
      version: 1,
      updateId: input.updateId,
      workspaceId: input.workspaceId,
      sourceDirectory,
      candidateGatewayNodeId: input.candidateGatewayNodeId,
      projectCount: counts.projectCount,
      sessionCount: counts.sessionCount,
      createdAt: input.now ?? Date.now(),
      digest,
      files,
    })
    return {
      targetDirectory,
      manifestPath,
      projectCount: counts.projectCount,
      sessionCount: counts.sessionCount,
      fileCount: files.length,
      digest,
    }
  } catch (error) {
    await rm(targetDirectory, { recursive: true, force: true })
    throw error
  }
}

async function mergeProjectCatalog(
  sourcePath: string,
  targetPath: string,
  candidateGatewayNodeId: string,
): Promise<void> {
  const [source, target] = await Promise.all([
    readRequiredRecord(sourcePath, 'source project catalog'),
    readRequiredRecord(targetPath, 'candidate project catalog'),
  ])
  if (source.version !== 1 || target.version !== 1) {
    throw new Error('Gateway project catalog version is not supported for handoff')
  }
  const projects = mergeKeyedArrays(
    requireArray(source.projects, 'source projects'),
    requireArray(target.projects, 'candidate projects'),
    value => requireString(record(value)?.roomId, 'project room ID'),
    'project room',
  )
  assertUniqueField(projects, 'roomId', 'room ID')
  assertUniqueField(projects, 'conversationId', 'conversation ID')
  assertUniqueOptionalField(projects, 'projectId', 'project ID')
  await writePrivateJson(targetPath, {
    version: 1,
    gatewayNodeId: candidateGatewayNodeId,
    projects,
  })
}

async function mergeRuntimeState(
  sourcePath: string,
  targetPath: string,
  workspaceId: string,
): Promise<{ projectCount: number; sessionCount: number }> {
  const [source, target] = await Promise.all([
    readRequiredRecord(sourcePath, 'source runtime state'),
    readRequiredRecord(targetPath, 'candidate runtime state'),
  ])
  if (
    source.version !== 3
    || target.version !== 3
    || source.workspaceId !== workspaceId
    || target.workspaceId !== workspaceId
  ) throw new Error('Gateway runtime state does not match the handoff Workspace')
  const projects = mergeRecords(
    requireRecord(source.projects, 'source runtime projects'),
    requireRecord(target.projects, 'candidate runtime projects'),
    'runtime project',
  )
  let sessionCount = 0
  const sessionIds = new Set<string>()
  for (const [roomId, value] of Object.entries(projects)) {
    const project = requireRecord(value, `runtime project ${roomId}`)
    const sessions = requireArray(project.sessions, `runtime project ${roomId} sessions`)
    for (const value of sessions) {
      const session = requireRecord(value, `runtime session in ${roomId}`)
      const sessionId = requireString(session.id, 'runtime session ID')
      if (sessionIds.has(sessionId)) {
        throw new Error(`Gateway handoff has duplicate session ID ${sessionId}`)
      }
      sessionIds.add(sessionId)
      sessionCount += 1
    }
  }
  await writePrivateJson(targetPath, { version: 3, workspaceId, projects })
  return { projectCount: Object.keys(projects).length, sessionCount }
}

async function mergeCommandJournal(sourcePath: string, targetPath: string): Promise<void> {
  if (!await fileExists(sourcePath) || !await fileExists(targetPath)) {
    throw new Error('Both Gateway command journals are required for promotion')
  }
  const source = new DatabaseSync(sourcePath, { readOnly: true })
  const target = new DatabaseSync(targetPath)
  try {
    requireSqliteIntegrity(source, 'source')
    requireSqliteIntegrity(target, 'candidate')
    const sourceMetadata = source.prepare(
      'SELECT schema_version FROM journal_metadata WHERE singleton = 1',
    ).get() as { schema_version?: unknown } | undefined
    const targetMetadata = target.prepare(
      'SELECT schema_version FROM journal_metadata WHERE singleton = 1',
    ).get() as { schema_version?: unknown } | undefined
    if (sourceMetadata?.schema_version !== 2 || targetMetadata?.schema_version !== 2) {
      throw new Error('Gateway command journal schema is not handoff-compatible')
    }
    const columns = [
      'command_key', 'fingerprint', 'operation', 'command_json', 'room_id',
      'source_matrix_event_id', 'status', 'accepted_at', 'dispatched_at',
      'terminal_at', 'terminal_json', 'terminal_delivery_event_id',
      'terminal_delivered_at',
    ] as const
    const sourceRows = source.prepare(
      `SELECT ${columns.join(', ')} FROM commands ORDER BY command_key`,
    ).all() as Array<Record<string, unknown>>
    const select = target.prepare(
      `SELECT ${columns.join(', ')} FROM commands WHERE command_key = ?`,
    )
    const insert = target.prepare(
      `INSERT INTO commands (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
    )
    target.exec('BEGIN IMMEDIATE')
    try {
      for (const row of sourceRows) {
        const key = requireString(row.command_key, 'command journal key')
        const existing = select.get(key) as Record<string, unknown> | undefined
        if (existing) {
          if (!sameJson(existing, row)) {
            throw new Error(`Gateway command journal conflict for ${key}`)
          }
          continue
        }
        insert.run(...columns.map(column => sqliteValue(row[column])))
      }
      target.prepare(`
        UPDATE journal_metadata
        SET generation = ?, legacy_source_path = NULL,
            legacy_source_sha256 = NULL, migrated_at = NULL
        WHERE singleton = 1
      `).run(randomUUID())
      target.exec('COMMIT')
    } catch (error) {
      target.exec('ROLLBACK')
      throw error
    }
    requireSqliteIntegrity(target, 'merged')
    target.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  } finally {
    source.close()
    target.close()
  }
}

async function mergeInboxFiles(sourcePaths: string[], targetPath: string): Promise<void> {
  let records: Record<string, unknown> = {}
  for (const path of sourcePaths) {
    const state = await readOptionalRecord(path)
    if (!state) continue
    if (state.version !== 1) throw new Error(`Unsupported Gateway inbox ${path}`)
    records = mergeRecords(records, requireRecord(state.records, 'inbox records'), 'inbox event')
  }
  if (Object.keys(records).length > 10_000) {
    throw new Error('Merged Gateway inbox exceeds 10000 retained events')
  }
  await writePrivateJson(targetPath, { version: 1, records })
}

async function mergeTimelineKeys(sourcePath: string, targetPath: string): Promise<void> {
  const source = await readOptionalRecord(sourcePath)
  if (!source) return
  const target = await readOptionalRecord(targetPath) ?? { version: 1, rooms: {} }
  if (source.version !== 1 || target.version !== 1) {
    throw new Error('Unsupported Gateway timeline key store')
  }
  const rooms = mergeRecords(
    requireRecord(source.rooms, 'source timeline key rooms'),
    requireRecord(target.rooms, 'candidate timeline key rooms'),
    'timeline key room',
  )
  await writePrivateJson(targetPath, { version: 1, rooms })
}

async function mergeReplayStores(sourcePath: string, targetPath: string): Promise<void> {
  const source = await readOptionalRecord(sourcePath)
  if (!source) return
  const target = await readOptionalRecord(targetPath) ?? { version: 1, claims: {} }
  if (source.version !== 1 || target.version !== 1) {
    throw new Error(`Unsupported Gateway replay store ${basename(targetPath)}`)
  }
  const sourceClaims = requireRecord(source.claims, 'source replay claims')
  const targetClaims = requireRecord(target.claims, 'candidate replay claims')
  const claims: Record<string, number> = {}
  for (const key of new Set([...Object.keys(sourceClaims), ...Object.keys(targetClaims)])) {
    const left = sourceClaims[key]
    const right = targetClaims[key]
    if (left !== undefined && (!Number.isSafeInteger(left) || (left as number) < 0)) {
      throw new Error(`Invalid source replay claim ${key}`)
    }
    if (right !== undefined && (!Number.isSafeInteger(right) || (right as number) < 0)) {
      throw new Error(`Invalid candidate replay claim ${key}`)
    }
    claims[key] = Math.max((left as number | undefined) ?? 0, (right as number | undefined) ?? 0)
  }
  await writePrivateJson(targetPath, { version: 1, claims })
}

async function mergeRecordStore(
  sourcePath: string,
  targetPath: string,
  workspaceId: string,
  fields: string[],
): Promise<void> {
  const source = await readOptionalRecord(sourcePath)
  if (!source) return
  const target = await readOptionalRecord(targetPath)
  if (!target) {
    await writePrivateJson(targetPath, source)
    return
  }
  if (
    source.version !== target.version
    || source.workspaceId !== workspaceId
    || target.workspaceId !== workspaceId
  ) throw new Error(`Gateway state store ${basename(targetPath)} is not handoff-compatible`)
  const merged = { ...target }
  for (const field of fields) {
    merged[field] = mergeRecords(
      requireRecord(source[field], `source ${field}`),
      requireRecord(target[field], `candidate ${field}`),
      field,
    )
  }
  await writePrivateJson(targetPath, merged)
}

async function mergeNativeReleases(
  sourcePath: string,
  targetPath: string,
  workspaceId: string,
): Promise<void> {
  const source = await readOptionalRecord(sourcePath)
  if (!source) return
  const target = await readOptionalRecord(targetPath) ?? {
    version: 1,
    workspaceId,
    releases: [],
  }
  if (
    source.version !== 1
    || target.version !== 1
    || source.workspaceId !== workspaceId
    || target.workspaceId !== workspaceId
  ) throw new Error('Native client release state is not handoff-compatible')
  const releases = mergeKeyedArrays(
    requireArray(source.releases, 'source native releases'),
    requireArray(target.releases, 'candidate native releases'),
    value => {
      const release = requireRecord(value, 'native release')
      return [release.platform, release.channel, release.architecture].map(part =>
        requireString(part, 'native release binding')).join('\0')
    },
    'native release',
    (left, right) => {
      const leftCode = Number(requireRecord(left, 'native release').versionCode)
      const rightCode = Number(requireRecord(right, 'native release').versionCode)
      if (leftCode === rightCode && !sameJson(left, right)) {
        throw new Error('Native release version is immutable across Gateway handoff')
      }
      return leftCode > rightCode ? left : right
    },
  )
  await writePrivateJson(targetPath, { version: 1, workspaceId, releases })
}

async function mergeWebPush(sourcePath: string, targetPath: string): Promise<void> {
  const source = await readOptionalRecord(sourcePath)
  if (!source) return
  const target = await readOptionalRecord(targetPath)
  if (!target) {
    await writePrivateJson(targetPath, source)
    return
  }
  if (source.version !== 1 || target.version !== 1 || !sameJson(source.vapid, target.vapid)) {
    throw new Error('Gateway Web Push identity is not handoff-compatible')
  }
  const subscriptions = mergeLatestUpdatedRecords(
    requireRecord(source.subscriptions, 'source Web Push subscriptions'),
    requireRecord(target.subscriptions, 'candidate Web Push subscriptions'),
  )
  const pending = mergeRecords(
    requireRecord(source.pending, 'source Web Push pending events'),
    requireRecord(target.pending, 'candidate Web Push pending events'),
    'Web Push pending event',
  )
  const completedEventIds = [...new Set([
    ...requireStringArray(source.completedEventIds, 'source completed Web Push events'),
    ...requireStringArray(target.completedEventIds, 'candidate completed Web Push events'),
  ])].slice(-512)
  await writePrivateJson(targetPath, {
    version: 1,
    vapid: target.vapid,
    subscriptions,
    pending,
    completedEventIds,
  })
}

function mergeRecords(
  source: Record<string, unknown>,
  target: Record<string, unknown>,
  label: string,
): Record<string, unknown> {
  const merged = structuredClone(target)
  for (const [key, value] of Object.entries(source)) {
    if (merged[key] !== undefined && !sameJson(merged[key], value)) {
      throw new Error(`Gateway handoff ${label} conflict for ${key}`)
    }
    merged[key] ??= structuredClone(value)
  }
  return merged
}

function mergeLatestUpdatedRecords(
  source: Record<string, unknown>,
  target: Record<string, unknown>,
): Record<string, unknown> {
  const merged = structuredClone(target)
  for (const [key, value] of Object.entries(source)) {
    const current = merged[key]
    if (current === undefined) {
      merged[key] = structuredClone(value)
      continue
    }
    const left = requireRecord(value, `record ${key}`)
    const right = requireRecord(current, `record ${key}`)
    const leftUpdatedAt = Number(left.updatedAt)
    const rightUpdatedAt = Number(right.updatedAt)
    if (!Number.isSafeInteger(leftUpdatedAt) || !Number.isSafeInteger(rightUpdatedAt)) {
      throw new Error(`Gateway handoff record ${key} has no valid update time`)
    }
    if (leftUpdatedAt === rightUpdatedAt && !sameJson(left, right)) {
      throw new Error(`Gateway handoff record ${key} conflicts at one update time`)
    }
    if (leftUpdatedAt > rightUpdatedAt) merged[key] = structuredClone(value)
  }
  return merged
}

function mergeKeyedArrays(
  source: unknown[],
  target: unknown[],
  keyOf: (value: unknown) => string,
  label: string,
  resolveConflict?: (left: unknown, right: unknown) => unknown,
): unknown[] {
  const merged = new Map<string, unknown>()
  for (const value of [...target, ...source]) {
    const key = keyOf(value)
    const current = merged.get(key)
    if (current === undefined) {
      merged.set(key, structuredClone(value))
    } else if (!sameJson(current, value)) {
      if (!resolveConflict) throw new Error(`Gateway handoff ${label} conflict for ${key}`)
      merged.set(key, structuredClone(resolveConflict(current, value)))
    }
  }
  return [...merged.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, value]) => value)
}

async function copyTree(source: string, target: string): Promise<void> {
  const entries = await readdir(source, { withFileTypes: true })
  for (const entry of entries) {
    if (EPHEMERAL_NAMES.has(entry.name) || entry.name.endsWith('.lock')) continue
    const sourcePath = join(source, entry.name)
    const targetPath = join(target, entry.name)
    const metadata = await lstat(sourcePath)
    if (metadata.isSymbolicLink()) {
      throw new Error(`Gateway deployment state contains a symlink: ${sourcePath}`)
    }
    if (metadata.isDirectory()) {
      await mkdir(targetPath, { recursive: true, mode: metadata.mode & 0o777 })
      await copyTree(sourcePath, targetPath)
      continue
    }
    if (metadata.isFile()) {
      await mkdir(dirname(targetPath), { recursive: true, mode: 0o700 })
      await copyFile(sourcePath, targetPath)
      await chmod(targetPath, metadata.mode & 0o777)
      continue
    }
    if (!metadata.isSocket()) {
      throw new Error(`Gateway deployment state has an unsupported file: ${sourcePath}`)
    }
  }
}

async function mergeTree(source: string, target: string): Promise<void> {
  if (!await fileExists(source)) return
  await mkdir(target, { recursive: true, mode: 0o700 })
  const entries = await readdir(source, { withFileTypes: true })
  for (const entry of entries) {
    const sourcePath = join(source, entry.name)
    const targetPath = join(target, entry.name)
    const metadata = await lstat(sourcePath)
    if (metadata.isSymbolicLink()) {
      throw new Error(`Gateway handoff data contains a symlink: ${sourcePath}`)
    }
    if (metadata.isDirectory()) {
      await mergeTree(sourcePath, targetPath)
      continue
    }
    if (!metadata.isFile()) continue
    if (await fileExists(targetPath)) {
      const [left, right] = await Promise.all([sha256File(sourcePath), sha256File(targetPath)])
      if (left !== right) throw new Error(`Gateway handoff file conflict: ${targetPath}`)
      continue
    }
    await mkdir(dirname(targetPath), { recursive: true, mode: 0o700 })
    await copyFile(sourcePath, targetPath)
    await chmod(targetPath, metadata.mode & 0o777)
  }
}

async function hashTree(root: string): Promise<Array<{
  path: string
  size: number
  sha256: string
}>> {
  const result: Array<{ path: string; size: number; sha256: string }> = []
  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name)
      const metadata = await lstat(path)
      if (metadata.isSymbolicLink()) throw new Error(`Gateway handoff target contains a symlink: ${path}`)
      if (metadata.isDirectory()) await visit(path)
      else if (metadata.isFile()) {
        result.push({
          path: relative(root, path),
          size: metadata.size,
          sha256: await sha256File(path),
        })
      }
    }
  }
  await visit(root)
  return result
}

async function readRequiredRecord(path: string, label: string): Promise<Record<string, unknown>> {
  const value = await readOptionalRecord(path)
  if (!value) throw new Error(`Gateway handoff is missing ${label}: ${path}`)
  return value
}

async function readOptionalRecord(path: string): Promise<Record<string, unknown> | null> {
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as unknown
    return requireRecord(value, `JSON file ${path}`)
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return null
    throw error
  }
}

async function writePrivateJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  const handle = await open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  await chmod(temporary, 0o600)
  await rename(temporary, path)
  await chmod(path, 0o600)
}

async function sha256File(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

function requireSqliteIntegrity(database: DatabaseSync, label: string): void {
  const row = database.prepare('PRAGMA quick_check').get() as Record<string, unknown> | undefined
  if (!row || Object.values(row)[0] !== 'ok') {
    throw new Error(`${label} Gateway command journal failed integrity check`)
  }
}

function sqliteValue(value: unknown): string | number | bigint | Uint8Array | null {
  if (
    value === null
    || typeof value === 'string'
    || typeof value === 'number'
    || typeof value === 'bigint'
    || value instanceof Uint8Array
  ) return value
  throw new Error('Gateway command journal contains an unsupported SQLite value')
}

function assertUniqueField(values: unknown[], field: string, label: string): void {
  const found = values.map(value => requireString(record(value)?.[field], label))
  if (new Set(found).size !== found.length) throw new Error(`Gateway handoff has duplicate ${label}`)
}

function assertUniqueOptionalField(values: unknown[], field: string, label: string): void {
  const found = values.map(value => record(value)?.[field]).filter(value => value !== undefined)
  if (found.some(value => typeof value !== 'string' || !value)) {
    throw new Error(`Gateway handoff has an invalid ${label}`)
  }
  if (new Set(found).size !== found.length) throw new Error(`Gateway handoff has duplicate ${label}`)
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  const parsed = record(value)
  if (!parsed) throw new Error(`Gateway handoff ${label} is invalid`)
  return parsed
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`Gateway handoff ${label} is invalid`)
  return value
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`Gateway handoff ${label} is invalid`)
  return value
}

function requireStringArray(value: unknown, label: string): string[] {
  const values = requireArray(value, label)
  if (values.some(entry => typeof entry !== 'string' || !entry)) {
    throw new Error(`Gateway handoff ${label} is invalid`)
  }
  return values as string[]
}

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalJson(left as JsonValue) === canonicalJson(right as JsonValue)
}

function requireOpaqueSegment(value: string, label: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value)) {
    throw new Error(`${label} is invalid`) 
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return false
    throw error
  }
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error
    && 'code' in error
    && (error as NodeJS.ErrnoException).code === code
}
