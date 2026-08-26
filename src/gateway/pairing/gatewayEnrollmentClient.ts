import { randomUUID } from 'node:crypto'
import { chmod, mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  MLP3_MATRIX_GATEWAY_ENROLLMENT_REQUEST_EVENT_TYPE,
  MLP3_MATRIX_GATEWAY_ENROLLMENT_RESPONSE_EVENT_TYPE,
  MLP3_MATRIX_WORKSPACE_DEVICE_GRANT_EVENT_TYPE,
  MLP3_MATRIX_WORKSPACE_DEVICE_REVOCATION_EVENT_TYPE,
  MLP3_MATRIX_WORKSPACE_DIRECTORY_EVENT_TYPE,
  gatewayEnrollmentResponseSchema,
  signedGatewayEnrollmentInvitationSchema,
  signedGatewayEnrollmentRequestSchema,
  type SignedGatewayEnrollmentInvitation,
  type SignedGatewayEnrollmentRequest,
} from '@malink/protocol'
import {
  base64UrlDecode,
  exportDeviceKeyPair,
  exportPairingPublicKey,
  gatewayEnrollmentVerificationCode,
  generateDeviceKeyPair,
  importDeviceKeyPair,
  openSecureEnvelope,
  signGatewayEnrollmentRequest,
  toArrayBuffer,
  verifyGatewayEnrollmentInvitation,
  webCrypto,
  type SerializedDeviceKeyPair,
} from '@malink/security'
import { FileReplayStore } from '@malink/security/node'
import {
  MatrixNodeSdkGatewayClient,
  loadOrCreateMatrixCryptoPassphrase,
} from '@/gateway/matrix/nodeClient'
import {
  loadOrLoginMatrixGateway,
  loginMatrixGatewayWithToken,
  type MatrixGatewayLogin,
} from '@/gateway/matrix/login'
import { FileGatewayIdentityStore } from './identityStore.js'
import { acceptGatewayJoinInvitation } from './gatewayJoin.js'
import { FileWorkspaceGatewayDirectory } from './workspaceDirectory.js'
import { FileWorkspaceDeviceAuthorization } from './workspaceAuthorization.js'
import {
  decodeGatewayEnrollmentInvitationLink,
  gatewayEnrollmentApprovalDeadline,
} from './gatewayEnrollment.js'

const RELAY_PATH = '/api/invitations'
const REQUEST_FILE = 'gateway-enrollment-request.json'
const FINALIZATION_FILE = 'gateway-enrollment-finalization.json'

interface GatewayEnrollmentRequestState {
  version: 1
  signedInvitation: SignedGatewayEnrollmentInvitation
  signedRequest: SignedGatewayEnrollmentRequest
  requestKeys: SerializedDeviceKeyPair
  gatewayName: string
  matrixDeviceId: string
}

interface GatewayEnrollmentFinalization {
  version: 1
  enrollmentId: string
  workspaceId: string
  gatewayNodeId: string
  gatewayName: string
  homeserver: string
  rendezvousRoomId: string
  matrixUserId: string
  invitationLink: string
  acceptedAt: number
  projectRoomId?: string
}

export interface GatewayEnrollmentJoinProgress {
  phase: 'requesting' | 'waiting' | 'approved'
  verificationCode?: string
  enrollmentId: string
  gatewayNodeId: string
}

