import type { PairingOperation } from '@malink/protocol'
import type { SerializedDeviceKeyPair } from '@malink/security'

export type MatrixGatewayCryptoConfig =
    | {
        backend: 'indexeddb'
        databasePrefix: string
        storageKey?: Uint8Array
        storagePassword?: string
    }
    | {
        backend: 'node-sqlite'
        /** Directory containing the durable Matrix Olm/Megolm SQLite store. */
        storagePath: string
        /** Passphrase used by the Rust SDK to encrypt the store at rest. */
        storagePassword?: string
        /** Durable /sync cursor committed only after a sync is fully processed. */
        syncTokenPath: string
    }
    | {
        backend: 'memory'
        databasePrefix: string
        allowInMemoryForTesting: true
    }

export interface MatrixGatewayConnectionConfig {
    baseUrl: string
    accessToken: string
    userId: string
    deviceId: string
    initialSyncTimeoutMs?: number
    /** Total retry budget for one Matrix request before durable callers take over. */
    requestRetryBudgetMs?: number
}

export interface MatrixGatewayRoomConfig {
    roomId: string
    /** Stable Malink conversation binding, distinct from an ACP session ID. */
    conversationId: string
    /** Explicit identity for dynamically provisioned projects. */
    projectId?: string
    /** User-facing name retained independently from the working-directory basename. */
    projectName?: string
    cwd: string
    providerName: string
    model?: string
    verboseLevel?: 0 | 1 | 2
    timeoutSeconds?: number
    providerSettings?: Record<string, unknown>
}

export interface MatrixGatewayPinnedTransportDevice {
    matrixUserId: string
    matrixDeviceId: string
    matrixDeviceKeys: string[]
}

export interface MatrixGatewayTrustedDevice extends MatrixGatewayPinnedTransportDevice {
    /** Malink application-layer device ID carried inside the signed command. */
    deviceId: string
    deviceName?: string
    publicKey: JsonWebKey
    allowedRoomIds: string[]
    allowedOperations?: PairingOperation[]
    /**
     * Raw Ed25519 fingerprints returned by
     * MatrixEvent.getClaimedEd25519Key() after E2EE decryption. These are not
     * Matrix device IDs and not Curve25519 sender keys.
     */
    certificateExpiresAt: number
    /** Pairing-certificate generation used to reset ordered command state. */
    sequenceEpoch: string
}

export interface MatrixGatewayApplicationSecurityConfig {
    gatewayDeviceId: string
    gatewayKeyPair: SerializedDeviceKeyPair
    envelopeReplayLedgerPath: string
    /** Timeout for one recipient attempt; durable retry continues afterward. */
    deliveryAttemptTimeoutMs?: number
}

export interface MatrixGatewayConfig {
    /** Shared MLP Workspace trust-domain ID. */
    gatewayId: string
    /** Stable identity of this exact Gateway computer inside the Workspace. */
    gatewayNodeId: string
    connection: MatrixGatewayConnectionConfig
    crypto: MatrixGatewayCryptoConfig
    rooms: MatrixGatewayRoomConfig[]
    trustedDevices: MatrixGatewayTrustedDevice[]
    replayLedgerPath: string
    applicationSecurity: MatrixGatewayApplicationSecurityConfig
    startupEventQueueLimit?: number
    /** Deadline for control commands; Agent turns use each room's timeoutSeconds. */
    commandExecutionTimeoutMs?: number
    /** Publishes one shared signed node heartbeat; defaults to 60 seconds. */
    gatewayHeartbeatIntervalMs?: number
    webPush?: {
        /** Contact URI included in VAPID JWTs. Defaults to Malink's notification address. */
        subject?: string
        /** Durable VAPID keys, subscriptions and delivery outbox. */
        statePath?: string
    }
}

