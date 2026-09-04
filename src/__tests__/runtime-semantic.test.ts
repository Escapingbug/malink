import { describe, expect, it } from 'vitest'
import { createProviderSemanticAdapter, DefaultProviderSemanticAdapter } from '@/runtime/providerAdapter'
import type { AgentEvent } from '@/providers/types'
import { mapSessionUpdate } from '@/providers/acp/eventAdapter'
import { ChannelProjector } from '@/runtime/channelProjector'

describe('DefaultProviderSemanticAdapter', () => {
    it('projects a passive client integration entry without making it a decision', () => {
        const projector = new ChannelProjector()
        const [projected] = projector.project({
            kind: 'integration_entry',
            meta: {
                id: 'integration-entry-1',
                sessionId: 'session-1',
                turnId: 'turn-1',
                provider: 'test-provider',
                seq: 1,
                timestamp: 1,
                sourcePhase: 'live',
            },
            presentation: {
                kind: 'integration_entry',
                version: 1,
                integrationId: 'metapp',
                routeId: 'artifact.preview',
                resourceRef: 'artifact-1',
                title: 'Project report',
                description: 'Rendered by metapp.',
            },
        })

        expect(projected).toMatchObject({
            isToolEvent: false,
            isTerminal: false,
            message: {
                text: 'Rendered by metapp.',
                integrationEntry: {
                    kind: 'integration_entry',
                    resourceRef: 'artifact-1',
                },
            },
        })
    })

    it('maps provider text into assistant text deltas', () => {
        const adapter = new DefaultProviderSemanticAdapter('test-provider')

        const events = adapter.toConversationEvents(
            { kind: 'text', text: 'hello' },
            { sessionId: 's1', turnId: 't1', provider: 'test-provider' },
        )

        expect(events).toHaveLength(1)
        expect(events[0]).toMatchObject({
            kind: 'assistant_text_delta',
            text: 'hello',
            messageId: 't1:assistant-message:1',
            meta: {
                sessionId: 's1',
                turnId: 't1',
                provider: 'test-provider',
                sourcePhase: 'live',
            },
        })
    })

    it('preserves provider message identity and creates a new fallback block after tools', () => {
        const adapter = new DefaultProviderSemanticAdapter('test-provider')
        const context = { sessionId: 's1', turnId: 't1', provider: 'test-provider' }

        const explicit = adapter.toConversationEvents(
            { kind: 'text', text: 'one', messageId: 'provider-message-1' },
            context,
        )[0]
        const firstAnonymous = adapter.toConversationEvents(
            { kind: 'text', text: 'two' },
            context,
        )[0]
        const secondAnonymous = adapter.toConversationEvents(
            { kind: 'text', text: 'three' },
            context,
        )[0]
        adapter.toConversationEvents({
            kind: 'tool_use',
            toolUseId: 'tool-1',
            toolName: 'Read',
            input: { path: 'README.md' },
        }, context)
        const afterTool = adapter.toConversationEvents(
            { kind: 'text', text: 'four' },
            context,
        )[0]
        const nextTurn = adapter.toConversationEvents(
            { kind: 'text', text: 'five' },
            { ...context, turnId: 't2' },
        )[0]

        expect(explicit).toMatchObject({ messageId: 'provider-message-1' })
        expect(firstAnonymous).toMatchObject({ messageId: 't1:assistant-message:1' })
        expect(secondAnonymous).toMatchObject({ messageId: 't1:assistant-message:1' })
        expect(afterTool).toMatchObject({ messageId: 't1:assistant-message:2' })
        expect(nextTurn).toMatchObject({ messageId: 't2:assistant-message:3' })
    })

    it('keeps the ACP message id on live text chunks', () => {
        const events = mapSessionUpdate({
            sessionUpdate: 'agent_message_chunk',
            messageId: '018f4f65-99d1-7f39-b4ef-31f676531abc',
            content: { type: 'text', text: 'delta' },
        } as Parameters<typeof mapSessionUpdate>[0])

        expect(events).toEqual([
            {
                kind: 'text',
                text: 'delta',
                messageId: '018f4f65-99d1-7f39-b4ef-31f676531abc',
            },
        ])
    })

    it('maps tool lifecycle events into canonical tool events', () => {
        const adapter = new DefaultProviderSemanticAdapter('test-provider')
        const toolUse: AgentEvent = {
            kind: 'tool_use',
            toolUseId: 'tool-1',
            toolName: 'Bash',
            status: 'running',
            input: { command: 'npm test' },
        }
        const toolResult: AgentEvent = {
            kind: 'tool_result',
            toolUseId: 'tool-1',
            toolName: 'Bash',
            output: 'ok',
            isError: false,
        }

        const started = adapter.toConversationEvents(toolUse, { sessionId: 's1', turnId: 't1', provider: 'test-provider' })
        const completed = adapter.toConversationEvents(toolResult, { sessionId: 's1', turnId: 't1', provider: 'test-provider' })

        expect(started[0]).toMatchObject({
            kind: 'tool',
            phase: 'updated',
            toolCallId: 'tool-1',
            toolName: 'Bash',
            category: 'execute',
        })
        expect(completed[0]).toMatchObject({
            kind: 'tool',
            phase: 'completed',
            toolCallId: 'tool-1',
            output: 'ok',
            isError: false,
        })
    })

    it('uses one stable final event id per turn result', () => {
        const adapter = new DefaultProviderSemanticAdapter('test-provider')
        const context = { sessionId: 's1', turnId: 't1', provider: 'test-provider' }

        const first = adapter.toConversationEvents({ kind: 'result', status: 'success' }, context)
        const second = adapter.toConversationEvents({ kind: 'result', status: 'success' }, context)

        expect(first[0].meta.id).toBe('t1:result')
        expect(second[0].meta.id).toBe('t1:result')
    })
})

