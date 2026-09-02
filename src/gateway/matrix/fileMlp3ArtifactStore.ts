import { createHash, randomUUID } from 'node:crypto'
import { basename, extname, isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { realpath, stat } from 'node:fs/promises'
import { AtomicJsonFile } from '@malink/security/node'
import { fromMarkdown } from 'mdast-util-from-markdown'
import {
  MAX_MALINK_ATTACHMENT_BYTES,
  artifactReferenceSchema,
  attachmentSchema,
  type MalinkArtifactReference,
  type MalinkAttachment,
  type Mlp3SessionProjection,
} from '@malink/protocol'
import type { ChannelAttachment, ChannelMessage } from '@/bridge/channelPort'
import type { MatrixTransport } from '@/channel/matrix'
import {
  uploadMlp3Attachment,
  type Mlp3AttachmentInput,
} from '@/channel/matrix/mlp3Attachment'

export const MALINK_ARTIFACT_SCHEME = 'malink-artifact:'
export const MAX_ARTIFACT_REFERENCES_PER_MESSAGE = 10
export const MAX_INLINE_IMAGE_BYTES = 4 * 1024 * 1024
export const MAX_INLINE_IMAGES_PER_MESSAGE = 4
export const MAX_INLINE_IMAGE_TOTAL_BYTES = 12 * 1024 * 1024

const MARKDOWN_LOCAL_LINK_SOURCE = /^(!?)\[([^\]\n]*)\]\(\s*(?:<([^>\n]+)>|([^\s)\n]+))(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)$/u
const SAFE_INLINE_IMAGE_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/avif',
])

export interface ArtifactMessageContext {
  roomId: string
  projectId: string
  sessionId: string
  threadRootEventId: string
  cwd: string
}

export interface PreparedArtifactMessage {
  message: ChannelMessage
  references: MalinkArtifactReference[]
}

export interface PublishedArtifactMessage {
  messageId: string
  messageVersion: number
  body: string
  format: 'plain' | 'markdown'
  final: boolean
  partIndex?: number
  partCount?: number
  projection: Mlp3SessionProjection
  references: MalinkArtifactReference[]
  attachments: MalinkAttachment[]
}

export interface MaterializedArtifactMessage extends PublishedArtifactMessage {
  status: 'materialized' | 'changed'
  referenceId: string
}

interface StoredArtifactReference {
  context: ArtifactMessageContext
  logicalMessageId: string
  messageKey: string
  canonicalPath: string
  metadata: MalinkArtifactReference
  attachment?: MalinkAttachment
}

interface StoredArtifactMessage extends PublishedArtifactMessage {
  context: ArtifactMessageContext
  updatedAt: number
}

interface ArtifactStoreState {
  version: 1
  workspaceId: string
  references: Record<string, StoredArtifactReference>
  messages: Record<string, StoredArtifactMessage>
}

interface FileMlp3ArtifactStoreOptions {
  wait?: (delayMs: number) => Promise<void>
  onLog?: (message: string) => void
}

interface MarkdownLocalLink {
  index: number
  length: number
  label: string
  destination: string
  imageSyntax: boolean
}

interface LocalArtifactCandidate {
  canonicalPath: string
  metadata: Omit<MalinkArtifactReference, 'id'>
  imageSyntax: boolean
  links: MarkdownLocalLink[]
}

interface MarkdownReplacement {
  length: number
  text: string
}

export class FileMlp3ArtifactStore {
  private readonly file: AtomicJsonFile<ArtifactStoreState>
  private mediaUploadTail: Promise<void> = Promise.resolve()
  private readonly referenceOperationTails = new Map<string, Promise<void>>()

  constructor(
    path: string,
    private readonly workspaceId: string,
    private readonly options: FileMlp3ArtifactStoreOptions = {},
  ) {
    this.file = new AtomicJsonFile(path)
  }

  async initialize(): Promise<void> {
    await this.file.transaction(
      () => defaultState(this.workspaceId),
      state => {
        validateState(state, this.workspaceId)
        return { result: undefined, changed: false }
      },
    )
  }

