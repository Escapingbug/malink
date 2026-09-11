import { expect, it, vi } from 'vitest'
import { AcpProvider } from '@/providers/acp'

function fixture(supported: boolean, result = 'child') {
  const forkSession = vi.fn(async () => ({ sessionId: result }))
  const provider = new AcpProvider({ name: 'fork-test', command: 'unused', args: [] })
  Object.assign(provider, { initialized: true, clientManager: { connected: true, supportsForkSession: supported, forkSession } })
  return { provider, forkSession }
}
const config = { cwd: '/repo', sessionId: 'parent', malinkSessionId: 'malink-child', signal: new AbortController().signal }

it('uses the advertised native fork with the new Malink MCP binding', async () => {
  const { provider, forkSession } = fixture(true)
  await expect(provider.forkSession(config)).resolves.toEqual({ sessionId: 'child' })
  expect(forkSession).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'parent', cwd: '/repo',
    mcpServers: [expect.objectContaining({ env: expect.arrayContaining([{ name: 'MALINK_SESSION_ID', value: 'malink-child' }]) })],
  }))
})
it('does not attempt an unsupported fork or accept reuse of the parent identity', async () => {
  const unsupported = fixture(false)
  expect(unsupported.provider.supportsSessionFork()).toBe(false)
  await expect(unsupported.provider.forkSession(config)).rejects.toThrow('does not support')
  expect(unsupported.forkSession).not.toHaveBeenCalled()
  await expect(fixture(true, 'parent').provider.forkSession(config)).rejects.toThrow('independent')
})
