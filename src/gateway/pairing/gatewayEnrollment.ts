import { randomUUID } from 'node:crypto'
import {
  canonicalJson,
  gatewayEnrollmentPendingSchema,
  gatewayEnrollmentResponseSchema,
  signedGatewayEnrollmentInvitationSchema,
  signedGatewayEnrollmentRequestSchema,
  type GatewayEnrollmentPending,
  type GatewayEnrollmentRequest,
  type GatewayEnrollmentResponse,
  type MatrixLoginInvitation,
  type MatrixTransportBinding,
  type SignedGatewayEnrollmentInvitation,
  type SignedGatewayEnrollmentRequest,
} from '@malink/protocol'
import {
  exportPairingPublicKey,
  gatewayEnrollmentVerificationCode,
  generatePairingChallenge,
  sealSecureEnvelope,
  signGatewayEnrollmentInvitation,
  verifyGatewayEnrollmentRequest,
} from '@malink/security'
import { AtomicJsonFile, type FileStoreOptions } from '@malink/security/node'
import type { GatewayPairingIdentity } from './identityStore.js'

const PREFIX = 'malink://gateway-enroll#data='
const MAX_LIFETIME_MS = 10 * 60_000
const MAX_LINK_CHARS = 128 * 1024
const MAX_OPEN_ENROLLMENTS = 32

export const GATEWAY_ENROLLMENT_APPROVAL_LIFETIME_MS = 10 * 60_000

export function gatewayEnrollmentApprovalDeadline(invitationExpiresAt: number): number {
  if (
    !Number.isSafeInteger(invitationExpiresAt)
    || invitationExpiresAt < 0
    || invitationExpiresAt > Number.MAX_SAFE_INTEGER - GATEWAY_ENROLLMENT_APPROVAL_LIFETIME_MS
  ) throw new TypeError('Gateway enrollment invitation expiry is invalid')
  return invitationExpiresAt + GATEWAY_ENROLLMENT_APPROVAL_LIFETIME_MS
}

interface EnrollmentRecord {
  invitation: SignedGatewayEnrollmentInvitation
  status: 'open' | 'pending' | 'approved'
  request?: SignedGatewayEnrollmentRequest
  response?: GatewayEnrollmentResponse
}

interface EnrollmentState {
  version: 1
  workspaceId: string
  enrollments: Record<string, EnrollmentRecord>
}

export class FileGatewayEnrollmentCoordinator {
  private readonly file: AtomicJsonFile<EnrollmentState>

  constructor(
    path: string,
    private readonly identity: GatewayPairingIdentity,
    options: FileStoreOptions = {},
  ) {
    this.file = new AtomicJsonFile(path, options)
  }

  async createInvitation(
    transport: MatrixTransportBinding,
    matrixLogin: MatrixLoginInvitation,
    now = Date.now(),
    lifetimeMs = 5 * 60_000,
  ): Promise<{ link: string; expiresAt: number; enrollmentId: string }> {
    if (!Number.isSafeInteger(lifetimeMs) || lifetimeMs < 30_000 || lifetimeMs > MAX_LIFETIME_MS) {
      throw new RangeError('Gateway enrollment lifetime must be between 30 seconds and 10 minutes')
    }
    if (matrixLogin.expiresAt <= now + 15_000) {
      throw new Error('Matrix login token expires too soon for Gateway enrollment')
    }
    const enrollmentId = randomUUID()
    const workspaceKey = await exportPairingPublicKey(this.identity.keys.publicKey)
    const expiresAt = Math.min(now + lifetimeMs, matrixLogin.expiresAt)
    const invitation = await signGatewayEnrollmentInvitation({
      kind: 'malink.gateway.enrollment-invitation',
      version: 1,
      enrollmentId,
      workspaceId: this.identity.workspaceId,
      workspaceKey,
      rendezvous: {
        homeserver: transport.homeserver,
        roomId: transport.roomId,
        userId: matrixLogin.userId,
      },
      matrixLogin: { ...matrixLogin, expiresAt },
      challenge: generatePairingChallenge(),
      issuedAt: now,
      expiresAt,
    }, this.identity.keys.privateKey, this.identity.keys.keyId)
    await this.file.transaction(
      () => initialState(this.identity.workspaceId),
      state => {
        validateState(state, this.identity.workspaceId)
        prune(state, now)
        if (Object.keys(state.enrollments).length >= MAX_OPEN_ENROLLMENTS) {
          throw new Error('Too many Gateway enrollments are already open')
        }
        state.enrollments[enrollmentId] = { invitation, status: 'open' }
        return { result: undefined, changed: true }
      },
    )
    const link = encodeGatewayEnrollmentInvitation(invitation)
    return { link, expiresAt, enrollmentId }
  }

