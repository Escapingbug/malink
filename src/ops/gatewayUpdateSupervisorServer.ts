import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http'
import { createConnection } from 'node:net'
import { chmod, lstat, mkdir, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  gatewayUpdateStatusSchema,
  type GatewayUpdateStatus,
} from '@malink/protocol'
import type { GatewayUpdateSupervisor } from './gatewayUpdateSupervisor.js'
import type {
  GatewayAgentUpdateBeginResult,
  GatewayAgentUpdateInstruction,
} from './gatewayUpdateSupervisor.js'

const MAX_BODY_BYTES = 8 * 1024

export interface GatewayUpdateSupervisorServer {
  socketPath: string
  stop(): Promise<void>
}

export async function startGatewayUpdateSupervisorServer(input: {
  socketPath: string
  supervisor: GatewayUpdateSupervisor
  onLog?: (message: string) => void
}): Promise<GatewayUpdateSupervisorServer> {
  await prepareSocketPath(input.socketPath)
  const server = createServer(async (request, response) => {
    setHeaders(response)
    try {
      if (request.headers.origin) throw new SupervisorHttpError(403, 'browser_origin_forbidden')
      const path = new URL(request.url ?? '/', 'http://localhost').pathname
      if (request.method === 'GET' && path === '/v1/status') {
        sendJson(response, 200, await input.supervisor.status())
        return
      }
      if (request.method === 'POST' && path === '/v1/releases/stage') {
        const releaseId = releaseIdFromBody(await readJsonBody(request))
        sendJson(response, 200, await input.supervisor.stage(releaseId))
        return
      }
      if (request.method === 'POST' && path === '/v1/releases/apply') {
        const releaseId = releaseIdFromBody(await readJsonBody(request))
        sendJson(response, 202, await input.supervisor.scheduleApply(releaseId))
        return
      }
      if (request.method === 'POST' && path === '/v1/agent-updates/instruction') {
        const releaseId = releaseIdFromBody(await readJsonBody(request))
        sendJson(response, 200, await input.supervisor.agentInstruction(releaseId))
        return
      }
      if (request.method === 'POST' && path === '/v1/agent-updates/begin') {
        const body = agentBeginFromBody(await readJsonBody(request))
        sendJson(response, 200, await input.supervisor.beginAgentUpdate(
          body.releaseId,
          body.maintenanceSessionId,
          body.ownerCommandId,
        ))
        return
      }
      if (request.method === 'POST' && path === '/v1/agent-updates/submit') {
        const releaseId = releaseIdFromBody(await readJsonBody(request))
        sendJson(response, 200, await input.supervisor.submitAgentRelease(releaseId))
        return
      }
      if (request.method === 'POST' && path === '/v1/agent-updates/fail') {
        const body = agentFailureFromBody(await readJsonBody(request))
        sendJson(response, 200, await input.supervisor.failAgentUpdate(
          body.releaseId,
          body.ownerCommandId,
          body.detail,
        ))
        return
      }
      if (request.method === 'POST' && path === '/v1/repairs/acknowledge') {
        sendJson(response, 200, await input.supervisor.acknowledgeGatewayRecovery())
        return
      }
      throw new SupervisorHttpError(404, 'not_found')
    } catch (error) {
      const mapped = mapError(error)
      input.onLog?.(
        `[gateway-update-supervisor] ${request.method ?? 'UNKNOWN'} ${request.url ?? '/'} `
        + `failed: ${mapped.code}`,
      )
      sendJson(response, mapped.status, {
        error: {
          code: mapped.code,
          message: mapped.message,
          retryable: mapped.retryable,
        },
      })
    }
  })
  server.requestTimeout = 30_000
  server.headersTimeout = 10_000
  server.keepAliveTimeout = 1_000
  await listen(server, input.socketPath)
  if (process.platform !== 'win32') await chmod(input.socketPath, 0o600)
  let stopped = false
  return {
    socketPath: input.socketPath,
    async stop() {
      if (stopped) return
      stopped = true
      await close(server)
      await removeOwnedSocket(input.socketPath)
    },
  }
}

export class GatewayUpdateSupervisorClient {
  constructor(
    private readonly socketPath: string,
    private readonly timeoutMs = 30 * 60_000,
  ) {}

  status(): Promise<GatewayUpdateStatus> {
    return this.request('GET', '/v1/status').then(value => gatewayUpdateStatusSchema.parse(value))
  }

  stage(releaseId: string): Promise<GatewayUpdateStatus> {
    return this.request('POST', '/v1/releases/stage', { releaseId })
      .then(value => gatewayUpdateStatusSchema.parse(value))
  }

  scheduleApply(releaseId: string): Promise<GatewayUpdateStatus> {
    return this.request('POST', '/v1/releases/apply', { releaseId })
      .then(value => gatewayUpdateStatusSchema.parse(value))
  }

  agentInstruction(releaseId: string): Promise<GatewayAgentUpdateInstruction> {
    return this.request('POST', '/v1/agent-updates/instruction', { releaseId })
  }

