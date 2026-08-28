import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { JsonValue, Mlp3Event } from '@malink/protocol'
import { InMemoryMatrixTransport } from '@/channel/matrix'
import type {
  MatrixSendEventRequest,
  MatrixTransport,
  MatrixUploadMediaRequest,
} from '@/channel/matrix/transport'
import {
  FileMlp3ArtifactStore,
  MAX_INLINE_IMAGE_BYTES,
  type ArtifactMessageContext,
} from '@/gateway/matrix/fileMlp3ArtifactStore'
import { MatrixMlp3Projection } from '../../apps/pwa/app/matrixMlp3Projection'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })),
  )
})

describe('MLP/3 artifact references', () => {
  it('rewrites bounded local links, deduplicates stat metadata, and eagerly uploads a small image', async () => {
    const root = await temporaryDirectory()
    const cwd = join(root, 'project')
    await mkdir(cwd)
    await writeFile(join(cwd, 'preview.png'), new Uint8Array([1, 2, 3, 4]))
    await writeFile(join(cwd, 'notes.txt'), 'notes')
    await writeFile(join(root, 'outside.txt'), 'secret')
    const store = new FileMlp3ArtifactStore(join(root, 'artifacts.json'), 'workspace-1')
    await store.initialize()

    const prepared = await store.prepare(context(cwd), 'message-1', {
      format: 'markdown',
      text: [
        '![preview](preview.png)',
        '[notes](notes.txt)',
        '[same notes](notes.txt)',
        '[outside](../outside.txt)',
        '`[inline example](notes.txt)`',
        '```md',
        '[fenced example](notes.txt)',
        '```',
      ].join('\n'),
    })

    expect(prepared.references).toHaveLength(2)
    expect(prepared.references.map(reference => reference.name).sort()).toEqual([
      'notes.txt',
      'preview.png',
    ])
    expect(prepared.message.text).not.toContain('(preview.png)')
    expect(prepared.message.text.match(/malink-artifact:/gu)).toHaveLength(3)
    expect(prepared.message.text).toContain('[outside](../outside.txt)')
    expect(prepared.message.text).toContain('`[inline example](notes.txt)`')
    expect(prepared.message.text).toContain('[fenced example](notes.txt)')
    expect(prepared.message.attachments).toMatchObject([
      { type: 'photo', filename: 'preview.png', optionalArtifact: true },
    ])
    expect(prepared.references.find(reference => reference.kind === 'image')?.size)
      .toBeLessThan(MAX_INLINE_IMAGE_BYTES)

    const transport = new InMemoryMatrixTransport()
    const eager = await store.uploadAttachment(transport, prepared.message.attachments![0]!)
    await store.published(context(cwd), {
      messageId: 'message-1',
      messageVersion: 1,
      body: prepared.message.text,
      format: 'markdown',
      final: true,
      projection: projection(),
      references: prepared.references,
      attachments: [eager],
    })

    const notes = prepared.references.find(reference => reference.name === 'notes.txt')!
    const materializations = await Promise.all([
      store.materialize(context(cwd), notes.id, notes.statRevision, transport),
      store.materialize(context(cwd), notes.id, notes.statRevision, transport),
    ])
    expect(materializations[0]).toMatchObject({
      status: 'materialized',
      messageId: 'message-1',
      messageVersion: 2,
      attachments: [{ id: eager.id }, { id: notes.id, name: 'notes.txt' }],
    })
    expect(materializations[1]).toMatchObject({
      status: 'materialized',
      messageVersion: 3,
    })
    expect(transport.media.size).toBe(2)
  })

  it('returns updated stat metadata without uploading when the source changed', async () => {
    const root = await temporaryDirectory()
    const cwd = join(root, 'project')
    await mkdir(cwd)
    const path = join(cwd, 'report.txt')
    await writeFile(path, 'old')
    const store = new FileMlp3ArtifactStore(join(root, 'artifacts.json'), 'workspace-1')
    await store.initialize()
    const prepared = await store.prepare(context(cwd), 'message-2', {
      format: 'markdown',
      text: '[report](report.txt)',
    })
    const reference = prepared.references[0]!
    await store.published(context(cwd), {
      messageId: 'message-2',
      messageVersion: 1,
      body: prepared.message.text,
      format: 'markdown',
      final: true,
      projection: projection(),
      references: prepared.references,
      attachments: [],
    })
    await writeFile(path, 'new and larger')

    const transport = new InMemoryMatrixTransport()
    const changed = await store.materialize(
      context(cwd),
      reference.id,
      reference.statRevision,
      transport,
    )
    expect(changed).toMatchObject({
      status: 'changed',
      messageVersion: 2,
      references: [{ id: reference.id, size: 14 }],
      attachments: [],
    })
    expect(transport.media.size).toBe(0)
  })

  it('serializes media uploads and honors Matrix 429 retry hints without timeline messages', async () => {
    const root = await temporaryDirectory()
    const firstPath = join(root, 'first.txt')
    const secondPath = join(root, 'second.txt')
    await writeFile(firstPath, 'first')
    await writeFile(secondPath, 'second')
    const waits: number[] = []
    const timeline: MatrixSendEventRequest[] = []
    let calls = 0
    let active = 0
    let maximumActive = 0
    const transport: MatrixTransport = {
      async sendEncryptedRoomEvent(request) {
        timeline.push(request)
        return { eventId: '$unexpected' }
      },
      async uploadEncryptedMedia(_request: MatrixUploadMediaRequest) {
        calls += 1
        active += 1
        maximumActive = Math.max(maximumActive, active)
        await Promise.resolve()
        active -= 1
        if (calls === 1) {
          throw { httpStatus: 429, data: { errcode: 'M_LIMIT_EXCEEDED', retry_after_ms: 25 } }
        }
        return { url: `mxc://example.test/${calls}` }
      },
    }
    const store = new FileMlp3ArtifactStore(
      join(root, 'artifacts.json'),
      'workspace-1',
      { wait: async delayMs => { waits.push(delayMs) } },
    )
    await store.initialize()

    const [first, second] = await Promise.all([
      store.uploadAttachment(transport, { path: firstPath }),
      store.uploadAttachment(transport, { path: secondPath }),
    ])

    expect(first.media.url).toBe('mxc://example.test/2')
    expect(second.media.url).toBe('mxc://example.test/3')
    expect(calls).toBe(3)
    expect(maximumActive).toBe(1)
    expect(waits).toEqual([250])
    expect(timeline).toEqual([])
  })

  it('uses a higher assistant version as both the in-place replacement and command terminal', () => {
    const client = new MatrixMlp3Projection()
    const reference = {
      id: 'reference-1',
      kind: 'file' as const,
      name: 'report.txt',
      relativePath: 'report.txt',
      mimeType: 'text/plain',
      size: 6,
      modifiedAt: 1,
      statRevision: 'revision-1',
    }
    client.applyEvent(assistantEvent({
      eventId: 'assistant-v1',
      messageVersion: 1,
      artifactReferences: [reference],
    }), '$physical-1')
    client.applyEvent(assistantEvent({
      eventId: 'assistant-v2',
      messageVersion: 2,
      causationCommandId: 'materialize-1',
      artifactReferences: [reference],
      ui: {
        kind: 'artifact_materialization',
        version: 1,
        referenceId: reference.id,
        status: 'materialized',
      },
    }), '$physical-2')

    expect(client.sessionMessages('session-1')).toHaveLength(1)
    expect(client.sessionMessages('session-1')[0]).toMatchObject({
      logicalId: 'assistant:message-1:0',
      version: 2,
    })
    expect(client.completions.get('materialize-1')).toMatchObject({
      commandId: 'materialize-1',
      outcome: 'succeeded',
      sessionId: 'session-1',
    })
  })
})

