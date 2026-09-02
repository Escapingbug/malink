import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import {
  canonicalJsonBytes,
  signedGatewayAgentUpdateChannelSchema,
  signedGatewayAgentUpdatePromptSchema,
} from '@malink/protocol'
import {
  base64UrlDecode,
  exportDeviceKeyPair,
  generateDeviceKeyPair,
  toArrayBuffer,
  webCrypto,
} from '@malink/security'
import {
  assertLocalGitCommit,
  defaultGatewayReleaseVersion,
  parseGatewayAgentUpdateArguments,
  publishGatewayAgentUpdate,
} from '../../scripts/gateway-agent-update-release.js'

const temporaryDirectories: string[] = []
const execFileAsync = promisify(execFile)

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path =>
    rm(path, { recursive: true, force: true })))
})

describe('Gateway Agent update publisher', () => {
  it('derives a sortable timestamp and commit based release version', () => {
    expect(defaultGatewayReleaseVersion(
      '12b086dc33867a4a4205d4d1938b694d7634a020',
      Date.UTC(2026, 7, 28, 2, 3, 15, 987),
    )).toBe('2026.08.28-020315Z-12b086d')
  })

  it('uses the timestamp version for omitted CLI identifiers', () => {
    expect(parseGatewayAgentUpdateArguments([
      '--out', '/tmp/published',
      '--commit', '12b086dc33867a4a4205d4d1938b694d7634a020',
      '--published-at', String(Date.UTC(2026, 7, 28, 2, 3, 15)),
      '--prompt-file', '/tmp/PROMPT.md',
      '--private-key', '/tmp/release-key.json',
    ])).toMatchObject({
      releaseId: '2026.08.28-020315Z-12b086d',
      versionName: '2026.08.28-020315Z-12b086d',
      buildId: 'gateway-2026.08.28-020315Z-12b086d',
      channelId: 'stable',
      channelGeneration: Date.UTC(2026, 7, 28, 2, 3, 15),
      mirrorBaseUrls: ['https://escapingbug.github.io/malink/gateway-agent-updates/'],
    })
  })

  it('accepts repeated signed mirror URLs for an intentional channel', () => {
    expect(parseGatewayAgentUpdateArguments([
      '--commit', '12b086dc33867a4a4205d4d1938b694d7634a020',
      '--prompt-file', '/tmp/PROMPT.md',
      '--private-key', '/tmp/release-key.json',
      '--channel-id', 'candidate',
      '--channel-generation', '7',
      '--mirror-base-url', 'https://one.example.test/gateway-agent-updates/',
      '--mirror-base-url', 'https://two.example.test/gateway-agent-updates/',
    ])).toMatchObject({
      channelId: 'candidate',
      channelGeneration: 7,
      mirrorBaseUrls: [
        'https://one.example.test/gateway-agent-updates/',
        'https://two.example.test/gateway-agent-updates/',
      ],
    })
  })

  it('accepts the package-manager argument separator', () => {
    expect(parseGatewayAgentUpdateArguments([
      '--',
      '--commit', '12b086dc33867a4a4205d4d1938b694d7634a020',
      '--prompt-file', '/tmp/PROMPT.md',
      '--private-key', '/tmp/release-key.json',
    ])).toMatchObject({
      commit: '12b086dc33867a4a4205d4d1938b694d7634a020',
      promptFile: '/tmp/PROMPT.md',
      privateKeyFile: '/tmp/release-key.json',
    })
  })

  it('publishes an immutable signed Prompt and a replaceable latest pointer', async () => {
    const root = await temporaryDirectory()
    const keys = await generateDeviceKeyPair()
    const keyPath = join(root, 'release-key.json')
    const promptPath = join(root, 'PROMPT.md')
    const output = join(root, 'published')
    await writeFile(keyPath, JSON.stringify(await exportDeviceKeyPair(keys)), { mode: 0o600 })
    await writeFile(promptPath, 'Build, test, and stage this exact Malink commit.\n')
    const commit = (await execFileAsync('git', ['rev-parse', 'HEAD'], {
      encoding: 'utf8',
    })).stdout.trim()

    const result = await publishGatewayAgentUpdate({
      output,
      releaseId: 'release-2',
      versionName: '2.0.0',
      buildId: 'build-2',
      repositoryUrl: 'https://github.com/Escapingbug/malink.git',
      commit,
      promptFile: promptPath,
      privateKeyFile: keyPath,
      publishedAt: 42,
    })
    const signed = signedGatewayAgentUpdatePromptSchema.parse(JSON.parse(
      await readFile(result.releasePath, 'utf8'),
    ))
    const signedChannel = signedGatewayAgentUpdateChannelSchema.parse(JSON.parse(
      await readFile(result.channelPath, 'utf8'),
    ))
    expect(JSON.parse(await readFile(result.latestPath, 'utf8'))).toEqual(signed)
    expect(signed.update).toMatchObject({
      releaseId: 'release-2',
      buildId: 'build-2',
      repository: {
        url: 'https://github.com/Escapingbug/malink.git',
        commit,
      },
      prompt: 'Build, test, and stage this exact Malink commit.',
    })
    const publicKey = await webCrypto().subtle.importKey(
      'jwk',
      signed.signer.publicKey,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    )
    await expect(webCrypto().subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      publicKey,
      toArrayBuffer(base64UrlDecode(signed.signature.value)),
      toArrayBuffer(canonicalJsonBytes(signed.update)),
    )).resolves.toBe(true)
    expect(signedChannel.channel).toMatchObject({
      channelId: 'stable',
      generation: 42,
      release: {
        releaseId: 'release-2',
        buildId: 'build-2',
        sha256: createHash('sha256').update(canonicalJsonBytes(signed)).digest('hex'),
      },
      mirrors: ['https://escapingbug.github.io/malink/gateway-agent-updates/'],
    })
    await expect(webCrypto().subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      publicKey,
      toArrayBuffer(base64UrlDecode(signedChannel.signature.value)),
      toArrayBuffer(canonicalJsonBytes(signedChannel.channel)),
    )).resolves.toBe(true)

    await expect(publishGatewayAgentUpdate({
      output,
      releaseId: 'release-3',
      versionName: '3.0.0',
      buildId: 'build-3',
      repositoryUrl: 'https://github.com/Escapingbug/malink.git',
      commit,
      promptFile: promptPath,
      privateKeyFile: keyPath,
      publishedAt: 43,
      channelGeneration: 41,
    })).rejects.toThrow(/roll back Gateway update channel/u)
    expect(JSON.parse(await readFile(result.channelPath, 'utf8'))).toEqual(signedChannel)

    await writeFile(promptPath, 'A different Prompt.\n')
    await expect(publishGatewayAgentUpdate({
      output,
      releaseId: 'release-2',
      versionName: '2.0.0',
      buildId: 'build-2',
      repositoryUrl: 'https://github.com/Escapingbug/malink.git',
      commit,
      promptFile: promptPath,
      privateKeyFile: keyPath,
      publishedAt: 42,
    })).rejects.toThrow(/replace immutable update Prompt/u)
  })

  it('refuses to sign a well-formed SHA that is not a local Git commit', async () => {
    await expect(assertLocalGitCommit(
      '0123456789abcdef0123456789abcdef01234567',
    )).rejects.toThrow(/is not a local Git commit/u)
  })
})

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'malink-gateway-agent-update-release-'))
  temporaryDirectories.push(path)
  return path
}
