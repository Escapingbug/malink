import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  canonicalJsonBytes,
  signedGatewayReleaseManifestSchema,
} from '@malink/protocol'
import {
  base64UrlDecode,
  exportDeviceKeyPair,
  generateDeviceKeyPair,
  toArrayBuffer,
  webCrypto,
} from '@malink/security'
import { publishGatewayUpdateRelease } from '../../scripts/gateway-update-release.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path =>
    rm(path, { recursive: true, force: true })))
})

describe('Gateway update release publisher', () => {
  it('copies immutable artifacts and signs the complete release manifest', async () => {
    const root = await temporaryDirectory()
    const source = join(root, 'prepared')
    await preparedRelease(source)
    const keys = await generateDeviceKeyPair()
    const keyPath = join(root, 'release-key.json')
    await writeFile(keyPath, JSON.stringify(await exportDeviceKeyPair(keys)), { mode: 0o600 })

    const result = await publishGatewayUpdateRelease({
      source,
      output: join(root, 'published'),
      releaseId: 'release-2',
      versionName: '2.0.0',
      buildId: 'build-2',
      baseUrl: new URL('https://updates.example.test/gateway/'),
      privateKeyFile: keyPath,
      publishedAt: 42,
      architecture: process.arch as 'arm64' | 'x64',
    })
    const signed = signedGatewayReleaseManifestSchema.parse(JSON.parse(
      await readFile(result.manifestPath, 'utf8'),
    ))
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
      toArrayBuffer(canonicalJsonBytes(signed.manifest)),
    )).resolves.toBe(true)
    expect(signed.manifest.files.map(file => file.path)).toEqual([
      'mcp/stdio.js',
      'ops/gatewayAgentUpdateCli.js',
      'ops/gatewayJournalRepairCli.js',
      'ops/gatewayUpdateSupervisorMain.js',
      'ops/matrix-local-gateway.js',
      'runtime/node',
    ])
    for (const file of signed.manifest.files) {
      const artifact = join(
        root,
        'published',
        'artifacts',
        'release-2',
        ...file.path.split('/'),
      )
      expect(createHash('sha256').update(await readFile(artifact)).digest('hex'))
        .toBe(file.sha256)
    }

    await writeFile(join(source, 'ops', 'matrix-local-gateway.js'), '// changed\n')
    await expect(publishGatewayUpdateRelease({
      source,
      output: join(root, 'published'),
      releaseId: 'release-2',
      versionName: '2.0.0',
      buildId: 'build-2',
      baseUrl: new URL('https://updates.example.test/gateway/'),
      privateKeyFile: keyPath,
      publishedAt: 42,
      architecture: process.arch as 'arm64' | 'x64',
    })).rejects.toThrow(/overwrite release artifact/u)
  })

  it('rejects a signed manifest that the supervisor cannot download', async () => {
    const root = await temporaryDirectory()
    const source = join(root, 'prepared')
    await preparedRelease(source)
    const longDirectory = join(source, 'node_modules', 'x'.repeat(200))
    await mkdir(longDirectory, { recursive: true })
    for (let start = 0; start < 1_800; start += 100) {
      await Promise.all(Array.from({ length: 100 }, (_, offset) =>
        writeFile(join(longDirectory, `runtime-${start + offset}.js`), 'x')))
    }
    const keys = await generateDeviceKeyPair()
    const keyPath = join(root, 'release-key.json')
    await writeFile(keyPath, JSON.stringify(await exportDeviceKeyPair(keys)), { mode: 0o600 })
    const output = join(root, 'published')

    await expect(publishGatewayUpdateRelease({
      source,
      output,
      releaseId: 'release-too-large',
      versionName: '2.0.0',
      buildId: 'build-too-large',
      baseUrl: new URL('https://updates.example.test/gateway/'),
      privateKeyFile: keyPath,
      publishedAt: 42,
      architecture: process.arch as 'arm64' | 'x64',
    })).rejects.toThrow(/manifest exceeds 1048576 bytes/u)
    await expect(readFile(join(
      output,
      'artifacts',
      'release-too-large',
      'runtime',
      'node',
    ))).rejects.toMatchObject({ code: 'ENOENT' })
  }, 30_000)
})

async function preparedRelease(root: string): Promise<void> {
  await mkdir(join(root, 'runtime'), { recursive: true })
  await mkdir(join(root, 'ops'), { recursive: true })
  await mkdir(join(root, 'mcp'), { recursive: true })
  await writeFile(join(root, 'runtime', 'node'), '#!/bin/sh\n', { mode: 0o755 })
  await writeFile(join(root, 'mcp', 'stdio.js'), '// mcp\n')
  await writeFile(join(root, 'ops', 'matrix-local-gateway.js'), '// gateway\n')
  await writeFile(
    join(root, 'ops', 'gatewayAgentUpdateCli.js'),
    '// Agent update CLI\n',
  )
  await writeFile(
    join(root, 'ops', 'gatewayJournalRepairCli.js'),
    '// journal repair CLI\n',
  )
  await writeFile(
    join(root, 'ops', 'gatewayUpdateSupervisorMain.js'),
    '// supervisor\n',
  )
}

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'malink-gateway-update-release-'))
  temporaryDirectories.push(path)
  return path
}