  async registerRequest(
    input: unknown,
    now = Date.now(),
  ): Promise<GatewayEnrollmentPending> {
    const signed = signedGatewayEnrollmentRequestSchema.parse(input)
    const snapshot = await this.file.transaction(
      () => initialState(this.identity.workspaceId),
      state => {
        validateState(state, this.identity.workspaceId)
        const changed = prune(state, now)
        const record = state.enrollments[signed.request.enrollmentId]
        if (!record || record.status === 'approved') {
          throw new Error('Gateway enrollment invitation is unknown or no longer open')
        }
        if (record.request && canonicalJson(record.request) !== canonicalJson(signed)) {
          throw new Error('Gateway enrollment invitation already has another request')
        }
        return {
          result: structuredClone(record.invitation),
          changed,
        }
      },
    )
    const invitation = snapshot.invitation
    const request = await verifyGatewayEnrollmentRequest(signed, {
      enrollmentId: invitation.enrollmentId,
      workspaceId: invitation.workspaceId,
      challenge: invitation.challenge,
      now,
    })
    if (request.expiresAt > invitation.expiresAt) {
      throw new Error('Gateway enrollment request exceeds its invitation lifetime')
    }
    const pending = gatewayEnrollmentPendingSchema.parse({
      enrollmentId: request.enrollmentId,
      gatewayNodeId: request.gatewayNodeId,
      gatewayName: request.gatewayName,
      verificationCode: await gatewayEnrollmentVerificationCode(request),
      requestedAt: request.issuedAt,
      expiresAt: request.expiresAt,
    })
    return this.file.transaction(
      () => initialState(this.identity.workspaceId),
      state => {
        validateState(state, this.identity.workspaceId)
        prune(state, now)
        const record = state.enrollments[request.enrollmentId]
        if (!record || record.status === 'approved') {
          throw new Error('Gateway enrollment invitation is unknown or no longer open')
        }
        if (record.request && canonicalJson(record.request) !== canonicalJson(signed)) {
          throw new Error('Gateway enrollment invitation already has another request')
        }
        const changed = !record.request
        record.request = signed
        record.status = 'pending'
        return { result: pending, changed }
      },
    )
  }

  async pending(now = Date.now()): Promise<GatewayEnrollmentPending[]> {
    const requests = await this.file.transaction(
      () => initialState(this.identity.workspaceId),
      state => {
        validateState(state, this.identity.workspaceId)
        const changed = prune(state, now)
        const pending = Object.values(state.enrollments)
          // Approval is a durable Matrix state response, not another action
          // for clients to repeat. Once it exists, remove the request from
          // actionable snapshots while the new Gateway completes activation.
          .filter(record => record.request && record.status === 'pending')
          .map(record => ({
            request: structuredClone(record.request!.request),
            expiresAt: record.request!.request.expiresAt,
          }))
        return { result: pending, changed }
      },
    )
    const pending = await Promise.all(requests.map(async ({ request, expiresAt }) =>
      gatewayEnrollmentPendingSchema.parse({
        enrollmentId: request.enrollmentId,
        gatewayNodeId: request.gatewayNodeId,
        gatewayName: request.gatewayName,
        verificationCode: await gatewayEnrollmentVerificationCode(request),
        requestedAt: request.issuedAt,
        expiresAt,
      })))
    return pending.sort((left, right) => left.requestedAt - right.requestedAt)
  }

