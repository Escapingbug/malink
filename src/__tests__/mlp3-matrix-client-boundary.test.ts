import { access, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const RETIRED_MATRIX_FILES = [
    'src/gateway/matrix/gateway.ts',
    'src/gateway/matrix/secureContent.ts',
    'src/gateway/matrix/authorizer.ts',
    'src/gateway/matrix/fileDeliveryOutbox.ts',
    'src/gateway/matrix/fileReplayLedger.ts',
    'src/gateway/matrix/fileRuntimeState.ts',
    'src/gateway/matrix/fileStateOutbox.ts',
    'src/channel/matrix/matrixPort.ts',
    'apps/pwa/app/matrixNativeProjection.ts',
    'clients/android/app/src/main/java/id/my/anciety/malink/client/MatrixNativeProjection.kt',
] as const

describe('MLP/3 Matrix transport boundary', () => {
    it('keeps one production Gateway and client composition path', async () => {
        const [daemon, localGateway, webClient, sharedWebMatrix, android] = await Promise.all([
            source('src/matrix-daemon.ts'),
            source('scripts/matrix-local-gateway.ts'),
            source('apps/pwa/app/client/web/WebMalinkClient.ts'),
            source('apps/pwa/app/matrix.ts'),
            source(
                'clients/android/app/src/main/java/id/my/anciety/malink/client/NativeClientRuntime.kt',
            ),
        ])

        expect(daemon).toContain('new MatrixMlp3GatewayRunner(')
        expect(localGateway).toContain('new MatrixMlp3GatewayRunner(')
        expect(webClient).toContain('connect: connectMatrixMlp3')
        expect(sharedWebMatrix).not.toMatch(/export async function connectMatrix\(/u)
        expect(android).toContain('MatrixMlp3NativeProjection(')

        await Promise.all(RETIRED_MATRIX_FILES.map(async path => {
            await expect(access(resolve(path))).rejects.toMatchObject({ code: 'ENOENT' })
        }))
    })

    it('keeps Android live delivery on the Matrix SDK timeline', async () => {
        const [connection, driver, storage] = await Promise.all([
            source(
                'clients/android/app/src/main/java/id/my/anciety/malink/matrix/MatrixConnectionRuntime.kt',
            ),
            source(
                'clients/android/app/src/main/java/id/my/anciety/malink/matrix/OfficialMatrixSdkDriver.kt',
            ),
            source(
                'clients/android/app/src/main/java/id/my/anciety/malink/matrix/MatrixAccountStorage.kt',
            ),
        ])

        expect(connection).toContain('onTimelineEvent = onDecryptedEvent')
        expect(connection).not.toContain('applicationControlReceiver')
        expect(connection).not.toContain('startApplicationControlGapRecovery')
        expect(driver).toContain('built.syncService()')
        expect(driver).toContain('roomList.subscribeToRooms(')
        expect(storage).not.toContain('applicationControlCursor')
    })

    it('does not restore the removed state/history RPC protocol', async () => {
        const sources = await Promise.all([
            source('src/gateway/matrix/mlp3Gateway.ts'),
            source('apps/pwa/app/matrixMlp3Connection.ts'),
            source(
                'clients/android/app/src/main/java/id/my/anciety/malink/client/NativeClientRuntime.kt',
            ),
            source('packages/protocol/src/mlp-v3.ts'),
        ])

        for (const content of sources) {
            expect(content).not.toContain('malink.gateway.state.request')
            expect(content).not.toContain('gateway_state_request')
            expect(content).not.toContain('malink.history.request')
            expect(content).not.toContain('history_request')
            expect(content).not.toContain('history_page')
            expect(content).not.toContain('history_replay')
        }
    })
})

function source(path: string): Promise<string> {
    return readFile(resolve(path), 'utf8')
}