  beginAgentUpdate(
    releaseId: string,
    maintenanceSessionId: string,
    ownerCommandId: string,
  ): Promise<GatewayAgentUpdateBeginResult> {
    return this.request('POST', '/v1/agent-updates/begin', {
      releaseId,
      maintenanceSessionId,
      ownerCommandId,
    }).then(agentUpdateBeginResult)
  }

  submitAgentRelease(releaseId: string): Promise<GatewayUpdateStatus> {
    return this.request('POST', '/v1/agent-updates/submit', { releaseId })
      .then(value => gatewayUpdateStatusSchema.parse(value))
  }

  failAgentUpdate(
    releaseId: string,
    ownerCommandId: string,
    detail: string,
  ): Promise<GatewayUpdateStatus> {
    return this.request('POST', '/v1/agent-updates/fail', {
      releaseId,
      ownerCommandId,
      detail,
    }).then(value => gatewayUpdateStatusSchema.parse(value))
  }

  acknowledgeGatewayRecovery(): Promise<GatewayUpdateStatus> {
    return this.request('POST', '/v1/repairs/acknowledge')
      .then(value => gatewayUpdateStatusSchema.parse(value))
  }

  private request<T>(method: string, path: string, body?: unknown): Promise<T> {
    return new Promise((resolve, reject) => {
      const encoded = body === undefined ? undefined : JSON.stringify(body)
      const outgoing = httpRequest({
          socketPath: this.socketPath,
          method,
          path,
          headers: encoded === undefined ? {} : {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(encoded).toString(),
          },
      }, response => {
          const chunks: Buffer[] = []
          response.on('data', (chunk: Buffer) => chunks.push(chunk))
          response.on('end', () => {
            try {
              const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
                error?: { code?: string; message?: string; retryable?: boolean }
              }
              const status = response.statusCode ?? 500
              if (status < 200 || status >= 300) {
                reject(new GatewayUpdateSupervisorRequestError(
                  parsed.error?.code ?? 'gateway_update_supervisor_failed',
                  parsed.error?.message ?? `Supervisor returned HTTP ${status}`,
                  parsed.error?.retryable === true,
                ))
              } else {
                resolve(parsed as T)
              }
            } catch (error) {
              reject(error)
            }
          })
      })
      outgoing.setTimeout(this.timeoutMs, () => outgoing.destroy(new Error(
        'Gateway update supervisor request timed out',
      )))
      outgoing.once('error', reject)
      if (encoded !== undefined) outgoing.write(encoded)
      outgoing.end()
    })
  }
}

class SupervisorHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message = code,
    readonly retryable = false,
  ) {
    super(message)
  }
}

class GatewayUpdateSupervisorRequestError extends Error {
  readonly commandCode: string

  constructor(code: string, message: string, readonly retryable: boolean) {
    super(message)
    this.name = 'GatewayUpdateSupervisorRequestError'
    this.commandCode = /^[a-z][a-z0-9_]{0,127}$/u.test(code)
      ? code
      : 'gateway_update_supervisor_failed'
  }
}

function releaseIdFromBody(input: unknown): string {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new SupervisorHttpError(400, 'invalid_request')
  }
  const values = Object.entries(input)
  if (
    values.length !== 1
    || values[0]?.[0] !== 'releaseId'
    || typeof values[0][1] !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(values[0][1])
  ) {
    throw new SupervisorHttpError(400, 'invalid_release_id')
  }
  return values[0][1]
}

function agentBeginFromBody(input: unknown): {
  releaseId: string
  maintenanceSessionId: string
  ownerCommandId: string
} {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new SupervisorHttpError(400, 'invalid_request')
  }
  const value = input as Record<string, unknown>
  if (
    Object.keys(value).length !== 3
    || typeof value.releaseId !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value.releaseId)
    || typeof value.maintenanceSessionId !== 'string'
    || value.maintenanceSessionId.length < 1
    || value.maintenanceSessionId.length > 256
    || typeof value.ownerCommandId !== 'string'
    || value.ownerCommandId.length < 1
    || value.ownerCommandId.length > 256
  ) {
    throw new SupervisorHttpError(400, 'invalid_request')
  }
  return {
    releaseId: value.releaseId,
    maintenanceSessionId: value.maintenanceSessionId,
    ownerCommandId: value.ownerCommandId,
  }
}

function agentUpdateBeginResult(input: unknown): GatewayAgentUpdateBeginResult {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Gateway Agent update begin result is invalid')
  }
  const value = input as Record<string, unknown>
  if (Object.keys(value).length !== 2 || typeof value.started !== 'boolean') {
    throw new Error('Gateway Agent update begin result is invalid')
  }
  return {
    started: value.started,
    status: gatewayUpdateStatusSchema.parse(value.status),
  }
}