export async function joinWorkspaceThroughGatewayEnrollment(input: {
  invitationLink: string
  dataDirectory: string
  gatewayName: string
  now?: () => number
  fetch?: typeof fetch
  onProgress?: (progress: GatewayEnrollmentJoinProgress) => void
}): Promise<{
  workspaceId: string
  gatewayNodeId: string
  projectRoomId: string
  fixturePath: string
}> {
  const now = input.now ?? Date.now
  const fetchImpl = input.fetch ?? fetch
  const requestStatePath = join(input.dataDirectory, REQUEST_FILE)
  const finalizationPath = join(input.dataDirectory, FINALIZATION_FILE)
  const interrupted = await readGatewayEnrollmentFinalization(finalizationPath)
  if (interrupted) {
    const login = await loadOrLoginMatrixGateway({
      homeserver: interrupted.homeserver,
      loginUser: matrixLoginUser(interrupted.matrixUserId),
      deviceId: `MALINK_GATEWAY_${randomUUID().replaceAll('-', '').slice(0, 16).toUpperCase()}`,
      deviceDisplayName: interrupted.gatewayName,
      sessionPath: join(input.dataDirectory, 'matrix-session.json'),
      readPassword: async () => undefined,
      fetch: fetchImpl,
    })
    if (login.user_id !== interrupted.matrixUserId) {
      throw new Error('Persisted Matrix session belongs to another Gateway account')
    }
    return finalizeGatewayEnrollment({
      dataDirectory: input.dataDirectory,
      finalizationPath,
      requestStatePath,
      finalization: interrupted,
      login,
      fetch: fetchImpl,
      onProgress: input.onProgress,
    })
  }
  let requestState = await readGatewayEnrollmentRequestState(requestStatePath)
  if (requestState) {
    const persistedRequestExpiresAt = requestState.signedInvitation.invitation.expiresAt
    if (typeof persistedRequestExpiresAt !== 'number') {
      throw new Error('Interrupted Gateway enrollment request expiry is invalid')
    }
    if (gatewayEnrollmentApprovalDeadline(persistedRequestExpiresAt) <= now()) {
      await unlink(requestStatePath)
      requestState = null
    }
  }
  let resolvedReplacement: {
    signedInvitation: SignedGatewayEnrollmentInvitation
    invitation: Awaited<ReturnType<typeof verifyGatewayEnrollmentInvitation>>
  } | null = null
  if (requestState) {
    try {
      const resolvedLink = await resolveGatewayEnrollmentLink(input.invitationLink, fetchImpl)
      const signedInvitation = decodeGatewayEnrollmentInvitationLink(resolvedLink)
      if (
        signedInvitation.invitation.enrollmentId
        !== requestState.signedInvitation.invitation.enrollmentId
      ) {
        resolvedReplacement = {
          signedInvitation,
          invitation: await verifyGatewayEnrollmentInvitation(signedInvitation, now()),
        }
      }
    } catch {
      // A short link can expire while its signed request is still waiting for
      // an already-issued approval. The private request state remains the
      // recovery authority until the approval window closes.
    }
    if (resolvedReplacement) {
      await removePrivateState(requestStatePath)
      requestState = null
    }
  }
  if (!requestState) {
    if (
      await fileExists(join(input.dataDirectory, 'gateway-identity.json'))
      || await fileExists(join(input.dataDirectory, 'matrix-fixture.json'))
    ) {
      throw new Error(
        'This Gateway data directory is already configured; choose an empty directory for a new node',
      )
    }
    const resolvedLink = resolvedReplacement
      ? null
      : await resolveGatewayEnrollmentLink(input.invitationLink, fetchImpl)
    const signedInvitation = resolvedReplacement?.signedInvitation
      ?? decodeGatewayEnrollmentInvitationLink(resolvedLink!)
    const invitation = resolvedReplacement?.invitation
      ?? await verifyGatewayEnrollmentInvitation(signedInvitation, now())
    const requestKeys = await generateDeviceKeyPair()
    const gatewayKey = await exportPairingPublicKey(requestKeys.publicKey)
    const signedRequest = await signGatewayEnrollmentRequest({
      kind: 'malink.gateway.enrollment-request',
      version: 1,
      enrollmentId: invitation.enrollmentId,
      workspaceId: invitation.workspaceId,
      gatewayNodeId: randomUUID(),
      gatewayName: input.gatewayName,
      gatewayKey,
      challenge: invitation.challenge,
      issuedAt: now(),
      expiresAt: invitation.expiresAt,
    }, requestKeys.privateKey, requestKeys.keyId)
    requestState = {
      version: 1,
      signedInvitation,
      signedRequest,
      requestKeys: await exportDeviceKeyPair(requestKeys),
      gatewayName: input.gatewayName,
      matrixDeviceId: `MALINK_GATEWAY_${randomUUID().replaceAll('-', '').slice(0, 16).toUpperCase()}`,
    }
    await writePrivateJson(requestStatePath, requestState)
  }
  const invitationExpiresAt = requestState.signedInvitation.invitation.expiresAt
  // The request was signed and persisted while the setup invitation was
  // valid. Verify that signature at the last valid instant when resuming, but
  // only while the bounded approval recovery window above remains open.
  const invitation = await verifyGatewayEnrollmentInvitation(
    requestState.signedInvitation,
    Math.min(now(), invitationExpiresAt - 1),
  )
  const requestKeys = await importDeviceKeyPair(requestState.requestKeys)
  const request = signedGatewayEnrollmentRequestSchema.parse(requestState.signedRequest)
  if (
    request.request.enrollmentId !== invitation.enrollmentId
    || request.request.workspaceId !== invitation.workspaceId
    || request.request.challenge !== invitation.challenge
    || request.request.gatewayKey.keyId !== requestKeys.keyId
  ) throw new Error('Interrupted Gateway enrollment request does not match its invitation')
  const gatewayNodeId = request.request.gatewayNodeId
  const verificationCode = await gatewayEnrollmentVerificationCode(request.request)
  const loginUser = matrixLoginUser(invitation.matrixLogin.userId)
  const login = await loginMatrixGatewayWithToken({
    homeserver: invitation.matrixLogin.homeserver,
    loginToken: invitation.matrixLogin.loginToken,
    expectedUserId: invitation.matrixLogin.userId,
    loginUser,
    deviceId: requestState.matrixDeviceId,
    deviceDisplayName: requestState.gatewayName,
    sessionPath: join(input.dataDirectory, 'matrix-session.json'),
    fetch: fetchImpl,
  })
  const client = new MatrixNodeSdkGatewayClient({
    baseUrl: invitation.rendezvous.homeserver,
    accessToken: login.access_token,
    userId: login.user_id,
    deviceId: login.device_id,
    initialSyncTimeoutMs: 30_000,
  }, 30_000, undefined, fetchImpl)
  await client.initializeCrypto({
    backend: 'node-sqlite',
    storagePath: join(input.dataDirectory, 'matrix-crypto'),
    storagePassword: await loadOrCreateMatrixCryptoPassphrase(
      join(input.dataDirectory, 'matrix-crypto.passphrase'),
    ),
    syncTokenPath: join(input.dataDirectory, 'matrix-sync-token.json'),
  })

  let responseTimeout: ReturnType<typeof setTimeout> | undefined
  let unsubscribeResponse: (() => void) | undefined
  const responsePromise = new Promise<unknown>((resolve, reject) => {
    responseTimeout = setTimeout(() => {
      reject(new Error('Gateway enrollment approval expired before it was received'))
    }, Math.max(1, gatewayEnrollmentApprovalDeadline(invitation.expiresAt) - now()))
    unsubscribeResponse = client.onRoomEvent(event => {
      if (
        event.encrypted
        || event.roomId !== invitation.rendezvous.roomId
        || event.eventType !== MLP3_MATRIX_GATEWAY_ENROLLMENT_RESPONSE_EVENT_TYPE
      ) return
      try {
        const response = gatewayEnrollmentResponseSchema.parse(event.content)
        if (
          response.enrollmentId !== invitation.enrollmentId
          || response.workspaceId !== invitation.workspaceId
          || response.gatewayNodeId !== gatewayNodeId
        ) return
        if (responseTimeout) clearTimeout(responseTimeout)
        unsubscribeResponse?.()
        resolve(response)
      } catch {
        // Ignore unrelated or malformed rendezvous state and keep waiting.
      }
    })
  })

  try {
    await client.start()
    await client.waitUntilReady()
    if (!client.setApplicationRoomState) {
      throw new Error('Matrix transport cannot publish Gateway enrollment requests')
    }
    input.onProgress?.({
      phase: 'requesting',
      enrollmentId: invitation.enrollmentId,
      gatewayNodeId,
    })
    await client.setApplicationRoomState({
      roomId: invitation.rendezvous.roomId,
      eventType: MLP3_MATRIX_GATEWAY_ENROLLMENT_REQUEST_EVENT_TYPE,
      stateKey: invitation.enrollmentId,
      content: request,
    })
    input.onProgress?.({
      phase: 'waiting',
      verificationCode,
      enrollmentId: invitation.enrollmentId,
      gatewayNodeId,
    })
    const persistedResponse = await fetchGatewayEnrollmentResponse(
      invitation.rendezvous.homeserver,
      invitation.rendezvous.roomId,
      invitation.enrollmentId,
      login.access_token,
      fetchImpl,
    )
    const response = gatewayEnrollmentResponseSchema.parse(
      persistedResponse ?? await responsePromise,
    )
    const opened = await openSecureEnvelope(response.sealedInvitation, {
      recipientPrivateKey: requestKeys.privateKey,
      senderPublicKey: invitation.workspaceKey.publicKey,
      expected: {
        gatewayId: invitation.workspaceId,
        conversationId: invitation.enrollmentId,
        direction: 'gateway_to_device',
        senderDeviceId: response.sealedInvitation.envelope.senderDeviceId,
        recipientDeviceId: gatewayNodeId,
        senderKeyId: invitation.workspaceKey.keyId,
        recipientKeyId: requestKeys.keyId,
      },
      replayStore: new FileReplayStore(join(input.dataDirectory, 'gateway-enrollment-replay.json')),
      now: now(),
    })
    const plaintext = record(opened.plaintext)
    if (plaintext?.kind !== 'gateway_join' || typeof plaintext.link !== 'string') {
      throw new Error('Gateway enrollment approval did not contain a Workspace grant')
    }
    const finalization: GatewayEnrollmentFinalization = {
      version: 1,
      enrollmentId: invitation.enrollmentId,
      workspaceId: invitation.workspaceId,
      gatewayNodeId,
      gatewayName: requestState.gatewayName,
      homeserver: invitation.rendezvous.homeserver,
      rendezvousRoomId: invitation.rendezvous.roomId,
      matrixUserId: login.user_id,
      invitationLink: plaintext.link,
      acceptedAt: now(),
    }
    // The sealed approval is a one-shot credential. Persist it privately before
    // committing local state so a network or process failure can resume instead
    // of consuming another setup invitation or creating a duplicate room.
    await writePrivateJson(finalizationPath, finalization)
    return await finalizeGatewayEnrollment({
      dataDirectory: input.dataDirectory,
      finalizationPath,
      requestStatePath,
      finalization,
      login,
      fetch: fetchImpl,
      onProgress: input.onProgress,
    })
  } finally {
    if (responseTimeout) clearTimeout(responseTimeout)
    unsubscribeResponse?.()
    await client.stop().catch(() => undefined)
  }
}

