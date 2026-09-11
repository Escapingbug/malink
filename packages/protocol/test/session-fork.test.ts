import { expect, it } from 'vitest'
import { commandPayloadSchema } from '../src/schema'
import { mlp3CommandSchema } from '../src/mlp-v3'

const command = { kind: 'malink.command', version: 3, workspaceId: 'workspace', projectId: 'project',
  deviceId: 'device', certificateId: 'certificate', commandId: 'command', sessionId: 'child', createdAt: 1,
  operation: 'session.create' }
it('preserves a native fork source through UI and MLP schemas and rejects conflicting modes', () => {
  const payload = { operation: 'session.create', forkFromSessionId: 'parent' }
  expect(commandPayloadSchema.parse(payload)).toEqual(payload)
  expect(mlp3CommandSchema.parse({ ...command, payload }).payload).toEqual(payload)
  for (const extra of [{ providerSessionId: 'restored' }, { scope: 'scratch' }]) {
    expect(commandPayloadSchema.safeParse({ ...payload, ...extra }).success).toBe(false)
    expect(mlp3CommandSchema.safeParse({ ...command, payload: { ...payload, ...extra } }).success).toBe(false)
  }
  expect(mlp3CommandSchema.safeParse({ ...command, payload: { ...payload, initialPrompt: { text: 'go' } } }).success).toBe(false)
})
