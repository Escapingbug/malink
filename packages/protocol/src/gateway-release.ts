import { z } from 'zod'
import { pairingPublicKeySchema } from './pairing.js'
import { signatureSchema } from './schema.js'

const opaqueId = z.string().min(1).max(256)
const timestamp = z.number().int().nonnegative()
const releaseId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u)
const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/u)
const stateClass = z.enum([
  'security-critical',
  'durable-command',
  'rebuildable-projection',
  'ephemeral-ui',
])

export const gatewayReleaseFileSchema = z
  .object({
    path: z.string().min(1).max(1_024).refine(isSafeRelativePath, {
      message: 'Gateway release files require normalized relative paths',
    }),
    url: z.url().max(2_048).refine(isCredentialFreeHttpUrl, {
      message: 'Gateway release files require credential-free HTTPS URLs',
    }),
    size: z.number().int().positive().max(512 * 1024 * 1024),
    sha256: sha256Hex,
    executable: z.boolean().optional(),
  })
  .strict()

export type GatewayReleaseFile = z.infer<typeof gatewayReleaseFileSchema>

export const gatewayReleaseStateEntrySchema = z
  .object({
    id: z.string().min(1).max(128),
    stateClass,
    schemaVersion: z.number().int().positive().max(1_000_000),
  })
  .strict()

export const gatewayReleaseManifestSchema = z
  .object({
    kind: z.literal('malink.gateway.release'),
    version: z.literal(1),
    releaseId,
    versionName: z.string().min(1).max(128),
    buildId: opaqueId,
    publishedAt: timestamp,
    platform: z.literal('darwin'),
    architecture: z.enum(['arm64', 'x64']),
    runtimePath: z.literal('runtime/node'),
    entrypointPath: z.literal('ops/matrix-local-gateway.js'),
    supervisorEntrypointPath: z.literal('ops/gatewayUpdateSupervisorMain.js'),
    files: z.array(gatewayReleaseFileSchema).min(2).max(10_000),
    stateCatalog: z.array(gatewayReleaseStateEntrySchema).min(1).max(256),
  })
  .strict()
  .superRefine((manifest, context) => {
    const paths = new Set<string>()
    let totalSize = 0
    for (const [index, file] of manifest.files.entries()) {
      if (file.path === 'release-manifest.json') {
        context.addIssue({
          code: 'custom',
          path: ['files', index, 'path'],
          message: 'release-manifest.json is reserved for verified release metadata',
        })
      }
      if (paths.has(file.path)) {
        context.addIssue({
          code: 'custom',
          path: ['files', index, 'path'],
          message: 'Gateway release file paths must be unique',
        })
      }
      paths.add(file.path)
      totalSize += file.size
    }
    if (
      !paths.has(manifest.runtimePath)
      || !paths.has(manifest.entrypointPath)
      || !paths.has(manifest.supervisorEntrypointPath)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['files'],
        message: 'Gateway release is missing its runtime, Gateway entrypoint, or supervisor entrypoint',
      })
    }
    const runtime = manifest.files.find(file => file.path === manifest.runtimePath)
    if (runtime && runtime.executable !== true) {
      context.addIssue({
        code: 'custom',
        path: ['files'],
        message: 'Gateway release runtime must be marked executable',
      })
    }
    if (totalSize > 1024 * 1024 * 1024) {
      context.addIssue({
        code: 'custom',
        path: ['files'],
        message: 'Gateway release exceeds the one GiB extracted-size limit',
      })
    }
    const stateIds = manifest.stateCatalog.map(entry => entry.id)
    if (new Set(stateIds).size !== stateIds.length) {
      context.addIssue({
        code: 'custom',
        path: ['stateCatalog'],
        message: 'Gateway release state catalog IDs must be unique',
      })
    }
  })

export type GatewayReleaseManifest = z.infer<typeof gatewayReleaseManifestSchema>

export const signedGatewayReleaseManifestSchema = z
  .object({
    manifest: gatewayReleaseManifestSchema,
    signer: pairingPublicKeySchema,
    signature: signatureSchema,
  })
  .strict()

export type SignedGatewayReleaseManifest = z.infer<
  typeof signedGatewayReleaseManifestSchema
>

export const gatewayUpdatePhaseSchema = z.enum([
  'idle',
  'staging',
  'staged',
  'waiting_for_idle',
  'scheduled',
  'activating',
  'probation',
  'committed',
  'rolled_back',
  'failed',
  'repair_required',
])

export type GatewayUpdatePhase = z.infer<typeof gatewayUpdatePhaseSchema>

export const gatewayUpdateStatusSchema = z
  .object({
    version: z.literal(1),
    phase: gatewayUpdatePhaseSchema,
    updateId: opaqueId.optional(),
    releaseId: releaseId.optional(),
    targetBuildId: opaqueId.optional(),
    currentBuildId: opaqueId.optional(),
    previousReleaseId: releaseId.optional(),
    detail: z.string().min(1).max(4_096).optional(),
    activeTurns: z.number().int().nonnegative().optional(),
    updatedAt: timestamp,
  })
  .strict()

export type GatewayUpdateStatus = z.infer<typeof gatewayUpdateStatusSchema>

function isSafeRelativePath(value: string): boolean {
  if (value.startsWith('/') || value.endsWith('/') || value.includes('\\')) return false
  const parts = value.split('/')
  return parts.every(part => part.length > 0 && part !== '.' && part !== '..')
}

function isCredentialFreeHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return (
      url.protocol === 'https:'
      || (url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost'))
    ) && !url.username && !url.password && !url.search && !url.hash
  } catch {
    return false
  }
}