export async function resolveGatewayEnrollmentLink(
  input: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  if (input.startsWith('malink://gateway-enroll#data=')) return input
  const url = new URL(input)
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('Gateway enrollment links must use Malink, HTTP, or HTTPS')
  }
  const fragment = new URLSearchParams(url.hash.replace(/^#/u, ''))
  const id = fragment.get('i') ?? ''
  const encodedKey = fragment.get('k') ?? ''
  if (!/^[A-Za-z0-9_-]{22}$/u.test(id)) throw new Error('Gateway enrollment short ID is invalid')
  const keyBytes = base64UrlDecode(encodedKey)
  if (keyBytes.byteLength !== 32) throw new Error('Gateway enrollment short key is invalid')
  const response = await fetchImpl(new URL(RELAY_PATH, url.origin), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'resolve', id }),
  })
  if (!response.ok) throw new Error('Gateway enrollment invitation is unavailable or expired')
  const entry = record(await response.json())
  if (
    typeof entry?.ciphertext !== 'string'
    || typeof entry.iv !== 'string'
    || typeof entry.expiresAt !== 'number'
    || !Number.isSafeInteger(entry.expiresAt)
    || entry.expiresAt <= Date.now()
  ) throw new Error('Gateway enrollment relay entry is invalid or expired')
  const key = await webCrypto().subtle.importKey(
    'raw',
    toArrayBuffer(keyBytes),
    { name: 'AES-GCM' },
    false,
    ['decrypt'],
  )
  let plaintext: ArrayBuffer
  try {
    plaintext = await webCrypto().subtle.decrypt({
      name: 'AES-GCM',
      iv: toArrayBuffer(base64UrlDecode(entry.iv)),
      additionalData: toArrayBuffer(new TextEncoder().encode(
        `malink.invitation.relay.v1\u0000${url.origin}\u0000${id}\u0000${entry.expiresAt}`,
      )),
    }, key, toArrayBuffer(base64UrlDecode(entry.ciphertext)))
  } catch (error) {
    throw new Error('Gateway enrollment invitation could not be decrypted', { cause: error })
  }
  const link = new TextDecoder('utf-8', { fatal: true }).decode(plaintext)
  const invitation = await verifyGatewayEnrollmentInvitation(
    decodeGatewayEnrollmentInvitationLink(link),
  )
  if (invitation.expiresAt !== entry.expiresAt) {
    throw new Error('Gateway enrollment invitation expiry does not match its relay entry')
  }
  return link
}

