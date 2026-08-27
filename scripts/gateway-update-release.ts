import { createHash, randomUUID } from 'node:crypto'
import {
  access,
  copyFile,
  link,
  lstat,
  mkdir,
  readFile,
  readdir,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { constants, createReadStream } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  canonicalJsonBytes,
  gatewayReleaseManifestSchema,
  pairingPublicKeySchema,
  signedGatewayReleaseManifestSchema,
  type GatewayReleaseFile,
} from '@malink/protocol'
import {
  base64UrlEncode,
  importDeviceKeyPair,
  toArrayBuffer,
  webCrypto,
  type SerializedDeviceKeyPair,
} from '@malink/security'
import { GATEWAY_STATE_CATALOG } from '../src/gateway/matrix/stateUpgradeCatalog.js'

interface Options {
  source: string
  output: string
  releaseId: string
  versionName: string
  buildId: string
  baseUrl: URL
  privateKeyFile: string
  publishedAt: number
  architecture: 'arm64' | 'x64'
}

const MAX_SIGNED_MANIFEST_BYTES = 1024 * 1024

export async function publishGatewayUpdateRelease(options: Options): Promise<{
  manifestPath: string
  signerPath: string
}> {
  const source = resolve(options.source)
  const output = resolve(options.output)
  if (output === source || output.startsWith(`${source}${sep}`)) {
    throw new Error('Gateway release output must not be inside the prepared release directory')
  }
  await requirePreparedRelease(source)
  const serialized = JSON.parse(
    await readFile(resolve(options.privateKeyFile), 'utf8'),
  ) as SerializedDeviceKeyPair
  const keys = await importDeviceKeyPair(serialized)
  const signer = pairingPublicKeySchema.parse({
    version: 1,
    algorithm: 'ES256',
    keyId: keys.keyId,
    publicKey: serialized.publicKey,
  })
  const paths = await regularReleaseFiles(source)
  const artifactRoot = join(output, 'artifacts', options.releaseId)
  const files: GatewayReleaseFile[] = []
  for (const path of paths) {
    const sourcePath = join(source, ...path.split('/'))
    const metadata = await stat(sourcePath)
    if (metadata.size < 1) throw new Error(`Gateway release file is empty: ${path}`)
    const sha256 = await hashFile(sourcePath)
    const fileUrl = new URL(
      ['artifacts', options.releaseId, ...path.split('/')]
        .map(encodeURIComponent)
        .join('/'),
      options.baseUrl,
    )
    files.push({
      path,
      url: fileUrl.href,
      size: metadata.size,
      sha256,
      ...((metadata.mode & 0o111) !== 0 ? { executable: true } : {}),
    })
  }
  const manifest = gatewayReleaseManifestSchema.parse({
    kind: 'malink.gateway.release',
    version: 1,
    releaseId: options.releaseId,
    versionName: options.versionName,
    buildId: options.buildId,
    publishedAt: options.publishedAt,
    platform: 'darwin',
    architecture: options.architecture,
    runtimePath: 'runtime/node',
    entrypointPath: 'ops/matrix-local-gateway.js',
    supervisorEntrypointPath: 'ops/gatewayUpdateSupervisorMain.js',
    files,
    stateCatalog: GATEWAY_STATE_CATALOG.map(({ id, stateClass, schemaVersion }) => ({
      id,
      stateClass,
      schemaVersion,
    })),
  })
  const rawSignature = await webCrypto().subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    keys.privateKey,
    toArrayBuffer(canonicalJsonBytes(manifest)),
  )
  const signed = signedGatewayReleaseManifestSchema.parse({
    manifest,
    signer,
    signature: {
      algorithm: 'ES256',
      keyId: keys.keyId,
      value: base64UrlEncode(new Uint8Array(rawSignature)),
    },
  })
  const signedManifestBytes = Buffer.byteLength(`${JSON.stringify(signed)}\n`)
  if (signedManifestBytes > MAX_SIGNED_MANIFEST_BYTES) {
    throw new Error(
      `Signed Gateway release manifest exceeds ${MAX_SIGNED_MANIFEST_BYTES} bytes; `
      + 'remove non-runtime files such as source maps and type declarations',
    )
  }
  for (const file of files) {
    await copyImmutable(
      join(source, ...file.path.split('/')),
      join(artifactRoot, ...file.path.split('/')),
      file.sha256,
    )
  }
  const manifestPath = join(output, 'manifests', `${options.releaseId}.json`)
  const signerPath = join(output, 'release-signer.json')
  await writeImmutableJson(manifestPath, signed)
  await writeImmutableJson(signerPath, signer)
  return { manifestPath, signerPath }
}