  async prepare(
    context: ArtifactMessageContext,
    messageId: string,
    message: ChannelMessage,
  ): Promise<PreparedArtifactMessage> {
    if (message.format !== 'markdown' || message.presentation) {
      return { message, references: [] }
    }

    const matches = markdownLocalLinks(message.text)
    if (matches.length === 0) return { message, references: [] }
    let canonicalCwd: string
    try {
      canonicalCwd = await realpath(context.cwd)
    } catch {
      return {
        message: rewriteUnavailableLocalLinks(message, matches),
        references: [],
      }
    }

    const candidates = new Map<string, LocalArtifactCandidate>()
    const replacementByIndex = new Map<number, MarkdownReplacement>()
    const availableReferenceSlots = Math.max(
      0,
      MAX_ARTIFACT_REFERENCES_PER_MESSAGE - (message.attachments?.length ?? 0),
    )
    for (const link of matches) {
      const destination = link.destination
      if (!destination || destination.startsWith(MALINK_ARTIFACT_SCHEME)) continue
      if (!isPotentialLocalArtifactDestination(destination)) continue
      const canonicalPath = await resolveLocalArtifactPath(destination, canonicalCwd)
      if (!canonicalPath || !isPathInside(canonicalCwd, canonicalPath)) {
        replacementByIndex.set(link.index, unavailableLocalLinkReplacement(link))
        continue
      }
      const metadata = await artifactMetadata(canonicalPath, canonicalCwd, link.imageSyntax)
      if (!metadata) {
        replacementByIndex.set(link.index, unavailableLocalLinkReplacement(link))
        continue
      }
      const candidateKey = `${canonicalPath}\0${metadata.kind}`
      const existingCandidate = candidates.get(candidateKey)
      if (existingCandidate) {
        existingCandidate.links.push(link)
        continue
      }
      if (candidates.size >= availableReferenceSlots) {
        replacementByIndex.set(link.index, unavailableLocalLinkReplacement(link))
        continue
      }
      candidates.set(candidateKey, {
        canonicalPath,
        metadata,
        imageSyntax: link.imageSyntax,
        links: [link],
      })
    }
    if (candidates.size === 0) {
      if (replacementByIndex.size === 0) return { message, references: [] }
      return {
        message: { ...message, text: rewriteMarkdown(message.text, matches, replacementByIndex) },
        references: [],
      }
    }

    const messageKey = artifactMessageKey(context.sessionId, messageId)
    const registered = await this.file.transaction(
      () => defaultState(this.workspaceId),
      state => {
        validateState(state, this.workspaceId)
        const result = [...candidates.values()].map(candidate => {
          const existing = Object.values(state.references).find(reference =>
            reference.logicalMessageId === messageId
            && reference.context.sessionId === context.sessionId
            && reference.canonicalPath === candidate.canonicalPath
            && reference.metadata.kind === candidate.metadata.kind)
          const id = existing?.metadata.id ?? randomUUID()
          const metadata = artifactReferenceSchema.parse({ id, ...candidate.metadata })
          state.references[id] = {
            context: { ...structuredClone(context), cwd: canonicalCwd },
            logicalMessageId: messageId,
            messageKey,
            canonicalPath: candidate.canonicalPath,
            metadata,
            ...(existing?.metadata.statRevision === metadata.statRevision && existing.attachment
              ? { attachment: existing.attachment }
              : {}),
          }
          return { candidate, metadata }
        })
        return { result, changed: true }
      },
    )

    const references: MalinkArtifactReference[] = []
    const attachments: ChannelAttachment[] = [...(message.attachments ?? [])]
    let inlineCount = 0
    let inlineBytes = 0
    for (const { candidate, metadata } of registered) {
      for (const link of candidate.links) {
        const label = link.label || metadata.name
        replacementByIndex.set(link.index, {
          length: link.length,
          text: `${link.imageSyntax ? '!' : ''}[${label}](${MALINK_ARTIFACT_SCHEME}${metadata.id})`,
        })
      }
      references.push(metadata)
      if (
        candidate.imageSyntax
        && SAFE_INLINE_IMAGE_MIME_TYPES.has(metadata.mimeType)
        && metadata.size <= MAX_INLINE_IMAGE_BYTES
        && inlineCount < MAX_INLINE_IMAGES_PER_MESSAGE
        && inlineBytes + metadata.size <= MAX_INLINE_IMAGE_TOTAL_BYTES
      ) {
        attachments.push({
          id: metadata.id,
          type: 'photo',
          path: candidate.canonicalPath,
          filename: metadata.name,
          optionalArtifact: true,
        })
        inlineCount += 1
        inlineBytes += metadata.size
      }
    }

    return {
      message: {
        ...message,
        text: rewriteMarkdown(message.text, matches, replacementByIndex),
        ...(attachments.length > 0 ? { attachments } : {}),
      },
      references,
    }
  }

