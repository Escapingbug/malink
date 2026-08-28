import { describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { resolveMalinkMcpServerCommand } from '@/providers/acp'

describe('resolveMalinkMcpServerCommand', () => {
    it('uses the release-pinned MCP stdio entry beside the ops directory', () => {
        const root = resolve('fake-release')
        const nodePath = resolve(root, 'runtime', 'node')
        const builtEntry = resolve(root, 'mcp', 'stdio.js')

        const command = resolveMalinkMcpServerCommand({
            moduleUrl: pathToFileURL(resolve(root, 'ops', 'matrix-local-gateway.js')).href,
            cwd: root,
            nodePath,
            pathExists: path => path === builtEntry,
        })

        expect(command).toEqual({
            command: nodePath,
            args: [builtEntry],
        })
    })

    it('uses the built MCP stdio entry when dist exists', () => {
        const root = resolve('fake-project')
        const nodePath = resolve(root, 'node')
        const builtEntry = resolve(root, 'dist', 'mcp', 'stdio.js')
        const moduleUrl = pathToFileURL(resolve(root, 'dist', 'daemon.js')).href

        const command = resolveMalinkMcpServerCommand({
            moduleUrl,
            cwd: root,
            nodePath,
            pathExists: (path) => path === builtEntry,
        })

        expect(command).toEqual({
            command: nodePath,
            args: [builtEntry],
        })
    })

    it('launches the source MCP stdio entry through local tsx in development', () => {
        const root = resolve('fake-project')
        const nodePath = resolve(root, 'node')
        const sourceEntry = resolve(root, 'src', 'mcp', 'stdio.ts')
        const tsxCli = resolve(root, 'node_modules', 'tsx', 'dist', 'cli.mjs')
        const existingPaths = new Set([sourceEntry, tsxCli])

        const command = resolveMalinkMcpServerCommand({
            moduleUrl: pathToFileURL(resolve(root, 'src', 'providers', 'acp', 'index.ts')).href,
            cwd: root,
            nodePath,
            pathExists: (path) => existingPaths.has(path),
        })

        expect(command).toEqual({
            command: nodePath,
            args: [tsxCli, sourceEntry],
        })
    })
})
