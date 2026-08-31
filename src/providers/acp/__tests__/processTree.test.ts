import { readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { AcpClientManager, AcpInitializeTimeoutError } from '../AcpClientManager'

const fixture = join(
    dirname(fileURLToPath(import.meta.url)),
    'fixtures',
    'processTreeAgent.mjs',
)
const pidFile = join(tmpdir(), `malink-acp-descendant-${process.pid}.pid`)
let descendantPid: number | undefined

afterEach(async () => {
    if (descendantPid && isRunning(descendantPid)) {
        try { process.kill(descendantPid, 'SIGKILL') } catch {}
    }
    descendantPid = undefined
    await rm(pidFile, { force: true })
})

describe.skipIf(process.platform === 'win32')('ACP process-tree lifecycle', () => {
    it('terminates adapter descendants after the adapter exits on stdin close', async () => {
        const manager = new AcpClientManager({
            command: process.execPath,
            args: [fixture],
            env: { ACP_TEST_DESCENDANT_PID_FILE: pidFile },
        })

        await manager.init()
        descendantPid = await readPidFile(pidFile)
        expect(isRunning(descendantPid)).toBe(true)

        await manager.close()

        await expect(waitUntilStopped(descendantPid)).resolves.toBe(true)
    })

    it('force-disposes adapter descendants as one process group', async () => {
        const manager = new AcpClientManager({
            command: process.execPath,
            args: [fixture],
            env: { ACP_TEST_DESCENDANT_PID_FILE: pidFile },
        })

        await manager.init()
        descendantPid = await readPidFile(pidFile)
        expect(isRunning(descendantPid)).toBe(true)

        manager.dispose()

        await expect(waitUntilStopped(descendantPid)).resolves.toBe(true)
    })

    it('waits for the complete adapter process tree to stop after initialize times out', async () => {
        const manager = new AcpClientManager({
            command: process.execPath,
            args: [fixture],
            env: {
                ACP_TEST_DESCENDANT_PID_FILE: pidFile,
                ACP_TEST_HANG_INITIALIZE: '1',
            },
        })

        const initializationFailure = expect(manager.init(1_000))
            .rejects.toBeInstanceOf(AcpInitializeTimeoutError)
        descendantPid = await readPidFile(pidFile)
        await initializationFailure

        await expect(waitUntilStopped(descendantPid)).resolves.toBe(true)
        expect(manager.connected).toBe(false)
    })
})

async function readPidFile(path: string): Promise<number> {
    const deadline = Date.now() + 2_000
    while (true) {
        try {
            const pid = Number((await readFile(path, 'utf8')).trim())
            if (Number.isSafeInteger(pid) && pid > 0) return pid
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
        if (Date.now() >= deadline) throw new Error('ACP descendant PID was not published')
        await new Promise(resolve => setTimeout(resolve, 20))
    }
}

async function waitUntilStopped(pid: number): Promise<boolean> {
    const deadline = Date.now() + 2_000
    while (isRunning(pid)) {
        if (Date.now() >= deadline) return false
        await new Promise(resolve => setTimeout(resolve, 20))
    }
    return true
}

function isRunning(pid: number): boolean {
    try {
        process.kill(pid, 0)
        return true
    } catch (error) {
        return (error as NodeJS.ErrnoException).code !== 'ESRCH'
    }
}