export function validateMatrixGatewayConfig(config: MatrixGatewayConfig): void {
    requireText(config.gatewayId, 'gatewayId')
    requireText(config.gatewayNodeId, 'gatewayNodeId')
    requireText(config.connection.baseUrl, 'connection.baseUrl')
    requireText(config.connection.accessToken, 'connection.accessToken')
    requireText(config.connection.userId, 'connection.userId')
    requireText(config.connection.deviceId, 'connection.deviceId')
    if (
        config.connection.requestRetryBudgetMs !== undefined
        && (
            !Number.isFinite(config.connection.requestRetryBudgetMs)
            || config.connection.requestRetryBudgetMs < 1_000
            || config.connection.requestRetryBudgetMs > 10 * 60_000
        )
    ) {
        throw new Error('connection.requestRetryBudgetMs must be between 1000 and 600000')
    }
    if (config.crypto.backend === 'node-sqlite') {
        requireText(config.crypto.storagePath, 'crypto.storagePath')
        requireText(config.crypto.syncTokenPath, 'crypto.syncTokenPath')
    } else {
        requireText(config.crypto.databasePrefix, 'crypto.databasePrefix')
    }
    if (
        config.crypto.backend === 'memory'
        && config.crypto.allowInMemoryForTesting !== true
    ) {
        throw new Error('In-memory Matrix crypto is forbidden unless explicitly enabled for tests')
    }
    requireText(config.replayLedgerPath, 'replayLedgerPath')
    if (!config.applicationSecurity) {
        throw new Error('Application-layer Matrix security is required')
    }
    requireText(config.applicationSecurity.gatewayDeviceId, 'applicationSecurity.gatewayDeviceId')
    requireText(config.applicationSecurity.envelopeReplayLedgerPath, 'applicationSecurity.envelopeReplayLedgerPath')
    if (
        config.applicationSecurity.deliveryAttemptTimeoutMs !== undefined
        && (
            !Number.isFinite(config.applicationSecurity.deliveryAttemptTimeoutMs)
            || config.applicationSecurity.deliveryAttemptTimeoutMs <= 0
        )
    ) {
        throw new Error('applicationSecurity.deliveryAttemptTimeoutMs must be positive')
    }
    if (config.applicationSecurity.gatewayDeviceId !== config.gatewayId) {
        throw new Error('applicationSecurity.gatewayDeviceId must equal gatewayId')
    }

    if (
        config.crypto.backend === 'indexeddb'
        && config.crypto.storageKey
        && config.crypto.storageKey.byteLength !== 32
    ) {
        throw new Error('Matrix crypto storageKey must be exactly 32 bytes')
    }
    if (config.rooms.length === 0) throw new Error('At least one Matrix room is required')

    assertUnique(config.rooms.map(room => room.roomId), 'room ID')
    assertUnique(config.rooms.map(room => room.conversationId), 'conversation ID')
    assertUnique(config.trustedDevices.map(device => device.deviceId), 'trusted device ID')
    assertUnique(
        config.trustedDevices.map(device => applicationPublicKeyFingerprint(device.publicKey)),
        'trusted application public key',
    )

    const roomIds = new Set(config.rooms.map(room => room.roomId))
    for (const room of config.rooms) {
        requireText(room.roomId, 'room.roomId')
        requireText(room.conversationId, 'room.conversationId')
        if (room.projectId !== undefined) requireText(room.projectId, 'room.projectId')
        if (room.projectName !== undefined) requireText(room.projectName, 'room.projectName')
        requireText(room.cwd, 'room.cwd')
        requireText(room.providerName, 'room.providerName')
        if (
            room.timeoutSeconds !== undefined
            && (
                !Number.isFinite(room.timeoutSeconds)
                || room.timeoutSeconds < 1
                || room.timeoutSeconds > 24 * 60 * 60
            )
        ) {
            throw new Error('room.timeoutSeconds must be between 1 and 86400')
        }
    }
    for (const device of config.trustedDevices) {
        requireText(device.deviceId, 'trustedDevice.deviceId')
        requireText(device.matrixUserId, 'trustedDevice.matrixUserId')
        if (device.matrixDeviceId !== undefined) {
            requireText(device.matrixDeviceId, 'trustedDevice.matrixDeviceId')
        }
        if (device.matrixDeviceKeys.length === 0) {
            throw new Error(`Trusted device ${device.deviceId} must pin at least one Matrix device key`)
        }
        if (
            device.certificateExpiresAt !== undefined
            && (!Number.isSafeInteger(device.certificateExpiresAt) || device.certificateExpiresAt < 0)
        ) {
            throw new Error(`Trusted device ${device.deviceId} has an invalid certificate expiry`)
        }
        requireText(device.sequenceEpoch, 'trustedDevice.sequenceEpoch')
        if (device.certificateExpiresAt === undefined) {
            throw new Error(`Trusted device ${device.deviceId} requires certificateExpiresAt for application security`)
        }
        for (const roomId of device.allowedRoomIds) {
            if (!roomIds.has(roomId)) {
                throw new Error(`Trusted device ${device.deviceId} references unknown room ${roomId}`)
            }
        }
    }

    if (config.startupEventQueueLimit !== undefined && config.startupEventQueueLimit < 1) {
        throw new Error('startupEventQueueLimit must be at least 1')
    }
    if (
        config.commandExecutionTimeoutMs !== undefined
        && (
            !Number.isFinite(config.commandExecutionTimeoutMs)
            || config.commandExecutionTimeoutMs < 1_000
            || config.commandExecutionTimeoutMs > 60 * 60_000
        )
    ) {
        throw new Error('commandExecutionTimeoutMs must be between 1000 and 3600000')
    }
    if (
        config.gatewayHeartbeatIntervalMs !== undefined
        && (
            !Number.isFinite(config.gatewayHeartbeatIntervalMs)
            || config.gatewayHeartbeatIntervalMs <= 0
        )
    ) {
        throw new Error('gatewayHeartbeatIntervalMs must be positive')
    }
    if (config.webPush?.statePath !== undefined) {
        requireText(config.webPush.statePath, 'webPush.statePath')
    }
    if (
        config.webPush?.subject !== undefined
        && !/^(?:mailto:|https:)/u.test(config.webPush.subject)
    ) {
        throw new Error('webPush.subject must be a mailto: or https: URI')
    }
}

function requireText(value: unknown, name: string): asserts value is string {
    if (typeof value !== 'string' || !value.trim()) {
        throw new Error(`${name} must not be empty`)
    }
}

function assertUnique(values: string[], label: string): void {
    const seen = new Set<string>()
    for (const value of values) {
        if (seen.has(value)) throw new Error(`Duplicate ${label}: ${value}`)
        seen.add(value)
    }
}

function applicationPublicKeyFingerprint(key: JsonWebKey): string {
    if (key.kty !== 'EC' || key.crv !== 'P-256' || !key.x || !key.y) {
        throw new Error('Trusted application public key must be a P-256 public JWK')
    }
    return JSON.stringify([key.kty, key.crv, key.x, key.y])
}
