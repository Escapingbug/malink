import { access, realpath, stat } from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import { isAbsolute } from 'node:path'
import { randomUUID } from 'node:crypto'
import type {
  AgentPermissionHandler,
  AgentProvider,
} from '@/providers/provider'
import { createProviderInstance } from '@/providers/registry'
import type { AgentEvent } from '@/providers/types'
import type {
  GatewayProviderPromptEvent,
  GatewayProviderPromptRequest,
  GatewayProviderPromptResponse,
} from './types.js'

const DEFAULT_PROMPT_TIMEOUT_MS = 180_000
const MAX_CAPTURED_EVENTS = 1_024
const MAX_CAPTURED_TEXT_CHARS = 512 * 1024
const MAX_EVENT_STRING_CHARS = 64 * 1024

export interface GatewayProviderPromptDefaults {
  provider: string
  cwd: string
}

export interface GatewayProviderPromptRunnerOptions {
  providerFactory?: (name: string) => AgentProvider | undefined
  now?: () => number
}

interface InitializableProvider extends AgentProvider {
  init?(): Promise<void>
}

export async function runGatewayProviderPrompt(
  request: GatewayProviderPromptRequest,
  defaults: GatewayProviderPromptDefaults,
  externalSignal?: AbortSignal,
  options: GatewayProviderPromptRunnerOptions = {},
): Promise<GatewayProviderPromptResponse> {
  const now = options.now ?? Date.now
  const providerName = request.provider ?? defaults.provider
  const cwd = await validatePromptCwd(request.cwd ?? defaults.cwd)
  const provider = (options.providerFactory ?? createProviderInstance)(providerName) as
    | InitializableProvider
    | undefined
  if (!provider) throw new Error(`Provider ${providerName} is not configured on this Gateway`)
  provider.prepareWorkingDirectory?.(cwd)

  const startedAt = now()
  const timeoutMs = request.timeoutMs ?? DEFAULT_PROMPT_TIMEOUT_MS
  const controller = new AbortController()
  let timedOut = false
  const abortFromCaller = () => controller.abort(externalSignal?.reason)
  if (externalSignal?.aborted) abortFromCaller()
  else externalSignal?.addEventListener('abort', abortFromCaller, { once: true })
  const timeout = setTimeout(() => {
    timedOut = true
    controller.abort(new Error(`Provider prompt timed out after ${timeoutMs}ms`))
  }, timeoutMs)

  const events: GatewayProviderPromptEvent[] = []
  const eventCounts: Record<string, number> = {}
  let text = ''
  let truncated = false
  let providerSessionId: string | undefined
  let sessionOpenMs: number | undefined
  let outcome: GatewayProviderPromptResponse['outcome'] = 'error'
  let errorMessage: string | undefined
  let handle: ReturnType<AgentProvider['startQuery']> | undefined

  try {
    await initializeProvider(provider, controller.signal)
    if (!provider.isReady()) {
      throw new Error(
        provider.getInitError() ?? `Provider ${providerName} did not become ready`,
      )
    }

    handle = provider.startQuery(request.prompt, {
      cwd,
      malinkSessionId: `gateway-admin-probe-${randomUUID()}`,
      ...(request.providerSessionId
        ? { sessionId: request.providerSessionId }
        : {}),
      signal: controller.signal,
      ...(request.model ? { model: request.model } : {}),
      permissionHandler: permissionHandler(
        request.permissionMode ?? 'default',
      ),
      decisionHandler: {
        requestDecision: async () => ({ value: 'deny' }),
      },
      providerSettings: {
        permissionMode: request.permissionMode ?? 'default',
        ...(request.reasoningEffort
          ? { reasoningEffort: request.reasoningEffort }
          : {}),
      },
    })

    const interruptOnAbort = () => {
      void handle?.interrupt().catch(() => undefined)
    }
    controller.signal.addEventListener('abort', interruptOnAbort, { once: true })
    try {
      for await (const event of handle.events) {
        const elapsedMs = Math.max(0, now() - startedAt)
        eventCounts[event.kind] = (eventCounts[event.kind] ?? 0) + 1
        if (event.kind === 'session_init') {
          providerSessionId = event.sessionId ?? providerSessionId
          sessionOpenMs ??= elapsedMs
        }
        if (event.kind === 'text') {
          const remaining = MAX_CAPTURED_TEXT_CHARS - text.length
          if (remaining > 0) text += event.text.slice(0, remaining)
          if (event.text.length > remaining) truncated = true
        } else if (events.length < MAX_CAPTURED_EVENTS) {
          events.push({ elapsedMs, event: boundedAgentEvent(event) })
        } else {
          truncated = true
        }
        if (event.kind === 'result') {
          outcome = event.status
          if (event.status === 'error' && event.summary) errorMessage = event.summary
        }
      }
    } finally {
      controller.signal.removeEventListener('abort', interruptOnAbort)
    }
    if (timedOut) outcome = 'timed_out'
    else if (externalSignal?.aborted) outcome = 'cancelled'
  } catch (error) {
    errorMessage = formatError(error)
    outcome = timedOut
      ? 'timed_out'
      : externalSignal?.aborted
        ? 'cancelled'
        : 'error'
  } finally {
    clearTimeout(timeout)
    externalSignal?.removeEventListener('abort', abortFromCaller)
    await provider.destroy?.().catch(error => {
      errorMessage ??= `Provider cleanup failed: ${formatError(error)}`
      outcome = 'error'
    })
  }

  const completedAt = now()
  return {
    provider: providerName,
    cwd,
    ...(request.providerSessionId
      ? { requestedProviderSessionId: request.providerSessionId }
      : {}),
    ...(providerSessionId ? { providerSessionId } : {}),
    startedAt,
    completedAt,
    durationMs: Math.max(0, completedAt - startedAt),
    ...(sessionOpenMs === undefined ? {} : { sessionOpenMs }),
    outcome,
    text,
    events,
    eventCounts,
    truncated,
    ...(errorMessage ? { error: errorMessage } : {}),
  }
}

