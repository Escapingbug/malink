import { describe, expect, it } from 'vitest'
import { gatewayAgentUpdateChannelSchema } from '../src/gateway-agent-update.js'

const channel = {
  kind: 'malink.gateway.agent-update-channel' as const,
  version: 1 as const,
  channelId: 'stable',
  generation: 42,
  publishedAt: 42,
  release: {
    releaseId: 'release-2',
    buildId: 'build-2',
    sha256: 'a'.repeat(64),
  },
  mirrors: ['https://escapingbug.github.io/malink/gateway-agent-updates/'],
}

describe('Gateway Agent update channel', () => {
  it('accepts a bounded HTTPS mirror root', () => {
    expect(gatewayAgentUpdateChannelSchema.parse(channel)).toEqual(channel)
  })

  it.each([
    ['unencrypted mirror', ['http://updates.example.test/gateway-agent-updates/']],
    ['credential-bearing mirror', ['https://token@updates.example.test/gateway-agent-updates/']],
    ['non-rooted mirror path', ['https://updates.example.test/gateway-agent-updates']],
    ['duplicate mirrors', [
      'https://updates.example.test/gateway-agent-updates/',
      'https://updates.example.test/gateway-agent-updates/',
    ]],
  ])('rejects %s', (_name, mirrors) => {
    expect(gatewayAgentUpdateChannelSchema.safeParse({ ...channel, mirrors }).success).toBe(false)
  })
})
