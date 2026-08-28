import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import {
    access,
    chmod,
    mkdir,
    lstat,
    open,
    readFile,
    readlink,
    realpath,
    rename,
    rm,
    symlink,
} from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { GatewayAdminClient } from '../gateway/admin/client.js'

export interface MacosGatewayReleaseOptions {
    releaseDirectory: string
    installRoot: string
    launchAgentPath: string
    serviceLabel: string
    adminSocketPath: string
    healthTimeoutMs?: number
    expectedBuildId?: string
    rollbackBuildId?: string
    requireDeepHealth?: boolean
    syncFreshnessMs?: number
    probationMs?: number
}

export interface MacosGatewayReleaseDependencies {
    restart?: (reloadLaunchAgent: boolean) => Promise<void>
    healthCheck?: (expectedBuildId?: string) => Promise<void>
    sleep?: (milliseconds: number) => Promise<void>
    launchctl?: (arguments_: readonly string[]) => Promise<void>
    onActivated?: () => void | Promise<void>
}

/**
 * Activates a prepared release through a stable symlink. Once the LaunchAgent
 * points at `current`, later deployments never unload it: launchd remains the
 * recovery owner while the release switch and rollback are atomic renames.
 */
export async function activateMacosGatewayRelease(
    input: MacosGatewayReleaseOptions,
    dependencies: MacosGatewayReleaseDependencies = {},
): Promise<void> {
    const releaseDirectory = resolve(input.releaseDirectory)
    const installRoot = resolve(input.installRoot)
    const currentLink = join(installRoot, 'current')
    const launchAgentPath = resolve(input.launchAgentPath)
    await validateMacosGatewayRelease(releaseDirectory)
    await mkdir(installRoot, { recursive: true })

    const previousTarget = await readLinkIfPresent(currentLink)
    const originalPlist = await readFile(launchAgentPath, 'utf8')
    const stablePlist = stableLaunchAgentPlist(
        originalPlist,
        currentLink,
        installRoot,
        dirname(releaseDirectory),
        [previousTarget, releaseDirectory].filter((value): value is string => Boolean(value)),
    )
    const reloadLaunchAgent = stablePlist !== originalPlist
    const sleep = dependencies.sleep ?? (milliseconds =>
        new Promise(resolveDelay => setTimeout(resolveDelay, milliseconds)))
    const restart = dependencies.restart ?? (reload =>
        restartLaunchAgent(
            input.serviceLabel,
            launchAgentPath,
            reload,
            dependencies.launchctl ?? runLaunchctl,
            sleep,
        ))
    const defaultHealthCheck = (expectedBuildId?: string) => () =>
        new GatewayAdminClient({
            socketPath: input.adminSocketPath,
            timeoutMs: 2_000,
        }).status().then(status => {
            if (status.state !== 'running') {
                throw new Error(`Gateway reported ${status.state}`)
            }
            if (expectedBuildId && status.buildId !== expectedBuildId) {
                throw new Error(
                    `Gateway reported build ${status.buildId ?? '(missing)'}; `
                    + `expected ${expectedBuildId}`,
                )
            }
            if (input.requireDeepHealth) {
                if (status.matrixReady !== true || typeof status.lastMatrixSyncAt !== 'number') {
                    throw new Error('Gateway Matrix synchronization is not ready')
                }
                const freshnessMs = input.syncFreshnessMs ?? 120_000
                if (Date.now() - status.lastMatrixSyncAt > freshnessMs) {
                    throw new Error('Gateway Matrix synchronization is stale')
                }
                if (status.pendingInboxEvents === undefined) {
                    throw new Error('Gateway durable inbox diagnostics are unavailable')
                }
            }
        })
    const targetHealthCheck = dependencies.healthCheck
        ? () => dependencies.healthCheck?.(input.expectedBuildId) ?? Promise.resolve()
        : defaultHealthCheck(input.expectedBuildId)
    const rollbackHealthCheck = dependencies.healthCheck
        ? () => dependencies.healthCheck?.(input.rollbackBuildId) ?? Promise.resolve()
        : defaultHealthCheck(input.rollbackBuildId)
    if (reloadLaunchAgent) await atomicWrite(launchAgentPath, stablePlist)
    await replaceSymlink(currentLink, releaseDirectory)
    try {
        await restart(reloadLaunchAgent)
        await waitForHealth(targetHealthCheck, sleep, input.healthTimeoutMs ?? 30_000)
        await dependencies.onActivated?.()
        await verifyProbation(
            targetHealthCheck,
            sleep,
            input.probationMs ?? 0,
        )
    } catch (activationError) {
        try {
            if (previousTarget) await replaceSymlink(currentLink, previousTarget)
            else await rm(currentLink, { force: true })
            if (reloadLaunchAgent) await atomicWrite(launchAgentPath, originalPlist)
            await restart(reloadLaunchAgent)
            await waitForHealth(rollbackHealthCheck, sleep, input.healthTimeoutMs ?? 30_000)
        } catch (rollbackError) {
            throw new Error(
                `Matrix Gateway activation failed and rollback also failed: ${formatError(rollbackError)}`,
                { cause: activationError },
            )
        }
        throw new Error(
            `Matrix Gateway activation failed and was rolled back: ${formatError(activationError)}`,
            { cause: activationError },
        )
    }
}

