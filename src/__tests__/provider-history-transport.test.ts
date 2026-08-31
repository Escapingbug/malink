import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  canonicalJsonBytes,
  mlp3EventPayloadSchema,
  type Mlp3Command,
  type ProviderHistoryMessage,
  type ProviderSessionEntry,
} from '@malink/protocol'
import { exportDeviceKeyPair, generateDeviceKeyPair } from '@malink/security'
import { InMemoryMatrixTransport } from '@/channel/matrix'
import {
  GatewayMlp3ContentLayer,
  MAX_MLP3_MATRIX_TIMELINE_CONTENT_BYTES,
} from '@/gateway/matrix/mlp3Content'
import { gatewayProjectIdentity } from '@/gateway/matrix/project'
import {
  PROVIDER_HISTORY_PLAINTEXT_BUDGET_BYTES,
  boundedProviderHistoryResult,
  boundedProviderSessionInspection,
  providerSessionsPage,
} from '@/gateway/matrix/providerHistoryTransport'

function session(index: number): ProviderSessionEntry {
  return {
    sessionId: `provider-session-${index}`,
    title: `会话 ${index} ${'long-title-'.repeat(30)}`,
    updatedAt: index,
    cwd: `/workspace/${index}/${'nested/'.repeat(20)}`,
  }
}

