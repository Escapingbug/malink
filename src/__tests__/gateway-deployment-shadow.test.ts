import { describe, expect, it } from 'vitest'
import { deploymentSourceShadowRoomIds } from '@/ops/gatewayDeploymentShadow'

describe('Gateway deployment shadow routes', () => {
  it('shadows only the replaced Gateway on a multi-computer Workspace', () => {
    expect(deploymentSourceShadowRoomIds([
      {
        gatewayNodeId: 'gateway-active',
        projects: [{ roomId: '!active:example.org' }],
      },
      {
        gatewayNodeId: 'gateway-other-computer',
        projects: [
          { roomId: '!remote-one:example.org' },
          { roomId: '!remote-two:example.org' },
        ],
      },
      {
        gatewayNodeId: 'gateway-candidate',
        projects: [{ roomId: '!trial:example.org' }],
      },
    ], 'gateway-active', ['!trial:example.org'])).toEqual(['!active:example.org'])
  })

  it('excludes any source route already owned by the candidate', () => {
    expect(deploymentSourceShadowRoomIds([{
      gatewayNodeId: 'gateway-active',
      projects: [
        { roomId: '!shared:example.org' },
        { roomId: '!source-only:example.org' },
      ],
    }], 'gateway-active', ['!shared:example.org'])).toEqual(['!source-only:example.org'])
  })
})
