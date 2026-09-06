import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { buildGatewayDeploymentHandoff } from '@/ops/gatewayDeploymentHandoff'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path =>
    rm(path, { recursive: true, force: true })))
})

describe('Gateway deployment handoff', () => {
  it('merges old and candidate projects, sessions, commands, keys, and shadow input', async () => {
    const fixture = await handoffFixture()
    await seedDeployment(fixture.source, {
      gatewayNodeId: 'gateway-old',
      roomId: '!old:example.test',
      projectId: 'project-old',
      sessionId: 'session-old',
      providerSessionId: 'provider-old',
      commandKey: '["workspace-1","device","certificate","command-old"]',
    })
    await seedDeployment(fixture.candidate, {
      gatewayNodeId: 'gateway-new',
      roomId: '!new:example.test',
      projectId: 'project-new',
      sessionId: 'session-new',
      providerSessionId: 'provider-new',
      commandKey: '["workspace-1","device","certificate","command-new"]',
    })
    await writeJson(join(
      fixture.candidate,
      'gateway-replay.jsonl.v3-matrix-shadow-inbox.json',
    ), {
      version: 1,
      records: {
        shadow: {
          key: 'shadow',
          event: { roomId: '!old:example.test', eventId: '$shadow' },
          receivedAt: 4,
          status: 'pending',
        },
      },
    })

    const result = await buildGatewayDeploymentHandoff({
      sourceDirectory: fixture.source,
      candidateDirectory: fixture.candidate,
      transactionRoot: fixture.transactions,
      updateId: 'update-1',
      candidateGatewayNodeId: 'gateway-new',
      workspaceId: 'workspace-1',
      now: 10,
    })

    expect(result).toMatchObject({ projectCount: 2, sessionCount: 2 })
    const catalog = await readJson(join(result.targetDirectory, 'gateway-projects.json'))
    expect(catalog).toMatchObject({ gatewayNodeId: 'gateway-new' })
    expect((catalog.projects as unknown[])).toHaveLength(2)
    const runtime = await readJson(join(
      result.targetDirectory,
      'gateway-replay.jsonl.v3-runtime-state.json',
    ))
    expect(Object.keys(runtime.projects as object)).toEqual([
      '!new:example.test',
      '!old:example.test',
    ])
    expect(JSON.stringify(runtime)).toContain('provider-old')
    expect(JSON.stringify(runtime)).toContain('provider-new')
    const inbox = await readJson(join(
      result.targetDirectory,
      'gateway-replay.jsonl.v3-matrix-inbox.json',
    ))
    expect(Object.keys(inbox.records as object).sort()).toEqual([
      'candidate-inbox',
      'shadow',
      'source-inbox',
    ])
    const keys = await readJson(join(
      result.targetDirectory,
      'envelope-replay.json.v3-project-keys.json',
    ))
    expect(Object.keys(keys.rooms as object).sort()).toEqual([
      '!new:example.test',
      '!old:example.test',
    ])
    const database = new DatabaseSync(join(
      result.targetDirectory,
      'gateway-replay.jsonl.v3-commands.sqlite',
    ), { readOnly: true })
    try {
      expect(database.prepare('SELECT command_key FROM commands ORDER BY command_key').all())
        .toEqual([
          { command_key: '["workspace-1","device","certificate","command-new"]' },
          { command_key: '["workspace-1","device","certificate","command-old"]' },
        ])
    } finally {
      database.close()
    }
    const manifest = await readJson(result.manifestPath)
    expect(manifest).toMatchObject({
      updateId: 'update-1',
      candidateGatewayNodeId: 'gateway-new',
      digest: result.digest,
    })
  })

  it('aborts without a target when project identities conflict', async () => {
    const fixture = await handoffFixture()
    await seedDeployment(fixture.source, {
      gatewayNodeId: 'gateway-old',
      roomId: '!old:example.test',
      projectId: 'same-project',
      sessionId: 'session-old',
      providerSessionId: 'provider-old',
      commandKey: '["workspace-1","device","certificate","command-old"]',
    })
    await seedDeployment(fixture.candidate, {
      gatewayNodeId: 'gateway-new',
      roomId: '!new:example.test',
      projectId: 'same-project',
      sessionId: 'session-new',
      providerSessionId: 'provider-new',
      commandKey: '["workspace-1","device","certificate","command-new"]',
    })

    await expect(buildGatewayDeploymentHandoff({
      sourceDirectory: fixture.source,
      candidateDirectory: fixture.candidate,
      transactionRoot: fixture.transactions,
      updateId: 'update-conflict',
      candidateGatewayNodeId: 'gateway-new',
      workspaceId: 'workspace-1',
    })).rejects.toThrow('duplicate project ID')
    await expect(readFile(join(fixture.transactions, 'update-conflict'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })
})

async function handoffFixture(): Promise<{
  root: string
  source: string
  candidate: string
  transactions: string
}> {
  const root = await mkdtemp(join(tmpdir(), 'malink-gateway-handoff-'))
  temporaryDirectories.push(root)
  const source = join(root, 'source')
  const candidate = join(root, 'candidate')
  const transactions = join(root, 'transactions')
  await Promise.all([
    mkdir(source, { recursive: true }),
    mkdir(candidate, { recursive: true }),
    mkdir(transactions, { recursive: true }),
  ])
  return { root, source, candidate, transactions }
}

async function seedDeployment(directory: string, input: {
  gatewayNodeId: string
  roomId: string
  projectId: string
  sessionId: string
  providerSessionId: string
  commandKey: string
}): Promise<void> {
  await writeJson(join(directory, 'gateway-projects.json'), {
    version: 1,
    gatewayNodeId: input.gatewayNodeId,
    projects: [{
      roomId: input.roomId,
      conversationId: input.roomId,
      projectId: input.projectId,
      projectName: input.projectId,
      cwd: `/tmp/${input.projectId}`,
      providerName: 'codex',
    }],
  })
  await writeJson(join(directory, 'gateway-replay.jsonl.v3-runtime-state.json'), {
    version: 3,
    workspaceId: 'workspace-1',
    projects: {
      [input.roomId]: {
        roomId: input.roomId,
        projectId: input.projectId,
        name: input.projectId,
        cwd: `/tmp/${input.projectId}`,
        provider: 'codex',
        sessions: [{ id: input.sessionId, providerSessionId: input.providerSessionId }],
      },
    },
  })
  await writeJson(join(directory, 'gateway-replay.jsonl.v3-matrix-inbox.json'), {
    version: 1,
    records: {
      [`${input.gatewayNodeId === 'gateway-old' ? 'source' : 'candidate'}-inbox`]: {
        key: `${input.gatewayNodeId === 'gateway-old' ? 'source' : 'candidate'}-inbox`,
      },
    },
  })
  await writeJson(join(directory, 'envelope-replay.json.v3-project-keys.json'), {
    version: 1,
    rooms: {
      [input.roomId]: {
        activeEpochId: `epoch-${input.projectId}`,
        epochs: [],
      },
    },
  })
  createJournal(join(directory, 'gateway-replay.jsonl.v3-commands.sqlite'), input.commandKey)
}

function createJournal(path: string, commandKey: string): void {
  const database = new DatabaseSync(path)
  try {
    database.exec(`
      CREATE TABLE journal_metadata (
        singleton INTEGER PRIMARY KEY,
        schema_version INTEGER NOT NULL,
        generation TEXT NOT NULL,
        legacy_source_path TEXT,
        legacy_source_sha256 TEXT,
        created_at INTEGER NOT NULL,
        migrated_at INTEGER
      ) STRICT;
      CREATE TABLE commands (
        command_key TEXT PRIMARY KEY,
        fingerprint TEXT NOT NULL,
        operation TEXT NOT NULL,
        command_json TEXT,
        room_id TEXT,
        source_matrix_event_id TEXT,
        status TEXT NOT NULL,
        accepted_at INTEGER NOT NULL,
        dispatched_at INTEGER,
        terminal_at INTEGER,
        terminal_json TEXT,
        terminal_delivery_event_id TEXT,
        terminal_delivered_at INTEGER
      ) STRICT;
    `)
    database.prepare(
      'INSERT INTO journal_metadata VALUES (1, 2, ?, NULL, NULL, 1, NULL)',
    ).run(`generation-${commandKey}`)
    database.prepare(`
      INSERT INTO commands (
        command_key, fingerprint, operation, command_json, room_id,
        source_matrix_event_id, status, accepted_at, dispatched_at,
        terminal_at, terminal_json, terminal_delivery_event_id,
        terminal_delivered_at
      ) VALUES (?, ?, 'session.create', NULL, NULL, NULL, 'accepted', 1, NULL, NULL, NULL, NULL, NULL)
    `).run(commandKey, `fingerprint-${commandKey}`)
  } finally {
    database.close()
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value)}\n`, { mode: 0o600 })
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
}
