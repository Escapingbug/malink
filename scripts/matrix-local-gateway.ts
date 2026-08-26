import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { hostname } from 'node:os'
import { fileURLToPath } from 'node:url'
import QRCode from 'qrcode'
import {
    MLP3_MATRIX_WORKSPACE_DEVICE_GRANT_EVENT_TYPE,
    MLP3_MATRIX_WORKSPACE_DEVICE_REVOCATION_EVENT_TYPE,
    MLP3_MATRIX_WORKSPACE_DIRECTORY_EVENT_TYPE,
    MLP3_MATRIX_GATEWAY_ENROLLMENT_REQUEST_EVENT_TYPE,
    MLP3_MATRIX_GATEWAY_ENROLLMENT_RESPONSE_EVENT_TYPE,
    pairingOperationSchema,
    type PairingOperation,
    type SignedWorkspaceGatewayDirectory,
} from '@malink/protocol'
import { PairingOfferGuard, signWorkspaceDeviceRevocation } from '@malink/security'
import { FileReplayStore } from '@malink/security/node'
import {
    FileGatewayIdentityStore,
    FileGatewayNodeProfileStore,
    FileTrustedDeviceRegistry,
    FileWorkspaceGatewayDirectory,
    FileWorkspaceDeviceAuthorization,
    DeviceInvitationCoordinator,
    GatewayPairingService,
    listenForMatrixPairingRequests,
    announceMatrixDeviceRotation,
    publishMatrixTransportSnapshot,
    pairingVerificationCode,
    ensurePortableWorkspaceGrant,
    trustedDeviceFromRecord,
    trustedDeviceFromWorkspaceGrant,
    FileGatewayEnrollmentCoordinator,
    GATEWAY_ENROLLMENT_APPROVAL_LIFETIME_MS,
    createGatewayJoinInvitation,
    gatewayNodeShortId,
} from '../src/gateway/pairing/index.js'
import {
    FileMatrixLoginTokenIssuer,
    startGatewayAdminServer,
} from '../src/gateway/admin/index.js'
import {
    MatrixMlp3GatewayRunner,
    MatrixNodeSdkGatewayClient,
    FileGatewayProjectCatalog,
    loadOrCreateMatrixCryptoPassphrase,
    loadOrLoginMatrixGateway,
    gatewayProjectIdentity,
    type MatrixGatewayConfig,
    type MatrixGatewayRoomConfig,
    type MatrixGatewayTrustedDevice,
} from '../src/gateway/matrix/index.js'
import { registerConfiguredProviders } from '../src/providers/configured.js'
import { getProvider, registerProvider } from '../src/providers/registry.js'
import type {
    AgentProvider,
    AgentQueryHandle,
    AgentQueryInput,
} from '../src/providers/provider.js'
import { createSessionExtensionRegistryFromEnvironment } from '../src/runtime/sessionExtensionConfig.js'
import { UnixSocketPrivilegeExecutor } from '../src/privilege/index.js'
import { GatewayUpdateSupervisorClient } from '../src/ops/gatewayUpdateSupervisorServer.js'

interface LocalMatrixFixture {
    homeserver: string
    roomId: string
    gatewayId: string
    gateway: { userId: string }
}

const dataDirectory = process.env.MALINK_MATRIX_DATA_DIR
    ?? join(process.cwd(), 'dev', 'matrix', 'gateway-data')
const enrolledFixturePath = join(dataDirectory, 'matrix-fixture.json')
const fixture = await readJson<LocalMatrixFixture>(
    process.env.MALINK_MATRIX_FIXTURE
        ?? (existsSync(enrolledFixturePath)
            ? enrolledFixturePath
            : join(process.cwd(), 'dev', 'matrix', 'local-test.json')),
)
assertAllowedHomeserver(fixture.homeserver)

const registered = registerConfiguredProviders()
const deterministicE2eProvider = process.env.MALINK_MATRIX_E2E_PROVIDER === '1'
if (deterministicE2eProvider && !isLoopbackHomeserver(fixture.homeserver)) {
    throw new Error('MALINK_MATRIX_E2E_PROVIDER is allowed only with a loopback homeserver')
}
const e2eStartupPairingOperations = parseE2eStartupPairingOperations(
    process.env.MALINK_MATRIX_E2E_STARTUP_PAIRING_OPERATIONS,
    deterministicE2eProvider,
)
const providerName = deterministicE2eProvider
    ? 'codex'
    : process.env.MALINK_PROVIDER
        ?? registered.defaultProvider
        ?? 'codex'
if (deterministicE2eProvider) {
    registerProvider(
        e2eProvider(providerName),
        () => e2eProvider(providerName),
        { type: 'codex' },
    )
}
const cwd = process.env.MALINK_CWD ?? process.cwd()
const sessionExtensionRegistry = await createSessionExtensionRegistryFromEnvironment()
const adminSocketPath = process.env.MALINK_GATEWAY_ADMIN_SOCKET
    ?? join(dataDirectory, 'admin.sock')
process.env.MALINK_GATEWAY_ADMIN_SOCKET = adminSocketPath
const defaultPrivilegeCredentialPath = join(dataDirectory, 'privilege-client.json')
const privilegeCredentialPath = process.env.MALINK_PRIVILEGE_CREDENTIAL_FILE?.trim()
    || (existsSync(defaultPrivilegeCredentialPath) ? defaultPrivilegeCredentialPath : undefined)
const privilegeExecutor = privilegeCredentialPath
    ? new UnixSocketPrivilegeExecutor(privilegeCredentialPath)
    : undefined