  async published(
    context: ArtifactMessageContext,
    input: PublishedArtifactMessage,
  ): Promise<void> {
    if (input.references.length === 0) return
    const messageKey = artifactMessageKey(context.sessionId, input.messageId, input.partIndex)
    await this.file.transaction(
      () => defaultState(this.workspaceId),
      state => {
        validateState(state, this.workspaceId)
        const attachments = input.attachments.map(attachment => attachmentSchema.parse(attachment))
        state.messages[messageKey] = {
          ...structuredClone(input),
          attachments,
          context: structuredClone(context),
          updatedAt: Date.now(),
        }
        for (const metadata of input.references) {
          const reference = state.references[metadata.id]
          if (
            reference?.logicalMessageId === input.messageId
            && reference.context.sessionId === context.sessionId
          ) reference.messageKey = messageKey
        }
        for (const attachment of attachments) {
          const reference = state.references[attachment.id]
          if (reference?.messageKey === messageKey) reference.attachment = attachment
        }
        return { result: undefined, changed: true }
      },
    )
  }

  materialize(
    context: ArtifactMessageContext,
    referenceId: string,
    expectedStatRevision: string,
    transport: MatrixTransport,
  ): Promise<MaterializedArtifactMessage> {
    const previous = this.referenceOperationTails.get(referenceId) ?? Promise.resolve()
    const operation = previous.then(
      () => this.materializeLocked(context, referenceId, expectedStatRevision, transport),
      () => this.materializeLocked(context, referenceId, expectedStatRevision, transport),
    )
    const tail = operation.then(() => undefined, () => undefined)
    this.referenceOperationTails.set(referenceId, tail)
    void tail.then(() => {
      if (this.referenceOperationTails.get(referenceId) === tail) {
        this.referenceOperationTails.delete(referenceId)
      }
    })
    return operation
  }

  private async materializeLocked(
    context: ArtifactMessageContext,
    referenceId: string,
    expectedStatRevision: string,
    transport: MatrixTransport,
  ): Promise<MaterializedArtifactMessage> {
    const snapshot = await this.readReference(context, referenceId)
    const currentMetadata = await artifactMetadata(
      snapshot.reference.canonicalPath,
      snapshot.reference.context.cwd,
      snapshot.reference.metadata.kind === 'image',
    )
    if (!currentMetadata) throw artifactError('artifact_missing', 'The referenced file is no longer available')

    const current = artifactReferenceSchema.parse({
      id: referenceId,
      ...currentMetadata,
    })
    const changed = expectedStatRevision !== snapshot.reference.metadata.statRevision
      || current.statRevision !== snapshot.reference.metadata.statRevision
    if (changed) {
      return this.commitReplacement(context, referenceId, current, undefined, 'changed')
    }

    let attachment = snapshot.reference.attachment
    if (!attachment) {
      attachment = await this.uploadAttachment(transport, {
        id: referenceId,
        path: snapshot.reference.canonicalPath,
        filename: current.name,
      })
      const afterUploadMetadata = await artifactMetadata(
        snapshot.reference.canonicalPath,
        snapshot.reference.context.cwd,
        snapshot.reference.metadata.kind === 'image',
      )
      if (!afterUploadMetadata) {
        throw artifactError('artifact_missing', 'The referenced file is no longer available')
      }
      const afterUpload = artifactReferenceSchema.parse({
        id: referenceId,
        ...afterUploadMetadata,
      })
      if (
        afterUpload.statRevision !== current.statRevision
        || attachment.size !== afterUpload.size
      ) {
        return this.commitReplacement(context, referenceId, afterUpload, undefined, 'changed')
      }
    }
    return this.commitReplacement(context, referenceId, current, attachment, 'materialized')
  }

