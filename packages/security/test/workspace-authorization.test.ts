import { describe, expect, it } from 'vitest'
import type { WorkspaceDeviceGrant, WorkspaceGatewayDirectory } from '@malink/protocol'
import {
  exportPairingPublicKey,
  generateDeviceKeyPair,
  signWorkspaceDeviceGrant,
  signWorkspaceGatewayDirectory,
  verifyWorkspaceDeviceGrant,
  verifyWorkspaceGatewayDirectory,
} from '../src/index.js'

const now = 1_800_000_000_000
const transport = {
  homeserver: 'https://matrix.example.org', roomId: '!project:example.org',
  userId: '@gateway:example.org', deviceId: 'GATEWAY',
  ed25519: 'gateway-ed25519-fingerprint',
}

describe('workspace authorization', () => {
  it('makes one device grant portable across every Gateway in a workspace', async () => {
    const workspace = await generateDeviceKeyPair()
    const device = await generateDeviceKeyPair()
    const grant: WorkspaceDeviceGrant = {
      kind: 'malink.workspace.device-grant', version: 1, grantId: 'grant-1',
      workspaceId: 'workspace-1', certificateId: 'certificate-1', deviceId: 'device-1',
      deviceName: 'Phone', deviceKey: await exportPairingPublicKey(device.publicKey),
      deviceTransport: transport, allowedOperations: ['prompt', 'device.invite'],
      issuedAt: now, expiresAt: now + 60_000,
    }
    const signed = await signWorkspaceDeviceGrant(grant, workspace.privateKey, workspace.keyId)
    await expect(verifyWorkspaceDeviceGrant(signed, workspace.publicJwk, {
      workspaceId: 'workspace-1', now: now + 1,
    })).resolves.toEqual(grant)
    await expect(verifyWorkspaceDeviceGrant(signed, workspace.publicJwk, {
      workspaceId: 'another-workspace', now: now + 1,
    })).rejects.toThrow(/another workspace/)
  })

  it('rejects a rolled-back or cross-workspace Gateway directory', async () => {
    const workspace = await generateDeviceKeyPair()
    const directory: WorkspaceGatewayDirectory = {
      kind: 'malink.workspace.gateway-directory', version: 1,
      directoryId: 'directory-2', workspaceId: 'workspace-1', revision: 2,
      gateways: [{
        gatewayNodeId: 'node-a', workspaceId: 'workspace-1', gatewayName: 'Studio',
        transport, publicKey: await exportPairingPublicKey(workspace.publicKey),
        projects: [{
          projectId: 'project-a', roomId: transport.roomId,
          conversationId: transport.roomId,
        }],
        issuedAt: now,
      }],
      issuedAt: now,
    }
    const signed = await signWorkspaceGatewayDirectory(
      directory, workspace.privateKey, workspace.keyId,
    )
    await expect(verifyWorkspaceGatewayDirectory(signed, workspace.publicJwk, {
      workspaceId: 'workspace-1', minimumRevision: 2,
    })).resolves.toEqual(directory)
    await expect(verifyWorkspaceGatewayDirectory(signed, workspace.publicJwk, {
      workspaceId: 'workspace-1', minimumRevision: 3,
    })).rejects.toThrow(/rolled back/)
  })
})
