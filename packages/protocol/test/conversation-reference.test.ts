import { expect, it } from 'vitest'
import { commandPayloadSchema, conversationReferencesSchema } from '../src/index'
const reference = { id: 'b6f76a13-97ac-4782-922b-2af160f89c1f', sessionId: 'source', title: 'Design', kind: 'session' }
it('preserves structured references and rejects ambiguous or oversized objects', () => {
  const prompt = { operation: 'prompt', sessionId: 'target', text: 'Compare', references: [reference] }
  expect(commandPayloadSchema.parse(prompt)).toEqual(prompt)
  expect(conversationReferencesSchema.safeParse([{ ...reference, text: 'not a whole history' }]).success).toBe(false)
  expect(conversationReferencesSchema.safeParse([{ ...reference, kind: 'message' }]).success).toBe(false)
  expect(conversationReferencesSchema.safeParse([reference, reference]).success).toBe(false)
})