function matrixLoginUser(userId: string): string {
  const match = userId.match(/^@([^:]+):/u)
  return match?.[1] ?? userId
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

async function createGatewayProjectRoom(
  homeserver: string,
  accessToken: string,
  fetchImpl: typeof fetch,
): Promise<string> {
  const response = await fetchImpl(`${new URL(homeserver).origin}/_matrix/client/v3/createRoom`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      visibility: 'private',
      preset: 'private_chat',
      name: 'Malink encrypted project',
      initial_state: [{
        type: 'm.room.encryption',
        state_key: '',
        content: { algorithm: 'm.megolm.v1.aes-sha2' },
      }],
    }),
  })
  const body = record(await response.json().catch(() => null))
  if (!response.ok || typeof body?.room_id !== 'string' || !body.room_id.startsWith('!')) {
    throw new Error(`Matrix could not create the new Gateway project room (HTTP ${response.status})`)
  }
  return body.room_id
}

async function finalizeGatewayEnrollment(input: {
  dataDirectory: string
  finalizationPath: string
  requestStatePath: string
  finalization: GatewayEnrollmentFinalization
  login: MatrixGatewayLogin
  fetch: typeof fetch
  onProgress?: (progress: GatewayEnrollmentJoinProgress) => void
}): Promise<{
  workspaceId: string
  gatewayNodeId: string
  projectRoomId: string
  fixturePath: string
}> {
  const controlState = await fetchWorkspaceControlState(
    input.finalization.homeserver,
    input.finalization.rendezvousRoomId,
    input.login.access_token,
    input.fetch,
  )
  const identityStore = new FileGatewayIdentityStore(
    join(input.dataDirectory, 'gateway-identity.json'),
  )
  const joined = await acceptGatewayJoinInvitation(
    identityStore,
    input.finalization.invitationLink,
    input.finalization.gatewayNodeId,
    input.finalization.acceptedAt,
  )
  if (joined.identity.workspaceId !== input.finalization.workspaceId) {
    throw new Error('Gateway enrollment approval belongs to another Workspace')
  }
  const directory = new FileWorkspaceGatewayDirectory(
    join(input.dataDirectory, 'workspace-gateways.json'),
    joined.identity,
  )
  if (joined.directory) await directory.merge(joined.directory)
  const authorization = new FileWorkspaceDeviceAuthorization(
    join(input.dataDirectory, 'workspace-device-authorization.json'),
    joined.identity,
  )
  for (const grant of joined.deviceGrants) await authorization.mergeGrant(grant)
  for (const revocation of joined.deviceRevocations) {
    await authorization.mergeRevocation(revocation)
  }
  let foundDirectory = false
  for (const event of controlState) {
    if (event.type === MLP3_MATRIX_WORKSPACE_DIRECTORY_EVENT_TYPE) {
      await directory.merge(event.content)
      foundDirectory = true
    } else if (event.type === MLP3_MATRIX_WORKSPACE_DEVICE_GRANT_EVENT_TYPE) {
      await authorization.mergeGrant(event.content)
    } else if (event.type === MLP3_MATRIX_WORKSPACE_DEVICE_REVOCATION_EVENT_TYPE) {
      await authorization.mergeRevocation(event.content)
    }
  }
  if (!foundDirectory && !joined.directory) {
    throw new Error('The existing Workspace Gateway directory is unavailable')
  }
  let projectRoomId = input.finalization.projectRoomId
  if (!projectRoomId) {
    projectRoomId = await createGatewayProjectRoom(
      input.finalization.homeserver,
      input.login.access_token,
      input.fetch,
    )
    input.finalization.projectRoomId = projectRoomId
    await writePrivateJson(input.finalizationPath, input.finalization)
  }
  const fixturePath = join(input.dataDirectory, 'matrix-fixture.json')
  await writePrivateJson(fixturePath, {
    homeserver: input.finalization.homeserver,
    roomId: projectRoomId,
    gatewayId: joined.identity.workspaceId,
    gateway: { userId: input.login.user_id },
  })
  await removePrivateState(input.requestStatePath)
  await removePrivateState(input.finalizationPath)
  input.onProgress?.({
    phase: 'approved',
    enrollmentId: input.finalization.enrollmentId,
    gatewayNodeId: joined.identity.gatewayNodeId,
  })
  return {
    workspaceId: joined.identity.workspaceId,
    gatewayNodeId: joined.identity.gatewayNodeId,
    projectRoomId,
    fixturePath,
  }
}