  async uploadEagerAttachment(
    transport: MatrixTransport,
    input: Mlp3AttachmentInput,
  ): Promise<MalinkAttachment> {
    if (!input.id) throw new Error('An eager artifact attachment requires its reference ID')
    const expected = await this.readUploadExpectation(input.id)
    const attachment = await this.uploadAttachment(transport, input)
    const current = await artifactMetadata(
      expected.canonicalPath,
      expected.context.cwd,
      expected.metadata.kind === 'image',
    )
    if (
      !current
      || current.statRevision !== expected.metadata.statRevision
      || attachment.size !== current.size
    ) {
      throw artifactError(
        'artifact_changed_during_upload',
        'The referenced image changed while it was being prepared',
      )
    }
    return attachment
  }

  /**
   * Artifact media shares one bounded lane. A Matrix 429 pauses this lane using
   * the homeserver's retry hint instead of creating retry/progress timeline events.
   */
  uploadAttachment(
    transport: MatrixTransport,
    input: Mlp3AttachmentInput,
  ): Promise<MalinkAttachment> {
    const upload = this.mediaUploadTail.then(async () => {
      let attempt = 0
      while (true) {
        try {
          return await uploadMlp3Attachment(transport, input)
        } catch (error) {
          attempt += 1
          const retryAfterMs = matrixRateLimitDelay(error, attempt)
          if (retryAfterMs === null) throw error
          this.options.onLog?.(
            `[mlp3/artifact] Matrix media upload rate-limited; retrying attempt ${attempt} in ${retryAfterMs}ms`,
          )
          await (this.options.wait ?? wait)(retryAfterMs)
        }
      }
    })
    this.mediaUploadTail = upload.then(() => undefined, () => undefined)
    return upload
  }

  private readUploadExpectation(referenceId: string): Promise<StoredArtifactReference> {
    return this.file.transaction(
      () => defaultState(this.workspaceId),
      state => {
        validateState(state, this.workspaceId)
        const reference = state.references[referenceId]
        if (!reference) throw artifactError('artifact_not_found', 'The image reference is unavailable')
        return { result: structuredClone(reference), changed: false }
      },
    )
  }

  private readReference(
    context: ArtifactMessageContext,
    referenceId: string,
  ): Promise<{ reference: StoredArtifactReference; message: StoredArtifactMessage }> {
    return this.file.transaction(
      () => defaultState(this.workspaceId),
      state => {
        validateState(state, this.workspaceId)
        const reference = state.references[referenceId]
        if (
          !reference
          || reference.context.roomId !== context.roomId
          || reference.context.projectId !== context.projectId
          || reference.context.sessionId !== context.sessionId
        ) throw artifactError('artifact_not_found', 'The file reference is unavailable in this session')
        const message = state.messages[reference.messageKey]
        if (!message) throw artifactError('artifact_not_published', 'The referenced message is not ready')
        return {
          result: { reference: structuredClone(reference), message: structuredClone(message) },
          changed: false,
        }
      },
    )
  }

  private commitReplacement(
    context: ArtifactMessageContext,
    referenceId: string,
    metadata: MalinkArtifactReference,
    attachment: MalinkAttachment | undefined,
    status: MaterializedArtifactMessage['status'],
  ): Promise<MaterializedArtifactMessage> {
    return this.file.transaction(
      () => defaultState(this.workspaceId),
      state => {
        validateState(state, this.workspaceId)
        const reference = state.references[referenceId]
        if (
          !reference
          || reference.context.roomId !== context.roomId
          || reference.context.projectId !== context.projectId
          || reference.context.sessionId !== context.sessionId
        ) throw artifactError('artifact_not_found', 'The file reference is unavailable in this session')
        const message = state.messages[reference.messageKey]
        if (!message) throw artifactError('artifact_not_published', 'The referenced message is not ready')

        reference.metadata = metadata
        if (attachment) {
          reference.attachment = attachmentSchema.parse(attachment)
        } else if (status === 'changed') {
          delete reference.attachment
          message.attachments = message.attachments.filter(item => item.id !== referenceId)
        }
        message.references = message.references.map(item => item.id === referenceId ? metadata : item)
        if (attachment && !message.attachments.some(item => item.id === attachment.id)) {
          message.attachments.push(attachmentSchema.parse(attachment))
        }
        message.messageVersion += 1
        message.updatedAt = Date.now()
        const result: MaterializedArtifactMessage = {
          status,
          referenceId,
          messageId: message.messageId,
          messageVersion: message.messageVersion,
          body: message.body,
          format: message.format,
          final: message.final,
          ...(message.partIndex === undefined ? {} : { partIndex: message.partIndex }),
          ...(message.partCount === undefined ? {} : { partCount: message.partCount }),
          projection: structuredClone(message.projection),
          references: structuredClone(message.references),
          attachments: structuredClone(message.attachments),
        }
        return { result, changed: true }
      },
    )
  }
}

