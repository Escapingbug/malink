import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  acceptGatewayJoinInvitation,
  createGatewayJoinInvitation,
  FileGatewayIdentityStore,
  FileWorkspaceGatewayDirectory,
} from '@/gateway/pairing'

const transport = {
  homeserver: 'https://matrix.example.org', roomId: '!project:example.org',
  userId: '@gateway:example.org', deviceId: 'GATEWAY-A',
  ed25519: 'gateway-ed25519-fingerprint',
}

describe('Workspace Gateway join', () => {
  it('shares one Workspace authority while assigning a distinct node identity', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'malink-workspace-join-'))
    const first = await new FileGatewayIdentityStore(join(directory, 'first.json'))
      .loadOrCreate('workspace-1', 1_800_000_000_000)
    const gatewayDirectory = new FileWorkspaceGatewayDirectory(
      join(directory, 'directory.json'), first,
    )
    const signedDirectory = await gatewayDirectory.publishLocal(
      'Gateway A', transport, 1_800_000_000_001,
      [{ projectId: 'project-a', roomId: transport.roomId, conversationId: transport.roomId }],
    )
    const invitation = createGatewayJoinInvitation(
      first, signedDirectory, 1_800_000_000_002, 60_000,
    )
    const second = await acceptGatewayJoinInvitation(
      new FileGatewayIdentityStore(join(directory, 'second.json')),
      invitation.link,
      'gateway-node-b',
      1_800_000_000_003,
    )

    expect(second.identity.workspaceId).toBe(first.workspaceId)
    expect(second.identity.keys.keyId).toBe(first.keys.keyId)
    expect(second.identity.gatewayNodeId).toBe('gateway-node-b')
    expect(second.directory).toEqual(signedDirectory)
  })

  it('rejects expired invitations and an existing identity from another Workspace', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'malink-workspace-join-reject-'))
    const first = await new FileGatewayIdentityStore(join(directory, 'first.json'))
      .loadOrCreate('workspace-1', 1_800_000_000_000)
    const invitation = createGatewayJoinInvitation(first, undefined, 1_800_000_000_000, 30_000)
    await expect(acceptGatewayJoinInvitation(
      new FileGatewayIdentityStore(join(directory, 'expired.json')),
      invitation.link,
      'node-b',
      1_800_000_030_000,
    )).rejects.toThrow(/expired/)

    const occupied = new FileGatewayIdentityStore(join(directory, 'occupied.json'))
    await occupied.loadOrCreate('workspace-2', 1_800_000_000_000)
    await expect(acceptGatewayJoinInvitation(
      occupied,
      invitation.link,
      'node-b',
      1_800_000_000_001,
    )).rejects.toThrow(/another Malink Workspace/)
  })

  it('merges concurrent trusted-node directories without dropping either Gateway', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'malink-workspace-directory-'))
    const first = await new FileGatewayIdentityStore(join(directory, 'first.json'))
      .loadOrCreate('workspace-1', 1_800_000_000_000)
    const firstDirectory = new FileWorkspaceGatewayDirectory(
      join(directory, 'first-directory.json'), first,
    )
    const firstOnly = await firstDirectory.publishLocal('Gateway A', transport, 1_800_000_000_001)
    const invitation = createGatewayJoinInvitation(first, firstOnly, 1_800_000_000_002, 60_000)
    const joined = await acceptGatewayJoinInvitation(
      new FileGatewayIdentityStore(join(directory, 'second.json')),
      invitation.link,
      'gateway-node-b',
      1_800_000_000_003,
    )
    const secondDirectory = new FileWorkspaceGatewayDirectory(
      join(directory, 'second-directory.json'), joined.identity,
    )
    await secondDirectory.merge(joined.directory)
    const secondView = await secondDirectory.publishLocal('Gateway B', {
      ...transport, deviceId: 'GATEWAY-B', userId: '@gateway-b:example.org',
    }, 1_800_000_000_004)

    // A changed locally at the same revision while B independently added itself.
    await firstDirectory.publishLocal('Gateway A renamed', transport, 1_800_000_000_005)
    const merged = await firstDirectory.merge(secondView)

    expect(merged.directory.revision).toBeGreaterThan(secondView.directory.revision)
    expect(merged.directory.gateways.map(value => value.gatewayNodeId).sort()).toEqual([
      first.gatewayNodeId,
      joined.identity.gatewayNodeId,
    ].sort())
  })
})