describe('ACP tool label fidelity', () => {
    it.each([
        ['Bash', 'execute', 'Bash', undefined],
        ['Terminal', 'execute', 'Terminal', undefined],
        ['Grep', 'search', 'Grep', undefined],
        ['Web Search', 'search', 'Search', 'Web Search'],
        ['Find', 'search', 'Search', 'Find'],
        ['Python runner', 'execute', 'Execute', 'Python runner'],
    ] as const)(
        'keeps provider title %s distinct from its %s category',
        (title, kind, expectedName, expectedDisplayTitle) => {
            const [event] = mapSessionUpdate({
                sessionUpdate: 'tool_call',
                toolCallId: `tool-${title}`,
                title,
                kind,
                status: 'pending',
                rawInput: {},
            } as Parameters<typeof mapSessionUpdate>[0])

            expect(event).toMatchObject({
                kind: 'tool_use',
                toolName: expectedName,
                toolKind: kind,
            })
            if (expectedDisplayTitle) {
                expect(event).toMatchObject({ displayTitle: expectedDisplayTitle })
            } else {
                expect(event).not.toHaveProperty('displayTitle')
            }
        },
    )

    it.each([
        {
            title: 'Python runner',
            kind: 'execute',
            rawInput: { command: 'python -m pytest' },
            expectedName: 'Python runner',
            expectedCategory: 'execute',
            expectedDetail: 'python -m pytest',
            forbiddenName: 'Bash',
        },
        {
            title: 'Web Search',
            kind: 'search',
            rawInput: { query: 'ACP tool kinds' },
            expectedName: 'Web Search',
            expectedCategory: 'search',
            expectedDetail: 'ACP tool kinds',
            forbiddenName: 'Grep',
        },
    ] as const)(
        'projects $title with its provider label instead of $forbiddenName',
        ({ title, kind, rawInput, expectedName, expectedCategory, expectedDetail, forbiddenName }) => {
            const adapter = createProviderSemanticAdapter('agent')
            const projector = new ChannelProjector()
            const messages = mapSessionUpdate({
                sessionUpdate: 'tool_call',
                toolCallId: `tool-${kind}`,
                title,
                kind,
                status: 'pending',
                rawInput,
            } as Parameters<typeof mapSessionUpdate>[0]).flatMap((event) =>
                adapter.toConversationEvents(event, {
                    sessionId: 'session-1',
                    turnId: 'turn-1',
                    provider: 'agent',
                }).flatMap((semanticEvent) => projector.project(semanticEvent)),
            )

            expect(messages[0]?.message.presentation).toMatchObject({
                kind: 'tool_group',
                tools: [{
                    name: expectedName,
                    category: expectedCategory,
                    detail: expectedDetail,
                }],
            })
            expect(messages[0]?.message.text).toContain(title)
            expect(messages[0]?.message.text).not.toContain(forbiddenName)
        },
    )

    it('does not replace an explicit Grep label with a later search fallback', () => {
        const adapter = createProviderSemanticAdapter('agent')
        const context = {
            sessionId: 'session-1',
            turnId: 'turn-1',
            provider: 'agent',
        }
        const [started] = mapSessionUpdate({
            sessionUpdate: 'tool_call',
            toolCallId: 'tool-grep',
            title: 'Grep',
            kind: 'search',
            status: 'pending',
            rawInput: {},
        } as Parameters<typeof mapSessionUpdate>[0])
        const [updated] = mapSessionUpdate({
            sessionUpdate: 'tool_call_update',
            toolCallId: 'tool-grep',
            title: null,
            kind: 'search',
            status: 'in_progress',
            rawInput: { query: 'tool label' },
        } as Parameters<typeof mapSessionUpdate>[0])

        adapter.toConversationEvents(started, context)
        expect(adapter.toConversationEvents(updated, context)[0]).toMatchObject({
            kind: 'tool',
            toolName: 'Grep',
            category: 'search',
            input: { pattern: 'tool label' },
        })
    })
})

describe('ChannelProjector durable tool snapshots', () => {
    it('emits the cumulative tool group once at the turn boundary', () => {
        const projector = new ChannelProjector()
        const meta = {
            id: 'tool-1',
            sessionId: 'session-1',
            turnId: 'turn-1',
            provider: 'test',
            seq: 1,
            timestamp: 1,
            sourcePhase: 'live' as const,
        }
        projector.project({
            kind: 'tool',
            meta,
            phase: 'completed',
            toolCallId: 'tool-1',
            toolName: 'Bash',
            category: 'execute',
            input: { command: 'pnpm test' },
            output: 'complete output',
        }, { preserveNormalToolGroup: true })

        const terminal = projector.project({
            kind: 'turn_finished',
            meta: { ...meta, id: 'turn-1:result', seq: 2, timestamp: 2 },
            status: 'success',
        }, { preserveNormalToolGroup: true })

        expect(terminal).toHaveLength(1)
        expect(terminal[0]).toMatchObject({
            toolUseId: 'normal-tool-group:1',
            isToolEvent: true,
            isTerminal: true,
            isFinalToolSnapshot: true,
            message: {
                presentation: {
                    kind: 'tool_group',
                    tools: [{ id: 'tool-1', phase: 'completed' }],
                },
            },
        })
        expect(terminal[0]?.message.presentation?.tools[0]).not.toHaveProperty('result')
        expect(JSON.stringify(terminal)).not.toContain('complete output')
    })
})