function assistantEvent(input: {
  eventId: string
  messageVersion: number
  causationCommandId?: string
  artifactReferences: Array<{
    id: string
    kind: 'file'
    name: string
    relativePath: string
    mimeType: string
    size: number
    modifiedAt: number
    statRevision: string
  }>
  ui?: JsonValue
}): Mlp3Event {
  return {
    kind: 'malink.event',
    version: 3,
    eventId: input.eventId,
    workspaceId: 'workspace-1',
    projectId: 'project-1',
    sessionId: 'session-1',
    ...(input.causationCommandId ? { causationCommandId: input.causationCommandId } : {}),
    occurredAt: input.messageVersion,
    payload: {
      type: 'assistant.message',
      messageId: 'message-1',
      messageVersion: input.messageVersion,
      body: '[report](malink-artifact:reference-1)',
      format: 'markdown',
      final: true,
      projection: projection(),
      artifactReferences: input.artifactReferences,
      ...(input.ui ? { ui: input.ui } : {}),
    },
  }
}

function context(cwd: string): ArtifactMessageContext {
  return {
    roomId: '!project:example.test',
    projectId: 'project-1',
    sessionId: 'session-1',
    threadRootEventId: '$root',
    cwd,
  }
}

function projection() {
  return {
    title: 'Session',
    lifecycle: 'active' as const,
    activity: 'idle' as const,
    updatedAt: 1,
    stateVersion: 1,
  }
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'malink-artifacts-'))
  temporaryDirectories.push(directory)
  return directory
}
