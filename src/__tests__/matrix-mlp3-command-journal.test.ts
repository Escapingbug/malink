import { chmod, mkdtemp, readFile, rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import type { Mlp3Command, Mlp3Event } from '@malink/protocol'
import { FileMlp3CommandJournal } from '@/gateway/matrix/fileMlp3CommandJournal'
import {
  inspectSqliteMlp3CommandJournal,
  SqliteMlp3CommandJournal,
} from '@/gateway/matrix/sqliteMlp3CommandJournal'

function command(
  id = 'command-1',
): Extract<Mlp3Command, { operation: 'prompt.submit' }> {
  return {
    kind: 'malink.command',
    version: 3,
    commandId: id,
    workspaceId: 'workspace-1',
    projectId: 'project-1',
    sessionId: 'session-1',
    deviceId: 'device-1',
    certificateId: 'certificate-1',
    createdAt: 1,
    operation: 'prompt.submit',
    payload: { operation: 'prompt.submit', text: 'hello' },
  }
}

function terminalEvent(): Mlp3Event {
  return {
    kind: 'malink.event',
    version: 3,
    eventId: 'terminal-event-1',
    workspaceId: 'workspace-1',
    projectId: 'project-1',
    sessionId: 'session-1',
    occurredAt: 3,
    causationCommandId: 'command-1',
    payload: {
      type: 'turn.completed',
      turnId: 'command-1',
      outcome: 'succeeded',
      projection: {
        title: 'Session',
        lifecycle: 'active',
        activity: 'idle',
        updatedAt: 3,
        stateVersion: 2,
      },
    },
  }
}

function providerListCommand(): Mlp3Command {
  return {
    kind: 'malink.command',
    version: 3,
    commandId: 'provider-list-command',
    workspaceId: 'workspace-1',
    projectId: 'project-1',
    deviceId: 'device-1',
    certificateId: 'certificate-1',
    createdAt: 1,
    operation: 'provider.sessions.list',
    payload: { operation: 'provider.sessions.list', provider: 'codex' },
  }
}

function projectDeleteCommand(): Extract<Mlp3Command, { operation: 'project.delete' }> {
  return {
    kind: 'malink.command',
    version: 3,
    commandId: 'project-delete-command',
    workspaceId: 'workspace-1',
    projectId: 'project-1',
    deviceId: 'device-1',
    certificateId: 'certificate-1',
    createdAt: 1,
    operation: 'project.delete',
    payload: { operation: 'project.delete' },
  }
}

describe('FileMlp3CommandJournal', () => {
  it('accepts independent command IDs without a global sequence slot', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'malink-v3-journal-')), 'journal.jsonl')
    const journal = new FileMlp3CommandJournal(path)
    await journal.initialize()
    await expect(journal.claim(command('command-2'), 2)).resolves.toMatchObject({ kind: 'accepted' })
    await expect(journal.claim(command('command-1'), 3)).resolves.toMatchObject({ kind: 'accepted' })
    expect(await journal.unfinished()).toHaveLength(2)
  })

  it('returns the durable state for an exact duplicate across restart', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'malink-v3-journal-')), 'journal.jsonl')
    const first = new FileMlp3CommandJournal(path)
    await first.initialize()
    await first.claim(command(), 1, {
      roomId: '!project:example.org',
      matrixEventId: '$root:example.org',
    })
    await first.markDispatched(command(), 2)
    await first.settle(command(), {
      outcome: 'succeeded',
      eventId: 'terminal-event-1',
      event: terminalEvent(),
      sessionId: 'session-1',
    }, 3)

    const recovered = new FileMlp3CommandJournal(path)
    await recovered.initialize()
    await expect(recovered.claim(command(), 4)).resolves.toMatchObject({
      kind: 'duplicate',
      record: {
        status: 'terminal',
        matrixEventId: '$root:example.org',
        terminal: { eventId: 'terminal-event-1' },
      },
    })
    await expect(recovered.pendingTerminalDeliveries()).resolves.toHaveLength(1)
    await recovered.markTerminalDelivered(command(), '$matrix-terminal', 5)
    await expect(recovered.pendingTerminalDeliveries()).resolves.toHaveLength(0)

    const delivered = new FileMlp3CommandJournal(path)
    await delivered.initialize()
    await expect(delivered.claim(command(), 6)).resolves.toMatchObject({
      record: { terminalDeliveryEventId: '$matrix-terminal' },
    })
  })

  it('does not redispatch a command left past the provider boundary', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'malink-v3-journal-')), 'journal.jsonl')
    const first = new FileMlp3CommandJournal(path)
    await first.initialize()
    await first.claim(command(), 1)
    await first.markDispatched(command(), 2)

    const recovered = new FileMlp3CommandJournal(path)
    await recovered.initialize()
    await expect(recovered.unfinished()).resolves.toMatchObject([
      { status: 'dispatched', command: { commandId: 'command-1' } },
    ])
  })

  it('loads an undelivered legacy Provider History terminal with oversized provider fields', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'malink-v3-journal-')), 'journal.jsonl')
    const input = providerListCommand()
    const first = new FileMlp3CommandJournal(path)
    await first.initialize()
    await first.claim(input, 1)
    await first.markDispatched(input, 2)
    const legacyPayload = {
      type: 'provider.sessions.listed' as const,
      provider: 'codex',
      sessions: [{
        sessionId: 'legacy-provider-session',
        title: '历史标题'.repeat(700),
        updatedAt: 1,
        cwd: '/workspace',
      }],
    }
    await first.settle(input, {
      outcome: 'succeeded',
      eventId: 'legacy-provider-terminal',
      event: {
        kind: 'malink.event',
        version: 3,
        eventId: 'legacy-provider-terminal',
        workspaceId: 'workspace-1',
        projectId: 'project-1',
        occurredAt: 3,
        causationCommandId: input.commandId,
        payload: legacyPayload,
      } as Mlp3Event,
      result: legacyPayload,
    }, 3)

    const recovered = new FileMlp3CommandJournal(path)
    await expect(recovered.initialize()).resolves.toBeUndefined()
    await expect(recovered.pendingTerminalDeliveries()).resolves.toMatchObject([{
      command: { commandId: input.commandId },
      terminal: { eventId: 'legacy-provider-terminal' },
    }])
  })
})

