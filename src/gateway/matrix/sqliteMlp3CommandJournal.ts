import { createHash, randomUUID } from 'node:crypto'
import { chmod, mkdir, open, readFile, stat } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  canonicalJson,
  mlp3CommandSchema,
  type Mlp3Command,
  type Mlp3EventPayload,
} from '@malink/protocol'
import { SecurityError } from '@malink/security'
import {
  isMlp3CommandTerminal,
  mlp3CommandFingerprint,
  mlp3CommandKey,
  parseMlp3CommandJournal,
  type Mlp3CommandClaim,
  type Mlp3CommandJournal,
  type Mlp3CommandJournalRecord,
  type Mlp3CommandTerminal,
} from './fileMlp3CommandJournal'

const COMMAND_JOURNAL_SCHEMA_VERSION = 2

type JournalMetadataRow = {
  schema_version: number
  generation: string
  legacy_source_path: string | null
  legacy_source_sha256: string | null
  migrated_at: number | null
}

type CommandRow = {
  command_key: string
  fingerprint: string
  operation: string
  command_json: string | null
  room_id: string | null
  source_matrix_event_id: string | null
  status: string
  accepted_at: number
  dispatched_at: number | null
  terminal_at: number | null
  terminal_json: string | null
  terminal_delivery_event_id: string | null
  terminal_delivered_at: number | null
}

export type SqliteMlp3CommandJournalMigration = {
  schemaVersion: number
  generation: string
  legacySourcePath?: string
  legacySourceSha256?: string
  migratedAt?: number
}

/**
 * Active MLP/3 execution-once store. The legacy JSONL is imported exactly once,
 * then remains immutable evidence bound to the database by its SHA-256 digest.
 */
