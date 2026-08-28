import { mkdtemp, mkdir, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
    activateMacosGatewayRelease,
    validateMacosGatewayRelease,
} from '@/ops/macosGatewayRelease'

describe('macOS Matrix Gateway release activation', () => {
    it('rejects a release without its MCP stdio entrypoint', async () => {
        const root = await releaseFixture()
        try {
            const nextRelease = join(root, 'releases', 'next')
            await rm(join(nextRelease, 'mcp', 'stdio.js'))

            await expect(validateMacosGatewayRelease(nextRelease)).rejects.toThrow(
                /Required Gateway release path is missing: .*mcp\/stdio\.js/u,
            )
        } finally {
            await rm(root, { recursive: true, force: true })
        }
    })

    it('preserves a stable Gateway Host while switching the current entrypoint', async () => {
        const root = await releaseFixture()
        try {
            const oldRelease = join(root, 'releases', 'old')
            const nextRelease = join(root, 'releases', 'next')
            await symlink(oldRelease, join(root, 'current'))
            const plistPath = join(root, 'gateway.plist')
            const host = join(root, 'Malink Gateway Host.app', 'Contents', 'MacOS', 'MalinkGatewayHost')
            const plist = `<string>${host}</string>\n<string>${join(root, 'current', 'ops', 'matrix-local-gateway.js')}</string>`
            await writeFile(plistPath, plist)
            const restart = vi.fn(async () => undefined)

            await activateMacosGatewayRelease({
                releaseDirectory: nextRelease,
                installRoot: root,
                launchAgentPath: plistPath,
                serviceLabel: 'com.malink.test-gateway',
                adminSocketPath: join(root, 'admin.sock'),
            }, {
                restart,
                healthCheck: async () => undefined,
            })

            expect(await readlink(join(root, 'current'))).toBe(nextRelease)
            expect(await readFile(plistPath, 'utf8')).toBe(plist)
            expect(restart).toHaveBeenCalledWith(false)
        } finally {
            await rm(root, { recursive: true, force: true })
        }
    })

    it('migrates a direct-release LaunchAgent to the stable current link', async () => {
        const root = await releaseFixture()
        try {
            const oldRelease = join(root, 'releases', 'old')
            const nextRelease = join(root, 'releases', 'next')
            const plistPath = join(root, 'gateway.plist')
            await writeFile(
                plistPath,
                `<string>${join(oldRelease, 'runtime', 'node')}</string>\n`
                + `<string>${join(oldRelease, 'ops', 'matrix-local-gateway.js')}</string>\n`
                + `<key>WorkingDirectory</key>\n<string>${oldRelease}</string>`,
            )
            const restart = vi.fn(async () => undefined)

            await activateMacosGatewayRelease({
                releaseDirectory: nextRelease,
                installRoot: root,
                launchAgentPath: plistPath,
                serviceLabel: 'com.malink.test-gateway',
                adminSocketPath: join(root, 'admin.sock'),
            }, {
                restart,
                healthCheck: async () => undefined,
            })

            expect(await readlink(join(root, 'current'))).toBe(nextRelease)
            expect(await readFile(plistPath, 'utf8')).toContain(join(root, 'current'))
            expect(await readFile(plistPath, 'utf8')).not.toContain(oldRelease)
            expect(await readFile(plistPath, 'utf8')).toContain(
                `<key>WorkingDirectory</key>\n<string>${root}</string>`,
            )
            expect(restart).toHaveBeenCalledWith(true)
        } finally {
            await rm(root, { recursive: true, force: true })
        }
    })

    it('reloads a stable-link LaunchAgent whose working directory is still release-switched', async () => {
        const root = await releaseFixture()
        try {
            const nextRelease = join(root, 'releases', 'next')
            const current = join(root, 'current')
            await symlink(join(root, 'releases', 'old'), current)
            const plistPath = join(root, 'gateway.plist')
            await writeFile(
                plistPath,
                `<string>${join(current, 'runtime', 'node')}</string>\n`
                + `<string>${join(current, 'ops', 'matrix-local-gateway.js')}</string>\n`
                + `<key>WorkingDirectory</key>\n<string>${current}</string>`,
            )
            const restart = vi.fn(async () => undefined)

            await activateMacosGatewayRelease({
                releaseDirectory: nextRelease,
                installRoot: root,
                launchAgentPath: plistPath,
                serviceLabel: 'com.malink.test-gateway',
                adminSocketPath: join(root, 'admin.sock'),
            }, {
                restart,
                healthCheck: async () => undefined,
            })

            expect(await readFile(plistPath, 'utf8')).toContain(
                `<key>WorkingDirectory</key>\n<string>${root}</string>`,
            )
            expect(restart).toHaveBeenCalledWith(true)
        } finally {
            await rm(root, { recursive: true, force: true })
        }
    })

    it('retries a transient bootstrap failure after unloading the old service', async () => {
        const root = await releaseFixture()
        try {
            const oldRelease = join(root, 'releases', 'old')
            const nextRelease = join(root, 'releases', 'next')
            const plistPath = join(root, 'gateway.plist')
            await writeFile(
                plistPath,
                `<string>${join(oldRelease, 'runtime', 'node')}</string>\n<string>${join(oldRelease, 'ops', 'matrix-local-gateway.js')}</string>`,
            )
            let bootstrapAttempts = 0
            const launchctl = vi.fn(async (arguments_: readonly string[]) => {
                if (arguments_[0] === 'bootstrap' && bootstrapAttempts++ === 0) {
                    throw new Error('Bootstrap failed: 5: Input/output error')
                }
            })
            const sleep = vi.fn(async () => undefined)

            await activateMacosGatewayRelease({
                releaseDirectory: nextRelease,
                installRoot: root,
                launchAgentPath: plistPath,
                serviceLabel: 'com.malink.test-gateway',
                adminSocketPath: join(root, 'admin.sock'),
            }, {
                launchctl,
                sleep,
                healthCheck: async () => undefined,
            })

            expect(bootstrapAttempts).toBe(2)
            expect(sleep).toHaveBeenCalledWith(250)
            expect(launchctl).toHaveBeenLastCalledWith([
                'kickstart',
                '-k',
                `gui/${process.getuid?.() ?? 0}/com.malink.test-gateway`,
            ])
            expect(await readlink(join(root, 'current'))).toBe(nextRelease)
        } finally {
            await rm(root, { recursive: true, force: true })
        }
    })

    it('atomically switches the stable release and rolls back when health verification fails', async () => {
        const root = await releaseFixture()
        try {
            const oldRelease = join(root, 'releases', 'old')
            const nextRelease = join(root, 'releases', 'next')
            await symlink(oldRelease, join(root, 'current'))
            const plistPath = join(root, 'gateway.plist')
            await writeFile(plistPath, `<string>${join(root, 'current')}</string>`)
            const restart = vi.fn(async () => undefined)
            const expectedBuilds: Array<string | undefined> = []

            await expect(activateMacosGatewayRelease({
                releaseDirectory: nextRelease,
                installRoot: root,
                launchAgentPath: plistPath,
                serviceLabel: 'com.malink.test-gateway',
                adminSocketPath: join(root, 'admin.sock'),
                healthTimeoutMs: 20,
                expectedBuildId: 'build-next',
                rollbackBuildId: 'build-old',
            }, {
                restart,
                healthCheck: async expectedBuildId => {
                    expectedBuilds.push(expectedBuildId)
                    if (await readlink(join(root, 'current')) === nextRelease) {
                        throw new Error('new release is unhealthy')
                    }
                    expect(expectedBuildId).toBe('build-old')
                },
                sleep: async () => undefined,
            })).rejects.toThrow(/rolled back/i)

            expect(await readlink(join(root, 'current'))).toBe(oldRelease)
            expect(restart).toHaveBeenCalledTimes(2)
            expect(expectedBuilds).toContain('build-next')
            expect(expectedBuilds).toContain('build-old')
            expect(await readFile(plistPath, 'utf8')).toContain(join(root, 'current'))
        } finally {
            await rm(root, { recursive: true, force: true })
        }
    })
})

async function releaseFixture(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'malink-macos-release-'))
    await Promise.all(['old', 'next'].map(async name => {
        const release = join(root, 'releases', name)
        await mkdir(join(release, 'runtime'), { recursive: true })
        await mkdir(join(release, 'ops'), { recursive: true })
        await mkdir(join(release, 'mcp'), { recursive: true })
        await writeFile(join(release, 'runtime', 'node'), '#!/bin/sh\n')
        await writeFile(join(release, 'ops', 'matrix-local-gateway.js'), '// gateway\n')
        await writeFile(join(release, 'mcp', 'stdio.js'), '// mcp\n')
    }))
    return root
}
