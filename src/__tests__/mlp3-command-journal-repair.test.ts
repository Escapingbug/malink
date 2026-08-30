import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Mlp3Command, Mlp3Event } from '@malink/protocol'
import { FileMlp3CommandJournal } from '@/gateway/matrix/fileMlp3CommandJournal'
import {
  planMlp3CommandJournalRepair,
  repairMlp3CommandJournal,
} from '@/gateway/matrix/mlp3CommandJournalRepair'

function command(): Mlp3Command {
  return {
    kind: 'malink.command',
    version: 3,
    commandId: 'gateway-update-command',
    workspaceId: 'workspace-1',
    projectId: 'project-1',
    deviceId: 'device-1',
    certificateId: 'certificate-1',
    createdAt: 1,
    operation: 'gateway.update.stage',
    payload: { operation: 'gateway.update.stage', releaseId: 'release-2' },
  }
}

function event(
  eventId: string,
  outcome: 'succeeded' | 'interrupted',
): Mlp3Event {
  return {
    kind: 'malink.event',
    version: 3,
    eventId,
    workspaceId: 'workspace-1',
    projectId: 'project-1',
    sessionId: 'maintenance-1',
    occurredAt: 3,
    causationCommandId: 'gateway-update-command',
    payload: outcome === 'interrupted'
      ? {
          type: 'command.rejected',
          commandId: 'gateway-update-command',
          code: 'execution_interrupted',
          message: 'The Gateway restarted after dispatch.',
          retryable: true,
        }
      : {
          type: 'turn.completed',
          turnId: 'gateway-update-command',
          outcome: 'succeeded',
          projection: {
            title: 'Gateway update',
            lifecycle: 'active',
            activity: 'idle',
            updatedAt: 3,
            stateVersion: 2,
          },
        },
  }
}

describe('MLP/3 command journal repair', () => {
  it('preserves the first delivered terminal and removes a later conflicting pair', async () => {
    const root = await mkdtemp(join(tmpdir(), 'malink-journal-repair-'))
    try {
      const path = join(root, 'commands.jsonl')
      const journal = new FileMlp3CommandJournal(path)
      await journal.initialize()
      await journal.claim(command(), 1)
      await journal.markDispatched(command(), 2)
      await journal.settle(command(), {
        outcome: 'interrupted',
        eventId: 'event-interrupted',
        event: event('event-interrupted', 'interrupted'),
      }, 3)
      await journal.markTerminalDelivered(command(), '$matrix-interrupted', 4)
      const accepted = JSON.parse((await readFile(path, 'utf8')).split('\n')[1]!) as {
        key: string
        fingerprint: string
      }
      await appendFile(path, `${JSON.stringify({
        version: 3,
        kind: 'terminal',
        key: accepted.key,
        fingerprint: accepted.fingerprint,
        terminalAt: 5,
        terminal: {
          outcome: 'succeeded',
          eventId: 'event-succeeded',
          event: event('event-succeeded', 'succeeded'),
        },
      })}\n${JSON.stringify({
        version: 3,
        kind: 'terminal_delivered',
        key: accepted.key,
        fingerprint: accepted.fingerprint,
        matrixEventId: '$matrix-succeeded',
        deliveredAt: 6,
      })}\n`)

      const plan = planMlp3CommandJournalRepair(await readFile(path, 'utf8'))
      expect(plan.removedLines).toEqual([6, 7])
      expect(plan.duplicateTerminals).toEqual([expect.objectContaining({
        commandId: 'gateway-update-command',
        preservedTerminalLine: 4,
        preservedTerminalEventId: 'event-interrupted',
        duplicateTerminalLine: 6,
        duplicateTerminalEventId: 'event-succeeded',
        duplicateDeliveryLine: 7,
      })])

      const result = await repairMlp3CommandJournal(path)
      expect(await readFile(result.backupPath, 'utf8')).toContain('event-succeeded')
      expect(await readFile(result.auditPath, 'utf8')).toContain(result.beforeSha256)
      const recovered = new FileMlp3CommandJournal(path)
      await recovered.initialize()
      await expect(recovered.claim(command(), 7)).resolves.toMatchObject({
        kind: 'duplicate',
        record: {
          status: 'terminal',
          terminal: { outcome: 'interrupted', eventId: 'event-interrupted' },
          terminalDeliveryEventId: '$matrix-interrupted',
        },
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('refuses to choose between conflicting undelivered terminals', async () => {
    const root = await mkdtemp(join(tmpdir(), 'malink-journal-repair-'))
    try {
      const path = join(root, 'commands.jsonl')
      const journal = new FileMlp3CommandJournal(path)
      await journal.initialize()
      await journal.claim(command(), 1)
      await journal.markDispatched(command(), 2)
      await journal.settle(command(), {
        outcome: 'interrupted',
        eventId: 'event-interrupted',
        event: event('event-interrupted', 'interrupted'),
      }, 3)
      const accepted = JSON.parse((await readFile(path, 'utf8')).split('\n')[1]!) as {
        key: string
        fingerprint: string
      }
      await appendFile(path, `${JSON.stringify({
        version: 3,
        kind: 'terminal',
        key: accepted.key,
        fingerprint: accepted.fingerprint,
        terminalAt: 4,
        terminal: {
          outcome: 'succeeded',
          eventId: 'event-succeeded',
          event: event('event-succeeded', 'succeeded'),
        },
      })}\n`)

      expect(() => planMlp3CommandJournalRepair('')).toThrow(/missing its generation/u)
      await expect(repairMlp3CommandJournal(path)).rejects.toThrow(
        /first terminal result was not durably delivered/u,
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