export class SqliteMlp3CommandJournal implements Mlp3CommandJournal {
  private database: DatabaseSync | null = null
  private initialized = false
  private generation: string | null = null
  private chain: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly databasePath: string,
    private readonly legacyJsonlPath: string,
  ) {}

  initialize(): Promise<void> {
    return this.serial(() => this.initializeCore())
  }

  close(): Promise<void> {
    return this.serial(async () => {
      this.database?.close()
      this.database = null
      this.initialized = false
      this.generation = null
    })
  }

  getGeneration(): string {
    if (!this.initialized || !this.generation) {
      throw new Error('MLP/3 command journal is not initialized')
    }
    return this.generation
  }

  claim(
    commandInput: Mlp3Command,
    now = Date.now(),
    context?: { roomId: string; matrixEventId: string },
  ): Promise<Mlp3CommandClaim> {
    return this.serial(async () => {
      const database = await this.requireDatabase()
      const command = mlp3CommandSchema.parse(commandInput)
      const key = mlp3CommandKey(command)
      const fingerprint = mlp3CommandFingerprint(command)
      const current = this.selectCommand(database, key)
      if (current) {
        if (current.fingerprint !== fingerprint) {
          throw new SecurityError(
            'idempotency_conflict',
            'Command ID was reused with different signed content',
          )
        }
        return { kind: 'duplicate', record: rowToRecord(current, command) }
      }
      database.prepare(`
        INSERT INTO commands (
          command_key, fingerprint, operation, command_json,
          room_id, source_matrix_event_id, status, accepted_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'accepted', ?)
      `).run(
        key,
        fingerprint,
        command.operation,
        JSON.stringify(command),
        context?.roomId ?? null,
        context?.matrixEventId ?? null,
        now,
      )
      return {
        kind: 'accepted',
        record: {
          command,
          fingerprint,
          ...(context ? context : {}),
          status: 'accepted',
          acceptedAt: now,
        },
      }
    })
  }

  markDispatched(commandInput: Mlp3Command, now = Date.now()): Promise<void> {
    return this.serial(async () => {
      const database = await this.requireDatabase()
      const command = mlp3CommandSchema.parse(commandInput)
      const row = this.requireExact(database, command)
      if (row.status === 'terminal' || row.status === 'dispatched') return
      const result = database.prepare(`
        UPDATE commands SET status = 'dispatched', dispatched_at = ?
        WHERE command_key = ? AND fingerprint = ? AND status = 'accepted'
      `).run(now, row.command_key, row.fingerprint)
      if (result.changes !== 1) throw new Error('Failed to persist MLP/3 dispatch transition')
    })
  }

  settle(
    commandInput: Mlp3Command,
    terminalInput: Mlp3CommandTerminal,
    now = Date.now(),
  ): Promise<void> {
    return this.serial(async () => {
      const database = await this.requireDatabase()
      const command = mlp3CommandSchema.parse(commandInput)
      if (!isMlp3CommandTerminal(terminalInput)) {
        throw new Error('Invalid MLP/3 command terminal result')
      }
      const terminal = structuredClone(terminalInput)
      const row = this.requireExact(database, command)
      if (row.status === 'terminal') {
        if (row.terminal_delivery_event_id) return
        const current = parseTerminal(row.terminal_json)
        if (canonicalJson(current) !== canonicalJson(terminal)) {
          throw new Error('Command already has a different terminal result')
        }
        return
      }
      const result = database.prepare(`
        UPDATE commands
        SET status = 'terminal', terminal_at = ?, terminal_json = ?
        WHERE command_key = ? AND fingerprint = ? AND status != 'terminal'
      `).run(now, JSON.stringify(terminal), row.command_key, row.fingerprint)
      if (result.changes !== 1) throw new Error('Failed to persist MLP/3 terminal transition')
    })
  }

  get(commandInput: Mlp3Command): Promise<Mlp3CommandJournalRecord | undefined> {
    return this.serial(async () => {
      const database = await this.requireDatabase()
      const command = mlp3CommandSchema.parse(commandInput)
      const row = this.selectCommand(database, mlp3CommandKey(command))
      if (!row) return undefined
      if (row.fingerprint !== mlp3CommandFingerprint(command)) {
        throw new SecurityError(
          'idempotency_conflict',
          'Command ID does not match its durable journal fingerprint',
        )
      }
      return rowToRecord(row, command)
    })
  }

  unfinished(): Promise<Mlp3CommandJournalRecord[]> {
    return this.serial(async () => {
      const database = await this.requireDatabase()
      return this.selectMany(
        database,
        "SELECT * FROM commands WHERE status != 'terminal' ORDER BY accepted_at, command_key",
      ).map(row => rowToRecord(row))
    })
  }

  pendingTerminalDeliveries(): Promise<Mlp3CommandJournalRecord[]> {
    return this.serial(async () => {
      const database = await this.requireDatabase()
      return this.selectMany(database, `
        SELECT * FROM commands
        WHERE status = 'terminal'
          AND terminal_delivery_event_id IS NULL
          AND terminal_json IS NOT NULL
        ORDER BY terminal_at, command_key
      `).map(row => rowToRecord(row))
    })
  }

  terminalProjectDeletions(): Promise<Array<Mlp3CommandJournalRecord & {
    command: Extract<Mlp3Command, { operation: 'project.delete' }>
  }>> {
    return this.serial(async () => {
      const database = await this.requireDatabase()
      return this.selectMany(database, `
        SELECT * FROM commands
        WHERE status = 'terminal' AND operation = 'project.delete' AND command_json IS NOT NULL
        ORDER BY terminal_at, command_key
      `).map(row => rowToRecord(row) as Mlp3CommandJournalRecord & {
        command: Extract<Mlp3Command, { operation: 'project.delete' }>
      })
    })
  }

  markTerminalDelivered(
    commandInput: Mlp3Command,
    matrixEventId: string,
    now = Date.now(),
  ): Promise<void> {
    return this.serial(async () => {
      const database = await this.requireDatabase()
      const command = mlp3CommandSchema.parse(commandInput)
      const row = this.requireExact(database, command)
      if (row.status !== 'terminal') {
        throw new Error('Command has no durable terminal event to mark delivered')
      }
      if (row.terminal_delivery_event_id) {
        if (row.terminal_delivery_event_id !== matrixEventId) {
          throw new Error('Command terminal was delivered with a different Matrix event ID')
        }
        return
      }
      const terminal = parseTerminal(row.terminal_json)
      if (!terminal.event) {
        throw new Error('Command has no durable terminal event to mark delivered')
      }
      const compactTerminal = compactDeliveredTerminal(terminal)
      const retainCommand = command.operation === 'project.delete'
      const result = database.prepare(`
        UPDATE commands
        SET terminal_delivery_event_id = ?, terminal_delivered_at = ?,
            terminal_json = ?, command_json = ?
        WHERE command_key = ? AND fingerprint = ?
          AND status = 'terminal' AND terminal_delivery_event_id IS NULL
      `).run(
        matrixEventId,
        now,
        JSON.stringify(compactTerminal),
        retainCommand ? JSON.stringify(command) : null,
        row.command_key,
        row.fingerprint,
      )
      if (result.changes !== 1) throw new Error('Failed to persist MLP/3 terminal delivery')
    })
  }

  private async requireDatabase(): Promise<DatabaseSync> {
    if (!this.initialized) await this.initializeCore()
    if (!this.database) throw new Error('MLP/3 command journal is not initialized')
    return this.database
  }

  private async initializeCore(): Promise<void> {
    if (this.initialized) return
    await mkdir(dirname(this.databasePath), { recursive: true })
    const handle = await open(this.databasePath, 'a', 0o600)
    await handle.close()
    await chmod(this.databasePath, 0o600)
    const database = new DatabaseSync(this.databasePath)
    this.database = database
    try {
      this.configure(database)
      this.createSchema(database)
      const metadata = this.readMetadata(database)
      if (metadata) {
        this.validateMetadata(metadata)
        await this.assertNoSplitAuthority(metadata)
        this.generation = metadata.generation
      } else {
        const count = this.commandCount(database)
        if (count !== 0) {
          throw new Error('SQLite MLP/3 command journal has records but no migration metadata')
        }
        const legacyBytes = await readOptionalFile(this.legacyJsonlPath)
        if (legacyBytes) {
          const migrated = this.migrateLegacy(database, legacyBytes)
          this.generation = migrated.generation
        } else {
          this.generation = randomUUID()
          this.insertFreshMetadata(database, this.generation)
        }
        this.assertIntegrity(database)
      }
      this.initialized = true
      await secureSqliteFiles(this.databasePath)
      if (this.readMetadata(database)?.legacy_source_path) {
        await secureLegacyEvidence(this.legacyJsonlPath)
      }
    } catch (error) {
      database.close()
      this.database = null
      this.generation = null
      throw error
    }
  }

  private configure(database: DatabaseSync): void {
    database.exec('PRAGMA journal_mode = WAL')
    database.exec('PRAGMA synchronous = FULL')
    database.exec('PRAGMA foreign_keys = ON')
    database.exec('PRAGMA busy_timeout = 5000')
  }

  private createSchema(database: DatabaseSync): void {
    database.exec(`
      CREATE TABLE IF NOT EXISTS journal_metadata (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        schema_version INTEGER NOT NULL,
        generation TEXT NOT NULL,
        legacy_source_path TEXT,
        legacy_source_sha256 TEXT,
        created_at INTEGER NOT NULL,
        migrated_at INTEGER,
        CHECK ((legacy_source_path IS NULL) = (legacy_source_sha256 IS NULL)),
        CHECK ((legacy_source_path IS NULL) = (migrated_at IS NULL))
      ) STRICT;

      CREATE TABLE IF NOT EXISTS commands (
        command_key TEXT PRIMARY KEY,
        fingerprint TEXT NOT NULL,
        operation TEXT NOT NULL,
        command_json TEXT,
        room_id TEXT,
        source_matrix_event_id TEXT,
        status TEXT NOT NULL CHECK (status IN ('accepted', 'dispatched', 'terminal')),
        accepted_at INTEGER NOT NULL,
        dispatched_at INTEGER,
        terminal_at INTEGER,
        terminal_json TEXT,
        terminal_delivery_event_id TEXT,
        terminal_delivered_at INTEGER,
        CHECK (status != 'dispatched' OR dispatched_at IS NOT NULL),
        CHECK (status != 'terminal' OR (terminal_at IS NOT NULL AND terminal_json IS NOT NULL)),
        CHECK ((terminal_delivery_event_id IS NULL) = (terminal_delivered_at IS NULL))
      ) STRICT;

      CREATE INDEX IF NOT EXISTS commands_status_idx
        ON commands(status, terminal_delivery_event_id);
      CREATE INDEX IF NOT EXISTS commands_operation_idx
        ON commands(operation, status);
    `)
  }

  private readMetadata(database: DatabaseSync): JournalMetadataRow | undefined {
    return database.prepare(`
      SELECT schema_version, generation, legacy_source_path, legacy_source_sha256, migrated_at
      FROM journal_metadata WHERE singleton = 1
    `).get() as JournalMetadataRow | undefined
  }

  private validateMetadata(metadata: JournalMetadataRow): void {
    if (metadata.schema_version !== COMMAND_JOURNAL_SCHEMA_VERSION) {
      throw new Error(
        `Unsupported SQLite MLP/3 command journal schema ${metadata.schema_version}`,
      )
    }
    if (!metadata.generation) throw new Error('SQLite MLP/3 command journal has no generation')
  }

  private async assertNoSplitAuthority(metadata: JournalMetadataRow): Promise<void> {
    if (!metadata.legacy_source_sha256) {
      if (await fileExists(this.legacyJsonlPath)) {
        throw new Error(
          'Legacy MLP/3 JSONL appeared after SQLite initialization; refusing split authority',
        )
      }
      return
    }
    // The source digest is evidence for an explicit audit, not a startup input.
    // Active recovery must remain independent of historical JSONL size.
  }

  private migrateLegacy(database: DatabaseSync, bytes: Buffer): {
    generation: string
    sourceSha256: string
  } {
    const parsed = parseMlp3CommandJournal(bytes.toString('utf8'))
    const sourceSha256 = sha256(bytes)
    const migratedAt = Date.now()
    const insert = database.prepare(`
      INSERT INTO commands (
        command_key, fingerprint, operation, command_json,
        room_id, source_matrix_event_id, status, accepted_at,
        dispatched_at, terminal_at, terminal_json,
        terminal_delivery_event_id, terminal_delivered_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    database.exec('BEGIN IMMEDIATE')
    try {
      for (const [key, record] of parsed.records) {
        const delivered = record.terminalDeliveryEventId !== undefined
        const terminal = record.terminal
          ? delivered ? compactDeliveredTerminal(record.terminal) : record.terminal
          : undefined
        insert.run(
          key,
          record.fingerprint,
          record.command.operation,
          delivered && record.command.operation !== 'project.delete'
            ? null
            : JSON.stringify(record.command),
          record.roomId ?? null,
          record.matrixEventId ?? null,
          record.status,
          record.acceptedAt,
          record.dispatchedAt ?? null,
          record.terminalAt ?? null,
          terminal ? JSON.stringify(terminal) : null,
          record.terminalDeliveryEventId ?? null,
          record.terminalDeliveredAt ?? (delivered ? migratedAt : null),
        )
      }
      database.prepare(`
        INSERT INTO journal_metadata (
          singleton, schema_version, generation, legacy_source_path,
          legacy_source_sha256, created_at, migrated_at
        ) VALUES (1, ?, ?, ?, ?, ?, ?)
      `).run(
        COMMAND_JOURNAL_SCHEMA_VERSION,
        parsed.generation,
        resolve(this.legacyJsonlPath),
        sourceSha256,
        migratedAt,
        migratedAt,
      )
      database.exec('COMMIT')
    } catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
    return { generation: parsed.generation, sourceSha256 }
  }

  private insertFreshMetadata(database: DatabaseSync, generation: string): void {
    const now = Date.now()
    database.prepare(`
      INSERT INTO journal_metadata (
        singleton, schema_version, generation, legacy_source_path,
        legacy_source_sha256, created_at, migrated_at
      ) VALUES (1, ?, ?, NULL, NULL, ?, NULL)
    `).run(COMMAND_JOURNAL_SCHEMA_VERSION, generation, now)
  }

  private commandCount(database: DatabaseSync): number {
    const row = database.prepare('SELECT COUNT(*) AS count FROM commands').get() as {
      count: number
    }
    return row.count
  }

  private assertIntegrity(database: DatabaseSync): void {
    const row = database.prepare('PRAGMA quick_check').get() as Record<string, unknown> | undefined
    if (!row || Object.values(row)[0] !== 'ok') {
      throw new Error('SQLite MLP/3 command journal failed its integrity check')
    }
  }

  private selectCommand(database: DatabaseSync, key: string): CommandRow | undefined {
    return database.prepare('SELECT * FROM commands WHERE command_key = ?')
      .get(key) as CommandRow | undefined
  }

  private selectMany(
    database: DatabaseSync,
    sql: string,
    ...parameters: Array<string | number>
  ): CommandRow[] {
    return database.prepare(sql).all(...parameters) as CommandRow[]
  }

  private requireExact(database: DatabaseSync, command: Mlp3Command): CommandRow {
    const row = this.selectCommand(database, mlp3CommandKey(command))
    if (!row || row.fingerprint !== mlp3CommandFingerprint(command)) {
      throw new Error('Command has no exact durable MLP/3 acceptance')
    }
    return row
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.chain.then(operation)
    this.chain = result.then(() => undefined, () => undefined)
    return result
  }
}

export async function inspectSqliteMlp3CommandJournal(
  databasePath: string,
): Promise<SqliteMlp3CommandJournalMigration | undefined> {
  if (!await fileExists(databasePath)) return undefined
  const database = new DatabaseSync(databasePath, { readOnly: true })
  try {
    const table = database.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'journal_metadata'
    `).get()
    if (!table) return undefined
    const row = database.prepare(`
      SELECT schema_version, generation, legacy_source_path, legacy_source_sha256, migrated_at
      FROM journal_metadata WHERE singleton = 1
    `).get() as JournalMetadataRow | undefined
    if (!row) return undefined
    return {
      schemaVersion: row.schema_version,
      generation: row.generation,
      ...(row.legacy_source_path ? { legacySourcePath: row.legacy_source_path } : {}),
      ...(row.legacy_source_sha256 ? { legacySourceSha256: row.legacy_source_sha256 } : {}),
      ...(row.migrated_at === null ? {} : { migratedAt: row.migrated_at }),
    }
  } finally {
    database.close()
  }
}

