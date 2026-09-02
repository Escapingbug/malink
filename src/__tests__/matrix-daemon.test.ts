import { describe, expect, it, vi } from 'vitest'
import {
    ClientEvent,
    MatrixScheduler,
    SyncState,
    type MatrixClient,
    type MatrixEvent,
} from 'matrix-js-sdk'
import {
    MALINK_MATRIX_GATEWAY_STATE_EVENT_TYPE,
    MALINK_MATRIX_SESSION_DIRECTORY_EVENT_TYPE,
    MALINK_MATRIX_SESSION_STATE_EVENT_TYPE,
} from '@malink/protocol'
import {
    MALINK_MATRIX_EXTENSION,
    type MatrixIncomingEvent,
} from '@/channel/matrix'
import {
    createGatewayMatrixScheduler,
    MatrixJsSdkGatewayClient,
    watchMatrixSyncHealth,
} from '@/gateway/matrix'

describe('MatrixJsSdkGatewayClient', () => {
    it('invites an authorized Workspace device only when it is not already present', async () => {
        const invite = vi.fn(async () => ({}))
        const sdk = {
            getRoom: vi.fn(() => ({
                getMember: (userId: string) => userId === '@joined:example.org'
                    ? { membership: 'join' }
                    : null,
            })),
            invite,
        } as unknown as MatrixClient
        const client = new MatrixJsSdkGatewayClient(sdk)

        await client.ensureRoomInvitation('!room:example.org', '@joined:example.org')
        await client.ensureRoomInvitation('!room:example.org', '@new:example.org')

        expect(invite).toHaveBeenCalledOnce()
        expect(invite).toHaveBeenCalledWith('!room:example.org', '@new:example.org')
    })

    it('redacts a complete thread and tolerates retiring a room missing from the SDK cache', async () => {
        const relation = (eventId: string) => ({ getId: () => eventId } as unknown as MatrixEvent)
        const relations = vi.fn()
            .mockResolvedValueOnce({ events: [relation('$reply-2')], nextBatch: 'next' })
            .mockResolvedValueOnce({ events: [relation('$reply-1')], nextBatch: null })
        const redactEvent = vi.fn(async (
            _roomId: string,
            _eventId: string,
            _transactionId: string,
            _options: unknown,
        ) => ({}))
        const leave = vi.fn(async () => {
            throw { errcode: 'M_FORBIDDEN' }
        })
        const forget = vi.fn(async () => ({}))
        const sdk = {
            relations,
            redactEvent,
            getUserId: vi.fn(() => '@gateway:example.org'),
            getRoom: vi.fn(() => undefined),
            leave,
            forget,
        } as unknown as MatrixClient
        const client = new MatrixJsSdkGatewayClient(sdk)

        await client.deleteRoomThread('!room:example.org', '$root')
        await client.retireRoom('!room:example.org')

        expect(relations).toHaveBeenCalledTimes(2)
        expect(redactEvent.mock.calls.map(call => call.slice(0, 2))).toEqual([
            ['!room:example.org', '$reply-2'],
            ['!room:example.org', '$reply-1'],
            ['!room:example.org', '$root'],
        ])
        expect(redactEvent.mock.calls.every(call =>
            String(call[2]).startsWith('malink.retire.')
        )).toBe(true)
        expect(leave).toHaveBeenCalledWith('!room:example.org')
        expect(forget).toHaveBeenCalledWith('!room:example.org', true)
    })

    it('leaves delivery ordering to the durable Malink scheduler instead of the SDK message FIFO', () => {
        const message = {
            getType: () => 'm.room.message',
            hasAssociation: () => false,
        } as unknown as MatrixEvent

        expect(MatrixScheduler.QUEUE_MESSAGES(message)).toBe('message')
        expect(createGatewayMatrixScheduler().queueAlgorithm(message)).toBeNull()
    })

    it('rehydrates a persisted thread root that was omitted from initial sync', async () => {
        const rootEvent = { getId: () => '$persisted-root' } as unknown as MatrixEvent
        const createThread = vi.fn()
        const room = {
            findEventById: vi.fn(() => undefined),
            getThread: vi.fn(() => undefined),
            createThread,
        }
        const sdk = {
            getRoom: vi.fn(() => room),
            fetchRoomEvent: vi.fn(async () => ({
                event_id: '$persisted-root',
                type: 'm.room.message',
                sender: '@gateway:example.org',
                origin_server_ts: 1,
                content: { msgtype: 'm.notice', body: 'session root' },
            })),
            getEventMapper: vi.fn(() => (event: { room_id?: string }) => {
                expect(event.room_id).toBe('!room:example.org')
                return rootEvent
            }),
        } as unknown as MatrixClient
        const client = new MatrixJsSdkGatewayClient(sdk)

        await client.prepareRoomThread('!room:example.org', '$persisted-root')

        expect(sdk.fetchRoomEvent).toHaveBeenCalledWith(
            '!room:example.org',
            '$persisted-root',
        )
        expect(createThread).toHaveBeenCalledWith(
            '$persisted-root',
            rootEvent,
            [],
            false,
        )
    })

    it('waits for an already trusted Matrix device to become visible after initial sync', async () => {
        const visibleDevice = { getFingerprint: () => 'matrix-ed25519-key' }
        const crypto = {
            getUserDeviceInfo: vi.fn()
                .mockResolvedValueOnce(new Map())
                .mockResolvedValueOnce(new Map([
                    ['@alice:example.org', new Map([['PWA1', visibleDevice]])],
                ])),
            setDeviceVerified: vi.fn(async () => undefined),
        }
        const sdk = {
            getCrypto: vi.fn(() => crypto),
        } as unknown as MatrixClient
        const onLog = vi.fn()
        const client = new MatrixJsSdkGatewayClient(sdk, 30_000, onLog, {
            trustedDeviceVisibilityTimeoutMs: 1_000,
            trustedDeviceVisibilityRetryMs: 0,
        })

        await client.pinTrustedDevices([{
            matrixUserId: '@alice:example.org',
            matrixDeviceId: 'PWA1',
            matrixDeviceKeys: ['matrix-ed25519-key'],
        }])

        expect(crypto.getUserDeviceInfo).toHaveBeenCalledTimes(2)
        expect(crypto.setDeviceVerified).toHaveBeenCalledWith(
            '@alice:example.org',
            'PWA1',
            true,
        )
        expect(onLog).toHaveBeenCalledWith(
            '[matrix-sdk] waiting for 1 trusted Matrix device(s) to become visible',
        )
    })

    it('enforces crypto-before-sync and maps the v41 SDK send/decrypt surface', async () => {
        let sdkEventListener: ((event: MatrixEvent) => void) | undefined
        const crypto = {
            isEncryptionEnabledInRoom: vi.fn(async () => true),
            setDeviceIsolationMode: vi.fn(),
            getUserDeviceInfo: vi.fn(async () => new Map([
                ['@alice:example.org', new Map([
                    ['PWA1', { getFingerprint: () => 'matrix-ed25519-key' }],
                ])],
            ])),
            setDeviceVerified: vi.fn(async () => undefined),
        }
        const sdk = {
            initRustCrypto: vi.fn(async () => undefined),
            getCrypto: vi.fn(() => crypto),
            on: vi.fn((event: ClientEvent, listener: (event: MatrixEvent) => void) => {
                if (event === ClientEvent.Event) sdkEventListener = listener
            }),
            off: vi.fn(),
            startClient: vi.fn(async () => undefined),
            stopClient: vi.fn(),
            getSyncState: vi.fn(() => SyncState.Prepared),
            sendMessage: vi.fn(async () => ({ event_id: '$sent' })),
            http: {
                authedRequest: vi.fn(async () => ({ event_id: '$control' })),
            },
            sendTyping: vi.fn(async () => ({})),
            decryptEventIfNeeded: vi.fn(async () => undefined),
        } as unknown as MatrixClient
        const client = new MatrixJsSdkGatewayClient(sdk)

        await expect(client.start()).rejects.toThrow('crypto must be initialized')
        await client.initializeCrypto({
            backend: 'indexeddb',
            databasePrefix: 'malink-device',
            storageKey: new Uint8Array(32),
        })
        await client.start()
        await client.waitUntilReady()
        await client.assertRoomEncrypted('!room:example.org')
        await client.pinTrustedDevices([{
            matrixUserId: '@alice:example.org',
            matrixDeviceId: 'PWA1',
            matrixDeviceKeys: ['matrix-ed25519-key'],
        }])
        expect(crypto.setDeviceVerified).toHaveBeenCalledWith(
            '@alice:example.org',
            'PWA1',
            true,
        )

        const mapped: MatrixIncomingEvent[] = []
        client.onRoomEvent(event => {
            mapped.push(event)
        })
        sdkEventListener?.({
            getRoomId: () => '!room:example.org',
            getId: () => '$incoming',
            getSender: () => '@alice:example.org',
            getType: () => 'm.room.message',
            getTs: () => 123,
            isEncrypted: () => true,
            getWireContent: () => ({ algorithm: 'm.megolm.v1.aes-sha2', ciphertext: 'cipher' }),
            getClaimedEd25519Key: () => 'matrix-ed25519-key',
            getSenderKey: () => 'curve25519-key',
            getContent: () => ({ msgtype: 'm.text', body: 'hello' }),
        } as unknown as MatrixEvent)
        await vi.waitFor(() => expect(mapped).toHaveLength(1))

        expect(sdk.initRustCrypto).toHaveBeenCalledWith(expect.objectContaining({
            useIndexedDB: true,
            cryptoDatabasePrefix: 'malink-device',
        }))
        expect(mapped[0]).toMatchObject({
            encrypted: true,
            senderDeviceId: 'matrix-ed25519-key',
            eventType: 'm.room.message',
            content: { body: 'hello' },
        })
        expect(mapped[0].encryptedPayloadFingerprint).toMatch(/^[a-f0-9]{64}$/)

        await client.sendEncryptedRoomEvent({
            roomId: '!room:example.org',
            eventType: 'm.room.message',
            content: { msgtype: 'm.text', body: 'outgoing' },
            transactionId: 'txn-1',
        })
        expect(sdk.sendMessage).toHaveBeenCalledWith(
            '!room:example.org',
            expect.objectContaining({ body: 'outgoing' }),
            'txn-1',
        )
        await expect(client.sendApplicationTimelineEvent({
            roomId: '!room:example.org',
            eventType: 'm.room.message',
            content: {
                msgtype: 'm.notice',
                body: 'invalid timeline',
                [MALINK_MATRIX_EXTENSION]: {
                    version: 2,
                    kind: 'session_root',
                },
            },
            transactionId: 'rejected-timeline',
        })).rejects.toThrow('must contain a Malink timeline envelope')
        await expect(client.sendApplicationControlEvent({
            roomId: '!room:example.org',
            eventType: 'io.malink.secure_control.v1',
            content: {
                msgtype: 'm.notice',
                body: 'plaintext result',
                [MALINK_MATRIX_EXTENSION]: {
                    version: 1,
                    kind: 'command_result',
                    command_id: 'must-not-send',
                },
            },
            transactionId: 'rejected-control',
        })).rejects.toThrow('must contain a Malink secure envelope')
        expect(sdk.http.authedRequest).not.toHaveBeenCalled()
        await client.sendApplicationTimelineEvent({
            roomId: '!room:example.org',
            eventType: 'm.room.message',
            content: {
                msgtype: 'm.notice',
                body: 'Encrypted Malink event',
                [MALINK_MATRIX_EXTENSION]: {
                    version: 3,
                    envelope: {
                        kind: 'malink.project-envelope',
                        version: 3,
                        roomId: '!room:example.org',
                        projectId: 'project-1',
                        keyId: 'project-key-1',
                        logicalEventId: 'event-1',
                        nonce: 'AAAAAAAAAAAAAAAA',
                        ciphertext: 'AAAAAAAAAAAAAAAAAAAAAA',
                    },
                },
            },
            transactionId: 'timeline/txn',
        })
        expect(sdk.http.authedRequest).toHaveBeenCalledWith(
            'PUT',
            '/rooms/!room%3Aexample.org/send/m.room.message/timeline%2Ftxn',
            undefined,
            expect.objectContaining({ body: 'Encrypted Malink event' }),
        )
        await client.sendApplicationControlEvent({
            roomId: '!room:example.org',
            eventType: 'io.malink.secure_control.v1',
            content: {
                msgtype: 'm.notice',
                body: 'Encrypted Malink message',
                [MALINK_MATRIX_EXTENSION]: {
                    version: 1,
                    kind: 'secure_envelope',
                    secure_envelope: { envelope: {}, signature: {} },
                },
            },
            transactionId: 'control/txn',
        })
        expect(sdk.http.authedRequest).toHaveBeenCalledWith(
            'PUT',
            '/rooms/!room%3Aexample.org/send/io.malink.secure_control.v1/control%2Ftxn',
            undefined,
            expect.objectContaining({ body: 'Encrypted Malink message' }),
        )
        await client.setApplicationRoomState({
            roomId: '!room:example.org',
            eventType: MALINK_MATRIX_SESSION_STATE_EVENT_TYPE,
            stateKey: 'session-1',
            content: {
                version: 2,
                kind: 'state_envelope',
                state_envelope: {
                    envelope: {
                        eventType: MALINK_MATRIX_SESSION_STATE_EVENT_TYPE,
                        stateKey: 'session-1',
                    },
                    signature: {},
                },
            },
        })
        expect(sdk.http.authedRequest).toHaveBeenCalledWith(
            'PUT',
            '/rooms/!room%3Aexample.org/state/io.malink.session.current.v2/session-1',
            undefined,
            expect.objectContaining({ kind: 'state_envelope' }),
            expect.any(Object),
        )
        await client.setApplicationRoomState({
            roomId: '!room:example.org',
            eventType: MALINK_MATRIX_SESSION_DIRECTORY_EVENT_TYPE,
            stateKey: 'malink.directory.1.0',
            content: {
                version: 2,
                kind: 'state_envelope',
                state_envelope: {
                    envelope: {
                        eventType: MALINK_MATRIX_SESSION_DIRECTORY_EVENT_TYPE,
                        stateKey: 'malink.directory.1.0',
                    },
                    signature: {},
                },
            },
        })
        expect(sdk.http.authedRequest).toHaveBeenCalledWith(
            'PUT',
            '/rooms/!room%3Aexample.org/state/io.malink.session.directory.v2/malink.directory.1.0',
            undefined,
            expect.objectContaining({ kind: 'state_envelope' }),
            expect.any(Object),
        )
        await expect(client.setApplicationRoomState({
            roomId: '!room:example.org',
            eventType: MALINK_MATRIX_GATEWAY_STATE_EVENT_TYPE,
            stateKey: 'gateway-1',
            content: {
                version: 2,
                kind: 'state_envelope',
                state_envelope: {
                    envelope: {
                        eventType: MALINK_MATRIX_GATEWAY_STATE_EVENT_TYPE,
                        stateKey: 'gateway-1',
                    },
                    signature: {},
                },
            },
        })).rejects.toThrow('must contain a Malink state envelope')
        expect(sdk.sendMessage).toHaveBeenCalledTimes(1)
        expect(sdk.http.authedRequest).toHaveBeenCalledTimes(4)
        await client.stop()
        expect(sdk.stopClient).toHaveBeenCalledOnce()
    })

    it('detects a silent sync stall and resets the deadline after progress', async () => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date('2026-08-05T00:00:00.000Z'))
        try {
            let syncListener: ((state: SyncState) => void) | undefined
            const sdk = {
                getSyncState: vi.fn(() => SyncState.Syncing),
                on: vi.fn((event: ClientEvent, listener: (state: SyncState) => void) => {
                    if (event === ClientEvent.Sync) syncListener = listener
                }),
                off: vi.fn(),
            } as unknown as MatrixClient
            const onStalled = vi.fn()
            const stop = watchMatrixSyncHealth(sdk, {
                stallTimeoutMs: 120_000,
                checkIntervalMs: 10_000,
            }, onStalled)

            await vi.advanceTimersByTimeAsync(110_000)
            expect(onStalled).not.toHaveBeenCalled()
            syncListener?.(SyncState.Syncing)
            await vi.advanceTimersByTimeAsync(110_000)
            expect(onStalled).not.toHaveBeenCalled()
            await vi.advanceTimersByTimeAsync(10_000)

            expect(onStalled).toHaveBeenCalledOnce()
            expect(onStalled.mock.calls[0]?.[0]).toMatchObject({
                message: 'Matrix sync made no progress for 120000ms (state=SYNCING)',
            })
            expect(sdk.off).toHaveBeenCalledWith(ClientEvent.Sync, syncListener)
            stop()
        } finally {
            vi.useRealTimers()
        }
    })
})