async function validatePromptCwd(input: string): Promise<string> {
  if (!isAbsolute(input)) throw new Error('Provider prompt cwd must be absolute')
  await access(input, fsConstants.R_OK | fsConstants.X_OK)
  const resolved = await realpath(input)
  if (!(await stat(resolved)).isDirectory()) {
    throw new Error('Provider prompt cwd must be a directory')
  }
  return resolved
}

async function initializeProvider(
  provider: InitializableProvider,
  signal: AbortSignal,
): Promise<void> {
  if (provider.isReady()) return
  if (!provider.init) {
    throw new Error(`Provider ${provider.name} cannot be initialized locally`)
  }
  await Promise.race([
    provider.init(),
    new Promise<never>((_, reject) => {
      if (signal.aborted) {
        reject(signal.reason ?? new Error('Provider prompt cancelled'))
        return
      }
      signal.addEventListener(
        'abort',
        () => reject(signal.reason ?? new Error('Provider prompt cancelled')),
        { once: true },
      )
    }),
  ])
}

function permissionHandler(mode: string): AgentPermissionHandler {
  return {
    async handleToolCall(_toolName, _input, options) {
      if (options.signal.aborted) return { behavior: 'deny', message: 'aborted' }
      if (mode === 'bypassPermissions') {
        return { behavior: 'allow', permanent: true }
      }
      return {
        behavior: 'deny',
        message: 'The non-interactive Gateway prompt entry does not approve tools. Use --permission-mode bypassPermissions explicitly when required.',
      }
    },
    reset() {},
  }
}

function boundedAgentEvent(event: AgentEvent): AgentEvent {
  const seen = new WeakSet<object>()
  const encoded = JSON.stringify(event, (_key, value: unknown) => {
    if (typeof value === 'bigint') return value.toString()
    if (typeof value === 'string' && value.length > MAX_EVENT_STRING_CHARS) {
      return `${value.slice(0, MAX_EVENT_STRING_CHARS)}…`
    }
    if (value && typeof value === 'object') {
      if (seen.has(value)) return '[Circular]'
      seen.add(value)
    }
    return value
  })
  return JSON.parse(encoded) as AgentEvent
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
