import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import {
  link,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import {
  canonicalJsonBytes,
  gatewayAgentUpdatePromptSchema,
  pairingPublicKeySchema,
  signedGatewayAgentUpdatePromptSchema,
} from '@malink/protocol'
import {
  base64UrlEncode,
  importDeviceKeyPair,
  toArrayBuffer,
  webCrypto,
  type SerializedDeviceKeyPair,
} from '@malink/security'
import { GATEWAY_STATE_CATALOG } from '../src/gateway/matrix/stateUpgradeCatalog.js'

const DEFAULT_REPOSITORY_URL = 'https://github.com/Escapingbug/malink.git'
const execFileAsync = promisify(execFile)

interface GatewayAgentUpdateReleaseOptions {
  output: string
  releaseId: string
  versionName: string
  buildId: string
  repositoryUrl: string
  commit: string
  promptFile: string
  privateKeyFile: string
  publishedAt: number
}

export async function publishGatewayAgentUpdate(
  options: GatewayAgentUpdateReleaseOptions,
): Promise<{ releasePath: string; latestPath: string; signerPath: string }> {
  await assertLocalGitCommit(options.commit)
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
  const prompt = (await readFile(resolve(options.promptFile), 'utf8')).trim()
  const update = gatewayAgentUpdatePromptSchema.parse({
    kind: 'malink.gateway.agent-update',
    version: 1,
    releaseId: options.releaseId,
    versionName: options.versionName,
    buildId: options.buildId,
    publishedAt: options.publishedAt,
    platform: 'darwin',
    repository: {
      url: options.repositoryUrl,
      commit: options.commit,
    },
    prompt,
    stateCatalog: GATEWAY_STATE_CATALOG.map(({ id, stateClass, schemaVersion }) => ({
      id,
      stateClass,
      schemaVersion,
    })),
  })
  const rawSignature = await webCrypto().subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    keys.privateKey,
    toArrayBuffer(canonicalJsonBytes(update)),
  )
  const signed = signedGatewayAgentUpdatePromptSchema.parse({
    update,
    signer,
    signature: {
      algorithm: 'ES256',
      keyId: keys.keyId,
      value: base64UrlEncode(new Uint8Array(rawSignature)),
    },
  })
  const output = resolve(options.output)
  const releasePath = join(output, 'releases', `${options.releaseId}.json`)
  const latestPath = join(output, 'latest.json')
  const signerPath = join(output, 'release-signer.json')
  await writeImmutableJson(releasePath, signed)
  await writeImmutableJson(signerPath, signer)
  await writeAtomicJson(latestPath, signed)
  return { releasePath, latestPath, signerPath }
}

export async function assertLocalGitCommit(commit: string, cwd = process.cwd()): Promise<void> {
  if (!/^[0-9a-f]{40}$/u.test(commit)) {
    throw new Error('Gateway Agent update commit must be an exact 40-character lowercase Git SHA')
  }
  try {
    const { stdout } = await execFileAsync('git', ['cat-file', '-t', commit], {
      cwd,
      encoding: 'utf8',
    })
    if (stdout.trim() !== 'commit') {
      throw new Error(`Git object is ${stdout.trim() || 'unknown'}, not a commit`)
    }
  } catch (error) {
    throw new Error(
      `Refusing to sign Gateway update: ${commit} is not a local Git commit`,
      { cause: error },
    )
  }
}

async function writeImmutableJson(path: string, value: unknown): Promise<void> {
  const content = `${JSON.stringify(value)}\n`
  try {
    const existing = await readFile(path, 'utf8')
    if (existing !== content) throw new Error(`Refusing to replace immutable update Prompt: ${path}`)
    return
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.next.${process.pid}.${randomUUID()}`
  await writeFile(temporary, content, { mode: 0o644, flag: 'wx' })
  try {
    await link(temporary, path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    if (await readFile(path, 'utf8') !== content) {
      throw new Error(`Refusing to replace immutable update Prompt: ${path}`)
    }
  } finally {
    await unlink(temporary).catch(() => undefined)
  }
}

async function writeAtomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.next.${process.pid}.${randomUUID()}`
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o644, flag: 'wx' })
  await rename(temporary, path)
}

function parseArguments(argv: readonly string[]): GatewayAgentUpdateReleaseOptions {
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
  const publishedAt = values.has('published-at')
    ? Number(required('published-at'))
    : Date.now()
  if (!Number.isSafeInteger(publishedAt) || publishedAt < 0) {
    throw new Error('--published-at must be a non-negative integer')
  }
  return {
    output: values.get('out') ?? 'dist/gateway-agent-update',
    releaseId: required('release-id'),
    versionName: required('version-name'),
    buildId: required('build-id'),
    repositoryUrl: values.get('repository-url') ?? DEFAULT_REPOSITORY_URL,
    commit: required('commit'),
    promptFile: required('prompt-file'),
    privateKeyFile: required('private-key'),
    publishedAt,
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await publishGatewayAgentUpdate(parseArguments(process.argv.slice(2)))
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}
