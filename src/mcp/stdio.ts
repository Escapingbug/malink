/**
 * Malink MCP Server — Stdio entry point
 *
 * Launched as a subprocess by ACP-compatible agents via the mcpServers config.
 * Provides malink environment context via MCP resources and tools.
 *
 * Usage: node dist/mcp/stdio.js
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { registerMalinkMcpSurface } from './register'

async function main() {
    const server = new McpServer({
        name: 'malink',
        version: '1.0.0',
    })

    registerMalinkMcpSurface(server)

    const transport = new StdioServerTransport()
    await server.connect(transport)
    console.error('[malink-mcp] Server started on stdio')
}

main().catch((e) => {
    console.error('[malink-mcp] Fatal:', e)
    process.exit(1)
})