async function requirePreparedRelease(source: string): Promise<void> {
  for (const [path, mode] of [
    ['runtime/node', constants.X_OK],
    ['ops/matrix-local-gateway.js', constants.R_OK],
    ['mcp/stdio.js', constants.R_OK],
    ['ops/gatewayUpdateSupervisorMain.js', constants.R_OK],
  ] as const) {
    const absolute = join(source, ...path.split('/'))
    const metadata = await lstat(absolute)
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new Error(`Prepared Gateway release path is not a regular file: ${path}`)
    }
    await access(absolute, mode)
  }
}

async function regularReleaseFiles(root: string): Promise<string[]> {
  const output: string[] = []
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = join(directory, entry.name)
      if (entry.isSymbolicLink()) throw new Error(`Gateway releases cannot contain symlinks: ${absolute}`)
      if (entry.isDirectory()) {
        await visit(absolute)
      } else if (entry.isFile()) {
        output.push(relative(root, absolute).split(sep).join('/'))
      } else {
        throw new Error(`Gateway releases can contain only files and directories: ${absolute}`)
      }
    }
  }
  await visit(root)
  return output
}

async function copyImmutable(source: string, destination: string, sha256: string): Promise<void> {
  try {
    const existing = await hashFile(destination)
    if (existing !== sha256) throw new Error(`Refusing to overwrite release artifact: ${destination}`)
    return
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  await mkdir(dirname(destination), { recursive: true })
  await copyFile(source, destination, constants.COPYFILE_EXCL)
}

async function writeImmutableJson(path: string, value: unknown): Promise<void> {
  const content = `${JSON.stringify(value)}\n`
  try {
    const existing = await readFile(path, 'utf8')
    if (existing !== content) throw new Error(`Refusing to overwrite immutable release metadata: ${path}`)
    return
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.next.${process.pid}.${randomUUID()}`
  await writeFile(temporary, content, { mode: 0o644, flag: 'wx' })
  try {
    await link(temporary, path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    if (await readFile(path, 'utf8') !== content) {
      throw new Error(`Refusing to overwrite immutable release metadata: ${path}`)
    }
  } finally {
    await unlink(temporary).catch(() => undefined)
  }
}

function hashFile(path: string): Promise<string> {
  return new Promise((resolveHash, reject) => {
    const hash = createHash('sha256')
    const input = createReadStream(path)
    input.once('error', reject)
    input.on('data', chunk => hash.update(chunk))
    input.once('end', () => resolveHash(hash.digest('hex')))
  })
}

function parseArguments(argv: readonly string[]): Options {
  const values = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!
    if (!argument.startsWith('--')) throw new Error(`Unexpected argument: ${argument}`)
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${argument}`)
    values.set(argument.slice(2), value)
    index += 1
  }
  const required = (name: string): string => {
    const value = values.get(name)?.trim()
    if (!value) throw new Error(`Missing --${name}`)
    return value
  }
  const baseUrl = new URL(required('base-url').replace(/\/*$/u, '/') )
  const loopback = baseUrl.protocol === 'http:'
    && (baseUrl.hostname === '127.0.0.1' || baseUrl.hostname === 'localhost')
  if (
    (baseUrl.protocol !== 'https:' && !loopback)
    || baseUrl.username
    || baseUrl.password
    || baseUrl.search
    || baseUrl.hash
  ) {
    throw new Error('--base-url must be a credential-free HTTPS URL')
  }
  const publishedAt = values.has('published-at')
    ? Number(required('published-at'))
    : Date.now()
  if (!Number.isSafeInteger(publishedAt) || publishedAt < 0) {
    throw new Error('--published-at must be a non-negative integer')
  }
  const architecture = (values.get('architecture') ?? process.arch) as 'arm64' | 'x64'
  if (architecture !== 'arm64' && architecture !== 'x64') {
    throw new Error('--architecture must be arm64 or x64')
  }
  return {
    source: required('source'),
    output: values.get('out') ?? 'dist/gateway-update',
    releaseId: required('release-id'),
    versionName: required('version-name'),
    buildId: required('build-id'),
    baseUrl,
    privateKeyFile: required('private-key'),
    publishedAt,
    architecture,
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await publishGatewayUpdateRelease(parseArguments(process.argv.slice(2)))
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}