if (privilegeExecutor) process.env.MALINK_PRIVILEGE_AVAILABLE = '1'
const gatewayUpdateSupervisor = process.env.MALINK_GATEWAY_UPDATE_SOCKET?.trim()
    ? new GatewayUpdateSupervisorClient(process.env.MALINK_GATEWAY_UPDATE_SOCKET.trim())
    : undefined
const gatewayBuildId = await currentGatewayBuildId()
const runId = Date.now().toString(36).toUpperCase()
const loginUser = process.env.MALINK_MATRIX_GATEWAY_USER ?? 'gateway'
const gatewayMatrixDeviceId = `MALINK_GATEWAY_${runId}`
const gatewaySessionPath = process.env.MALINK_MATRIX_GATEWAY_SESSION_FILE
    ?? join(dataDirectory, 'matrix-session.json')
const identity = await new FileGatewayIdentityStore(
    join(dataDirectory, 'gateway-identity.json'),
).loadOrCreate(fixture.gatewayId)
const gatewayProfileStore = new FileGatewayNodeProfileStore(
    join(dataDirectory, 'gateway-profile.json'),
    identity.gatewayNodeId,
)
const configuredGatewayName = process.env.MALINK_GATEWAY_NAME?.trim()
const detectedGatewayName = hostname().trim()
    || `Gateway ${gatewayNodeShortId(identity.gatewayNodeId)}`
let gatewayProfile = await gatewayProfileStore.loadOrCreate(
    configuredGatewayName || detectedGatewayName,
)
if (configuredGatewayName && gatewayProfile.gatewayName !== configuredGatewayName) {
    gatewayProfile = await gatewayProfileStore.rename(configuredGatewayName)
}
const login = await loadOrLoginMatrixGateway({
    homeserver: fixture.homeserver,
    loginUser,
    deviceId: gatewayMatrixDeviceId,
    deviceDisplayName: `${gatewayProfile.gatewayName} ${gatewayMatrixDeviceId}`,
    sessionPath: gatewaySessionPath,
    readPassword: async () => process.env.MALINK_MATRIX_GATEWAY_PASSWORD
        ?? await readPasswordFile(process.env.MALINK_MATRIX_GATEWAY_PASSWORD_FILE)
        ?? (isLoopbackHomeserver(fixture.homeserver) ? 'malink-gateway-local' : undefined),
    onLog: message => process.stderr.write(`[matrix-login] ${message}\n`),
})
const client = new MatrixNodeSdkGatewayClient({
    baseUrl: fixture.homeserver,
    accessToken: login.access_token,
    userId: login.user_id,
    deviceId: login.device_id,
    initialSyncTimeoutMs: 30_000,
}, 30_000, message => {
    process.stderr.write(`${message}\n`)
})
const registry = new FileTrustedDeviceRegistry(
    join(dataDirectory, 'trusted-devices.json'),
)
const pairingService = new GatewayPairingService(
    identity,
    registry,
    new PairingOfferGuard(
        new FileReplayStore(join(dataDirectory, 'pairing-replay.json')),
    ),
)

const cryptoConfig = {
    backend: 'node-sqlite' as const,
    storagePath: join(dataDirectory, 'matrix-crypto'),
    storagePassword: await loadOrCreateMatrixCryptoPassphrase(
        join(dataDirectory, 'matrix-crypto.passphrase'),
    ),
    syncTokenPath: join(dataDirectory, 'matrix-sync-token.json'),
}
await client.initializeCrypto(cryptoConfig)
await client.start()
await client.waitUntilReady()
const ownKeys = client.getOwnDeviceKeys()
const currentTransport = {
    homeserver: fixture.homeserver,
    roomId: fixture.roomId,
    userId: login.user_id,
    deviceId: login.device_id,
    ed25519: ownKeys.ed25519,
}
const workspaceDirectory = new FileWorkspaceGatewayDirectory(
    join(dataDirectory, 'workspace-gateways.json'),
    identity,
)
const configuredRootRoom: MatrixGatewayRoomConfig = {
    roomId: fixture.roomId,
    conversationId: fixture.roomId,
    cwd,
    providerName,
}
const projectCatalog = new FileGatewayProjectCatalog(
    join(dataDirectory, 'gateway-projects.json'),
    identity.gatewayNodeId,
)
await projectCatalog.initialize([configuredRootRoom])
const configuredRooms = await projectCatalog.list()
for (const room of configuredRooms) await client.assertRoomEncrypted(room.roomId)

async function publishLocalWorkspaceDirectory(): Promise<void> {
    const rooms = await projectCatalog.list()
    await workspaceDirectory.publishLocal(
        gatewayProfile.gatewayName,
        currentTransport,
        Date.now(),
        rooms.map(room => ({
            projectId: room.projectId ?? gatewayProjectIdentity(room.cwd, room.projectName).id,
            roomId: room.roomId,
            conversationId: room.conversationId,
        })),
        {
            buildId: gatewayBuildId,
            ...(gatewayUpdateSupervisor ? { onlineUpdate: true } : {}),
        },
    )
}

await publishLocalWorkspaceDirectory()
const workspaceAuthorization = new FileWorkspaceDeviceAuthorization(
    join(dataDirectory, 'workspace-device-authorization.json'),
    identity,
)
const gatewayEnrollmentCoordinator = new FileGatewayEnrollmentCoordinator(
    join(dataDirectory, 'gateway-enrollments.json'),
    identity,
)
const gatewayLoginTokenIssuer = new FileMatrixLoginTokenIssuer({
    credentialsPath: gatewaySessionPath,
    readPassword: async () => process.env.MALINK_MATRIX_GATEWAY_PASSWORD
        ?? await readPasswordFile(process.env.MALINK_MATRIX_GATEWAY_PASSWORD_FILE),
})
pairingService.setWorkspaceDirectoryProvider(() => workspaceDirectory.load())
const pwaLoginPath = process.env.MALINK_PWA_LOGIN_FILE
    ?? join(dirname(dataDirectory), 'pwa-login.json')
