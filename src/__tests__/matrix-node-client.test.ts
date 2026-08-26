import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MALINK_MATRIX_SESSION_STATE_EVENT_TYPE } from '@malink/protocol'
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
        await client.ensureRoomInvitation('!room:example.test', '@new:example.test')

        expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
        const post = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST')
        expect(String(post?.[0])).toContain('/invite')
        expect(post?.[1]?.body).toBe(JSON.stringify({ user_id: '@new:example.test' }))
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

    it('serializes account-wide room writes through one 429 retry window', async () => {
        let calls = 0
        let active = 0
        let maxActive = 0
        const fetchMock = vi.fn(async () => {
            const call = ++calls
            active += 1
            maxActive = Math.max(maxActive, active)
            await Promise.resolve()
            active -= 1
            if (call === 1) {
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

        await expect(Promise.all([state('session-1'), state('session-2')]))
            .resolves.toHaveLength(2)

        expect(calls).toBe(3)
        expect(maxActive).toBe(1)
        expect(logs).toContain('[matrix-node] rate limited; retrying in 250ms')
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