function markdownLocalLinks(markdown: string): MarkdownLocalLink[] {
  const links: MarkdownLocalLink[] = []
  const root = fromMarkdown(markdown)
  const visit = (node: {
    type?: string
    position?: { start?: { offset?: number }; end?: { offset?: number } }
    children?: unknown[]
  }) => {
    if (node.type === 'link' || node.type === 'image') {
      const start = node.position?.start?.offset
      const end = node.position?.end?.offset
      if (start !== undefined && end !== undefined) {
        const source = markdown.slice(start, end)
        const match = MARKDOWN_LOCAL_LINK_SOURCE.exec(source)
        const destination = match?.[3] ?? match?.[4]
        if (match && destination) {
          links.push({
            index: start,
            length: end - start,
            label: match[2] ?? '',
            destination,
            imageSyntax: match[1] === '!',
          })
        }
      }
    }
    for (const child of node.children ?? []) {
      if (child && typeof child === 'object') visit(child)
    }
  }
  visit(root)
  return links.sort((left, right) => left.index - right.index)
}

function rewriteUnavailableLocalLinks(
  message: ChannelMessage,
  links: MarkdownLocalLink[],
): ChannelMessage {
  const replacements = new Map<number, MarkdownReplacement>()
  for (const link of links) {
    if (isPotentialLocalArtifactDestination(link.destination)) {
      replacements.set(link.index, unavailableLocalLinkReplacement(link))
    }
  }
  if (replacements.size === 0) return message
  return { ...message, text: rewriteMarkdown(message.text, links, replacements) }
}

function rewriteMarkdown(
  markdown: string,
  links: MarkdownLocalLink[],
  replacements: Map<number, MarkdownReplacement>,
): string {
  let rewritten = ''
  let cursor = 0
  for (const link of links) {
    const replacement = replacements.get(link.index)
    if (!replacement) continue
    rewritten += markdown.slice(cursor, link.index) + replacement.text
    cursor = link.index + replacement.length
  }
  return rewritten + markdown.slice(cursor)
}

function unavailableLocalLinkReplacement(link: MarkdownLocalLink): MarkdownReplacement {
  return {
    length: link.length,
    text: `${link.label || 'Local file'} *(local file reference unavailable)*`,
  }
}

function isPotentialLocalArtifactDestination(destinationInput: string): boolean {
  let destination: string
  try {
    destination = decodeURIComponent(destinationInput)
  } catch {
    destination = destinationInput
  }
  if (!destination || destination.startsWith('#') || destination.startsWith('?')) return false
  if (destination.startsWith('//')) return false
  if (/^[a-z]:[\\/]/iu.test(destination)) return true
  const scheme = /^([a-z][a-z0-9+.-]*):/iu.exec(destination)?.[1]?.toLowerCase()
  return !scheme || scheme === 'file'
}

async function resolveLocalArtifactPath(destinationInput: string, cwd: string): Promise<string | null> {
  let destination: string
  try {
    destination = decodeURIComponent(destinationInput)
  } catch {
    destination = destinationInput
  }
  if (/^[a-z][a-z0-9+.-]*:/iu.test(destination) && !destination.startsWith('file:')) return null
  let candidate: string
  try {
    candidate = destination.startsWith('file:')
      ? fileURLToPath(destination)
      : isAbsolute(destination)
        ? destination
        : resolve(cwd, destination)
  } catch {
    return null
  }
  const attempts = [candidate]
  const withoutLocation = candidate.replace(/:\d+(?::\d+)?$/u, '')
  if (withoutLocation !== candidate) attempts.push(withoutLocation)
  for (const attempt of attempts) {
    try {
      return await realpath(attempt)
    } catch {
      // Try the optional line/column-free form before treating the link as remote text.
    }
  }
  return null
}