async function readGatewayEnrollmentRequestState(
  path: string,
): Promise<GatewayEnrollmentRequestState | null> {
  let value: unknown
  try {
    value = JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if (record(error)?.code === 'ENOENT') return null
    throw new Error('Could not read interrupted Gateway enrollment request', { cause: error })
  }
  const state = record(value)
  if (
    state?.version !== 1
    || typeof state.gatewayName !== 'string'
    || !state.gatewayName
    || typeof state.matrixDeviceId !== 'string'
    || !state.matrixDeviceId
  ) throw new Error('Interrupted Gateway enrollment request is invalid')
  return {
    version: 1,
    signedInvitation: signedGatewayEnrollmentInvitationSchema.parse(state.signedInvitation),
    signedRequest: signedGatewayEnrollmentRequestSchema.parse(state.signedRequest),
    requestKeys: state.requestKeys as SerializedDeviceKeyPair,
    gatewayName: state.gatewayName,
    matrixDeviceId: state.matrixDeviceId,
  }
}

async function removePrivateState(path: string): Promise<void> {
  try {
    await unlink(path)
  } catch (error) {
    if (record(error)?.code !== 'ENOENT') throw error
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path)
    return true
  } catch (error) {
    if (record(error)?.code === 'ENOENT') return false
    throw error
  }
}