const invitationCoordinator = new DeviceInvitationCoordinator(
    pairingService,
    registry,
    {
        gatewayName: () => gatewayProfile.gatewayName,
        gatewayTransport: () => currentTransport,
        matrixLoginTokenIssuer: new FileMatrixLoginTokenIssuer({
            credentialsPath: pwaLoginPath,
        }),
        onAudit: event => {
            if (event.action === 'created') {
                process.stdout.write(
                    `Created ${event.source.kind} pairing invitation `
                    + `${event.invitationId ?? '(unknown)'}.\n`,
                )
                return
            }
            process.stderr.write(
                `[device-invitation] ${event.source.kind} failed: `
                + `${event.errorCode ?? 'unknown'}\n`,
            )
        },
    },
)

const active = await registry.listActive()
for (const record of active) {
    const grant = await ensurePortableWorkspaceGrant(
        identity,
        registry,
        record.certificate.certificate.deviceId,
    )
    await workspaceAuthorization.mergeGrant(grant)
}
let startupPairing: {
    link: string
    expiresAt: number
    verificationCode: string
} | null = null
if (active.length === 0) {
    const created = await pairingService.createOffer({
        gatewayName: gatewayProfile.gatewayName,
        gatewayTransport: currentTransport,
        ...(e2eStartupPairingOperations
            ? { allowedOperations: e2eStartupPairingOperations }
            : {}),
        source: { kind: 'gateway-startup' },
    })
    const invitationCode = await pairingVerificationCode(
        created.signedOffer.offer.offerId,
        created.signedOffer.offer.challenge,
        created.signedOffer.offer.gatewayKey.keyId,
    )
    startupPairing = {
        link: created.link,
        expiresAt: created.signedOffer.offer.expiresAt,
        verificationCode: invitationCode,
    }
} else {
    const rotated = await announceMatrixDeviceRotation({
        client,
        service: pairingService,
        registry,
        nextTransport: currentTransport,
        trustedDevices: active,
    })
    if (rotated) {
        process.stdout.write('Gateway Matrix transport key rotated and signed automatically.\n')
    }
    await publishMatrixTransportSnapshot({
        client,
        service: pairingService,
        registry,
        transport: currentTransport,
    })
    process.stdout.write('Published the durable Gateway profile recovery snapshot.\n')
    if (process.env.MALINK_PAIR_NEW_DEVICE === '1') {
        const created = await invitationCoordinator.create({
            source: { kind: 'gateway-startup' },
            matrixLogin: 'disabled',
        })
        process.stdout.write('\nAdd another Malink device:\n\n')
        process.stdout.write(await QRCode.toString(created.invitationLink, {
            type: 'terminal',
            small: true,
            errorCorrectionLevel: 'L',
        }))
        process.stdout.write(
            `\nInvitation code: ${formatCode(created.verificationCode)}\n`,
        )
        process.stdout.write(
            `Pairing link (paste fallback):\n${created.pairingLink}\n\n`,
        )
    }
}

const localRoomIds = configuredRooms.map(room => room.roomId)
const portableTrustedDevices = async () =>
    (await workspaceAuthorization.activeGrants()).map(grant =>
        trustedDeviceFromWorkspaceGrant(grant, localRoomIds))
const trustedDevices = deduplicateTrustedDevices([
    ...active.map(record => trustedDeviceFromRecord(record, localRoomIds)),
    ...await portableTrustedDevices(),
])
let runner: MatrixMlp3GatewayRunner | null = null
let requestWorkspaceShutdown: ((failure: Error) => void) | null = null
let workspaceControlChain = Promise.resolve()
const publishedWorkspaceState = new Map<string, string>()
let provisionedAuthorizationFingerprint = ''
let synchronizedDirectoryRevision = -1

async function performWorkspaceControlSync(): Promise<void> {
    const directory = await workspaceDirectory.load()
    if (!directory) throw new Error('Workspace Gateway directory is unavailable')
    if (!directory.directory.gateways.some(gateway =>
        gateway.gatewayNodeId === identity.gatewayNodeId)) {
        const failure = new Error(
            `Gateway node ${identity.gatewayNodeId} was removed from the Workspace`,
        )
        if (requestWorkspaceShutdown) {
            requestWorkspaceShutdown(failure)
            return
        }
        throw failure
    }
    const roomIds = workspaceDirectoryRoomIds(directory)
    const grants = await workspaceAuthorization.activeGrants()
    if (!client.ensureRoomInvitation) {
        throw new Error('Matrix transport cannot invite authorized Workspace devices')
    }
    for (const grant of grants) {
        for (const roomId of roomIds) {
            await client.ensureRoomInvitation(roomId, grant.grant.deviceTransport.userId)
        }
    }
    await publishWorkspaceState(
        roomIds,
        MLP3_MATRIX_WORKSPACE_DIRECTORY_EVENT_TYPE,
        identity.workspaceId,
        directory,
    )
    for (const grant of grants) {
        await publishWorkspaceState(
            roomIds,
            MLP3_MATRIX_WORKSPACE_DEVICE_GRANT_EVENT_TYPE,
            `${grant.grant.deviceId}.${grant.grant.certificateId}`,
            grant,
        )
    }
    for (const revocation of await workspaceAuthorization.revocations()) {
        await publishWorkspaceState(
            roomIds,
            MLP3_MATRIX_WORKSPACE_DEVICE_REVOCATION_EVENT_TYPE,
            `${revocation.revocation.deviceId}.${revocation.revocation.certificateId}`,
            revocation,
        )
    }
    const authorizationFingerprint = grants
        .map(value => `${value.grant.deviceId}:${value.grant.certificateId}`)
        .sort()
        .join('|')
    if (runner?.getState() === 'running' &&
        authorizationFingerprint !== provisionedAuthorizationFingerprint) {
        await runner.provisionCurrentState()
        provisionedAuthorizationFingerprint = authorizationFingerprint
    }
    if (runner?.getState() === 'running' &&
        directory.directory.revision !== synchronizedDirectoryRevision) {
        await runner.syncState()
        synchronizedDirectoryRevision = directory.directory.revision
    }
}

