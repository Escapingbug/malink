import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Mlp3Command, Mlp3Event } from '@malink/protocol'
import { FileMlp3CommandJournal } from '@/gateway/matrix/fileMlp3CommandJournal'

function command(id = 'command-1'): Mlp3Command {
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
})