  async approve(
    enrollmentId: string,
    invitationLink: string,
    now = Date.now(),
  ): Promise<{
    response: GatewayEnrollmentResponse
    gatewayNodeId: string
    gatewayName: string
  }> {
    const snapshot = await this.file.transaction<{
      request: GatewayEnrollmentRequest
      response?: GatewayEnrollmentResponse
    }>(
      () => initialState(this.identity.workspaceId),
      state => {
        validateState(state, this.identity.workspaceId)
        const changed = prune(state, now)
        const record = state.enrollments[enrollmentId]
        if (!record?.request) throw new Error('Gateway enrollment request is not pending')
        if (record.response) {
          return {
            result: {
              request: structuredClone(record.request.request),
              response: gatewayEnrollmentResponseSchema.parse(record.response),
            },
            changed,
          }
        }
        return {
          result: { request: structuredClone(record.request.request) },
          changed,
        }
      },
    )
    const request = snapshot.request
    if (snapshot.response) {
      return {
        response: snapshot.response,
        gatewayNodeId: request.gatewayNodeId,
        gatewayName: request.gatewayName,
      }
    }
    const lifetimeMs = GATEWAY_ENROLLMENT_APPROVAL_LIFETIME_MS
    const sealedInvitation = await sealSecureEnvelope({
      gatewayId: this.identity.workspaceId,
      conversationId: enrollmentId,
      direction: 'gateway_to_device',
      senderDeviceId: this.identity.gatewayNodeId,
      recipientDeviceId: request.gatewayNodeId,
      senderKeyId: this.identity.keys.keyId,
      recipientKeyId: request.gatewayKey.keyId,
      plaintext: { kind: 'gateway_join', link: invitationLink },
      senderPrivateKey: this.identity.keys.privateKey,
      recipientPublicKey: request.gatewayKey.publicKey,
      now,
      lifetimeMs,
    })
    const response = gatewayEnrollmentResponseSchema.parse({
      kind: 'malink.gateway.enrollment-response',
      version: 1,
      enrollmentId,
      workspaceId: this.identity.workspaceId,
      gatewayNodeId: request.gatewayNodeId,
      sealedInvitation,
      issuedAt: now,
      expiresAt: now + lifetimeMs,
    })
    const committed = await this.file.transaction(
      () => initialState(this.identity.workspaceId),
      state => {
        validateState(state, this.identity.workspaceId)
        const record = state.enrollments[enrollmentId]
        if (!record?.request) throw new Error('Gateway enrollment request is not pending')
        if (record.response) {
          return { result: gatewayEnrollmentResponseSchema.parse(record.response), changed: false }
        }
        record.response = response
        record.status = 'approved'
        return { result: response, changed: true }
      },
    )
    return {
      response: committed,
      gatewayNodeId: request.gatewayNodeId,
      gatewayName: request.gatewayName,
    }
  }
}

export function encodeGatewayEnrollmentInvitation(
  invitation: SignedGatewayEnrollmentInvitation,
): string {
  const link = `${PREFIX}${Buffer.from(
    canonicalJson(signedGatewayEnrollmentInvitationSchema.parse(invitation)),
    'utf8',
  ).toString('base64url')}`
  if (link.length > MAX_LINK_CHARS) throw new Error('Gateway enrollment invitation is too large')
  return link
}

export function decodeGatewayEnrollmentInvitationLink(
  link: string,
): SignedGatewayEnrollmentInvitation {
  if (!link.startsWith(PREFIX) || link.length > MAX_LINK_CHARS) {
    throw new TypeError('Invalid Malink Gateway enrollment link')
  }
  try {
    const encoded = link.slice(PREFIX.length)
    if (!/^[A-Za-z0-9_-]+$/u.test(encoded)) throw new Error('invalid base64url')
    return signedGatewayEnrollmentInvitationSchema.parse(
      JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')),
    )
  } catch (error) {
    throw new TypeError('Invalid Malink Gateway enrollment payload', { cause: error })
  }
}

function initialState(workspaceId: string): EnrollmentState {
  return { version: 1, workspaceId, enrollments: {} }
}

function validateState(state: EnrollmentState, workspaceId: string): void {
  if (
    state.version !== 1
    || state.workspaceId !== workspaceId
    || !state.enrollments
    || typeof state.enrollments !== 'object'
    || Object.keys(state.enrollments).length > MAX_OPEN_ENROLLMENTS
  ) throw new TypeError('Gateway enrollment state is invalid')
  for (const [id, record] of Object.entries(state.enrollments)) {
    const invitation = signedGatewayEnrollmentInvitationSchema.parse(record.invitation)
    if (
      id !== invitation.invitation.enrollmentId
      || !['open', 'pending', 'approved'].includes(record.status)
      || (record.request && record.request.request.enrollmentId !== id)
      || (record.response && record.response.enrollmentId !== id)
    ) throw new TypeError('Gateway enrollment record is invalid')
  }
}

function prune(state: EnrollmentState, now: number): boolean {
  let changed = false
  for (const [id, record] of Object.entries(state.enrollments)) {
    const expiresAt = record.response?.expiresAt ?? record.invitation.invitation.expiresAt
    if (expiresAt > now) continue
    delete state.enrollments[id]
    changed = true
  }
  return changed
}
