import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type {
  AgentProvider,
  AgentQueryConfig,
  AgentQueryHandle,
  AgentQueryInput,
} from '@/providers/provider'
import type { AgentEvent } from '@/providers/types'
import { runGatewayProviderPrompt } from '../providerPrompt'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(directory =>
      rm(directory, { recursive: true, force: true }),
    ),
  )
})

describe('Gateway Provider prompt runner', () => {
  it('runs a registered Provider with the requested online-equivalent cwd and session', async () => {
    const cwd = await temporaryDirectory()
    const provider = new ProbeProvider([
      { kind: 'session_init', sessionId: 'session-recovered' },
      { kind: 'text', text: 'probe ' },
      { kind: 'text', text: 'ok' },
      { kind: 'result', status: 'success' },
    ])

    const result = await runGatewayProviderPrompt({
      prompt: 'diagnose',
      providerSessionId: 'session-existing',
      permissionMode: 'bypassPermissions',
      reasoningEffort: 'high',
    }, {
      provider: 'codex',
      cwd,
    }, undefined, {
      providerFactory: name => name === 'codex' ? provider : undefined,
    })

    expect(result).toMatchObject({
      provider: 'codex',
      cwd: await realpath(cwd),
      requestedProviderSessionId: 'session-existing',
      providerSessionId: 'session-recovered',
      outcome: 'success',
      text: 'probe ok',
      eventCounts: { session_init: 1, text: 2, result: 1 },
      truncated: false,
    })
    expect(provider.initCalls).toBe(1)
    expect(provider.destroyCalls).toBe(1)
    expect(provider.lastPrompt).toBe('diagnose')
    expect(provider.lastConfig).toMatchObject({
      cwd: await realpath(cwd),
      sessionId: 'session-existing',
      providerSettings: {
        permissionMode: 'bypassPermissions',
        reasoningEffort: 'high',
      },
    })
    await expect(provider.lastConfig?.permissionHandler?.handleToolCall(
      'write',
      {},
      { signal: new AbortController().signal },
    )).resolves.toMatchObject({ behavior: 'allow', permanent: true })
  })

  it('interrupts and reports a prompt that exceeds its local timeout', async () => {
    const cwd = await temporaryDirectory()
    const provider = new HangingProbeProvider()

    const result = await runGatewayProviderPrompt({
      prompt: 'hang',
      timeoutMs: 10,
    }, {
      provider: 'codex',
      cwd,
    }, undefined, {
      providerFactory: () => provider,
    })

    expect(result.outcome).toBe('timed_out')
    expect(provider.interruptCalls).toBe(1)
    expect(provider.destroyCalls).toBe(1)
  })
})

class ProbeProvider implements AgentProvider {
  readonly name = 'codex'
  ready = false
  initCalls = 0
  destroyCalls = 0
  lastPrompt: AgentQueryInput | undefined
  lastConfig: AgentQueryConfig | undefined

  constructor(private readonly emitted: AgentEvent[]) {}

  async init(): Promise<void> {
    this.initCalls += 1
    this.ready = true
  }

  startQuery(prompt: AgentQueryInput, config: AgentQueryConfig): AgentQueryHandle {
    this.lastPrompt = prompt
    this.lastConfig = config
    const emitted = this.emitted
    return {
      events: {
        async *[Symbol.asyncIterator]() {
          for (const event of emitted) yield event
        },
      },
      async interrupt() {},
    }
  }

  isReady(): boolean { return this.ready }
  getInitError(): string | null { return null }
  getAvailableModels() { return [] }
  getAvailablePermissionModes() { return ['default', 'bypassPermissions'] }
  async destroy(): Promise<void> { this.destroyCalls += 1 }
}

class HangingProbeProvider extends ProbeProvider {
  interruptCalls = 0
  private release: (() => void) | undefined

  constructor() {
    super([])
  }

  override startQuery(
    prompt: AgentQueryInput,
    config: AgentQueryConfig,
  ): AgentQueryHandle {
    this.lastPrompt = prompt
    this.lastConfig = config
    return {
      events: {
        [Symbol.asyncIterator]: () => ({
          next: async () => {
            await new Promise<void>(resolve => { this.release = resolve })
            return { done: true, value: undefined }
          },
        }),
      },
      interrupt: async () => {
        this.interruptCalls += 1
        this.release?.()
      },
    }
  }
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'malink-provider-prompt-'))
  temporaryDirectories.push(directory)
  return directory
}
