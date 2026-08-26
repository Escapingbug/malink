import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FileMatrixEventInbox } from '@/gateway/matrix/fileMatrixEventInbox'
import type { MatrixIncomingEvent } from '@/channel/matrix'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path =>
    rm(path, { recursive: true, force: true })))
})

describe('FileMatrixEventInbox', () => {
  it('persists pending events and removes them only after completion', async () => {
    const directory = await temporaryDirectory()
    const path = join(directory, 'matrix-inbox.json')
    const event = incomingEvent('$event-1')
    const first = new FileMatrixEventInbox(path)
    await first.initialize()

    await expect(first.stage(event, 42)).resolves.toBe(true)
    await expect(first.stage(event, 43)).resolves.toBe(false)

    const reopened = new FileMatrixEventInbox(path)
    await reopened.initialize()
    await expect(reopened.pending()).resolves.toEqual([expect.objectContaining({
      event,
      receivedAt: 42,
      status: 'pending',
    })])

    await reopened.complete(event)
    await expect(reopened.pending()).resolves.toEqual([])
    await expect(reopened.counts()).resolves.toEqual({ pending: 0, quarantined: 0 })
  })

  it('rejects an event ID whose content changes after durable receipt', async () => {
    const directory = await temporaryDirectory()
    const inbox = new FileMatrixEventInbox(join(directory, 'matrix-inbox.json'))
    await inbox.initialize()
    await inbox.stage(incomingEvent('$event-1'))

    await expect(inbox.stage({
      ...incomingEvent('$event-1'),
      content: { body: 'changed' },
    })).rejects.toThrow(/changed after durable receipt/u)
  })

  it('retains rejected events as bounded quarantine instead of retrying them', async () => {
    const directory = await temporaryDirectory()
    const inbox = new FileMatrixEventInbox(join(directory, 'matrix-inbox.json'))
    const event = incomingEvent('$poison')
    await inbox.initialize()
    await inbox.stage(event)
    await inbox.quarantine(event, new Error('invalid signature'))

    await expect(inbox.pending()).resolves.toEqual([])
    await expect(inbox.counts()).resolves.toEqual({ pending: 0, quarantined: 1 })
  })
})

function incomingEvent(eventId: string): MatrixIncomingEvent {
  return {
    roomId: '!project:example.test',
    eventId,
    eventType: 'm.room.message',
    sender: '@device:example.test',
    encrypted: false,
    content: { body: 'Malink command' },
  }
}

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'malink-matrix-event-inbox-'))
  temporaryDirectories.push(path)
  return path
}