function agentFailureFromBody(input: unknown): {
  releaseId: string
  ownerCommandId: string
  detail: string
} {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new SupervisorHttpError(400, 'invalid_request')
  }
  const value = input as Record<string, unknown>
  if (
    Object.keys(value).length !== 3
    || typeof value.releaseId !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value.releaseId)
    || typeof value.ownerCommandId !== 'string'
    || value.ownerCommandId.length < 1
    || value.ownerCommandId.length > 256
    || typeof value.detail !== 'string'
    || value.detail.length < 1
    || value.detail.length > 4_096
  ) {
    throw new SupervisorHttpError(400, 'invalid_request')
  }
  return {
    releaseId: value.releaseId,
    ownerCommandId: value.ownerCommandId,
    detail: value.detail,
  }
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_BODY_BYTES) throw new SupervisorHttpError(413, 'body_too_large')
    chunks.push(buffer)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } catch {
    throw new SupervisorHttpError(400, 'invalid_json')
  }
}

function mapError(error: unknown): SupervisorHttpError {
  if (error instanceof SupervisorHttpError) return error
  const failure = classifyGatewayUpdateFailure(error)
  return new SupervisorHttpError(
    500,
    failure.code,
    error instanceof Error ? error.message : String(error),
    failure.retryable,
  )
}

function classifyGatewayUpdateFailure(error: unknown): {
  code: string
  retryable: boolean
} {
  if (error && typeof error === 'object') {
    const candidate = error as { commandCode?: unknown; retryable?: unknown }
    if (
      typeof candidate.commandCode === 'string'
      && /^[a-z][a-z0-9_]{0,127}$/u.test(candidate.commandCode)
    ) {
      return {
        code: candidate.commandCode,
        retryable: candidate.retryable === true,
      }
    }
  }
  const message = error instanceof Error ? error.message : String(error)
  if (
    error instanceof TypeError
    || /(?:\bHTTP (?:408|425|429|5\d\d)\b|fetch failed|network(?:error| request)?|timed out|timeout|socket hang up|connection (?:reset|refused)|rate.?limit|too many requests|service unavailable)/iu.test(message)
  ) {
    return { code: 'gateway_update_transient_failure', retryable: true }
  }
  if (/\bHTTP 404\b/u.test(message)) {
    return { code: 'gateway_update_release_unavailable', retryable: false }
  }
  if (/(?:signature|signer|signed .* invalid|untrusted origin|invalid JSON|ID does not match|channel .* (?:advanced|changed|equivocal)|immutable|changed after|rollback is unsafe|state version|targets .* not|missing file|integrity verification)/iu.test(message)) {
    return { code: 'gateway_update_invalid_release', retryable: false }
  }
  if (/(?:not staged|not prepared|Cannot .* while update is|already draining)/u.test(message)) {
    return { code: 'gateway_update_state_conflict', retryable: false }
  }
  return { code: 'gateway_update_failed', retryable: false }
}

function setHeaders(response: ServerResponse): void {
  response.setHeader('content-type', 'application/json; charset=utf-8')
  response.setHeader('cache-control', 'no-store')
  response.setHeader('x-content-type-options', 'nosniff')
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  if (response.headersSent) return
  response.writeHead(status)
  response.end(JSON.stringify(body))
}

async function prepareSocketPath(socketPath: string): Promise<void> {
  if (process.platform === 'win32') return
  await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 })
  await chmod(dirname(socketPath), 0o700)
  try {
    const stat = await lstat(socketPath)
    if (stat.isSymbolicLink() || !stat.isSocket()) {
      throw new Error('Gateway update supervisor socket path is not a socket')
    }
    if (process.getuid && stat.uid !== process.getuid()) {
      throw new Error('Gateway update supervisor socket is owned by another user')
    }
    if (await socketAcceptsConnections(socketPath)) {
      throw new Error('Another Gateway update supervisor is already running')
    }
    await unlink(socketPath)
  } catch (error) {
    if (!isNodeError(error, 'ENOENT')) throw error
  }
}

function socketAcceptsConnections(socketPath: string): Promise<boolean> {
  return new Promise((resolveSocket, reject) => {
    const socket = createConnection({ path: socketPath })
    let settled = false
    const finish = (value: boolean) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolveSocket(value)
    }
    socket.setTimeout(250, () => finish(false))
    socket.once('connect', () => finish(true))
    socket.once('error', error => {
      if (
        isNodeError(error, 'ECONNREFUSED')
        || isNodeError(error, 'ENOENT')
        || isNodeError(error, 'ECONNRESET')
      ) {
        finish(false)
      } else if (!settled) {
        settled = true
        reject(error)
      }
    })
  })
}

function listen(server: Server, socketPath: string): Promise<void> {
  return new Promise((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(socketPath, () => {
      server.off('error', reject)
      resolveListen()
    })
  })
}

function close(server: Server): Promise<void> {
  return new Promise((resolveClose, reject) => {
    server.close(error => error ? reject(error) : resolveClose())
  })
}

async function removeOwnedSocket(socketPath: string): Promise<void> {
  if (process.platform === 'win32') return
  try {
    const stat = await lstat(socketPath)
    if (stat.isSocket() && (!process.getuid || stat.uid === process.getuid())) {
      await unlink(socketPath)
    }
  } catch (error) {
    if (!isNodeError(error, 'ENOENT')) throw error
  }
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error
    && 'code' in error
    && (error as NodeJS.ErrnoException).code === code
}