function synchronizeWorkspaceControl(
    before: () => Promise<void> = async () => undefined,
): Promise<void> {
    const operation = workspaceControlChain.then(before).then(performWorkspaceControlSync)
    workspaceControlChain = operation.catch(() => undefined)
    return operation
}

async function publishWorkspaceState(
    roomIds: readonly string[],
    eventType: string,
    stateKey: string,
    content: Record<string, unknown>,
): Promise<void> {
    if (!client.setApplicationRoomState) {
        throw new Error('Matrix transport cannot publish signed Workspace control state')
    }
    const digest = createHash('sha256').update(JSON.stringify(content)).digest('hex')
    for (const roomId of roomIds) {
        const key = `${roomId}\u0000${eventType}\u0000${stateKey}`
        if (publishedWorkspaceState.get(key) === digest) continue
        await client.setApplicationRoomState({ roomId, eventType, stateKey, content })
        publishedWorkspaceState.set(key, digest)
    }
}

const stopWorkspaceControl = client.onRoomEvent(event => {
    if (event.encrypted) return
    if (
        event.eventType === 'm.room.member'
        && localRoomIds.includes(event.roomId)
        && event.content.membership === 'join'
        && event.sender !== currentTransport.userId
    ) {
        void runner?.provisionCurrentState().catch(error => {
            process.stderr.write(`[workspace-control] project join provisioning failed: ${formatError(error)}\n`)
        })
        return
    }
    if (
        event.roomId === currentTransport.roomId
        && event.eventType === MLP3_MATRIX_GATEWAY_ENROLLMENT_REQUEST_EVENT_TYPE
    ) {
        void gatewayEnrollmentCoordinator.registerRequest(event.content)
            .then(async pending => {
                process.stdout.write(
                    `Gateway ${pending.gatewayName} requested Workspace enrollment; `
                    + `verification=${pending.verificationCode}.\n`,
                )
                await runner?.syncState()
            })
            .catch(error => {
                process.stderr.write(`[gateway-enrollment] rejected request: ${formatError(error)}\n`)
            })
        return
    }
    let merge: (() => Promise<void>) | undefined
    if (event.eventType === MLP3_MATRIX_WORKSPACE_DIRECTORY_EVENT_TYPE) {
        merge = async () => { await workspaceDirectory.merge(event.content) }
    } else if (event.eventType === MLP3_MATRIX_WORKSPACE_DEVICE_GRANT_EVENT_TYPE) {
        merge = async () => { await workspaceAuthorization.mergeGrant(event.content) }
    } else if (event.eventType === MLP3_MATRIX_WORKSPACE_DEVICE_REVOCATION_EVENT_TYPE) {
        merge = async () => { await workspaceAuthorization.mergeRevocation(event.content) }
    }
    if (!merge) return
    void synchronizeWorkspaceControl(merge).catch(error => {
        process.stderr.write(`[workspace-control] rejected update: ${formatError(error)}\n`)
    })
})
const stopPairingRecovery = listenForMatrixPairingRequests({
    client,
    service: pairingService,
    registry,
    gatewayTransport: currentTransport,
    // Only offers persisted by GatewayPairingService can be accepted, so the
    // listener can remain available for invitations created by an active PWA.
    acceptNewOffers: true,
    onProvisioned: async () => {
        if (!runner || runner.getState() !== 'running') {
            throw new Error('Gateway Room State is not ready for pairing')
        }
        await runner.provisionCurrentState()
    },
    onAccepted: async record => {
        if (record.workspaceGrant) {
            await synchronizeWorkspaceControl(async () => {
                await workspaceAuthorization.mergeGrant(record.workspaceGrant)
            })
        }
        process.stdout.write(`Device ${record.certificate.certificate.deviceName} is now active.\n`)
        process.stdout.write(
            `Gateway ready with ${(await registry.listActive()).length} trusted device(s).\n`,
        )
    },
    onRejected: error => {
        process.stderr.write(`[matrix-pairing-recovery] rejected: ${formatError(error)}\n`)
    },
})
const config: MatrixGatewayConfig = {
    gatewayId: identity.gatewayId,
    connection: {
        baseUrl: fixture.homeserver,
        accessToken: login.access_token,
        userId: login.user_id,
        deviceId: login.device_id,
        initialSyncTimeoutMs: 30_000,
    },
    crypto: cryptoConfig,
    rooms: configuredRooms,
    trustedDevices,
    replayLedgerPath: join(dataDirectory, 'gateway-replay.jsonl'),
    applicationSecurity: {
        gatewayDeviceId: identity.gatewayId,
        gatewayKeyPair: identity.serialized,
        envelopeReplayLedgerPath: join(dataDirectory, 'envelope-replay.json'),
    },
    gatewayHeartbeatIntervalMs: positiveDurationFromEnvironment(
        'MALINK_MATRIX_GATEWAY_HEARTBEAT_INTERVAL_MS',
        30_000,
    ),
}
runner = new MatrixMlp3GatewayRunner(config, {
    client,
    sessionExtensionRegistry,
    ...(privilegeExecutor ? { privilegeExecutor } : {}),
    ...(gatewayUpdateSupervisor ? { gatewayUpdateSupervisor } : {}),
    ...(deterministicE2eProvider
        ? { providerFactory: () => e2eProvider(providerName) }
        : {}),
    listTrustedDevices: async () =>
        deduplicateTrustedDevices([
            ...(await registry.listActive()).map(record =>
                trustedDeviceFromRecord(record, localRoomIds)),
            ...await portableTrustedDevices(),
        ]),
    isTrustedDeviceActive: async deviceId => {
        const local = await registry.get(deviceId)
        if (local?.workspaceGrant) return workspaceAuthorization.isActive(deviceId)
        return local?.status === 'active' || await workspaceAuthorization.isActive(deviceId)
    },
    createDeviceInvitation: async ({ requestedByDeviceId, commandId, lifetimeMs }) => {
        const created = await invitationCoordinator.create({
            source: {
                kind: 'paired-device',
                deviceId: requestedByDeviceId,
                commandId,
            },
            matrixLogin: 'disabled',
            ...(lifetimeMs === undefined ? {} : { lifetimeMs }),
        })
        process.stdout.write(
            `Device ${requestedByDeviceId} authorized a new pairing invitation.\n`,
        )
        return {
            pairingLink: created.pairingLink,
            expiresAt: created.expiresAt,
        }
    },
    createGatewayEnrollmentInvitation: async ({ requestedByDeviceId, lifetimeMs }) => {
        const now = Date.now()
        const expiresAt = now + (lifetimeMs ?? 5 * 60_000)
        const loginResult = await gatewayLoginTokenIssuer.issue({
            homeserver: currentTransport.homeserver,
            offerExpiresAt: expiresAt,
        })
        if (loginResult.status !== 'ready') {
            throw new Error(
                `The Matrix Gateway account cannot issue a one-time login token (${loginResult.status})`,
            )
        }
        const invitation = await gatewayEnrollmentCoordinator.createInvitation(
            currentTransport,
            loginResult.invitation,
            now,
            lifetimeMs,
        )
        process.stdout.write(
            `Device ${requestedByDeviceId} authorized Gateway enrollment ${invitation.enrollmentId}.\n`,
        )
        return { enrollmentLink: invitation.link, expiresAt: invitation.expiresAt }
    },
    approveGatewayEnrollment: async ({ requestedByDeviceId, enrollmentId }) => {
        const now = Date.now()
        const joinInvitation = createGatewayJoinInvitation(
            identity,
            undefined,
            now,
            GATEWAY_ENROLLMENT_APPROVAL_LIFETIME_MS,
        )
        const approved = await gatewayEnrollmentCoordinator.approve(
            enrollmentId,
            joinInvitation.link,
            now,
        )
        if (!client.setApplicationRoomState) {
            throw new Error('Matrix transport cannot publish Gateway enrollment responses')
        }
        await client.setApplicationRoomState({
            roomId: currentTransport.roomId,
            eventType: MLP3_MATRIX_GATEWAY_ENROLLMENT_RESPONSE_EVENT_TYPE,
            stateKey: enrollmentId,
            content: approved.response,
        })
        process.stdout.write(
            `Device ${requestedByDeviceId} approved Gateway ${approved.gatewayName}.\n`,
        )
        return {
            gatewayNodeId: approved.gatewayNodeId,
            gatewayName: approved.gatewayName,
        }
    },
    pendingGatewayEnrollments: () => gatewayEnrollmentCoordinator.pending(),
    workspaceGatewayDirectory: () => workspaceDirectory.load(),
    createProject: async input => {
        if (!client.ensureProjectRoom) {
            throw new Error('Matrix transport cannot create project rooms')
        }
        if (!isAbsolute(input.cwd)) {
            throw new Error('Project working directory must be an absolute path on the target Gateway')
        }
        const projectName = input.name.trim()
        if (!projectName) throw new Error('Project name is required')
        const projectCwd = resolve(input.cwd)
        const identityForProject = gatewayProjectIdentity(
            projectCwd,
            projectName,
            identity.gatewayNodeId,
        )
        const catalogProjects = await projectCatalog.list()
        const existing = catalogProjects.find(project =>
            resolve(project.cwd) === projectCwd)
            ?? await projectCatalog.findByProjectId(identityForProject.id)
        if (existing) {
            return {
                room: existing,
                gatewayNodeId: identity.gatewayNodeId,
                alreadyExisted: true,
            }
        }
        if (catalogProjects.length >= 256) {
            throw new Error('This Gateway already has the maximum of 256 projects')
        }
        try {
            const details = await stat(projectCwd)
            if (!details.isDirectory()) {
                throw new Error(`Project working directory is not a directory: ${projectCwd}`)
            }
        } catch (error) {
            if (!isMissingFile(error)) throw error
            if (input.createDirectory === false) {
                throw new Error(`Project working directory does not exist: ${projectCwd}`)
            }
            await mkdir(projectCwd, { recursive: true, mode: 0o700 })
        }
        const selectedProvider = input.provider ?? input.sourceRoom.providerName
        if (!getProvider(selectedProvider)) {
            throw new Error(`Provider ${selectedProvider} is not configured on this Gateway`)
        }
        const inviteUserIds = (await workspaceAuthorization.activeGrants())
            .map(grant => grant.grant.deviceTransport.userId)
        const roomResult = await client.ensureProjectRoom({
            aliasLocalpart: projectRoomAliasLocalpart(
                identity.workspaceId,
                identity.gatewayNodeId,
                identityForProject.id,
            ),
            name: 'Malink project',
            inviteUserIds,
            marker: {
                kind: 'malink.project.provisioning',
                version: 1,
                workspaceId: identity.workspaceId,
                gatewayNodeId: identity.gatewayNodeId,
                projectId: identityForProject.id,
            },
        })
        const room = await projectCatalog.add({
            roomId: roomResult.roomId,
            conversationId: roomResult.roomId,
            projectId: identityForProject.id,
            projectName,
            cwd: projectCwd,
            providerName: selectedProvider,
        })
        localRoomIds.splice(0, localRoomIds.length, ...(
            await projectCatalog.list()
        ).map(project => project.roomId))
        process.stdout.write(
            `Device ${input.requestedByDeviceId} created project ${projectName} on this Gateway.\n`,
        )
        return {
            room,
            gatewayNodeId: identity.gatewayNodeId,
            alreadyExisted: roomResult.alreadyExisted,
        }
    },
    onProjectCreated: async () => {
        await synchronizeWorkspaceControl(publishLocalWorkspaceDirectory)
    },
    onRejected: (event, error) => {
        process.stderr.write(
            `[matrix-gateway] rejected ${event.eventId}: ${formatError(error)}\n`,
        )
    },
    ...(deterministicE2eProvider
        ? { onLog: (message: string) => process.stderr.write(`${message}\n`) }
        : {}),
})

