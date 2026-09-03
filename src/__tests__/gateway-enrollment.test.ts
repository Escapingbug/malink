import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  exportPairingPublicKey,
  gatewayEnrollmentVerificationCode,
  generateDeviceKeyPair,
  InMemoryReplayStore,
  openSecureEnvelope,
  signGatewayEnrollmentRequest,
  verifyGatewayEnrollmentInvitation,
} from '@malink/security'
import {
  FileGatewayEnrollmentCoordinator,
  FileGatewayIdentityStore,
  GATEWAY_ENROLLMENT_APPROVAL_LIFETIME_MS,
  createGatewayJoinInvitation,
  decodeGatewayEnrollmentInvitationLink,
  gatewayEnrollmentApprovalDeadline,
} from '@/gateway/pairing'
import { gatewayEnrollmentInteractiveWaitMs } from '@/gateway/pairing/gatewayEnrollmentClient'

describe('Gateway enrollment rendezvous', () => {
  it('keeps a bounded approval recovery window after setup-link expiry', () => {
    const invitationExpiresAt = 1_800_000_000_000

    expect(gatewayEnrollmentApprovalDeadline(invitationExpiresAt)).toBe(
      invitationExpiresAt + GATEWAY_ENROLLMENT_APPROVAL_LIFETIME_MS,
    )
    expect(() => gatewayEnrollmentApprovalDeadline(Number.MAX_SAFE_INTEGER)).toThrow(
      /expiry is invalid/u,
    )
  })

  it('ends the interactive request at expiry while retaining late-response recovery', () => {
    const now = 1_800_000_000_000
    const invitationExpiresAt = now + 45_000

    expect(gatewayEnrollmentInteractiveWaitMs(invitationExpiresAt, now)).toBe(45_000)
    expect(gatewayEnrollmentInteractiveWaitMs(invitationExpiresAt, invitationExpiresAt)).toBe(1)
    expect(gatewayEnrollmentApprovalDeadline(invitationExpiresAt)).toBeGreaterThan(
      invitationExpiresAt,
    )
  })

  it('requires client approval before releasing the Workspace grant', async () => {
    const now = 1_800_000_000_000
    const directory = await mkdtemp(join(tmpdir(), 'malink-gateway-enrollment-'))
    const identity = await new FileGatewayIdentityStore(
      join(directory, 'gateway-identity.json'),
    ).loadOrCreate('workspace-1', now)
    const coordinator = new FileGatewayEnrollmentCoordinator(
      join(directory, 'gateway-enrollments.json'),
      identity,
    )
    const created = await coordinator.createInvitation({
      homeserver: 'https://matrix.example.org',
      roomId: '!project:example.org',
      userId: '@gateway:example.org',
      deviceId: 'OLDGATEWAY',
      ed25519: 'old-gateway-ed25519-key',
    }, {
      homeserver: 'https://matrix.example.org',
      userId: '@gateway:example.org',
      loginToken: 'one-time-login-token',
      expiresAt: now + 120_000,
    }, now, 120_000)

    const signedInvitation = decodeGatewayEnrollmentInvitationLink(created.link)
    const invitation = await verifyGatewayEnrollmentInvitation(signedInvitation, now)
    expect(JSON.stringify(invitation)).not.toContain(identity.serialized.privateKey.d)
    expect(await coordinator.pending(now)).toEqual([])

    const requestKeys = await generateDeviceKeyPair()
    const gatewayNodeId = 'new-gateway-node'
    const request = await signGatewayEnrollmentRequest({
      kind: 'malink.gateway.enrollment-request',
      version: 1,
      enrollmentId: invitation.enrollmentId,
      workspaceId: invitation.workspaceId,
      gatewayNodeId,
      gatewayName: 'Office Gateway',
      gatewayKey: await exportPairingPublicKey(requestKeys.publicKey),
      challenge: invitation.challenge,
      issuedAt: now + 1,
      expiresAt: now + 119_000,
    }, requestKeys.privateKey, requestKeys.keyId)
    const pending = await coordinator.registerRequest(request, now + 1)
    expect(pending).toMatchObject({
      gatewayNodeId,
      gatewayName: 'Office Gateway',
      verificationCode: await gatewayEnrollmentVerificationCode(request.request),
    })

    const bearer = createGatewayJoinInvitation(
      identity,
      undefined,
      now + 2,
      GATEWAY_ENROLLMENT_APPROVAL_LIFETIME_MS,
    )
    const approved = await coordinator.approve(
      invitation.enrollmentId,
      bearer.link,
      now + 2,
    )
    expect(JSON.stringify(approved.response)).not.toContain('workspaceKeyPair')
    expect(approved.response.expiresAt).toBe(
      now + 2 + GATEWAY_ENROLLMENT_APPROVAL_LIFETIME_MS,
    )
    const opened = await openSecureEnvelope(approved.response.sealedInvitation, {
      recipientPrivateKey: requestKeys.privateKey,
      senderPublicKey: identity.keys.publicKey,
      expected: {
        gatewayId: identity.workspaceId,
        conversationId: invitation.enrollmentId,
        direction: 'gateway_to_device',
        senderDeviceId: identity.gatewayNodeId,
        recipientDeviceId: gatewayNodeId,
        senderKeyId: identity.keys.keyId,
        recipientKeyId: requestKeys.keyId,
      },
      replayStore: new InMemoryReplayStore(),
      now: created.expiresAt + 1,
    })
    expect(opened.plaintext).toEqual({ kind: 'gateway_join', link: bearer.link })
    expect(await coordinator.pending(created.expiresAt + 1)).toEqual([])
    const repeated = await coordinator.approve(
      invitation.enrollmentId,
      'unused-after-idempotent-approval',
      created.expiresAt + 1,
    )
    expect(repeated.response).toEqual(approved.response)
    expect(await coordinator.pending(approved.response.expiresAt)).toEqual([])
  })

  it('cancels a pending request idempotently and notifies the waiting Gateway', async () => {
    const now = 1_800_000_000_000
    const directory = await mkdtemp(join(tmpdir(), 'malink-gateway-enrollment-cancel-'))
    const identity = await new FileGatewayIdentityStore(
      join(directory, 'gateway-identity.json'),
    ).loadOrCreate('workspace-cancel', now)
    const coordinator = new FileGatewayEnrollmentCoordinator(
      join(directory, 'gateway-enrollments.json'),
      identity,
    )
    const created = await coordinator.createInvitation({
      homeserver: 'https://matrix.example.org',
      roomId: '!project:example.org',
      userId: '@gateway:example.org',
      deviceId: 'OLDGATEWAY',
      ed25519: 'old-gateway-ed25519-key',
    }, {
      homeserver: 'https://matrix.example.org',
      userId: '@gateway:example.org',
      loginToken: 'one-time-login-token',
      expiresAt: now + 120_000,
    }, now, 120_000)
    const invitation = await verifyGatewayEnrollmentInvitation(
      decodeGatewayEnrollmentInvitationLink(created.link),
      now,
    )
    const requestKeys = await generateDeviceKeyPair()
    const request = await signGatewayEnrollmentRequest({
      kind: 'malink.gateway.enrollment-request',
      version: 1,
      enrollmentId: invitation.enrollmentId,
      workspaceId: invitation.workspaceId,
      gatewayNodeId: 'cancelled-gateway-node',
      gatewayName: 'Cancelled Gateway',
      gatewayKey: await exportPairingPublicKey(requestKeys.publicKey),
      challenge: invitation.challenge,
      issuedAt: now + 1,
      expiresAt: now + 119_000,
    }, requestKeys.privateKey, requestKeys.keyId)
    await coordinator.registerRequest(request, now + 1)

    const cancelled = await coordinator.cancel(invitation.enrollmentId, now + 2)
    const repeated = await coordinator.cancel(invitation.enrollmentId, now + 3)
    expect(repeated).toEqual(cancelled)
    expect(await coordinator.pending(now + 3)).toEqual([])
    await expect(coordinator.approve(
      invitation.enrollmentId,
      'unused-after-cancellation',
      now + 3,
    )).rejects.toThrow(/was cancelled/u)
    await expect(coordinator.registerRequest(request, now + 3)).rejects.toThrow(
      /unknown or no longer open/u,
    )

    const opened = await openSecureEnvelope(cancelled.response.sealedInvitation, {
      recipientPrivateKey: requestKeys.privateKey,
      senderPublicKey: identity.keys.publicKey,
      expected: {
        gatewayId: identity.workspaceId,
        conversationId: invitation.enrollmentId,
        direction: 'gateway_to_device',
        senderDeviceId: identity.gatewayNodeId,
        recipientDeviceId: request.request.gatewayNodeId,
        senderKeyId: identity.keys.keyId,
        recipientKeyId: requestKeys.keyId,
      },
      replayStore: new InMemoryReplayStore(),
      now: now + 3,
    })
    expect(opened.plaintext).toEqual({
      kind: 'gateway_join_cancelled',
      cancelledAt: now + 2,
    })
  })

  it('rejects a request that does not carry the invitation challenge', async () => {
    const now = 1_800_000_000_000
    const directory = await mkdtemp(join(tmpdir(), 'malink-gateway-enrollment-reject-'))
    const identity = await new FileGatewayIdentityStore(
      join(directory, 'gateway-identity.json'),
    ).loadOrCreate('workspace-2', now)
    const coordinator = new FileGatewayEnrollmentCoordinator(
      join(directory, 'gateway-enrollments.json'),
      identity,
    )
    const created = await coordinator.createInvitation({
      homeserver: 'https://matrix.example.org',
      roomId: '!project:example.org',
      userId: '@gateway:example.org',
      deviceId: 'OLDGATEWAY',
      ed25519: 'old-gateway-ed25519-key',
    }, {
      homeserver: 'https://matrix.example.org',
      userId: '@gateway:example.org',
      loginToken: 'one-time-login-token',
      expiresAt: now + 60_000,
    }, now, 60_000)
    const invitation = await verifyGatewayEnrollmentInvitation(
      decodeGatewayEnrollmentInvitationLink(created.link),
      now,
    )
    const requestKeys = await generateDeviceKeyPair()
    const request = await signGatewayEnrollmentRequest({
      kind: 'malink.gateway.enrollment-request',
      version: 1,
      enrollmentId: invitation.enrollmentId,
      workspaceId: invitation.workspaceId,
      gatewayNodeId: 'attacker-node',
      gatewayName: 'Wrong Gateway',
      gatewayKey: await exportPairingPublicKey(requestKeys.publicKey),
      challenge: 'A'.repeat(43),
      issuedAt: now + 1,
      expiresAt: now + 59_000,
    }, requestKeys.privateKey, requestKeys.keyId)
    await expect(coordinator.registerRequest(request, now + 1)).rejects.toThrow(
      /binding is invalid/u,
    )
  })
})
