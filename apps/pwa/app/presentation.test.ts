import { describe, expect, it } from 'vitest'
import {
    messageFormat,
    parseToolGroupPresentation,
} from './presentation'

describe('PWA structured presentation parsing', () => {
    it('accepts a bounded, typed tool group snapshot', () => {
        expect(parseToolGroupPresentation({
            kind: 'tool_group',
            version: 1,
            groupId: 'group-1',
            tools: [
                {
                    id: 'tool-1',
                    name: 'Bash',
                    title: 'Bash',
                    detail: 'npm test',
                    category: 'execute',
                    phase: 'completed',
                    isError: false,
                    startedAt: 1_000,
                    updatedAt: 2_000,
                },
                {
                    id: 'tool-2',
                    name: 'Read',
                    title: '/repo/app.ts',
                    category: 'read',
                    phase: 'updated',
                    isError: false,
                    startedAt: 2_100,
                    updatedAt: 2_200,
                },
            ],
        })).toMatchObject({
            groupId: 'group-1',
            tools: [
                { id: 'tool-1', detail: 'npm test' },
                { id: 'tool-2', phase: 'updated' },
            ],
        })
    })

    it('preserves tool details and results beyond the former preview limit', () => {
        const detail = `printf '${'input '.repeat(120)}'`
        const result = `first line\n${'output '.repeat(180)}\nimportant final line`
        const parsed = parseToolGroupPresentation({
            kind: 'tool_group',
            version: 1,
            groupId: 'long-tool-group',
            tools: [{
                id: 'long-tool',
                name: 'Bash',
                title: 'Bash',
                detail,
                result,
                category: 'execute',
                phase: 'completed',
                isError: false,
                startedAt: 1_000,
                updatedAt: 2_000,
            }],
        })

        expect(parsed?.tools[0]?.detail).toBe(detail)
        expect(parsed?.tools[0]?.result).toBe(result)
    })

    it('rejects malformed tool groups and unsafe format declarations', () => {
        expect(parseToolGroupPresentation({
            kind: 'tool_group',
            version: 1,
            groupId: 'group-1',
            tools: [{ id: 'missing-required-fields' }],
        })).toBeUndefined()
        expect(messageFormat('markdown')).toBe('markdown')
        expect(messageFormat('org.matrix.custom.html')).toBe('plain')
        expect(messageFormat('<script>')).toBe('plain')
    })

})
