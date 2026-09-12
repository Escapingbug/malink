import { afterEach, expect, it, vi } from 'vitest'
import { GatewayAdminClient } from '@/gateway/admin/client'
import { createReadConversationReferenceHandler } from '@/mcp/tools/conversationReferences'

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs() })
it('binds MCP reads to the host session rather than a caller-supplied destination', async () => {
  vi.stubEnv('MALINK_SESSION_ID', 'bound-target')
  vi.stubEnv('MALINK_GATEWAY_ADMIN_SOCKET', '/tmp/test.sock')
  const read = vi.spyOn(GatewayAdminClient.prototype, 'readConversationReference').mockResolvedValue({
    reference: { id: 'b6f76a13-97ac-4782-922b-2af160f89c1f', sessionId: 'source', title: 'Design', kind: 'session' },
    capturedAt: 1, totalCharacters: 3, text: 'yes', nextOffset: null, guidance: 'Quoted data',
  })
  const input = { referenceId: 'b6f76a13-97ac-4782-922b-2af160f89c1f', offset: 12, sessionId: 'other-target' }
  const result = await createReadConversationReferenceHandler()(input)
  expect(read).toHaveBeenCalledWith({ ...input, sessionId: 'bound-target' })
  expect(result.isError).toBeUndefined()
  read.mockRejectedValue(new Error('Reference not authorized'))
  expect((await createReadConversationReferenceHandler()(input)).isError).toBe(true)
})