await runner.start()
await synchronizeWorkspaceControl()
const workspaceControlTimer = setInterval(() => {
    void synchronizeWorkspaceControl().catch(error => {
        process.stderr.write(`[workspace-control] synchronization failed: ${formatError(error)}\n`)
    })
}, config.gatewayHeartbeatIntervalMs ?? 30_000)
const adminServer = await startGatewayAdminServer({
    socketPath: adminSocketPath,
    gatewayId: identity.gatewayId,
    gatewayNodeId: identity.gatewayNodeId,
    getGatewayName: () => gatewayProfile.gatewayName,
    renameGateway: async gatewayName => {
        gatewayProfile = await gatewayProfileStore.rename(gatewayName)
        await synchronizeWorkspaceControl(publishLocalWorkspaceDirectory)
    },
    coordinator: invitationCoordinator,
    pairingService,
    registry,
    getGatewayState: () => runner?.getState() ?? 'starting',
    buildId: gatewayBuildId,
    getGatewayDiagnostics: () => runner!.healthSnapshot(),
    syncGatewayState: async () => {
        await runner?.syncState()
    },
    onDeviceRevoked: async (deviceId, reason, revokedAt) => {
        const record = await registry.get(deviceId)
        const certificateId = record?.workspaceGrant?.grant.certificateId
            ?? record?.certificate.certificate.certificateId
        if (!certificateId) throw new Error(`Device ${deviceId} has no portable authorization`)
        if (await workspaceAuthorization.findRevocation(deviceId, certificateId)) return
        const issuedAt = await registry.reserveGatewayIssuedAt(revokedAt)
        const signed = await signWorkspaceDeviceRevocation({
            kind: 'malink.workspace.device-revocation',
            version: 1,
            revocationId: randomUUID(),
            workspaceId: identity.workspaceId,
            deviceId,
            certificateId,
            ...(reason ? { reason } : {}),
            issuedAt,
        }, identity.keys.privateKey, identity.keys.keyId)
        await synchronizeWorkspaceControl(async () => {
            await workspaceAuthorization.mergeRevocation(signed)
        })
    },
    receiveWorkspaceFile: async input => {
        if (!runner) throw new Error('Gateway runtime is unavailable')
        return runner.receiveWorkspaceFile(input)
    },
    sendSessionFile: async ({ sessionId, ...input }) => {
        if (!runner) throw new Error('Gateway runtime is unavailable')
        return runner.sendSessionFile(sessionId, input)
    },
    publishNativeClientRelease: async release => {
        if (!runner) throw new Error('Gateway runtime is unavailable')
        return runner.publishNativeClientRelease(release)
    },
    ...(privilegeExecutor
        ? {
            onPrivilegedExecution: async ({ sessionId, ...request }) =>
                await runner!.requestPrivilegedExecution(sessionId, request),
        }
        : {}),
    onLog: message => process.stdout.write(`${message}\n`),
})
process.stdout.write(`Gateway ready with ${trustedDevices.length} trusted device(s).\n`)
process.stdout.write(
    `Gateway node: ${gatewayProfile.gatewayName} · ${gatewayNodeShortId(identity.gatewayNodeId)}\n`,
)
if (startupPairing) {
    process.stdout.write('\nPair this Gateway from Malink:\n\n')
    process.stdout.write(await QRCode.toString(startupPairing.link, {
        type: 'terminal',
        small: true,
        errorCorrectionLevel: 'L',
    }))
    process.stdout.write(`\nInvitation code: ${formatCode(startupPairing.verificationCode)}\n`)
    process.stdout.write(`Pairing link (paste fallback):\n${startupPairing.link}\n\n`)
    process.stdout.write(
        `Waiting for one encrypted pairing request until ${startupPairing.expiresAt}. `
        + 'Gateway will commit current Room State before accepting it.\n',
    )
}
process.stdout.write(`Provider: ${providerName}\nWorking directory: ${cwd}\n`)
if (sessionExtensionRegistry.descriptors().length > 0) {
    process.stdout.write(
        `Session extensions: ${sessionExtensionRegistry.descriptors().map(item => item.name).join(', ')}\n`,
    )
}
process.stdout.write(`Gateway admin socket: ${adminServer.socketPath}\n`)
process.stdout.write('Press Ctrl+C to stop the Gateway.\n')