async function fetchWorkspaceControlState(
  homeserver: string,
  roomId: string,
  accessToken: string,
  fetchImpl: typeof fetch,
): Promise<Array<{ type: string; content: unknown }>> {
  const response = await fetchImpl(
    `${new URL(homeserver).origin}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state`,
    { headers: { authorization: `Bearer ${accessToken}` } },
  )
  const body: unknown = await response.json().catch(() => null)
  if (!response.ok || !Array.isArray(body)) {
    throw new Error(`Matrix could not read the existing Workspace state (HTTP ${response.status})`)
  }
  return body.flatMap(value => {
    const event = record(value)
    return typeof event?.type === 'string' && event.content !== undefined
      ? [{ type: event.type, content: event.content }]
      : []
  })
}

async function fetchGatewayEnrollmentResponse(
  homeserver: string,
  roomId: string,
  enrollmentId: string,
  accessToken: string,
  fetchImpl: typeof fetch,
): Promise<unknown | null> {
  const response = await fetchImpl(
    `${new URL(homeserver).origin}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}`
      + `/state/${encodeURIComponent(MLP3_MATRIX_GATEWAY_ENROLLMENT_RESPONSE_EVENT_TYPE)}`
      + `/${encodeURIComponent(enrollmentId)}`,
    { headers: { authorization: `Bearer ${accessToken}` } },
  )
  if (response.status === 404) return null
  if (!response.ok) {
    throw new Error(`Matrix could not read the Gateway enrollment response (HTTP ${response.status})`)
  }
  return response.json()
}

async function readGatewayEnrollmentFinalization(
  path: string,
): Promise<GatewayEnrollmentFinalization | null> {
  let value: unknown
  try {
    value = JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if (record(error)?.code === 'ENOENT') return null
    throw new Error('Could not read interrupted Gateway enrollment state', { cause: error })
  }
  const state = record(value)
  if (
    state?.version !== 1
    || typeof state.enrollmentId !== 'string'
    || typeof state.workspaceId !== 'string'
    || typeof state.gatewayNodeId !== 'string'
    || typeof state.gatewayName !== 'string'
    || typeof state.homeserver !== 'string'
    || typeof state.rendezvousRoomId !== 'string'
    || typeof state.matrixUserId !== 'string'
    || typeof state.invitationLink !== 'string'
    || typeof state.acceptedAt !== 'number'
    || !Number.isSafeInteger(state.acceptedAt)
    || (state.projectRoomId !== undefined && typeof state.projectRoomId !== 'string')
  ) throw new Error('Interrupted Gateway enrollment state is invalid')
  return state as unknown as GatewayEnrollmentFinalization
}

async function writePrivateJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  const handle = await open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  if (process.platform !== 'win32') await chmod(temporary, 0o600)
  await rename(temporary, path)
  if (process.platform !== 'win32') await chmod(path, 0o600)
}