export async function validateMacosGatewayRelease(releaseDirectory: string): Promise<void> {
    const root = await realpath(releaseDirectory)
    const runtime = join(root, 'runtime', 'node')
    const entrypoint = join(root, 'ops', 'matrix-local-gateway.js')
    const mcpEntrypoint = join(root, 'mcp', 'stdio.js')
    for (const path of [runtime, entrypoint, mcpEntrypoint]) {
        const metadata = await lstat(path).catch(error => {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                throw new Error(`Required Gateway release path is missing: ${path}`)
            }
            throw error
        })
        if (metadata.isSymbolicLink() || !metadata.isFile()) {
            throw new Error(`Gateway release path is not a regular file: ${path}`)
        }
        const resolved = await realpath(path)
        if (!resolved.startsWith(`${root}/`)) {
            throw new Error(`Gateway release path escapes its root: ${path}`)
        }
    }
    await access(runtime, constants.X_OK)
        .catch(async () => {
            await access(runtime, constants.F_OK)
            await chmod(runtime, 0o755)
        })
    await access(entrypoint, constants.R_OK)
    await access(mcpEntrypoint, constants.R_OK)
}

function stableLaunchAgentPlist(
    plist: string,
    currentLink: string,
    installRoot: string,
    releasesRoot: string,
    releaseDirectories: readonly string[],
): string {
    let migrated = plist
    if (!migrated.includes(currentLink)) {
        for (const releaseDirectory of releaseDirectories) {
            if (!migrated.includes(releaseDirectory)) continue
            migrated = migrated.replaceAll(releaseDirectory, currentLink)
            break
        }
        if (migrated === plist) {
            const releasePath = new RegExp(
                `${escapeRegExp(releasesRoot)}/[^/\\s<]+`,
                'gu',
            )
            migrated = plist.replace(releasePath, currentLink)
        }
    }
    if (!migrated.includes(currentLink)) {
        throw new Error(
            'LaunchAgent does not reference either the stable current link or the release being activated.',
        )
    }

    // Never leave a long-running Gateway inside the atomically switched
    // `current` symlink. macOS descendants can block in getcwd() after a
    // release swap, starving ACP stdio and turning healthy session opens into
    // timeouts. Executables remain release-pinned through absolute paths while
    // the process cwd stays on the stable install root.
    return migrated.replace(
        /(<key>WorkingDirectory<\/key>\s*<string>)([^<]*)(<\/string>)/u,
        (_match, prefix: string, workingDirectory: string, suffix: string) => {
            const isReleaseDirectory = workingDirectory === currentLink
                || workingDirectory.startsWith(`${releasesRoot}/`)
            return isReleaseDirectory
                ? `${prefix}${installRoot}${suffix}`
                : `${prefix}${workingDirectory}${suffix}`
        },
    )
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

async function replaceSymlink(path: string, target: string): Promise<void> {
    const temporary = `${path}.next.${process.pid}.${randomUUID()}`
    await symlink(target, temporary)
    try {
        await rename(temporary, path)
        await syncDirectory(dirname(path))
    } finally {
        await rm(temporary, { force: true })
    }
}

async function atomicWrite(path: string, content: string): Promise<void> {
    const temporary = `${path}.next.${process.pid}.${randomUUID()}`
    await mkdir(dirname(path), { recursive: true })
    const handle = await open(temporary, 'wx', 0o644)
    try {
        await handle.writeFile(content, 'utf8')
        await handle.sync()
    } finally {
        await handle.close()
    }
    await rename(temporary, path)
    await syncDirectory(dirname(path))
}

async function syncDirectory(path: string): Promise<void> {
    const handle = await open(path, 'r')
    try {
        await handle.sync()
    } finally {
        await handle.close()
    }
}

async function readLinkIfPresent(path: string): Promise<string | null> {
    try {
        return await readlink(path)
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw error
    }
}

async function restartLaunchAgent(
    label: string,
    plistPath: string,
    reload: boolean,
    launchctl: (arguments_: readonly string[]) => Promise<void>,
    sleep: (milliseconds: number) => Promise<void>,
): Promise<void> {
    const userDomain = `gui/${process.getuid?.() ?? 0}`
    const service = `${userDomain}/${label}`
    if (reload) {
        await launchctl(['bootout', service]).catch(() => undefined)
        await bootstrapLaunchAgent(launchctl, userDomain, plistPath, sleep)
    }
    try {
        await launchctl(['kickstart', '-k', service])
    } catch (error) {
        if (reload) throw error
        await bootstrapLaunchAgent(launchctl, userDomain, plistPath, sleep)
        await launchctl(['kickstart', '-k', service])
    }
}

async function bootstrapLaunchAgent(
    launchctl: (arguments_: readonly string[]) => Promise<void>,
    userDomain: string,
    plistPath: string,
    sleep: (milliseconds: number) => Promise<void>,
): Promise<void> {
    let lastError: unknown = new Error('launchctl bootstrap did not run')
    for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
            await launchctl(['bootstrap', userDomain, plistPath])
            return
        } catch (error) {
            lastError = error
        }
        if (attempt < 4) await sleep(250 * (attempt + 1))
    }
    throw lastError
}

