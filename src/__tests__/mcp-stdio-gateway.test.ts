import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join, resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { expect, it } from 'vitest'

it('boots the Gateway MCP subprocess and delivers an image through the bound session route', async () => {
    const directory = await mkdtemp('/tmp/malink-mcp-')
    const socketPath = join(directory, 'admin.sock')
    const requests: Array<{ url?: string; body: unknown }> = []
    const server = createServer(async (request, response) => {
        const chunks: Buffer[] = []
        for await (const chunk of request) chunks.push(Buffer.from(chunk))
        requests.push({ url: request.url, body: JSON.parse(Buffer.concat(chunks).toString()) })
        response.setHeader('Content-Type', 'application/json')
        response.end(JSON.stringify({ status: 'queued', deliveryId: 'image-delivery-1' }))
    })
    const client = new Client({ name: 'malink-test', version: '1.0.0' })
    const transport = new StdioClientTransport({
        command: process.execPath,
        args: [resolve('node_modules/tsx/dist/cli.mjs'), resolve('src/mcp/stdio.ts')],
        env: {
            PATH: process.env.PATH ?? '',
            MALINK_CHANNEL: 'matrix',
            MALINK_SESSION_ID: 'bound-session',
            MALINK_SESSION_CWD: '/repo',
            MALINK_CONVERSATION_ID: 'restored-provider-session',
            MALINK_GATEWAY_ADMIN_SOCKET: socketPath,
        },
        stderr: 'pipe',
    })
    try {
        await new Promise<void>((resolve, reject) => {
            server.once('error', reject)
            server.listen(socketPath, resolve)
        })
        await client.connect(transport)
        expect(client.getInstructions()).toContain('PWA or Android')
        expect((await client.listTools()).tools.map(tool => tool.name).sort())
            .toEqual(['get_malink_context', 'send_file'])
        const context = await client.readResource({ uri: 'malink://session' })
        expect(context.contents[0]).toMatchObject({ text: expect.stringContaining('bound-session') })
        const result = await client.callTool({ name: 'send_file', arguments: {
            path: '/repo/image.png', type: 'image', caption: 'Result', sessionId: 'other-session',
        } })
        expect(result.isError).not.toBe(true)
        expect(result.content).toEqual([{ type: 'text', text: expect.stringContaining('image-delivery-1') }])
        expect(requests).toEqual([{ url: '/v1/session-files', body: {
            sessionId: 'bound-session', path: '/repo/image.png', type: 'image', caption: 'Result',
        } }])
    } finally {
        await client.close()
        await transport.close()
        if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
        await rm(directory, { recursive: true, force: true })
    }
}, 15_000)
