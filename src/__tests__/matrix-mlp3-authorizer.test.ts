import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { generateDeviceKeyPair, signMlp3Command } from '@malink/security'
import { FileMlp3CommandJournal } from '@/gateway/matrix/fileMlp3CommandJournal'
import type { MatrixGatewayTrustedDevice } from '@/gateway/matrix/config'
import {
  MatrixMlp3CommandAuthorizer,
  canApprovePrivilegedExecution,
} from '@/gateway/matrix/mlp3Authorizer'

describe('MatrixMlp3CommandAuthorizer', () => {
  it('requires a separately granted capability for root approvals', () => {
    const device: MatrixGatewayTrustedDevice = {
      deviceId: 'device-1',
      publicKey: {} as JsonWebKey,
      allowedRoomIds: ['!project:example.org'],
      allowedOperations: ['prompt', 'decision', 'device.invite'],
      matrixUserId: '@owner:example.org',
      matrixDeviceId: 'PHONE',
      matrixDeviceKeys: ['matrix-phone-key'],
      certificateExpiresAt: Date.now() + 60_000,
      sequenceEpoch: 'certificate-1',
    }
    expect(canApprovePrivilegedExecution(device)).toBe(false)
    expect(canApprovePrivilegedExecution({
      ...device,
      allowedOperations: [...(device.allowedOperations ?? []), 'privilege.approve'],
    })).toBe(true)
  })

  it('authorizes independent commands by certificate and command ID only', async () => {
    const keys = await generateDeviceKeyPair()
    const journal = new FileMlp3CommandJournal(
      join(await mkdtemp(join(tmpdir(), 'malink-v3-auth-')), 'journal.jsonl'),
    )
    await journal.initialize()
    const authorizer = new MatrixMlp3CommandAuthorizer('workspace-1', journal)
    const command = {
      kind: 'malink.command' as const,
      version: 3 as const,
      commandId: 'command-1',
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      sessionId: 'session-1',
      deviceId: 'device-1',
      certificateId: 'certificate-1',
      createdAt: 1,
      operation: 'prompt.submit' as const,
      payload: { operation: 'prompt.submit' as const, text: 'hello' },
    }
    const signed = await signMlp3Command(command, keys.privateKey, keys.keyId)
    const policy: MatrixGatewayTrustedDevice = {
      deviceId: 'device-1',
      publicKey: keys.publicJwk,
      allowedRoomIds: ['!project:example.org'],
      allowedOperations: ['prompt'] as Array<'prompt'>,
      matrixUserId: '@owner:example.org',
      matrixDeviceId: 'PHONE',
      matrixDeviceKeys: ['matrix-phone-key'],
      certificateExpiresAt: Date.now() + 60_000,
      sequenceEpoch: 'certificate-1',
    }
    await expect(authorizer.authorize(
      signed,
      policy,
      '!project:example.org',
      'project-1',
    )).resolves.toMatchObject({ claim: { kind: 'accepted' } })
    await expect(authorizer.authorize(
      signed,
      policy,
      '!project:example.org',
      'project-1',
    )).resolves.toMatchObject({ claim: { kind: 'duplicate' } })
  })

  it('uses the existing device-invite grant for Gateway enrollment', async () => {
    const keys = await generateDeviceKeyPair()
    const journal = new FileMlp3CommandJournal(
      join(await mkdtemp(join(tmpdir(), 'malink-v3-gateway-auth-')), 'journal.jsonl'),
    )
    await journal.initialize()
    const authorizer = new MatrixMlp3CommandAuthorizer('workspace-1', journal)
    const command = await signMlp3Command({
      kind: 'malink.command',
      version: 3,
      commandId: 'gateway-enrollment-command-1',
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      deviceId: 'device-1',
      certificateId: 'certificate-1',
      createdAt: 1,
      operation: 'gateway.enrollment.invitation.create',
      payload: {
        operation: 'gateway.enrollment.invitation.create',
        lifetimeMs: 300_000,
      },
    }, keys.privateKey, keys.keyId)
    const policy: MatrixGatewayTrustedDevice = {
      deviceId: 'device-1',
      publicKey: keys.publicJwk,
      allowedRoomIds: ['!project:example.org'],
      allowedOperations: ['device.invite'] as Array<'device.invite'>,
      matrixUserId: '@owner:example.org',
      matrixDeviceId: 'PHONE',
      matrixDeviceKeys: ['matrix-phone-key'],
      certificateExpiresAt: Date.now() + 60_000,
      sequenceEpoch: 'certificate-1',
    }

    await expect(authorizer.authorize(
      command,
      policy,
      '!project:example.org',
      'project-1',
    )).resolves.toMatchObject({
      command: { operation: 'gateway.enrollment.invitation.create' },
      claim: { kind: 'accepted' },
    })
  })

  it('upgrades an existing full Workspace member to current ordinary operations', async () => {
    const keys = await generateDeviceKeyPair()
    const journal = new FileMlp3CommandJournal(
      join(await mkdtemp(join(tmpdir(), 'malink-v3-workspace-upgrade-')), 'journal.jsonl'),
    )
    await journal.initialize()
    const authorizer = new MatrixMlp3CommandAuthorizer('workspace-1', journal)
    const command = await signMlp3Command({
      kind: 'malink.command',
      version: 3,
      commandId: 'project-create-command-1',
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      deviceId: 'device-1',
      certificateId: 'certificate-1',
      createdAt: 1,
      operation: 'project.create',
      payload: {
        operation: 'project.create',
        name: 'New project',
        cwd: '/srv/new-project',
      },
    }, keys.privateKey, keys.keyId)
    const policy: MatrixGatewayTrustedDevice = {
      deviceId: 'device-1',
      publicKey: keys.publicJwk,
      allowedRoomIds: ['!project:example.org'],
      // This is the default operation set issued before project.create was
      // added. device.invite marks it as a full Workspace member.
      allowedOperations: [
        'prompt',
        'cancel',
        'decision',
        'session.settings',
        'session.create',
        'project.settings',
        'provider.sessions.list',
        'provider.session.inspect',
        'session.archive',
        'session.restore',
        'session.delete',
        'device.invite',
      ],
      matrixUserId: '@owner:example.org',
      matrixDeviceId: 'PHONE',
      matrixDeviceKeys: ['matrix-phone-key'],
      certificateExpiresAt: Date.now() + 60_000,
      sequenceEpoch: 'certificate-1',
    }

    await expect(authorizer.authorize(
      command,
      policy,
      '!project:example.org',
      'project-1',
    )).resolves.toMatchObject({
      command: { operation: 'project.create' },
      claim: { kind: 'accepted' },
    })
  })

  it('maps the pinned-release grant to every Gateway update command', async () => {
    const keys = await generateDeviceKeyPair()
    const journal = new FileMlp3CommandJournal(
      join(await mkdtemp(join(tmpdir(), 'malink-v3-update-auth-')), 'journal.jsonl'),
    )
    await journal.initialize()
    const authorizer = new MatrixMlp3CommandAuthorizer('workspace-1', journal)
    const policy = {
      deviceId: 'device-1',
      publicKey: keys.publicJwk,
      allowedRoomIds: ['!project:example.org'],
      allowedOperations: ['gateway.update'] as Array<'gateway.update'>,
      matrixUserId: '@owner:example.org',
      matrixDeviceId: 'PHONE',
      matrixDeviceKeys: ['matrix-phone-key'],
      certificateExpiresAt: Date.now() + 60_000,
      sequenceEpoch: 'certificate-1',
    }
    const command = await signMlp3Command({
      kind: 'malink.command',
      version: 3,
      commandId: 'gateway-update-status-1',
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      deviceId: 'device-1',
      certificateId: 'certificate-1',
      createdAt: 1,
      operation: 'gateway.update.status',
      payload: { operation: 'gateway.update.status' },
    }, keys.privateKey, keys.keyId)

    await expect(authorizer.authorize(
      command,
      policy,
      '!project:example.org',
      'project-1',
    )).resolves.toMatchObject({
      command: { operation: 'gateway.update.status' },
      claim: { kind: 'accepted' },
    })
  })

  it('returns a journaled rejection for a valid but explicitly limited device', async () => {
    const keys = await generateDeviceKeyPair()
    const journal = new FileMlp3CommandJournal(
      join(await mkdtemp(join(tmpdir(), 'malink-v3-limited-auth-')), 'journal.jsonl'),
    )
    await journal.initialize()
    const authorizer = new MatrixMlp3CommandAuthorizer('workspace-1', journal)
    const command = await signMlp3Command({
      kind: 'malink.command',
      version: 3,
      commandId: 'limited-project-create-1',
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      deviceId: 'limited-device',
      certificateId: 'limited-certificate',
      createdAt: 1,
      operation: 'project.create',
      payload: {
        operation: 'project.create',
        name: 'Denied project',
        cwd: '/srv/denied-project',
      },
    }, keys.privateKey, keys.keyId)
    const authorization = await authorizer.authorize(command, {
      deviceId: 'limited-device',
      publicKey: keys.publicJwk,
      allowedRoomIds: ['!project:example.org'],
      allowedOperations: ['prompt'],
      matrixUserId: '@limited:example.org',
      matrixDeviceId: 'LIMITED',
      matrixDeviceKeys: ['matrix-limited-key'],
      certificateExpiresAt: Date.now() + 60_000,
      sequenceEpoch: 'limited-certificate',
    }, '!project:example.org', 'project-1')

    expect(authorization).toMatchObject({
      command: { commandId: 'limited-project-create-1' },
      claim: { kind: 'accepted', record: { status: 'accepted' } },
      rejection: {
        code: 'operation_not_allowed',
        retryable: false,
      },
    })
  })
})