function runLaunchctl(arguments_: readonly string[]): Promise<void> {
    return new Promise((resolveRun, reject) => {
        const child = spawn('/bin/launchctl', arguments_, { stdio: 'inherit' })
        child.once('error', reject)
        child.once('exit', code => {
            if (code === 0) resolveRun()
            else reject(new Error(`launchctl ${arguments_.join(' ')} exited with ${code}`))
        })
    })
}

async function waitForHealth(
    healthCheck: () => Promise<void>,
    sleep: (milliseconds: number) => Promise<void>,
    timeoutMs: number,
): Promise<void> {
    const deadline = Date.now() + timeoutMs
    let lastError: unknown = new Error('Gateway health check did not run')
    do {
        try {
            await healthCheck()
            return
        } catch (error) {
            lastError = error
        }
        await sleep(Math.min(250, Math.max(0, deadline - Date.now())))
    } while (Date.now() < deadline)
    throw new Error(`Gateway did not become healthy: ${formatError(lastError)}`)
}

async function verifyProbation(
    healthCheck: () => Promise<void>,
    sleep: (milliseconds: number) => Promise<void>,
    probationMs: number,
): Promise<void> {
    if (!Number.isFinite(probationMs) || probationMs < 0) {
        throw new RangeError('Gateway probation duration must be non-negative')
    }
    if (probationMs === 0) return
    const deadline = Date.now() + probationMs
    while (Date.now() < deadline) {
        await sleep(Math.min(1_000, Math.max(0, deadline - Date.now())))
        await healthCheck()
    }
}

function formatError(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}
