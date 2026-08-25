import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  acceptGatewayJoinInvitation,
  createGatewayJoinInvitation,
  FileGatewayIdentityStore,
  FileWorkspaceDeviceAuthorization,
  FileWorkspaceGatewayDirectory,
} from '@/gateway/pairing'
import {
  exportPairingPublicKey,
  generateDeviceKeyPair,
  signWorkspaceDeviceGrant,
  signWorkspaceDeviceRevocation,
} from '@malink/security'

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
    const firstChanged = await firstDirectory.publishLocal(
      'Gateway A renamed', transport, 1_800_000_000_005,
    )
    const merged = await firstDirectory.merge(secondView)
    const independentlyMerged = await secondDirectory.merge(firstChanged)

    expect(merged.directory.revision).toBeGreaterThan(secondView.directory.revision)
    expect(merged.directory.gateways.map(value => value.gatewayNodeId).sort()).toEqual([
      first.gatewayNodeId,
      joined.identity.gatewayNodeId,
    ].sort())
    expect(independentlyMerged.directory.gateways).toEqual(merged.directory.gateways)

    // Both nodes signed the same union at revision 3 with different random
    // directory IDs. Exactly one deterministic loser advances to revision 4,
    // after which both stores converge and stop republishing.
    const resolvedAtFirst = await firstDirectory.merge(independentlyMerged)
    const resolvedAtSecond = await secondDirectory.merge(merged)
    const resolved = resolvedAtFirst.directory.revision > resolvedAtSecond.directory.revision
      ? resolvedAtFirst
      : resolvedAtSecond
    expect(resolved.directory.revision).toBe(merged.directory.revision + 1)
    await firstDirectory.merge(resolved)
    await secondDirectory.merge(resolved)
    expect(await firstDirectory.load()).toEqual(resolved)
    expect(await secondDirectory.load()).toEqual(resolved)
    expect(resolved.directory.gateways.find(value =>
      value.gatewayNodeId === first.gatewayNodeId)?.gatewayName).toBe('Gateway A renamed')
  })

  it('propagates Gateway removal tombstones and never resurrects a stale node', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'malink-workspace-removal-'))
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
    const both = await secondDirectory.publishLocal('Gateway B', {
      ...transport, deviceId: 'GATEWAY-B', userId: '@gateway:example.org',
    }, 1_800_000_000_004)
    await firstDirectory.merge(both)

    const removed = await firstDirectory.remove('gateway-node-b', 1_800_000_000_005)
    const propagated = await secondDirectory.merge(removed)

    expect(propagated.directory.gateways.map(value => value.gatewayNodeId)).toEqual([
      first.gatewayNodeId,
    ])
    expect(propagated.directory.removedGatewayNodeIds).toContain('gateway-node-b')
    await expect(secondDirectory.publishLocal(
      'Gateway B', { ...transport, deviceId: 'GATEWAY-B' }, 1_800_000_000_006,
    )).rejects.toThrow(/removed/)
    await expect(firstDirectory.merge(both)).rejects.toThrow(/rolled back/)
    expect((await firstDirectory.load())?.directory.gateways).toHaveLength(1)
  })

  it('carries portable device grants and revocations to a newly joined Gateway', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'malink-workspace-authorization-'))
    const first = await new FileGatewayIdentityStore(join(directory, 'first.json'))
      .loadOrCreate('workspace-1', 1_800_000_000_000)
    const device = await generateDeviceKeyPair()
    const grant = await signWorkspaceDeviceGrant({
      kind: 'malink.workspace.device-grant', version: 1, grantId: 'grant-1',
      workspaceId: first.workspaceId, certificateId: 'certificate-1', deviceId: device.keyId,
      deviceName: 'Phone', deviceKey: await exportPairingPublicKey(device.publicKey),
      deviceTransport: {
        ...transport, userId: '@phone:example.org', deviceId: 'PHONE',
        ed25519: 'phone-ed25519-fingerprint',
      },
      allowedOperations: ['prompt'], issuedAt: 1_800_000_000_001,
      expiresAt: 1_800_000_100_000,
    }, first.keys.privateKey, first.keys.keyId)
    const revocation = await signWorkspaceDeviceRevocation({
      kind: 'malink.workspace.device-revocation', version: 1,
      revocationId: 'revocation-1', workspaceId: first.workspaceId,
      deviceId: device.keyId, certificateId: 'certificate-1',
      issuedAt: 1_800_000_000_002,
    }, first.keys.privateKey, first.keys.keyId)
    const invitation = createGatewayJoinInvitation(
      first, undefined, 1_800_000_000_003, 60_000,
      { grants: [grant], revocations: [revocation] },
    )
    const joined = await acceptGatewayJoinInvitation(
      new FileGatewayIdentityStore(join(directory, 'second.json')),
      invitation.link,
      'gateway-node-b',
      1_800_000_000_004,
    )
    const authorization = new FileWorkspaceDeviceAuthorization(
      join(directory, 'authorization.json'), joined.identity,
    )
    await authorization.mergeGrant(joined.deviceGrants[0]!, 1_800_000_000_004)
    expect(await authorization.isActive(device.keyId, 1_800_000_000_004)).toBe(true)
    await authorization.mergeRevocation(joined.deviceRevocations[0]!)
    expect(await authorization.isActive(device.keyId, 1_800_000_000_004)).toBe(false)

    const tampered = structuredClone(grant)
    tampered.grant.deviceName = 'Tampered'
    await expect(authorization.mergeGrant(tampered, 1_800_000_000_004))
      .rejects.toThrow(/signature/i)
  })
})