const syncStallTimeoutMs = positiveDurationFromEnvironment(
    'MALINK_MATRIX_SYNC_STALL_TIMEOUT_MS',
    120_000,
)
const shutdownTimeoutMs = positiveDurationFromEnvironment(
    'MALINK_MATRIX_SHUTDOWN_TIMEOUT_MS',
    10_000,
)
let requestStop: (failure?: Error) => void = () => undefined
let stopping = false
const stopped = new Promise<{ failure: Error | null; forced: boolean }>(resolve => {
    requestStop = (failure?: Error): void => {
        if (stopping) return
        stopping = true
        clearInterval(workspaceControlTimer)
        const shutdown = adminServer.stop()
            .catch(error => {
                process.stderr.write(
                    `[gateway-admin] shutdown failed: ${formatError(error)}\n`,
                )
            })
            .then(() => runner!.stop())
            .catch(error => {
                process.stderr.write(
                    `[matrix-gateway] shutdown failed: ${formatError(error)}\n`,
                )
            })
        void completeWithin(shutdown, shutdownTimeoutMs).then(completed => {
            if (!completed) {
                process.stderr.write(
                    `[matrix-gateway] shutdown exceeded ${shutdownTimeoutMs}ms; forcing exit.\n`,
                )
            }
            resolve({ failure: failure ?? null, forced: !completed })
        })
    }
    process.once('SIGINT', () => requestStop())
    process.once('SIGTERM', () => requestStop())
})
requestWorkspaceShutdown = requestStop
let stopSyncWatchdog = (): void => undefined
const armSyncWatchdog = (): void => {
    stopSyncWatchdog = client.watchSyncHealth({
        stallTimeoutMs: syncStallTimeoutMs,
    }, error => {
        process.stderr.write(
            `[matrix-gateway] ${error.message}; restarting Matrix sync in place.\n`,
        )
        void (async () => {
            try {
                await client.restartSync()
            } catch (restartError) {
                const failure = restartError instanceof Error
                    ? restartError
                    : new Error(formatError(restartError))
                process.stderr.write(
                    `[matrix-gateway] Matrix sync restart failed: ${failure.message}\n`,
                )
                requestStop(failure)
                return
            }
            if (stopping) return
            process.stderr.write('[matrix-gateway] Matrix sync restarted in place.\n')
            try {
                await runner!.syncState()
            } catch (stateError) {
                process.stderr.write(
                    `[matrix-gateway] post-restart Room State sync failed: ${formatError(stateError)}\n`,
                )
            }
            if (!stopping) armSyncWatchdog()
        })()
    })
}
armSyncWatchdog()
const stopResult = await stopped
stopSyncWatchdog()
stopPairingRecovery()
stopWorkspaceControl()
const exitCode = stopResult.failure ? 1 : 0
if (stopResult.forced) process.exit(exitCode)
if (stopResult.failure) process.exitCode = exitCode

