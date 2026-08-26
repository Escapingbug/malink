import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  canonicalJsonBytes,
  signedGatewayAgentUpdatePromptSchema,
} from '@malink/protocol'
import {
  base64UrlDecode,
  exportDeviceKeyPair,
  generateDeviceKeyPair,
  toArrayBuffer,
  webCrypto,
} from '@malink/security'
import { publishGatewayAgentUpdate } from '../../scripts/gateway-agent-update-release.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path =>
    rm(path, { recursive: true, force: true })))
})

describe('Gateway Agent update publisher', () => {
  it('publishes an immutable signed Prompt and a replaceable latest pointer', async () => {
    const root = await temporaryDirectory()
    const keys = await generateDeviceKeyPair()
    const keyPath = join(root, 'release-key.json')
    const promptPath = join(root, 'PROMPT.md')
    const output = join(root, 'published')
    await writeFile(keyPath, JSON.stringify(await exportDeviceKeyPair(keys)), { mode: 0o600 })
    await writeFile(promptPath, 'Build, test, and stage this exact Malink commit.\n')

    const result = await publishGatewayAgentUpdate({
      output,
      releaseId: 'release-2',
      versionName: '2.0.0',
      buildId: 'build-2',
      repositoryUrl: 'https://github.com/Escapingbug/malink.git',
      commit: '0123456789abcdef0123456789abcdef01234567',
      promptFile: promptPath,
      privateKeyFile: keyPath,
      publishedAt: 42,
    })
    const signed = signedGatewayAgentUpdatePromptSchema.parse(JSON.parse(
      await readFile(result.releasePath, 'utf8'),
    ))
    expect(JSON.parse(await readFile(result.latestPath, 'utf8'))).toEqual(signed)
    expect(signed.update).toMatchObject({
      releaseId: 'release-2',
      buildId: 'build-2',
      repository: {
        url: 'https://github.com/Escapingbug/malink.git',
        commit: '0123456789abcdef0123456789abcdef01234567',
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

    await writeFile(promptPath, 'A different Prompt.\n')
    await expect(publishGatewayAgentUpdate({
      output,
      releaseId: 'release-2',
      versionName: '2.0.0',
      buildId: 'build-2',
      repositoryUrl: 'https://github.com/Escapingbug/malink.git',
      commit: '0123456789abcdef0123456789abcdef01234567',
      promptFile: promptPath,
      privateKeyFile: keyPath,
      publishedAt: 42,
    })).rejects.toThrow(/replace immutable update Prompt/u)
  })
})

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'malink-gateway-agent-update-release-'))
  temporaryDirectories.push(path)
  return path
}
