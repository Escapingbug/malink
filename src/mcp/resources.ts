import { z } from 'zod'
import {
    isMatrixMcpEnvironment,
    malinkAgentInstructions,
    readMalinkEnvironment,
} from '@/runtime/malinkEnvironment'
import {
    registerContextResources as registerTelegramResources,
    registerContextTools as registerTelegramTools,
} from './legacy/telegramResources'

function matrixTopics(): Record<string, string> {
    const environment = readMalinkEnvironment()
    return {
        environment: malinkAgentInstructions(environment.fileDelivery),
        session: JSON.stringify({
            channel: 'matrix',
            ...environment,
            capabilities: ['get_malink_context', ...(environment.fileDelivery ? ['send_file'] : [])],
        }, null, 2),
        rendering: [
            'Malink clients render Markdown, including code blocks and tables. Do not use Telegram HTML or Telegram table-image markers.',
            'Use send_file with type=document (or file) for downloadable artifacts, type=image for image previews, type=markdown for rendered Markdown, or type=code with language for fenced code.',
            'For long reports, deliver the file and give a brief explanation in the conversation. Local filesystem paths alone do not deliver files.',
        ].join('\n'),
        commands: 'The user controls prompts, cancellation, session settings and permissions through the Malink client. Do not advertise legacy Telegram slash commands. Only use commands and tools exposed by the current provider and client.',
        channel: 'Channel: Matrix / Malink PWA and Android. Each session has its own conversation thread. Gateway deliveries use signed, application-encrypted MLP messages and attachments. The Gateway outbox owns delivery retries; queued does not mean received or read. Do not send ordinary Matrix messages or access another conversation to bypass this route.',
    }
}

export function registerContextResources(server: any): void {
    if (!isMatrixMcpEnvironment()) return registerTelegramResources(server)
    for (const topic of Object.keys(matrixTopics())) {
        server.resource(
            `Malink ${topic[0]!.toUpperCase()}${topic.slice(1)}`,
            `malink://${topic}`,
            { description: `Malink ${topic} context`, mimeType: 'text/markdown' },
            async () => ({ contents: [{
                uri: `malink://${topic}`,
                mimeType: 'text/markdown',
                text: matrixTopics()[topic],
            }] }),
        )
    }
}

export function registerContextTools(server: any): void {
    if (!isMatrixMcpEnvironment()) return registerTelegramTools(server)
    server.tool(
        'get_malink_context',
        'Read the current Malink environment, bound session identity, file delivery capabilities and rendering guidance.',
        { topic: z.enum(['environment', 'session', 'rendering', 'commands', 'channel']).optional() },
        async (args: { topic?: string }) => {
            const topics = matrixTopics()
            return { content: [{
                type: 'text' as const,
                text: args.topic ? topics[args.topic] : `${topics.environment}\n\n${topics.session}`,
            }] }
        },
    )
}
