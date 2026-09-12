import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { it, expect } from 'vitest'
import { ConversationReferenceStore } from '@/gateway/matrix/conversationReferenceStore'

it('binds durable snapshots to the destination, preserves full history and refuses substitution', async () => {
  const dir = await mkdtemp('/tmp/malink-references-')
  try {
    const path = join(dir, 'references.json')
    const store = new ConversationReferenceStore(path)
    const reference = { id: 'b6f76a13-97ac-4782-922b-2af160f89c1f', sessionId: 'source', title: 'Design', kind: 'session' as const }
    const snapshot = { projectId: 'project', targetSessionId: 'target', reference, capturedAt: 1,
      messages: Array.from({ length: 300 }, (_, i) => ({ role: 'assistant', text: `${i}: ${'x'.repeat(18000)}` })) }
    await store.put(snapshot)
    await expect(store.read('other-target', reference.id)).rejects.toThrow('no user-approved access')
    await expect(store.put({ ...snapshot, reference: { ...reference, sessionId: 'secret' } })).rejects.toThrow('another snapshot')
    const restarted = new ConversationReferenceStore(path)
    expect((await restarted.get('target', reference.id))?.messages).toEqual(snapshot.messages)
    const first = await restarted.read('target', reference.id)
    expect(first.text).toHaveLength(16000)
    expect(first.nextOffset).toBe(16000)
    const second = await restarted.read('target', reference.id, first.nextOffset!)
    expect(second.text.startsWith('x')).toBe(true)
    const last = await restarted.read('target', reference.id, first.totalCharacters - 20)
    expect(last.text).toHaveLength(20)
    expect(last.nextOffset).toBeNull()
    await expect(restarted.read('target', reference.id, -1)).rejects.toThrow('Invalid')
  } finally { await rm(dir, { recursive: true, force: true }) }
})
