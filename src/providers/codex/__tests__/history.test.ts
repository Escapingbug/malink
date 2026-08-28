import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import {
    parseCodexThreadHistory,
    readCodexSessionHistory,
    type SpawnCodexHistoryProcess,
} from '../history'

describe('parseCodexThreadHistory', () => {
    it('maps only user and agent messages from Codex thread turns', () => {
        expect(parseCodexThreadHistory('thread-1', {
            id: 'thread-1',
            name: null,
            preview: 'Fallback preview',
            turns: [
                {
                    items: [
                        {
                            type: 'userMessage',
                            id: 'user-1',
                            content: [
                                { type: 'text', text: 'Hello ' },
                                { type: 'image', url: 'file:///tmp/image.png' },
                                { type: 'text', text: 'world' },
                            ],
                        },
                        { type: 'reasoning', id: 'reasoning-1', summary: ['Private thought'] },
                        { type: 'agentMessage', id: 'agent-1', text: 'First answer' },
                        { type: 'fileChange', id: 'tool-1', changes: [] },
                    ],
                },
                {
                    items: [
                        { type: 'agentMessage', id: 'agent-1', text: ' continued' },
                        { type: 'agentMessage', id: 'agent-2', text: 'Second answer' },
                    ],
                },
            ],
        })).toEqual({
            sessionId: 'thread-1',
            title: 'Hello world',
            messages: [
                { id: 'user-1', role: 'user', text: 'Hello world' },
                { id: 'agent-1', role: 'assistant', text: 'First answer continued' },
                { id: 'agent-2', role: 'assistant', text: 'Second answer' },
            ],
        })
    })

    it('rejects a response for a different thread', () => {
        expect(() => parseCodexThreadHistory('thread-1', {
            id: 'thread-2',
            turns: [],
        })).toThrow('different session')
    })

    it('rejects history from a thread outside the project working directory', () => {
        expect(() => parseCodexThreadHistory('thread-1', {
            id: 'thread-1',
            cwd: '/other-project',
            turns: [],
        }, '/project')).toThrow('outside this project')
    })
})

describe('readCodexSessionHistory', () => {
    it('uses thread/read without resuming or claiming a writer', async () => {
        const process = new FakeCodexHistoryProcess({
            id: 'thread-active',
            cwd: '/project',
            name: 'Active thread',
            turns: [{
                items: [
                    {
                        type: 'userMessage',
                        id: 'user-1',
                        content: [{ type: 'text', text: 'Inspect me' }],
                    },
                    { type: 'agentMessage', id: 'agent-1', text: 'Visible history' },
                ],
            }],
        })
        const spawnCalls: Array<{ command: string; args: string[] }> = []
        const spawnProcess: SpawnCodexHistoryProcess = (command, args) => {
            spawnCalls.push({ command, args })
            return process
        }

        await expect(readCodexSessionHistory({
            sessionId: 'thread-active',
            cwd: '/project',
            command: '/opt/codex/bin/codex',
            commandArgs: ['/opt/malink/codex-acp.js', 'cli'],
            spawnProcess,
        })).resolves.toEqual({
            sessionId: 'thread-active',
            title: 'Active thread',
            messages: [
                { id: 'user-1', role: 'user', text: 'Inspect me' },
                { id: 'agent-1', role: 'assistant', text: 'Visible history' },
            ],
        })
        expect(spawnCalls).toEqual([{
            command: '/opt/codex/bin/codex',
            args: [
                '/opt/malink/codex-acp.js',
                'cli',
                'app-server',
                '--listen',
                'stdio://',
            ],
        }])
        expect(process.requests.map(request => request.method)).toEqual([
            'initialize',
            'thread/read',
        ])
        expect(process.requests).not.toContainEqual(expect.objectContaining({
            method: 'thread/resume',
        }))
        expect(process.exitCode).toBe(0)
    })
})

class FakeCodexHistoryProcess extends EventEmitter {
    readonly stdin = new PassThrough()
    readonly stdout = new PassThrough()
    readonly stderr = new PassThrough()
    readonly pid = 12345
    readonly requests: Array<Record<string, unknown>> = []
    exitCode: number | null = null
    signalCode: NodeJS.Signals | null = null
    private input = ''

    constructor(private readonly thread: unknown) {
        super()
        this.stdin.on('data', chunk => {
            this.input += String(chunk)
            for (;;) {
                const newline = this.input.indexOf('\n')
                if (newline < 0) break
                const line = this.input.slice(0, newline)
                this.input = this.input.slice(newline + 1)
                const request = JSON.parse(line) as Record<string, unknown>
                this.requests.push(request)
                if (request.id === 1) {
                    this.respond({ jsonrpc: '2.0', id: 1, result: { userAgent: 'fake' } })
                } else if (request.id === 2) {
                    this.respond({ jsonrpc: '2.0', id: 2, result: { thread: this.thread } })
                }
            }
        })
        this.stdin.on('finish', () => this.exit(0, null))
    }

    kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
        this.exit(null, signal)
        return true
    }

    private respond(value: unknown): void {
        queueMicrotask(() => this.stdout.write(`${JSON.stringify(value)}\n`))
    }

    private exit(exitCode: number | null, signal: NodeJS.Signals | null): void {
        if (this.exitCode !== null || this.signalCode !== null) return
        this.exitCode = exitCode
        this.signalCode = signal
        this.emit('exit', exitCode, signal)
    }
}
