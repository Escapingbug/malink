/** Host context shared by ACP prompt injection and the Gateway MCP surface. */
export interface MalinkEnvironment {
    sessionId?: string
    cwd?: string
    fileDelivery: boolean
}

export function isMatrixMcpEnvironment(env: NodeJS.ProcessEnv = process.env): boolean {
    return env.MALINK_CHANNEL === 'matrix' || Boolean(env.MALINK_GATEWAY_ADMIN_SOCKET?.trim())
}

export function readMalinkEnvironment(env: NodeJS.ProcessEnv = process.env): MalinkEnvironment {
    const sessionId = env.MALINK_SESSION_ID?.trim() || undefined
    return {
        sessionId,
        cwd: env.MALINK_SESSION_CWD?.trim() || undefined,
        fileDelivery: Boolean(sessionId && env.MALINK_GATEWAY_ADMIN_SOCKET?.trim()),
    }
}

export function malinkAgentInstructions(toolsAvailable: boolean): string {
    return [
        'You are running inside Malink, a remote agent workspace. The user communicates through the Malink PWA or Android client over Matrix, not your local CLI.',
        'Your text responses appear in the current conversation. The user cannot directly access your terminal or local files. Use clear Markdown and do not rely on terminal UI or local paths as delivered artifacts.',
        toolsAvailable
            ? 'Malink MCP tools are attached. Use get_malink_context for environment and session details. Use send_file with an absolute local path to deliver files to this conversation: type=image for an image preview, type=document for a downloadable file, type=markdown or type=code for rendered text. A queued result is not confirmed delivery; report failures accurately.'
            : 'Malink file delivery is unavailable for this turn. Do not assume Malink tools are attached or claim to have delivered files. Explain this limitation when file delivery is needed.',
        'Use only tools actually exposed in this session. Environment context does not grant additional permissions or authorize contacting other conversations.',
    ].join('\n')
}
