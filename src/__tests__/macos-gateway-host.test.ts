import { access, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MACOS_GATEWAY_HOST_BUNDLE_ID,
  MACOS_GATEWAY_HOST_EXECUTABLE,
  installMacosGatewayHost,
  macosGatewayHostExecutablePath,
  macosGatewayHostEntitlements,
  macosGatewayHostInfoPlist,
} from '@/ops/macosGatewayHost'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory =>
    rm(directory, { recursive: true, force: true }),
  ))
})

describe('macOS Gateway Host', () => {
  it('defines a background app with a stable TCC identity and protected-folder reasons', () => {
    const plist = macosGatewayHostInfoPlist()

    expect(plist).toContain(`<string>${MACOS_GATEWAY_HOST_BUNDLE_ID}</string>`)
    expect(plist).toContain(`<string>${MACOS_GATEWAY_HOST_EXECUTABLE}</string>`)
    expect(plist).toContain('<key>LSUIElement</key><true/>')
    expect(plist).toContain('<key>NSDocumentsFolderUsageDescription</key>')
    expect(plist).toContain('<key>NSDesktopFolderUsageDescription</key>')
    expect(plist).toContain('<key>NSDownloadsFolderUsageDescription</key>')
    expect(plist).toContain('<key>NSNetworkVolumesUsageDescription</key>')
    expect(plist).toContain('<key>NSRemovableVolumesUsageDescription</key>')
    expect(macosGatewayHostEntitlements()).toContain(
      '<key>com.apple.security.cs.allow-jit</key><true/>',
    )
    expect(macosGatewayHostEntitlements()).toContain(
      '<key>com.apple.security.cs.disable-library-validation</key><true/>',
    )
  })

  it('installs atomically and reuses the same app instead of replacing its identity', async () => {
    const directory = await temporaryDirectory()
    const sourceNodePath = join(directory, 'node')
    const appPath = join(directory, 'Applications', 'Malink Gateway Host.app')
    await writeFile(sourceNodePath, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    const run = vi.fn(async () => undefined)

    const installed = await installMacosGatewayHost(
      { appPath, sourceNodePath },
      { platform: 'darwin', run },
    )
    expect(installed).toEqual({
      appPath,
      executablePath: macosGatewayHostExecutablePath(appPath),
      created: true,
    })
    await expect(access(installed.executablePath, constants.X_OK)).resolves.toBeUndefined()
    await expect(readFile(join(appPath, 'Contents', 'Info.plist'), 'utf8'))
      .resolves.toBe(macosGatewayHostInfoPlist())
    await expect(readFile(join(appPath, 'Contents', 'Resources', 'host.json'), 'utf8'))
      .resolves.toContain(MACOS_GATEWAY_HOST_BUNDLE_ID)
    expect(run).toHaveBeenCalledWith('/usr/bin/codesign', expect.arrayContaining([
      '--identifier',
      MACOS_GATEWAY_HOST_BUNDLE_ID,
    ]))

    const originalModifiedAt = (await stat(installed.executablePath)).mtimeMs
    const reused = await installMacosGatewayHost(
      { appPath, sourceNodePath },
      { platform: 'darwin', run },
    )
    expect(reused.created).toBe(false)
    expect((await stat(installed.executablePath)).mtimeMs).toBe(originalModifiedAt)
  })

  it('refuses unsupported platforms and non-app destinations', async () => {
    const directory = await temporaryDirectory()
    const sourceNodePath = join(directory, 'node')
    await writeFile(sourceNodePath, '#!/bin/sh\nexit 0\n', { mode: 0o755 })

    await expect(installMacosGatewayHost(
      { sourceNodePath },
      { platform: 'linux', run: async () => undefined },
    )).rejects.toThrow('requires macOS')
    await expect(installMacosGatewayHost(
      { appPath: join(directory, 'host'), sourceNodePath },
      { platform: 'darwin', run: async () => undefined },
    )).rejects.toThrow('must end in .app')
  })
})

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'malink-gateway-host-'))
  temporaryDirectories.push(directory)
  return directory
}
