import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { FileMatrixMlp3Outbox } from '@/gateway/matrix/fileMatrixMlp3Outbox'
import { FileGatewayWebPushService } from '@/gateway/matrix/webPush'
import {
  buildGatewayDeploymentHandoff,
  seedGatewayDeploymentCandidateWebPush,
} from '@/ops/gatewayDeploymentHandoff'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path =>
    rm(path, { recursive: true, force: true })))
})

describe('Gateway deployment handoff', () => {
  it('leaves a retained repair room and provider continuation exclusively in the source', async () => {
    const fixture = await handoffFixture()
    for (const [directory, suffix] of [[fixture.source, 'old'], [fixture.candidate, 'new']] as const) {
      await seedDeployment(directory, { gatewayNodeId: `gateway-${suffix}`, roomId: `!${suffix}:example.test`,
        projectId: `project-${suffix}`, sessionId: `session-${suffix}`, providerSessionId: `provider-${suffix}`,
        commandKey: `["workspace-1","device","certificate","command-${suffix}"]` })
    }
    const sourcePath = join(fixture.source, 'gateway-replay.jsonl.v3-runtime-state.json')
    const before = await readFile(sourcePath, 'utf8')
    const result = await buildGatewayDeploymentHandoff({ sourceDirectory: fixture.source,
      candidateDirectory: fixture.candidate, transactionRoot: fixture.transactions,
      updateId: 'retained-test', candidateGatewayNodeId: 'gateway-new', workspaceId: 'workspace-1',
      retainedRoomId: '!old:example.test' })
    const target = await readJson(join(result.targetDirectory, 'gateway-replay.jsonl.v3-runtime-state.json'))
    expect(Object.keys(target.projects as object)).toEqual(['!new:example.test'])
    expect(await readFile(sourcePath, 'utf8')).toBe(before)
    expect(result.sessionCount).toBe(1)
  })
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
    const sourceRuntimePath = join(fixture.source, 'gateway-replay.jsonl.v3-runtime-state.json')
    const sourceRuntime = await readJson(sourceRuntimePath)
    const sourceProjects = sourceRuntime.projects as Record<string, { sessions: unknown[] }>
    sourceProjects['!old:example.test']!.sessions.push(
      { id: 'session-archived', lifecycle: 'archived', providerSessionId: 'retained-archive' },
      { id: 'session-deleted', lifecycle: 'deleted', providerSessionId: 'retained-deleted' },
    )
    await writeJson(sourceRuntimePath, sourceRuntime)
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
    expect(JSON.stringify(runtime)).toContain('retained-archive')
    expect(JSON.stringify(runtime)).toContain('retained-deleted')
    const outbox = new FileMatrixMlp3Outbox(join(
      result.targetDirectory,
      'envelope-replay.json.v3-outbox.jsonl',
    ))
    await outbox.initialize()
    expect(outbox.pending().flatMap(delivery =>
      delivery.kind === 'event' ? [delivery.transactionId] : []).sort()).toEqual([
      'transaction-gateway-new',
      'transaction-gateway-old',
    ])
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

  it('copies and re-homes scratch working directories into the promoted data root', async () => {
    const fixture = await handoffFixture()
    const sessionId = 'gateway-update-node-legacy'
    const component = createHash('sha256')
      .update(`malink-scratch-session\0${sessionId}`)
      .digest('hex')
    const sourceScratch = join(fixture.source, 'scratch-sessions', component)
    await mkdir(sourceScratch, { recursive: true })
    await writeFile(join(sourceScratch, 'maintenance.txt'), 'preserved\n')
    await seedDeployment(fixture.source, {
      gatewayNodeId: 'gateway-old',
      roomId: '!old:example.test',
      projectId: 'project-old',
      sessionId,
      sessionScope: 'scratch',
      sessionCwd: sourceScratch,
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

    const result = await buildGatewayDeploymentHandoff({
      sourceDirectory: fixture.source,
      candidateDirectory: fixture.candidate,
      transactionRoot: fixture.transactions,
      updateId: 'update-scratch',
      candidateGatewayNodeId: 'gateway-new',
      workspaceId: 'workspace-1',
    })

    const runtime = await readJson(join(
      result.targetDirectory,
      'gateway-replay.jsonl.v3-runtime-state.json',
    ))
    const projects = runtime.projects as Record<string, { sessions: Array<Record<string, unknown>> }>
    const migrated = projects['!old:example.test']!.sessions.find(session => session.id === sessionId)
    expect(migrated?.cwd).toBe(join(result.targetDirectory, 'scratch-sessions', component))
    await expect(readFile(join(
      result.targetDirectory,
      'scratch-sessions',
      component,
      'maintenance.txt',
    ), 'utf8')).resolves.toBe('preserved\n')
  })

  it('seeds the candidate Web Push identity without duplicating live delivery state', async () => {
    const fixture = await handoffFixture()
    await writeJson(join(fixture.source, 'gateway-replay.jsonl.v3-web-push.json'), webPushState(
      'source',
      { device: { endpoint: 'https://push.example/source', updatedAt: 1 } },
      { event: { payload: {}, targets: [], attempts: 0, nextAttemptAt: 1 } },
      ['completed'],
    ))

    await seedGatewayDeploymentCandidateWebPush(fixture.source, fixture.candidate)

    const candidatePath = join(
      fixture.candidate,
      'gateway-replay.jsonl.v3-web-push.json',
    )
    await expect(readJson(candidatePath)).resolves.toEqual(webPushState('source', {}, {}, []))
    const service = new FileGatewayWebPushService(candidatePath, {
      sender: { sendNotification: async () => undefined },
    })
    await service.initialize()
    expect(service.publicKey()).toBe('A'.repeat(87))
    await service.flush()
    service.stop()
  })

  it('keeps the active Web Push state when an older candidate has another identity', async () => {
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
    const source = webPushState(
      'source',
      { device: { endpoint: 'https://push.example/source', updatedAt: 1 } },
      { event: { payload: {}, targets: [], attempts: 0, nextAttemptAt: 1 } },
      ['source-completed'],
    )
    await writeJson(join(
      fixture.source,
      'gateway-replay.jsonl.v3-web-push.json',
    ), source)
    await writeJson(join(
      fixture.candidate,
      'gateway-replay.jsonl.v3-web-push.json',
    ), webPushState(
      'candidate',
      { device: { endpoint: 'https://push.example/candidate', updatedAt: 2 } },
      { candidate: { payload: {}, targets: [], attempts: 0, nextAttemptAt: 2 } },
      ['candidate-completed'],
    ))

    const result = await buildGatewayDeploymentHandoff({
      sourceDirectory: fixture.source,
      candidateDirectory: fixture.candidate,
      transactionRoot: fixture.transactions,
      updateId: 'update-web-push',
      candidateGatewayNodeId: 'gateway-new',
      workspaceId: 'workspace-1',
    })

    await expect(readJson(join(
      result.targetDirectory,
      'gateway-replay.jsonl.v3-web-push.json',
    ))).resolves.toEqual(source)
  })
})

function webPushState(
  identity: string,
  subscriptions: Record<string, unknown>,
  pending: Record<string, unknown>,
  completedEventIds: string[],
): Record<string, unknown> {
  const keyByte = identity === 'source' ? 'A' : 'B'
  return {
    version: 1,
    vapid: {
      subject: 'mailto:notifications@malink.dev',
      publicKey: keyByte.repeat(87),
      privateKey: keyByte.toLowerCase().repeat(43),
    },
    subscriptions,
    pending,
    completedEventIds,
  }
}

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
  sessionScope?: 'project' | 'scratch'
  sessionCwd?: string
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
        sessions: [{
          id: input.sessionId,
          lifecycle: 'active',
          ...(input.sessionScope ? { scope: input.sessionScope } : {}),
          ...(input.sessionCwd ? { cwd: input.sessionCwd } : {}),
          providerSessionId: input.providerSessionId,
        }],
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
  const outbox = new FileMatrixMlp3Outbox(join(
    directory,
    'envelope-replay.json.v3-outbox.jsonl',
  ))
  await outbox.initialize()
  await outbox.stage(outbox.createEvent({
    roomId: input.roomId,
    transactionId: `transaction-${input.gatewayNodeId}`,
    content: { msgtype: 'm.notice', body: `pending from ${input.gatewayNodeId}` },
    createdAt: 1,
  }))
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