describe('Provider History Matrix transport bounds', () => {
  it('paginates a large provider session list within one safe plaintext budget', () => {
    const input = Array.from({ length: 256 }, (_, index) => session(index))
    const first = providerSessionsPage('codex', input)

    expect(first.sessions.length).toBeGreaterThan(0)
    expect(first.sessions.length).toBeLessThan(input.length)
    expect(first.nextCursor).toBeTruthy()
    expect(Buffer.byteLength(JSON.stringify(first), 'utf8'))
      .toBeLessThanOrEqual(PROVIDER_HISTORY_PLAINTEXT_BUDGET_BYTES)

    const seen = [...first.sessions]
    let cursor = first.nextCursor
    while (cursor) {
      const page = providerSessionsPage('codex', input, cursor)
      expect(page.sessions.length).toBeGreaterThan(0)
      expect(Buffer.byteLength(JSON.stringify(page), 'utf8'))
        .toBeLessThanOrEqual(PROVIDER_HISTORY_PLAINTEXT_BUDGET_BYTES)
      seen.push(...page.sessions)
      cursor = page.nextCursor
    }
    expect(seen.map(entry => entry.sessionId)).toEqual(input.map(entry => entry.sessionId))
  })

  it('keeps the signed, encrypted and Base64-wrapped Matrix event below its limit', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'malink-provider-history-size-'))
    const gateway = await generateDeviceKeyPair()
    const phone = await generateDeviceKeyPair()
    const roomId = '!provider-history:example.org'
    const layer = new GatewayMlp3ContentLayer(
      'workspace-1',
      {
        gatewayDeviceId: 'workspace-1',
        gatewayKeyPair: await exportDeviceKeyPair(gateway),
        envelopeReplayLedgerPath: join(directory, 'security'),
      },
      [{
        deviceId: 'phone-1',
        publicKey: phone.publicJwk,
        allowedRoomIds: [roomId],
        allowedOperations: ['provider.sessions.list'],
        matrixUserId: '@owner:example.org',
        matrixDeviceId: 'PHONE',
        matrixDeviceKeys: ['matrix-phone-key'],
        certificateExpiresAt: Date.now() + 60_000,
        sequenceEpoch: 'certificate-1',
      }],
    )
    await layer.initialize()
    const transport = new InMemoryMatrixTransport()
    const room = {
      roomId,
      conversationId: 'provider-history',
      cwd: '/repo',
      providerName: 'codex',
    }
    const payload = providerSessionsPage(
      'codex',
      Array.from({ length: 256 }, (_, index) => session(index)),
    )

    await layer.sendEvent(room, {
      kind: 'malink.event',
      version: 3,
      eventId: 'provider-history-page-1',
      workspaceId: 'workspace-1',
      projectId: gatewayProjectIdentity('/repo').id,
      occurredAt: 1,
      causationCommandId: 'provider-history-command-1',
      payload,
    }, transport)

    const content = transport.delivered.at(-1)?.content
    expect(content).toBeTruthy()
    expect(canonicalJsonBytes(content).byteLength)
      .toBeLessThanOrEqual(MAX_MLP3_MATRIX_TIMELINE_CONTENT_BYTES)
  })

  it('keeps the newest inspect messages within the same transport budget', () => {
    const messages: ProviderHistoryMessage[] = Array.from({ length: 20 }, (_, index) => ({
      id: `message-${index}`,
      role: index % 2 === 0 ? 'user' : 'assistant',
      text: `${index}:${'历史内容'.repeat(2_000)}`,
    }))
    const payload = boundedProviderSessionInspection({
      type: 'provider.session.inspected',
      provider: 'codex',
      providerSessionId: 'provider-session-1',
      title: 'Provider session',
      messages,
    })

    expect(payload.messages.length).toBeGreaterThan(0)
    expect(payload.messages.at(-1)?.id).toBe('message-19')
    expect(Buffer.byteLength(JSON.stringify(payload), 'utf8'))
      .toBeLessThanOrEqual(PROVIDER_HISTORY_PLAINTEXT_BUDGET_BYTES)
  })

  it('bounds an oversized terminal result journaled by an older Gateway', () => {
    const command = {
      kind: 'malink.command',
      version: 3,
      commandId: 'provider-list-old',
      workspaceId: 'workspace-1',
      deviceId: 'device-1',
      certificateId: 'certificate-1',
      createdAt: 1,
      projectId: 'project-1',
      operation: 'provider.sessions.list',
      payload: { operation: 'provider.sessions.list', provider: 'codex' },
    } satisfies Mlp3Command
    const result = boundedProviderHistoryResult(command, {
      type: 'provider.sessions.listed',
      provider: 'codex',
      sessions: Array.from({ length: 256 }, (_, index) => session(index)),
    })

    expect(Buffer.byteLength(JSON.stringify(result), 'utf8'))
      .toBeLessThanOrEqual(PROVIDER_HISTORY_PLAINTEXT_BUDGET_BYTES)
    expect(result).toMatchObject({ nextCursor: expect.any(String) })
  })

  it('normalizes provider-owned fields that older journals persisted outside the schema', () => {
    const command = {
      kind: 'malink.command',
      version: 3,
      commandId: 'provider-list-legacy-fields',
      workspaceId: 'workspace-1',
      deviceId: 'device-1',
      certificateId: 'certificate-1',
      createdAt: 1,
      projectId: 'project-1',
      operation: 'provider.sessions.list',
      payload: { operation: 'provider.sessions.list', provider: 'codex' },
    } satisfies Mlp3Command
    const result = boundedProviderHistoryResult(command, {
      type: 'provider.sessions.listed',
      provider: 'codex',
      sessions: [{
        sessionId: 'legacy-provider-session',
        title: '历史标题'.repeat(700),
        updatedAt: 1,
        cwd: `/workspace/${'nested/'.repeat(2_000)}`,
      }],
    })

    const parsed = mlp3EventPayloadSchema.parse(result)
    expect(parsed).toMatchObject({
      type: 'provider.sessions.listed',
      sessions: [{ sessionId: 'legacy-provider-session' }],
    })
    if (parsed.type !== 'provider.sessions.listed') throw new Error('Unexpected payload type')
    expect(parsed.sessions[0]?.title.length).toBe(512)
    expect(parsed.sessions[0]?.cwd?.length).toBe(8_192)
    expect(Buffer.byteLength(JSON.stringify(parsed), 'utf8'))
      .toBeLessThanOrEqual(PROVIDER_HISTORY_PLAINTEXT_BUDGET_BYTES)
  })
})