function rowToRecord(row: CommandRow, fallbackCommand?: Mlp3Command): Mlp3CommandJournalRecord {
  const command = row.command_json
    ? mlp3CommandSchema.parse(parseJson(row.command_json, 'command'))
    : fallbackCommand
  if (!command || mlp3CommandKey(command) !== row.command_key) {
    throw new Error('SQLite MLP/3 command journal has no valid command payload')
  }
  if (mlp3CommandFingerprint(command) !== row.fingerprint || command.operation !== row.operation) {
    throw new Error('SQLite MLP/3 command journal command binding is invalid')
  }
  if (!['accepted', 'dispatched', 'terminal'].includes(row.status)) {
    throw new Error('SQLite MLP/3 command journal has an invalid command status')
  }
  const terminal = row.terminal_json ? parseTerminal(row.terminal_json) : undefined
  if ((row.status === 'terminal') !== Boolean(terminal)) {
    throw new Error('SQLite MLP/3 command journal has an invalid terminal binding')
  }
  return {
    command,
    fingerprint: row.fingerprint,
    ...(row.room_id ? { roomId: row.room_id } : {}),
    ...(row.source_matrix_event_id ? { matrixEventId: row.source_matrix_event_id } : {}),
    status: row.status as Mlp3CommandJournalRecord['status'],
    acceptedAt: row.accepted_at,
    ...(row.dispatched_at === null ? {} : { dispatchedAt: row.dispatched_at }),
    ...(row.terminal_at === null ? {} : { terminalAt: row.terminal_at }),
    ...(terminal ? { terminal } : {}),
    ...(row.terminal_delivery_event_id
      ? { terminalDeliveryEventId: row.terminal_delivery_event_id }
      : {}),
    ...(row.terminal_delivered_at === null
      ? {}
      : { terminalDeliveredAt: row.terminal_delivered_at }),
  }
}

