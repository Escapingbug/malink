import { describe, expect, it } from 'vitest'
import type { Mlp3Command } from '@malink/protocol'
import {
  generateMlp3ProjectKey,
  generateDeviceKeyPair,
  openMlp3Envelope,
  openMlp3ProjectKeyGrant,
  sealMlp3Envelope,
  sealMlp3ProjectKeyGrant,
  signMlp3Command,
  verifyMlp3Command,
} from '../src/index.js'

function command(): Mlp3Command {
  return {
    kind: 'malink.command',
    version: 3,
    commandId: 'command-1',
    workspaceId: 'workspace-1',
    projectId: 'project-1',
    sessionId: 'session-1',
    deviceId: 'device-1',
    certificateId: 'certificate-1',
    createdAt: 1,
    operation: 'prompt.submit',
    payload: { operation: 'prompt.submit', text: 'hello' },
  }
}

describe('Malink MLP/3 security', () => {
  it('signs a command without a clock, sequence or global revision gate', async () => {
    const device = await generateDeviceKeyPair()
    const signed = await signMlp3Command(
      command(),
      device.privateKey,
      device.keyId,
    )
    await expect(verifyMlp3Command(signed, device.publicKey, {
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      deviceId: 'device-1',
      certificateId: 'certificate-1',
      allowedOperations: ['prompt.submit'],
    })).resolves.toMatchObject({ commandId: 'command-1' })
  })

  it('uses one authenticated project envelope for both commands and events', async () => {
    const device = await generateDeviceKeyPair()
    const signed = await signMlp3Command(
      command(),
      device.privateKey,
      device.keyId,
    )
    const projectKey = generateMlp3ProjectKey()
    const envelope = await sealMlp3Envelope({
      plaintext: { kind: 'signed_command', value: signed },
      projectKey,
      roomId: '!project:example.org',
      projectId: 'project-1',
      keyId: 'project-key-1',
      logicalEventId: 'command-1',
    })
    const opened = await openMlp3Envelope(envelope, {
      projectKey,
      roomId: '!project:example.org',
      projectId: 'project-1',
      keyId: 'project-key-1',
    })
    expect(opened.plaintext).toMatchObject({
      kind: 'signed_command',
      value: { command: { commandId: 'command-1' } },
    })
  })

  it('binds ciphertext to its project room without signing Matrix relations', async () => {
    const device = await generateDeviceKeyPair()
    const signed = await signMlp3Command(command(), device.privateKey, device.keyId)
    const projectKey = generateMlp3ProjectKey()
    const envelope = await sealMlp3Envelope({
      plaintext: { kind: 'signed_command', value: signed },
      projectKey,
      roomId: '!project:example.org',
      projectId: 'project-1',
      keyId: 'project-key-1',
      logicalEventId: 'command-1',
    })
    await expect(openMlp3Envelope(envelope, {
      projectKey,
      roomId: '!other:example.org',
      projectId: 'project-1',
      keyId: 'project-key-1',
    })).rejects.toMatchObject({ code: 'binding_mismatch' })
  })

  it('keeps a directly addressed key grant durably re-readable', async () => {
    const gateway = await generateDeviceKeyPair()
    const device = await generateDeviceKeyPair()
    const bindings = {
      grantId: 'grant-1',
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      roomId: '!project:example.org',
      deviceId: 'device-1',
      certificateId: 'certificate-1',
      senderKeyId: gateway.keyId,
      recipientKeyId: device.keyId,
    }
    const sealed = await sealMlp3ProjectKeyGrant({
      plaintext: {
        kind: 'project.key_grant',
        version: 3,
        workspaceId: bindings.workspaceId,
        projectId: bindings.projectId,
        roomId: bindings.roomId,
        deviceId: bindings.deviceId,
        certificateId: bindings.certificateId,
        activeKeyId: 'project-key-1',
        keys: [{
          keyId: 'project-key-1',
          key: 'A'.repeat(43),
          createdAt: 1,
        }],
      },
      bindings,
      senderPrivateKey: gateway.privateKey,
      recipientPublicKey: device.publicKey,
    })
    const open = () => openMlp3ProjectKeyGrant(sealed, {
      expected: bindings,
      recipientPrivateKey: device.privateKey,
      senderPublicKey: gateway.publicKey,
    })
    await expect(open()).resolves.toMatchObject({ activeKeyId: 'project-key-1' })
    await expect(open()).resolves.toMatchObject({ activeKeyId: 'project-key-1' })
  })
})