async function readJson<T>(path: string): Promise<T> {
    try {
        const text = (await readFile(path, 'utf8')).replace(/^\uFEFF/u, '')
        return JSON.parse(text) as T
    } catch (error) {
        throw new Error(`Could not read ${path}: ${formatError(error)}`)
    }
}

async function currentGatewayBuildId(): Promise<string> {
    const manifestPath = join(
        dirname(fileURLToPath(import.meta.url)),
        '..',
        'release-manifest.json',
    )
    try {
        const value = JSON.parse(await readFile(manifestPath, 'utf8')) as {
            manifest?: { buildId?: unknown }
        }
        if (typeof value.manifest?.buildId !== 'string' || !value.manifest.buildId) {
            throw new Error('Gateway release manifest has no build ID')
        }
        return value.manifest.buildId
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return process.env.MALINK_GATEWAY_BUILD_ID?.trim() || 'development'
        }
        throw error
    }
}

function workspaceDirectoryRoomIds(directory: SignedWorkspaceGatewayDirectory): string[] {
    const rooms = new Set<string>([fixture.roomId])
    for (const gateway of directory.directory.gateways) {
        for (const project of gateway.projects ?? []) rooms.add(project.roomId)
    }
    return [...rooms]
}

function deduplicateTrustedDevices(
    devices: readonly MatrixGatewayTrustedDevice[],
): MatrixGatewayTrustedDevice[] {
    const result = new Map<string, MatrixGatewayTrustedDevice>()
    for (const device of devices) result.set(device.deviceId, device)
    return [...result.values()]
}

function positiveDurationFromEnvironment(name: string, fallbackMs: number): number {
    const raw = process.env[name]
    if (raw === undefined) return fallbackMs
    const value = Number(raw)
    if (!Number.isFinite(value) || value <= 0) {
        throw new Error(`${name} must be a positive duration in milliseconds`)
    }
    return value
}

async function completeWithin(operation: Promise<unknown>, timeoutMs: number): Promise<boolean> {
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
        return await Promise.race([
            operation.then(() => true),
            new Promise<boolean>(resolve => {
                timeout = setTimeout(() => resolve(false), timeoutMs)
            }),
        ])
    } finally {
        if (timeout) clearTimeout(timeout)
    }
}

async function readPasswordFile(path: string | undefined): Promise<string | undefined> {
    if (!path) return undefined
    const password = (await readFile(path, 'utf8')).trim()
    if (!password) throw new Error(`Matrix Gateway password file is empty: ${path}`)
    return password
}

function assertAllowedHomeserver(homeserver: string): void {
    const url = new URL(homeserver)
    if (isLoopbackHomeserver(homeserver)) return
    if (url.protocol !== 'https:') {
        throw new Error('A non-local Matrix homeserver must use HTTPS')
    }
}