function parseTerminal(json: string | null): Mlp3CommandTerminal {
  if (!json) throw new Error('SQLite MLP/3 command journal has no terminal payload')
  const value = parseJson(json, 'terminal')
  if (!isMlp3CommandTerminal(value)) {
    throw new Error('SQLite MLP/3 command journal has an invalid terminal payload')
  }
  return value
}

function parseJson(json: string, label: string): unknown {
  try {
    return JSON.parse(json)
  } catch {
    throw new Error(`SQLite MLP/3 command journal has invalid ${label} JSON`)
  }
}

function compactDeliveredTerminal(terminal: Mlp3CommandTerminal): Mlp3CommandTerminal {
  const payload = terminal.event?.payload
  const error = terminalError(payload)
  return {
    outcome: terminal.outcome,
    eventId: terminal.eventId,
    ...(terminal.sessionId === undefined ? {} : { sessionId: terminal.sessionId }),
    ...(terminal.code === undefined && !error ? {} : { code: terminal.code ?? error?.code }),
    ...(terminal.error === undefined && !error ? {} : { error: terminal.error ?? error?.message }),
    ...(payload?.type === 'turn.completed' && payload.outcome === 'cancelled'
      ? { reconciledOutcome: 'cancelled' as const }
      : terminal.reconciledOutcome ? { reconciledOutcome: terminal.reconciledOutcome } : {}),
    ...(error ? { retryable: error.retryable } : terminal.retryable === undefined
      ? {}
      : { retryable: terminal.retryable }),
  }
}

function terminalError(payload: Mlp3EventPayload | undefined): {
  code: string
  message: string
  retryable: boolean
} | undefined {
  if (payload?.type === 'turn.failed') {
    return { code: payload.code, message: payload.message, retryable: false }
  }
  if (payload?.type === 'command.rejected') {
    return { code: payload.code, message: payload.message, retryable: payload.retryable }
  }
  return undefined
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

async function readOptionalFile(path: string): Promise<Buffer | undefined> {
  try {
    return await readFile(path)
  } catch (error) {
    if (isMissingFile(error)) return undefined
    throw error
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (isMissingFile(error)) return false
    throw error
  }
}

async function secureSqliteFiles(databasePath: string): Promise<void> {
  await Promise.all(
    [databasePath, `${databasePath}-wal`, `${databasePath}-shm`].map(async path => {
      try {
        await chmod(path, 0o600)
      } catch (error) {
        if (!isMissingFile(error)) throw error
      }
    }),
  )
}

async function secureLegacyEvidence(path: string): Promise<void> {
  try {
    await chmod(path, 0o400)
  } catch (error) {
    if (!isMissingFile(error)) throw error
  }
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
}