describe('SqliteMlp3CommandJournal', () => {
  it('imports JSONL once without modifying it and keeps unfinished commands queryable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'malink-v3-sqlite-journal-'))
    const jsonlPath = join(root, 'journal.jsonl')
    const sqlitePath = join(root, 'journal.sqlite')
    const legacy = new FileMlp3CommandJournal(jsonlPath)
    await legacy.initialize()
    await legacy.claim(command(), 1, {
      roomId: '!project:example.org',
      matrixEventId: '$command:example.org',
    })
    await legacy.markDispatched(command(), 2)
    const before = await readFile(jsonlPath)

    const journal = new SqliteMlp3CommandJournal(sqlitePath, jsonlPath)
    await journal.initialize()
    expect(await readFile(jsonlPath)).toEqual(before)
    await expect(journal.unfinished()).resolves.toMatchObject([{
      status: 'dispatched',
      command: { commandId: 'command-1' },
      matrixEventId: '$command:example.org',
    }])
    await expect(inspectSqliteMlp3CommandJournal(sqlitePath)).resolves.toMatchObject({
      generation: legacy.getGeneration(),
      legacySourcePath: jsonlPath,
      legacySourceSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
    })
    await journal.close()

    const reopened = new SqliteMlp3CommandJournal(sqlitePath, jsonlPath)
    await expect(reopened.initialize()).resolves.toBeUndefined()
    await expect(reopened.claim(command(), 4)).resolves.toMatchObject({
      kind: 'duplicate',
      record: { status: 'dispatched' },
    })
    await reopened.close()
  })

  it('retains the terminal event for client recovery while compacting delivered commands', async () => {
    const root = await mkdtemp(join(tmpdir(), 'malink-v3-sqlite-journal-'))
    const jsonlPath = join(root, 'journal.jsonl')
    const sqlitePath = join(root, 'journal.sqlite')
    const journal = new SqliteMlp3CommandJournal(sqlitePath, jsonlPath)
    await journal.claim(command(), 1)
    await journal.markDispatched(command(), 2)
    await journal.settle(command(), {
      outcome: 'succeeded',
      eventId: 'terminal-event-1',
      event: terminalEvent(),
      sessionId: 'session-1',
    }, 3)
    await expect(journal.pendingTerminalDeliveries()).resolves.toMatchObject([{
      command: { payload: { text: 'hello' } },
      terminal: { event: { payload: { type: 'turn.completed' } } },
    }])
    await journal.markTerminalDelivered(command(), '$matrix-terminal', 4)
    await expect(journal.pendingTerminalDeliveries()).resolves.toEqual([])
    await expect(journal.claim(command(), 5)).resolves.toMatchObject({
      kind: 'duplicate',
      record: {
        terminalDeliveryEventId: '$matrix-terminal',
        terminal: { eventId: 'terminal-event-1', sessionId: 'session-1' },
      },
    })
    await journal.close()

    const database = new DatabaseSync(sqlitePath, { readOnly: true })
    try {
      expect(database.prepare(`
        SELECT COUNT(*) AS count, command_json, terminal_json
        FROM commands WHERE operation = 'prompt.submit'
      `).get()).toMatchObject({ count: 1, command_json: null })
      const row = database.prepare(`
        SELECT terminal_json FROM commands WHERE operation = 'prompt.submit'
      `).get() as { terminal_json: string }
      expect(JSON.parse(row.terminal_json)).toMatchObject({
        event: { payload: { type: 'turn.completed' } },
      })
    } finally {
      database.close()
    }
  })

  it('retains delivered project deletion authority for restart recovery', async () => {
    const root = await mkdtemp(join(tmpdir(), 'malink-v3-sqlite-journal-'))
    const journal = new SqliteMlp3CommandJournal(
      join(root, 'journal.sqlite'),
      join(root, 'journal.jsonl'),
    )
    const input = projectDeleteCommand()
    await journal.claim(input, 1)
    await journal.markDispatched(input, 2)
    await journal.settle(input, {
      outcome: 'succeeded',
      eventId: 'terminal-event-1',
      event: terminalEvent(),
    }, 3)
    await journal.markTerminalDelivered(input, '$matrix-terminal', 4)
    await expect(journal.terminalProjectDeletions()).resolves.toMatchObject([{
      command: { commandId: 'project-delete-command', operation: 'project.delete' },
      terminal: { outcome: 'succeeded' },
    }])
    await journal.close()
  })

  it('does not read historical JSONL again after migration', async () => {
    const root = await mkdtemp(join(tmpdir(), 'malink-v3-sqlite-journal-'))
    const jsonlPath = join(root, 'journal.jsonl')
    const sqlitePath = join(root, 'journal.sqlite')
    const legacy = new FileMlp3CommandJournal(jsonlPath)
    await legacy.initialize()
    await legacy.claim(command(), 1)
    const journal = new SqliteMlp3CommandJournal(sqlitePath, jsonlPath)
    await journal.initialize()
    await journal.close()

    await chmod(jsonlPath, 0o600)
    await rename(jsonlPath, `${jsonlPath}.archived`)
    const reopened = new SqliteMlp3CommandJournal(sqlitePath, jsonlPath)
    await expect(reopened.initialize()).resolves.toBeUndefined()
    await expect(reopened.claim(command(), 2)).resolves.toMatchObject({
      kind: 'duplicate',
    })
    await reopened.close()
  })

  it('rejects command ID reuse with different signed content', async () => {
    const root = await mkdtemp(join(tmpdir(), 'malink-v3-sqlite-journal-'))
    const journal = new SqliteMlp3CommandJournal(
      join(root, 'journal.sqlite'),
      join(root, 'journal.jsonl'),
    )
    await journal.claim(command(), 1)
    await expect(journal.claim({
      ...command(),
      payload: { operation: 'prompt.submit', text: 'different' },
    }, 2)).rejects.toMatchObject({ code: 'idempotency_conflict' })
    await journal.close()
  })
})