function parseE2eStartupPairingOperations(
    serialized: string | undefined,
    deterministicE2eProvider: boolean,
): PairingOperation[] | undefined {
    if (serialized === undefined) return undefined
    if (!deterministicE2eProvider) {
        throw new Error(
            'MALINK_MATRIX_E2E_STARTUP_PAIRING_OPERATIONS requires the loopback-only E2E provider',
        )
    }
    const candidate: unknown = JSON.parse(serialized)
    if (!Array.isArray(candidate) || candidate.length === 0) {
        throw new Error('E2E startup pairing operations must be a non-empty JSON array')
    }
    const operations = candidate.map(operation => pairingOperationSchema.parse(operation))
    if (new Set(operations).size !== operations.length) {
        throw new Error('E2E startup pairing operations must be unique')
    }
    return operations
}

function isLoopbackHomeserver(homeserver: string): boolean {
    const url = new URL(homeserver)
    return url.protocol === 'http:'
        && (url.hostname === 'localhost' || url.hostname === '127.0.0.1')
}

function formatCode(code: string): string {
    return code.replace(/(\d{3})(\d{3})/u, '$1 $2')
}

function projectRoomAliasLocalpart(
    workspaceId: string,
    gatewayNodeId: string,
    projectId: string,
): string {
    const digest = createHash('sha256')
        .update(`malink-project-room\0${workspaceId}\0${gatewayNodeId}\0${projectId}`)
        .digest('hex')
        .slice(0, 40)
    return `malink-project-${digest}`
}

function isMissingFile(error: unknown): boolean {
    return !!error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'
}

function formatError(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}

function e2eProvider(name: string): AgentProvider {
    const delayMs = Number.parseInt(
        process.env.MALINK_MATRIX_E2E_PROVIDER_DELAY_MS ?? '0',
        10,
    )
    if (!Number.isSafeInteger(delayMs) || delayMs < 0 || delayMs > 300_000) {
        throw new Error('MALINK_MATRIX_E2E_PROVIDER_DELAY_MS must be between 0 and 300000')
    }
    return {
        name,
        startQuery(input): AgentQueryHandle {
            const prompt = providerInputText(input)
            process.stdout.write(
                `[e2e-provider] invocation sha256=${createHash('sha256').update(prompt).digest('hex')}\n`,
            )
            return {
                events: (async function* () {
                    if (delayMs > 0) {
                        await new Promise(resolve => setTimeout(resolve, delayMs))
                    }
                    yield {
                        kind: 'text' as const,
                        text: await deterministicE2eResponse(input),
                    }
                    yield {
                        kind: 'text' as const,
                        text: `\n\nAgent received exactly: ${prompt}`,
                    }
                    yield { kind: 'result' as const, status: 'success' as const }
                })(),
                async interrupt() {},
            }
        },
        isReady: () => true,
        getInitError: () => null,
        getAvailableModels: () => [{
            id: 'malink-e2e-model',
            name: 'Malink E2E Model',
            defaultReasoningLevel: 'high',
            supportedReasoningLevels: [
                { effort: 'medium', description: 'Deterministic medium reasoning' },
                { effort: 'high', description: 'Deterministic high reasoning' },
            ],
        }],
        getAvailablePermissionModes: () => ['default'],
    }
}

function providerInputText(input: Parameters<AgentProvider['startQuery']>[0]): string {
    return typeof input === 'string'
        ? input
        : input.parts.map(part => part.type === 'text' ? part.text : '').join('\n')
}

async function deterministicE2eResponse(input: AgentQueryInput): Promise<string> {
    const prompt = providerInputText(input)
    const largeResponse = prompt.match(/MALINK_E2E_LARGE_RESPONSE:([A-Z0-9-]+)/u)?.[1]
    if (largeResponse) {
        const lines = Array.from({ length: 640 }, (_, index) =>
            `large-output-${largeResponse}-${index.toString().padStart(4, '0')}-` +
            '持久化分页恢复必须完整且可重复验证',
        )
        return [
            `MALINK-E2E-LARGE-BEGIN-${largeResponse}`,
            ...lines,
            `MALINK-E2E-LARGE-END-${largeResponse}`,
        ].join('\n')
    }
    if (typeof input === 'string') return 'Malink deterministic E2E response'
    const attachmentMarkerPattern = /MALINK_E2E_ATTACHMENT_MARKER:([A-Z0-9-]+)/u
    const fileReferencePattern = /^- ([^:\n]+): (.+) \(([^,\n]+), (\d+) bytes\)$/gmu
    const attachments: Array<{
        label: string
        bytes: Buffer
        expectedBytes?: number
    }> = []
    for (const part of input.parts) {
        if (part.type === 'text') {
            for (const match of part.text.matchAll(fileReferencePattern)) {
                const [, filename, path, , size] = match
                if (!filename || !path || !size) continue
                attachments.push({
                    label: filename,
                    bytes: await readFile(path),
                    expectedBytes: Number.parseInt(size, 10),
                })
            }
            continue
        }
        if (part.type === 'file') {
            attachments.push({
                label: part.filename,
                bytes: await readFile(part.path),
                expectedBytes: part.sizeBytes,
            })
            continue
        }
        attachments.push({
            label: part.filename ?? part.type,
            bytes: Buffer.from(part.data, 'base64'),
            expectedBytes: part.sizeBytes,
        })
    }
    if (attachments.length === 0) return 'Malink deterministic E2E response'

    const markers: string[] = []
    for (const attachment of attachments) {
        if (
            attachment.expectedBytes !== undefined
            && attachment.bytes.byteLength !== attachment.expectedBytes
        ) {
            throw new Error(
                `E2E Agent received the wrong byte count for ${attachment.label}`,
            )
        }
        const marker = attachment.bytes.toString('utf8').match(attachmentMarkerPattern)?.[1]
        if (!marker) {
            throw new Error(
                `E2E Agent could not read the attachment marker from ${attachment.label}`,
            )
        }
        markers.push(marker)
    }
    return `Malink deterministic E2E attachment result: ${markers.join(', ')}`
}
