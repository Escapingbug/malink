import { registerContextResources, registerContextTools } from './resources'
import { registerNotifyTools, registerSendFileTool } from './tools/notify'
import { registerSessionTools, type SessionToolContext } from './tools/session'
import { registerPrivilegeTools } from './tools/privilege'

export interface MalinkMcpRegistrationOptions {
    includeNotifyTools?: boolean
    sessionTools?: SessionToolContext
}

export function registerMalinkMcpSurface(server: any, options: MalinkMcpRegistrationOptions = {}): void {
    registerContextResources(server)
    registerContextTools(server)

    const includeNotifyTools = options.includeNotifyTools ?? hasSessionIdentity()
    if (includeNotifyTools) {
        registerNotifyTools(server)
    } else if (options.includeNotifyTools === undefined) {
        registerSendFileTool(server)
    }

    if (options.sessionTools) {
        registerSessionTools(server, options.sessionTools)
    }

    registerPrivilegeTools(server)
}

function hasSessionIdentity(): boolean {
    return Boolean(process.env.MALINK_CONVERSATION_ID?.trim())
}
