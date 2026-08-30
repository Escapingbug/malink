import { appendFile, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { GatewayAdminStatus } from '@/gateway/admin'
import type { Mlp3Command, Mlp3Event } from '@malink/protocol'
import { FileMlp3CommandJournal } from '@/gateway/matrix/fileMlp3CommandJournal'
import { runGatewayJournalRepairCli } from '@/ops/gatewayJournalRepairCli'

const updateCommand: Mlp3Command = {
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

function terminalEvent(eventId: string, interrupted: boolean): Mlp3Event {
  return {
    kind: 'malink.event',
    version: 3,
    eventId,
    workspaceId: 'workspace-1',
    projectId: 'project-1',
    occurredAt: 3,
    causationCommandId: updateCommand.commandId,
    payload: interrupted
      ? {
          type: 'command.rejected',
          commandId: updateCommand.commandId,
          code: 'execution_interrupted',
          message: 'The Gateway restarted after dispatch.',
          retryable: true,
        }
      : {
          type: 'gateway.update.status',
          status: {
            version: 1,
            phase: 'staged',
            releaseId: 'release-2',
            targetBuildId: 'build-2',
            updatedAt: 3,
          },
        },
  }
}

describe('Gateway journal repair CLI', () => {
  it('stops one named Gateway, repairs with backup, restarts, and verifies health', async () => {
    const root = await mkdtemp(join(tmpdir(), 'malink-journal-cli-'))
    try {
      const dataDirectory = join(root, 'gateway-data')
      await mkdir(dataDirectory)
      const journalPath = join(dataDirectory, 'gateway-replay.jsonl.v3-commands.jsonl')
      await writeRepairableJournal(journalPath)
      const launchAgent = join(root, 'gateway.plist')
      await writeFile(launchAgent, '<plist/>\n')
      const launchctl = vi.fn(async (_arguments: readonly string[]) => undefined)
      const gateway = healthyGateway()
      const waitForGateway = vi.fn(async () => gateway)
      const acknowledgeRecovery = vi.fn(async () => ({
        version: 1 as const,
        phase: 'rolled_back' as const,
        currentBuildId: 'build-1',
        updatedAt: 5,
      }))

      const result = await runGatewayJournalRepairCli([
        '--',
        'recover',
        '--data-dir', dataDirectory,
        '--service-label', 'com.malink.matrix-gateway',
        '--launch-agent', launchAgent,
        '--supervisor-socket', join(root, 'supervisor.sock'),
      ], {
        platform: 'darwin',
        uid: 501,
        launchctl,
        waitForGateway,
        acknowledgeRecovery,
      })

      expect(result).toMatchObject({
        state: 'recovered',
        repair: { removedLines: [6, 7] },
        gateway: { state: 'running', matrixReady: true },
        supervisor: { phase: 'rolled_back', currentBuildId: 'build-1' },
      })
      expect(launchctl.mock.calls.map(([arguments_]) => arguments_)).toEqual([
        ['bootout', 'gui/501/com.malink.matrix-gateway'],
        ['bootstrap', 'gui/501', launchAgent],
        ['kickstart', '-k', 'gui/501/com.malink.matrix-gateway'],
      ])
      expect(waitForGateway).toHaveBeenCalledWith(join(dataDirectory, 'admin.sock'), 180_000)
      expect(acknowledgeRecovery).toHaveBeenCalledWith(join(root, 'supervisor.sock'))
      expect(await readFile((result as { repair: { backupPath: string } }).repair.backupPath, 'utf8'))
        .toContain('event-succeeded')
      const recovered = new FileMlp3CommandJournal(journalPath)
      await recovered.initialize()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

async function writeRepairableJournal(path: string): Promise<void> {
  const journal = new FileMlp3CommandJournal(path)
  await journal.initialize()
  await journal.claim(updateCommand, 1)
  await journal.markDispatched(updateCommand, 2)
  await journal.settle(updateCommand, {
    outcome: 'interrupted',
    eventId: 'event-interrupted',
    event: terminalEvent('event-interrupted', true),
  }, 3)
  await journal.markTerminalDelivered(updateCommand, '$matrix-interrupted', 4)
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
      event: terminalEvent('event-succeeded', false),
    },
  })}\n${JSON.stringify({
    version: 3,
    kind: 'terminal_delivered',
    key: accepted.key,
    fingerprint: accepted.fingerprint,
    matrixEventId: '$matrix-succeeded',
    deliveredAt: 6,
  })}\n`)
}

function healthyGateway(): GatewayAdminStatus {
  return {
    version: 1,
    gatewayId: 'workspace-1',
    workspaceId: 'workspace-1',
    gatewayNodeId: 'node-1',
    gatewayShortId: 'NODE1',
    gatewayName: 'Test Gateway',
    state: 'running',
    pid: 123,
    startedAt: 1,
    activeDeviceCount: 1,
    openInvitationCount: 0,
    matrixReady: true,
    lastMatrixSyncAt: 2,
  }
}