async function artifactMetadata(
  canonicalPath: string,
  cwd: string,
  imageSyntax: boolean,
): Promise<Omit<MalinkArtifactReference, 'id'> | null> {
  let metadata
  try {
    metadata = await stat(canonicalPath)
  } catch {
    return null
  }
  if (!metadata.isFile() || metadata.size > MAX_MALINK_ATTACHMENT_BYTES) return null
  const mimeType = artifactMimeType(canonicalPath)
  const relativePath = relative(cwd, canonicalPath).replaceAll('\\', '/') || basename(canonicalPath)
  const modifiedAt = Math.max(0, Math.trunc(metadata.mtimeMs))
  const statRevision = createHash('sha256')
    .update('malink-artifact-stat:v1\0')
    .update(canonicalPath)
    .update('\0')
    .update(String(metadata.size))
    .update('\0')
    .update(String(modifiedAt))
    .digest('base64url')
  return {
    kind: imageSyntax && mimeType.startsWith('image/') ? 'image' : 'file',
    name: basename(canonicalPath),
    relativePath,
    mimeType,
    size: metadata.size,
    modifiedAt,
    statRevision,
  }
}

function isPathInside(cwd: string, candidate: string): boolean {
  const path = relative(resolve(cwd), candidate)
  return path === '' || (!path.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && path !== '..' && !isAbsolute(path))
}

function artifactMimeType(path: string): string {
  switch (extname(path).toLowerCase()) {
    case '.png': return 'image/png'
    case '.jpg':
    case '.jpeg': return 'image/jpeg'
    case '.webp': return 'image/webp'
    case '.gif': return 'image/gif'
    case '.avif': return 'image/avif'
    case '.svg': return 'image/svg+xml'
    case '.pdf': return 'application/pdf'
    case '.json': return 'application/json'
    case '.md':
    case '.markdown': return 'text/markdown'
    case '.txt':
    case '.log': return 'text/plain'
    case '.csv': return 'text/csv'
    case '.mp3': return 'audio/mpeg'
    case '.wav': return 'audio/wav'
    case '.m4a': return 'audio/mp4'
    case '.mp4': return 'video/mp4'
    case '.zip': return 'application/zip'
    default: return 'application/octet-stream'
  }
}

function artifactMessageKey(sessionId: string, messageId: string, partIndex?: number): string {
  return `${sessionId}\0${messageId}\0${partIndex ?? 0}`
}

function artifactError(code: string, message: string): Error {
  const error = new Error(message) as Error & { commandCode?: string; retryable?: boolean }
  error.commandCode = code
  error.retryable = false
  return error
}

function defaultState(workspaceId: string): ArtifactStoreState {
  return { version: 1, workspaceId, references: {}, messages: {} }
}

function validateState(state: ArtifactStoreState, workspaceId: string): void {
  if (
    state.version !== 1
    || state.workspaceId !== workspaceId
    || !state.references
    || typeof state.references !== 'object'
    || Array.isArray(state.references)
    || !state.messages
    || typeof state.messages !== 'object'
    || Array.isArray(state.messages)
  ) throw new Error('Invalid MLP/3 artifact reference store')
}

function matrixRateLimitDelay(error: unknown, attempt: number): number | null {
  const root = asRecord(error)
  const data = asRecord(root?.data) ?? asRecord(root?.body)
  const status = [root?.status, root?.statusCode, root?.httpStatus, data?.status]
    .find(value => typeof value === 'number')
  const errcode = [root?.errcode, data?.errcode]
    .find(value => typeof value === 'string')
  if (status !== 429 && errcode !== 'M_LIMIT_EXCEEDED') return null
  const requested = [root?.retry_after_ms, data?.retry_after_ms]
    .find(value => typeof value === 'number' && Number.isFinite(value) && value > 0)
  return typeof requested === 'number'
    ? Math.min(300_000, Math.max(250, Math.ceil(requested)))
    : Math.min(60_000, 1_000 * (2 ** Math.min(6, Math.max(0, attempt - 1))))
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function wait(delayMs: number): Promise<void> {
  return new Promise(resolveWait => setTimeout(resolveWait, delayMs))
}
