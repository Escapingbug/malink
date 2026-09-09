import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
    MALINK_MATRIX_SESSION_STATE_EVENT_TYPE,
    MLP3_MATRIX_PROVIDER_CATALOG_EVENT_TYPE,
} from '@malink/protocol'
import {
    MatrixNodeSdkGatewayClient,
    loadOrCreateMatrixCryptoPassphrase,
} from '@/gateway/matrix'

const temporaryDirectories: string[] = []

afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map(path =>
        rm(path, { recursive: true, force: true })))
})

describe('MatrixNodeSdkGatewayClient', () => {
    it('retries an aborted sync request unless the sync lifecycle was stopped', async () => {
        const directory = await temporaryDirectory()
        let syncRequests = 0
        const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
            if (!String(input).includes('/_matrix/client/v3/sync')) {
                return jsonResponse({ one_time_key_counts: {} })
            }
            syncRequests += 1
            if (syncRequests === 1) throw new DOMException('Request timed out', 'AbortError')
            if (syncRequests === 2) return jsonResponse({
                next_batch: 'recovered-after-request-timeout',
                rooms: { join: {} },
            })
            return new Promise<Response>((_resolve, reject) => {
                const signal = init?.signal
                const aborted = () => reject(signal?.reason ?? new DOMException('Stopped', 'AbortError'))
                if (signal?.aborted) aborted()
                else signal?.addEventListener('abort', aborted, { once: true })
            })
        }) as unknown as typeof fetch
        const client = new MatrixNodeSdkGatewayClient({
            baseUrl: 'https://matrix.example.test', accessToken: 'token',
            userId: '@gateway:example.test', deviceId: 'STABLE_DEVICE',
        }, 2_000, undefined, fetchMock)
        await client.initializeCrypto({
            backend: 'node-sqlite', storagePath: join(directory, 'crypto'),
            storagePassword: 'test-only-passphrase', syncTokenPath: join(directory, 'sync.json'),
        })
        try {
            await client.start()
            await client.waitUntilReady()
            await vi.waitFor(() => expect(syncRequests).toBe(3))
        } finally {
            await client.stop()
        }
        expect(syncRequests).toBe(3)
        expect(JSON.parse(await readFile(join(directory, 'sync.json'), 'utf8'))).toBeTruthy()
    })

    it.each([MLP3_MATRIX_PROVIDER_CATALOG_EVENT_TYPE, 'io.malink.gateway_deployment.v1'])(
      'accepts application-encrypted current state %s', async eventType => {
        const fetchMock = vi.fn(async () => jsonResponse({ event_id: '$catalog' }))
        const client = new MatrixNodeSdkGatewayClient({
            baseUrl: 'https://matrix.example.test',
            accessToken: 'token',
            userId: '@gateway:example.test',
            deviceId: 'STABLE_DEVICE',
        }, 1_000, undefined, fetchMock)

        await expect(client.setApplicationRoomState({
            roomId: '!room:example.test',
            eventType,
            stateKey: 'codex/manifest',
            content: {
                msgtype: 'm.notice',
                body: 'Encrypted Malink event',
                'io.malink': {
                    version: 3,
                    envelope: {
                        kind: 'malink.project-envelope',
                        version: 3,
                        roomId: '!room:example.test',
                        projectId: 'project-1',
                        keyId: 'key-1',
                        logicalEventId: 'catalog-1',
                        nonce: 'AAAAAAAAAAAAAAAA',
                        ciphertext: 'AAAAAAAAAAAAAAAAAAAAAA',
                    },
                },
            },
        })).resolves.toMatchObject({ eventId: '$catalog' })

        expect(fetchMock).toHaveBeenCalledOnce()
    })

    it('idempotently creates an encrypted project room with a Gateway ownership marker', async () => {
        const directory = await temporaryDirectory()
        let createAttempts = 0
        const marker = {
            kind: 'malink.project.provisioning' as const,
            version: 1 as const,
            workspaceId: 'workspace-1',
            gatewayNodeId: 'gateway-node-1',
            projectId: 'project-1',
        }
        const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
            const url = decodeURIComponent(String(input))
            if (url.endsWith('/_matrix/client/v3/createRoom')) {
                createAttempts += 1
                if (createAttempts > 1) {
                    return new Response(JSON.stringify({ errcode: 'M_ROOM_IN_USE' }), {
                        status: 400,
                        headers: { 'content-type': 'application/json' },
                    })
                }
                return new Response(JSON.stringify({ room_id: '!project:example.test' }), {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                })
            }
            if (url.includes('/directory/room/#malink-project-test:example.test')) {
                return jsonResponse({ room_id: '!project:example.test' })
            }
            if (url.includes('/state/io.malink.project.provisioning.v1/')) {
                return jsonResponse(marker)
            }
            if (url.includes('/state/m.room.encryption/')) {
                return jsonResponse({ algorithm: 'm.megolm.v1.aes-sha2' })
            }
            if (url.includes('/state/m.room.history_visibility/')) {
                return jsonResponse({ history_visibility: 'shared' })
            }
            if (url.includes('/joined_members')) return jsonResponse({ joined: {} })
            return jsonResponse({ one_time_key_counts: {} })
        })
        const client = new MatrixNodeSdkGatewayClient({
            baseUrl: 'https://matrix.example.test',
            accessToken: 'token',
            userId: '@gateway:example.test',
            deviceId: 'STABLE_DEVICE',
        }, 1_000, undefined, fetchMock as unknown as typeof fetch)
        await client.initializeCrypto({
            backend: 'node-sqlite',
            storagePath: join(directory, 'crypto'),
            storagePassword: 'test-only-passphrase',
            syncTokenPath: join(directory, 'sync.json'),
        })
        const request = {
            aliasLocalpart: 'malink-project-test',
            name: 'Malink project',
            inviteUserIds: ['@phone:example.test'],
            marker,
        }

        await expect(client.ensureProjectRoom(request)).resolves.toEqual({
            roomId: '!project:example.test',
            alreadyExisted: false,
        })
        await expect(client.ensureProjectRoom(request)).resolves.toEqual({
            roomId: '!project:example.test',
            alreadyExisted: true,
        })

        const createCall = fetchMock.mock.calls.find(([input]) =>
            String(input).endsWith('/_matrix/client/v3/createRoom'))
        const body = JSON.parse(String(createCall?.[1]?.body)) as Record<string, unknown>
        expect(body).toMatchObject({
            room_alias_name: 'malink-project-test',
            visibility: 'private',
            preset: 'private_chat',
            invite: ['@phone:example.test'],
        })
        expect(body.initial_state).toEqual(expect.arrayContaining([
            expect.objectContaining({ type: 'm.room.encryption' }),
            expect.objectContaining({
                type: 'io.malink.project.provisioning.v1',
                content: marker,
            }),
        ]))
        const requestCount = fetchMock.mock.calls.length
        await client.ensureRoomInvitation('!project:example.test', '@phone:example.test')
        expect(fetchMock).toHaveBeenCalledTimes(requestCount)
        await client.stop()
    })

    it('invites an authorized Workspace device after checking current membership', async () => {
        const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
            const url = String(input)
            if (url.includes(encodeURIComponent('@joined:example.test'))) {
                return new Response(JSON.stringify({ membership: 'join' }), {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                })
            }
            if (init?.method === 'GET') {
                return new Response(JSON.stringify({ errcode: 'M_NOT_FOUND' }), {
                    status: 404,
                    headers: { 'content-type': 'application/json' },
                })
            }
            return new Response('{}', {
                status: 200,
                headers: { 'content-type': 'application/json' },
            })
        })
        const client = new MatrixNodeSdkGatewayClient({
            baseUrl: 'https://matrix.example.test',
            accessToken: 'token',
            userId: '@gateway:example.test',
            deviceId: 'STABLE_DEVICE',
        }, 1_000, undefined, fetchMock as unknown as typeof fetch)

        await client.ensureRoomInvitation('!room:example.test', '@joined:example.test')
        await client.ensureRoomInvitation('!room:example.test', '@joined:example.test')
        await client.ensureRoomInvitation('!room:example.test', '@new:example.test')
        await client.ensureRoomInvitation('!room:example.test', '@new:example.test')

        expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
        expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'GET')).toHaveLength(2)
        const post = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST')
        expect(String(post?.[0])).toContain('/invite')
        expect(post?.[1]?.body).toBe(JSON.stringify({ user_id: '@new:example.test' }))
    })

    it('redacts recursively paged thread relations and retires the room', async () => {
        const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
            const url = new URL(String(input))
            const path = decodeURIComponent(url.pathname)
            if (path.includes('/relations/')) {
                return jsonResponse(url.searchParams.get('from')
                    ? { chunk: [{ event_id: '$reply-1' }] }
                    : { chunk: [{ event_id: '$reply-2' }], next_batch: 'next' })
            }
            if (path.endsWith('/members')) {
                return jsonResponse({
                    chunk: [
                        {
                            state_key: '@gateway:example.test',
                            content: { membership: 'join' },
                        },
                        {
                            state_key: '@phone:example.test',
                            content: { membership: 'join' },
                        },
                    ],
                })
            }
            if (path.endsWith('/aliases')) {
                return jsonResponse({ aliases: ['#history:example.test'] })
            }
            return jsonResponse({})
        })
        const client = new MatrixNodeSdkGatewayClient({
            baseUrl: 'https://matrix.example.test',
            accessToken: 'token',
            userId: '@gateway:example.test',
            deviceId: 'STABLE_DEVICE',
        }, 1_000, undefined, fetchMock as unknown as typeof fetch)

        await client.deleteRoomThread('!room:example.test', '$root')
        await client.retireRoom('!room:example.test')

        const calls = fetchMock.mock.calls.map(([input, init]) => ({
            method: init?.method,
            path: decodeURIComponent(new URL(String(input)).pathname),
        }))
        expect(calls.filter(call => call.path.includes('/redact/'))).toHaveLength(3)
        expect(calls).toEqual(expect.arrayContaining([
            expect.objectContaining({ method: 'POST', path: expect.stringContaining('/kick') }),
            expect.objectContaining({ method: 'DELETE', path: '/_matrix/client/v3/directory/room/#history:example.test' }),
            expect.objectContaining({ method: 'POST', path: expect.stringContaining('/leave') }),
            expect.objectContaining({ method: 'POST', path: expect.stringContaining('/forget') }),
        ]))
    })

    it('yields failed background redaction to its durable cleanup retry authority', async () => {
        let redactions = 0
        const fetchMock = vi.fn(async (input: string | URL | Request) => {
            const path = decodeURIComponent(new URL(String(input)).pathname)
            if (path.includes('/relations/')) return jsonResponse({ chunk: [] })
            if (path.includes('/redact/')) {
                redactions += 1
                throw new TypeError('fetch failed')
            }
            return jsonResponse({ event_id: '$live-write' })
        })
        const client = new MatrixNodeSdkGatewayClient({
            baseUrl: 'https://matrix.example.test', accessToken: 'token',
            userId: '@gateway:example.test', deviceId: 'STABLE_DEVICE',
        }, 1_000, undefined, fetchMock as unknown as typeof fetch)
        await expect(client.deleteRoomThread('!room:example.test', '$root'))
            .rejects.toThrow('fetch failed')
        expect(redactions).toBe(1)
    })

    it('stops a background thread cleanup between idempotent Matrix writes', async () => {
        const controller = new AbortController()
        const fetchMock = vi.fn(async (input: string | URL | Request) => {
            const url = new URL(String(input))
            const path = decodeURIComponent(url.pathname)
            if (path.includes('/relations/')) {
                return jsonResponse({ chunk: [{ event_id: '$reply-1' }] })
            }
            if (path.includes('/redact/')) {
                controller.abort(new Error('Gateway is stopping'))
            }
            return jsonResponse({})
        })
        const client = new MatrixNodeSdkGatewayClient({
            baseUrl: 'https://matrix.example.test',
            accessToken: 'token',
            userId: '@gateway:example.test',
            deviceId: 'STABLE_DEVICE',
        }, 1_000, undefined, fetchMock as unknown as typeof fetch)

        await expect(client.deleteRoomThread(
            '!room:example.test',
            '$root',
            { signal: controller.signal },
        )).rejects.toThrow('Gateway is stopping')

        expect(fetchMock.mock.calls.filter(([input]) =>
            decodeURIComponent(new URL(String(input)).pathname).includes('/redact/')
        )).toHaveLength(1)
    })

    it('reopens the same Olm identity for a persisted Matrix device', async () => {
        const directory = await temporaryDirectory()
        const fetchMock = vi.fn(async () => new Response(JSON.stringify({
            one_time_key_counts: {},
        }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
        })) as unknown as typeof fetch
        const config = {
            backend: 'node-sqlite' as const,
            storagePath: join(directory, 'crypto'),
            storagePassword: 'test-only-passphrase',
            syncTokenPath: join(directory, 'sync.json'),
        }
        const connection = {
            baseUrl: 'https://matrix.example.test',
            accessToken: 'token',
            userId: '@gateway:example.test',
            deviceId: 'STABLE_DEVICE',
        }

        const first = new MatrixNodeSdkGatewayClient(
            connection,
            1_000,
            undefined,
            fetchMock,
        )
        await first.initializeCrypto(config)
        const firstKeys = first.getOwnDeviceKeys()
        await first.stop()

        const second = new MatrixNodeSdkGatewayClient(
            connection,
            1_000,
            undefined,
            fetchMock,
        )
        await second.initializeCrypto(config)
        expect(second.getOwnDeviceKeys()).toEqual(firstKeys)
        await second.stop()
    })

    it('retries transient crypto request failures during startup', async () => {
        const directory = await temporaryDirectory()
        let calls = 0
        const logs: string[] = []
        const fetchMock = vi.fn(async () => {
            calls += 1
            if (calls === 1) throw new TypeError('fetch failed')
            return jsonResponse({ one_time_key_counts: {} })
        }) as unknown as typeof fetch
        const client = new MatrixNodeSdkGatewayClient(
            {
                baseUrl: 'https://matrix.example.test',
                accessToken: 'token',
                userId: '@gateway:example.test',
                deviceId: 'STABLE_DEVICE',
            },
            1_000,
            message => logs.push(message),
            fetchMock,
        )

        await client.initializeCrypto({
            backend: 'node-sqlite',
            storagePath: join(directory, 'crypto'),
            storagePassword: 'test-only-passphrase',
            syncTokenPath: join(directory, 'sync.json'),
        })

        expect(calls).toBeGreaterThanOrEqual(2)
        expect(logs).toContain(
            '[matrix-node] POST /_matrix/client/v3/keys/upload failed transiently; '
            + 'retrying in 250ms: fetch failed',
        )
        await client.stop()
    })

    it('creates one stable, owner-only crypto-store passphrase', async () => {
        const directory = await temporaryDirectory()
        const path = join(directory, 'matrix-crypto.passphrase')

        const first = await loadOrCreateMatrixCryptoPassphrase(path)
        const second = await loadOrCreateMatrixCryptoPassphrase(path)

        expect(second).toBe(first)
        expect(first.length).toBeGreaterThanOrEqual(40)
        expect((await stat(path)).mode & 0o777).toBe(0o600)
    })

    it('restarts only the sync loop while preserving the crypto identity', async () => {
        const directory = await temporaryDirectory()
        let syncRequests = 0
        const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
            const url = String(input)
            if (url.includes('/_matrix/client/v3/sync')) {
                syncRequests += 1
                if (syncRequests === 2) {
                    return new Response(JSON.stringify({
                        next_batch: 'sync-after-restart',
                        to_device: { events: [] },
                        device_lists: { changed: [], left: [] },
                        device_one_time_keys_count: {},
                        rooms: { join: {} },
                    }), {
                        status: 200,
                        headers: { 'content-type': 'application/json' },
                    })
                }
                return new Promise<Response>((_resolve, reject) => {
                    const signal = init?.signal
                    const rejectAbort = () => reject(
                        signal?.reason ?? new DOMException('Aborted', 'AbortError'),
                    )
                    if (signal?.aborted) rejectAbort()
                    else signal?.addEventListener('abort', rejectAbort, { once: true })
                })
            }
            return new Response(JSON.stringify({ one_time_key_counts: {} }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            })
        }) as unknown as typeof fetch
        const client = new MatrixNodeSdkGatewayClient(
            {
                baseUrl: 'https://matrix.example.test',
                accessToken: 'token',
                userId: '@gateway:example.test',
                deviceId: 'STABLE_DEVICE',
            },
            1_000,
            undefined,
            fetchMock,
        )
        await client.initializeCrypto({
            backend: 'node-sqlite',
            storagePath: join(directory, 'crypto'),
            storagePassword: 'test-only-passphrase',
            syncTokenPath: join(directory, 'sync.json'),
        })
        const keys = client.getOwnDeviceKeys()
        await client.start()
        await vi.waitFor(() => expect(syncRequests).toBe(1))

        await client.restartSync()
        await client.waitUntilReady()

        expect(syncRequests).toBeGreaterThanOrEqual(2)
        expect(client.getOwnDeviceKeys()).toEqual(keys)
        await client.stop()
    })

    it('commits a sync cursor only after async event listeners durably accept the batch', async () => {
        const directory = await temporaryDirectory()
        const syncPath = join(directory, 'sync.json')
        const listenerStarted = deferred<void>()
        const listenerRelease = deferred<void>()
        let syncRequests = 0
        const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
            if (String(input).includes('/_matrix/client/v3/sync')) {
                syncRequests += 1
                if (syncRequests === 1) {
                    return new Response(JSON.stringify({
                        next_batch: 'after-durable-listener',
                        to_device: { events: [] },
                        device_lists: { changed: [], left: [] },
                        device_one_time_keys_count: {},
                        rooms: {
                            join: {
                                '!project:example.test': {
                                    timeline: {
                                        events: [{
                                            event_id: '$command',
                                            type: 'm.room.message',
                                            sender: '@device:example.test',
                                            origin_server_ts: 42,
                                            content: { body: 'Malink command' },
                                        }],
                                    },
                                },
                            },
                        },
                    }), {
                        status: 200,
                        headers: { 'content-type': 'application/json' },
                    })
                }
                return new Promise<Response>((_resolve, reject) => {
                    const signal = init?.signal
                    const rejectAbort = () => reject(
                        signal?.reason ?? new DOMException('Aborted', 'AbortError'),
                    )
                    if (signal?.aborted) rejectAbort()
                    else signal?.addEventListener('abort', rejectAbort, { once: true })
                })
            }
            return new Response(JSON.stringify({ one_time_key_counts: {} }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            })
        }) as unknown as typeof fetch
        const client = new MatrixNodeSdkGatewayClient({
            baseUrl: 'https://matrix.example.test',
            accessToken: 'token',
            userId: '@gateway:example.test',
            deviceId: 'STABLE_DEVICE',
        }, 1_000, undefined, fetchMock)
        await client.initializeCrypto({
            backend: 'node-sqlite',
            storagePath: join(directory, 'crypto'),
            storagePassword: 'test-only-passphrase',
            syncTokenPath: syncPath,
        })
        client.onRoomEvent(async () => {
            listenerStarted.resolve()
            await listenerRelease.promise
        })

        await client.start()
        await listenerStarted.promise
        await expect(readFile(syncPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })

        listenerRelease.resolve()
        await vi.waitFor(async () => {
            expect(JSON.parse(await readFile(syncPath, 'utf8'))).toEqual({
                version: 1,
                nextBatch: 'after-durable-listener',
            })
        })
        await client.stop()
    })

    it('serializes account-wide room writes through one 429 retry window', async () => {
        let calls = 0
        let active = 0
        let maxActive = 0
        const callTimes: number[] = []
        const fetchMock = vi.fn(async () => {
            const call = ++calls
            callTimes.push(Date.now())
            active += 1
            maxActive = Math.max(maxActive, active)
            await Promise.resolve()
            active -= 1
            if (call === 2) {
                return new Response(JSON.stringify({
                    errcode: 'M_LIMIT_EXCEEDED',
                    retry_after_ms: 1,
                }), {
                    status: 429,
                    headers: { 'content-type': 'application/json' },
                })
            }
            return new Response(JSON.stringify({ event_id: `$event-${call}` }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            })
        }) as unknown as typeof fetch
        const logs: string[] = []
        const client = new MatrixNodeSdkGatewayClient(
            {
                baseUrl: 'https://matrix.example.test',
                accessToken: 'token',
                userId: '@gateway:example.test',
                deviceId: 'STABLE_DEVICE',
            },
            1_000,
            message => logs.push(message),
            fetchMock,
        )
        const state = (stateKey: string) => client.setApplicationRoomState({
            roomId: '!room:example.test',
            eventType: MALINK_MATRIX_SESSION_STATE_EVENT_TYPE,
            stateKey,
            content: {
                version: 2,
                kind: 'state_envelope',
                state_envelope: {
                    envelope: {
                        eventType: MALINK_MATRIX_SESSION_STATE_EVENT_TYPE,
                        stateKey,
                    },
                    signature: {},
                },
            },
        })

        await expect(Promise.all([
            state('session-1'),
            state('session-2'),
            state('session-3'),
        ])).resolves.toHaveLength(3)

        expect(calls).toBe(4)
        expect(maxActive).toBe(1)
        // The 429 arrived after one successful write. Learn the complete
        // refill period (elapsed time plus retry_after), then pace the next
        // queued write instead of immediately consuming another empty bucket.
        expect(callTimes[3]! - callTimes[2]!).toBeGreaterThanOrEqual(450)
        expect(logs.some(message =>
            message.startsWith('[matrix-node] PUT /_matrix/client/v3/rooms/')
            && message.endsWith('rate limited; retrying in 250ms'))).toBe(true)
    })

    it('releases the room write lane when a 429 exceeds the request retry budget', async () => {
        let calls = 0
        const fetchMock = vi.fn(async () => {
            calls += 1
            if (calls === 1) {
                return new Response(JSON.stringify({
                    errcode: 'M_LIMIT_EXCEEDED',
                    retry_after_ms: 10_000,
                }), { status: 429, headers: { 'content-type': 'application/json' } })
            }
            return jsonResponse({ event_id: '$recovered' })
        }) as unknown as typeof fetch
        const client = new MatrixNodeSdkGatewayClient({
            baseUrl: 'https://matrix.example.test',
            accessToken: 'token',
            userId: '@gateway:example.test',
            deviceId: 'STABLE_DEVICE',
            requestRetryBudgetMs: 1_000,
        }, 1_000, undefined, fetchMock)
        const state = (stateKey: string) => client.setApplicationRoomState({
            roomId: '!room:example.test',
            eventType: MALINK_MATRIX_SESSION_STATE_EVENT_TYPE,
            stateKey,
            content: {
                version: 2,
                kind: 'state_envelope',
                state_envelope: {
                    envelope: {
                        eventType: MALINK_MATRIX_SESSION_STATE_EVENT_TYPE,
                        stateKey,
                    },
                    signature: {},
                },
            },
        })

        await expect(state('first')).rejects.toThrow('exhausted its 1000ms retry budget')
        await expect(state('second')).resolves.toMatchObject({ eventId: '$recovered' })
        expect(calls).toBe(2)
    })

    it('times out a stalled response body and releases the room write lane', async () => {
        let calls = 0
        let bodyReadAborted = false
        const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
            calls += 1
            if (calls === 1) {
                const signal = init?.signal
                return {
                    ok: true,
                    status: 200,
                    text: () => new Promise<string>((_resolve, reject) => {
                        const rejectAbort = () => {
                            bodyReadAborted = true
                            reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'))
                        }
                        if (signal?.aborted) rejectAbort()
                        else signal?.addEventListener('abort', rejectAbort, { once: true })
                    }),
                } as Response
            }
            return jsonResponse({ event_id: '$after-body-timeout' })
        }) as unknown as typeof fetch
        const client = new MatrixNodeSdkGatewayClient({
            baseUrl: 'https://matrix.example.test',
            accessToken: 'token',
            userId: '@gateway:example.test',
            deviceId: 'STABLE_DEVICE',
        }, 20, undefined, fetchMock)
        const state = (stateKey: string) => client.setApplicationRoomState({
            roomId: '!room:example.test',
            eventType: MALINK_MATRIX_SESSION_STATE_EVENT_TYPE,
            stateKey,
            content: {
                version: 2,
                kind: 'state_envelope',
                state_envelope: {
                    envelope: {
                        eventType: MALINK_MATRIX_SESSION_STATE_EVENT_TYPE,
                        stateKey,
                    },
                    signature: {},
                },
            },
        })

        await expect(state('stalled')).rejects.toMatchObject({ name: 'AbortError' })
        expect(bodyReadAborted).toBe(true)
        await expect(state('recovered')).resolves.toMatchObject({
            eventId: '$after-body-timeout',
        })
        expect(calls).toBe(2)
    })

    it('releases the room write lane when fetch ignores abort', async () => {
        let calls = 0
        const fetchMock = vi.fn(async () => {
            calls += 1
            if (calls === 1) return new Promise<Response>(() => undefined)
            return jsonResponse({ event_id: '$after-ignored-fetch-abort' })
        }) as unknown as typeof fetch
        const client = new MatrixNodeSdkGatewayClient({
            baseUrl: 'https://matrix.example.test',
            accessToken: 'token',
            userId: '@gateway:example.test',
            deviceId: 'STABLE_DEVICE',
        }, 20, undefined, fetchMock)
        const state = (stateKey: string) => client.setApplicationRoomState({
            roomId: '!room:example.test',
            eventType: MALINK_MATRIX_SESSION_STATE_EVENT_TYPE,
            stateKey,
            content: {
                version: 2,
                kind: 'state_envelope',
                state_envelope: {
                    envelope: {
                        eventType: MALINK_MATRIX_SESSION_STATE_EVENT_TYPE,
                        stateKey,
                    },
                    signature: {},
                },
            },
        })

        await expect(state('ignored-fetch-abort')).rejects.toMatchObject({ name: 'AbortError' })
        await expect(state('recovered')).resolves.toMatchObject({
            eventId: '$after-ignored-fetch-abort',
        })
        expect(calls).toBe(2)
    })

    it('cancels one application timeline attempt and releases the room write lane', async () => {
        let calls = 0
        let firstRequestAborted = false
        const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
            calls += 1
            if (calls === 1) {
                return new Promise<Response>((_resolve, reject) => {
                    const rejectAbort = () => {
                        firstRequestAborted = true
                        reject(init?.signal?.reason ?? new DOMException('Aborted', 'AbortError'))
                    }
                    if (init?.signal?.aborted) rejectAbort()
                    else init?.signal?.addEventListener('abort', rejectAbort, { once: true })
                })
            }
            return jsonResponse({ event_id: '$after-attempt-abort' })
        }) as unknown as typeof fetch
        const client = new MatrixNodeSdkGatewayClient({
            baseUrl: 'https://matrix.example.test',
            accessToken: 'token',
            userId: '@gateway:example.test',
            deviceId: 'STABLE_DEVICE',
        }, 30_000, undefined, fetchMock)
        const content = {
            msgtype: 'm.notice',
            body: 'Encrypted Malink event',
            'io.malink': {
                version: 3,
                envelope: {
                    kind: 'malink.project-envelope',
                    version: 3,
                    roomId: '!room:example.test',
                    projectId: 'project-1',
                    keyId: 'key-1',
                    logicalEventId: 'event-1',
                    nonce: 'AAAAAAAAAAAAAAAA',
                    ciphertext: 'AAAAAAAAAAAAAAAAAAAAAA',
                },
            },
        }
        const controller = new AbortController()
        const stalled = client.sendApplicationTimelineEvent({
            roomId: '!room:example.test',
            eventType: 'm.room.message',
            content,
            transactionId: 'stable-transaction',
            signal: controller.signal,
        })
        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
        controller.abort(new Error('durable delivery attempt expired'))

        await expect(stalled).rejects.toThrow('durable delivery attempt expired')
        expect(firstRequestAborted).toBe(true)
        await expect(client.sendApplicationTimelineEvent({
            roomId: '!room:example.test',
            eventType: 'm.room.message',
            content,
            transactionId: 'stable-transaction',
        })).resolves.toEqual({ eventId: '$after-attempt-abort' })
        expect(calls).toBe(2)
    })

    it('releases the room write lane when a streamed body ignores abort', async () => {
        let calls = 0
        const fetchMock = vi.fn(async () => {
            calls += 1
            if (calls === 1) {
                return new Response(new ReadableStream<Uint8Array>({
                    start() {
                        // Deliberately never emit data or close. A real proxy
                        // can leave a successful chunked response in this state.
                    },
                }), {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                })
            }
            return jsonResponse({ event_id: '$after-ignored-body-abort' })
        }) as unknown as typeof fetch
        const client = new MatrixNodeSdkGatewayClient({
            baseUrl: 'https://matrix.example.test',
            accessToken: 'token',
            userId: '@gateway:example.test',
            deviceId: 'STABLE_DEVICE',
        }, 20, undefined, fetchMock)
        const state = (stateKey: string) => client.setApplicationRoomState({
            roomId: '!room:example.test',
            eventType: MALINK_MATRIX_SESSION_STATE_EVENT_TYPE,
            stateKey,
            content: {
                version: 2,
                kind: 'state_envelope',
                state_envelope: {
                    envelope: {
                        eventType: MALINK_MATRIX_SESSION_STATE_EVENT_TYPE,
                        stateKey,
                    },
                    signature: {},
                },
            },
        })

        await expect(state('ignored-body-abort')).rejects.toMatchObject({ name: 'AbortError' })
        await expect(state('recovered')).resolves.toMatchObject({
            eventId: '$after-ignored-body-abort',
        })
        expect(calls).toBe(2)
    })

    it('accepts a complete mutation result without waiting for chunked response EOF', async () => {
        let calls = 0
        let bodyCancelled = false
        const encoded = new TextEncoder().encode(JSON.stringify({ event_id: '$accepted' }))
        const fetchMock = vi.fn(async () => {
            calls += 1
            if (calls === 1) {
                return new Response(new ReadableStream<Uint8Array>({
                    start(controller) {
                        const split = Math.floor(encoded.length / 2)
                        controller.enqueue(encoded.slice(0, split))
                        controller.enqueue(encoded.slice(split))
                    },
                    cancel() {
                        bodyCancelled = true
                        return new Promise<void>(() => undefined)
                    },
                }), {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                })
            }
            return jsonResponse({ event_id: '$after-accepted' })
        }) as unknown as typeof fetch
        const client = new MatrixNodeSdkGatewayClient({
            baseUrl: 'https://matrix.example.test',
            accessToken: 'token',
            userId: '@gateway:example.test',
            deviceId: 'STABLE_DEVICE',
        }, 20, undefined, fetchMock)
        const state = (stateKey: string) => client.setApplicationRoomState({
            roomId: '!room:example.test',
            eventType: MALINK_MATRIX_SESSION_STATE_EVENT_TYPE,
            stateKey,
            content: {
                version: 2,
                kind: 'state_envelope',
                state_envelope: {
                    envelope: {
                        eventType: MALINK_MATRIX_SESSION_STATE_EVENT_TYPE,
                        stateKey,
                    },
                    signature: {},
                },
            },
        })

        await expect(state('accepted-without-eof')).resolves.toEqual({
            eventId: '$accepted',
        })
        expect(bodyCancelled).toBe(true)
        await expect(state('next-write')).resolves.toEqual({
            eventId: '$after-accepted',
        })
        expect(calls).toBe(2)
    })
})

async function temporaryDirectory(): Promise<string> {
    const path = await mkdtemp(join(tmpdir(), 'malink-matrix-node-client-'))
    temporaryDirectories.push(path)
    return path
}

function jsonResponse(value: unknown): Response {
    return new Response(JSON.stringify(value), {
        status: 200,
        headers: { 'content-type': 'application/json' },
    })
}

function deferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void
    let reject!: (reason?: unknown) => void
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise
        reject = rejectPromise
    })
    return { promise, resolve, reject }
}
