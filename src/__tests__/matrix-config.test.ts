import { describe, expect, it } from 'vitest'
import {
    validateMatrixGatewayConfig,
    type MatrixGatewayConfig,
} from '@/gateway/matrix/config'

describe('Matrix gateway configuration', () => {
    it('requires one physical Gateway node identity', () => {
        const config = fixture()
        Reflect.deleteProperty(config, 'gatewayNodeId')

        expect(() => validateMatrixGatewayConfig(config)).toThrow(
            'gatewayNodeId must not be empty',
        )
    })

    it('requires application-layer security', () => {
        const config = fixture()
        Reflect.deleteProperty(config, 'applicationSecurity')

        expect(() => validateMatrixGatewayConfig(config)).toThrow(
            'Application-layer Matrix security is required',
        )
    })

    it('forbids accidental in-memory production crypto', () => {
        const config = fixture()
        config.crypto = {
            backend: 'memory',
            databasePrefix: 'malink-test',
            allowInMemoryForTesting: false,
        } as unknown as MatrixGatewayConfig['crypto']

        expect(() => validateMatrixGatewayConfig(config)).toThrow(
            'In-memory Matrix crypto is forbidden',
        )
    })

    it('rejects two application device IDs backed by the same public key', () => {
        const config = fixture()
        config.trustedDevices.push({
            ...structuredClone(config.trustedDevices[0]!),
            deviceId: 'pwa-device-2',
            matrixDeviceId: 'PWA2',
            matrixDeviceKeys: ['matrix-ed25519-key-2'],
        })

        expect(() => validateMatrixGatewayConfig(config)).toThrow(
            'Duplicate trusted application public key',
        )
    })

    it('bounds control command execution timeouts', () => {
        const tooShort = fixture()
        tooShort.commandExecutionTimeoutMs = 999
        expect(() => validateMatrixGatewayConfig(tooShort)).toThrow(
            'commandExecutionTimeoutMs must be between 1000 and 3600000',
        )

        const valid = fixture()
        valid.commandExecutionTimeoutMs = 1_000
        expect(() => validateMatrixGatewayConfig(valid)).not.toThrow()
    })

    it('bounds Agent-driven Gateway update execution timeouts independently', () => {
        const tooShort = fixture()
        tooShort.gatewayUpdateExecutionTimeoutMs = 999
        expect(() => validateMatrixGatewayConfig(tooShort)).toThrow(
            'gatewayUpdateExecutionTimeoutMs must be between 1000 and 86400000',
        )

        const valid = fixture()
        valid.gatewayUpdateExecutionTimeoutMs = 2 * 60 * 60_000
        expect(() => validateMatrixGatewayConfig(valid)).not.toThrow()
    })

    it('requires a positive Workspace control repair cadence', () => {
        const invalid = fixture()
        invalid.workspaceControlIntervalMs = 0
        expect(() => validateMatrixGatewayConfig(invalid)).toThrow(
            'workspaceControlIntervalMs must be positive',
        )

        const valid = fixture()
        valid.workspaceControlIntervalMs = 60_000
        expect(() => validateMatrixGatewayConfig(valid)).not.toThrow()
    })

    it('bounds the Matrix request retry budget', () => {
        const invalid = fixture()
        invalid.connection.requestRetryBudgetMs = 999
        expect(() => validateMatrixGatewayConfig(invalid)).toThrow(
            'connection.requestRetryBudgetMs must be between 1000 and 600000',
        )
    })

    it('bounds the compatible provider timeout setting', () => {
        const invalid = fixture()
        invalid.rooms[0]!.timeoutSeconds = 0
        expect(() => validateMatrixGatewayConfig(invalid)).toThrow(
            'room.timeoutSeconds must be between 1 and 86400',
        )
    })
})

function fixture(): MatrixGatewayConfig {
    return {
        gatewayId: 'gateway-1',
        gatewayNodeId: 'gateway-node-1',
        connection: {
            baseUrl: 'https://matrix.example.org',
            accessToken: 'secret-token',
            userId: '@gateway:example.org',
            deviceId: 'GATEWAY1',
        },
        crypto: {
            backend: 'memory',
            databasePrefix: 'malink-test',
            allowInMemoryForTesting: true,
        },
        rooms: [{
            roomId: '!room:example.org',
            conversationId: 'conversation-1',
            cwd: '/workspace',
            providerName: 'mock-provider',
        }],
        trustedDevices: [{
            deviceId: 'pwa-device-1',
            publicKey: {
                kty: 'EC',
                crv: 'P-256',
                x: 'test-x',
                y: 'test-y',
            },
            allowedRoomIds: ['!room:example.org'],
            allowedOperations: ['prompt'],
            matrixUserId: '@alice:example.org',
            matrixDeviceId: 'PWA1',
            matrixDeviceKeys: ['matrix-ed25519-key'],
            certificateExpiresAt: Date.now() + 60_000,
            sequenceEpoch: 'certificate-pwa-1',
        }],
        replayLedgerPath: '/state/gateway-replay.jsonl',
        applicationSecurity: {
            gatewayDeviceId: 'gateway-1',
            gatewayKeyPair: {
                version: 1,
                algorithm: 'ES256',
                keyId: 'gateway-key',
                publicKey: {
                    kty: 'EC',
                    crv: 'P-256',
                    x: 'gateway-x',
                    y: 'gateway-y',
                },
                privateKey: {
                    kty: 'EC',
                    crv: 'P-256',
                    x: 'gateway-x',
                    y: 'gateway-y',
                    d: 'gateway-d',
                },
            },
            envelopeReplayLedgerPath: '/state/envelope-replay.json',
        },
    }
}
