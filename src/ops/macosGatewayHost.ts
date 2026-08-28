import { spawn } from 'node:child_process'
import {
  access,
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { constants } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

export const MACOS_GATEWAY_HOST_BUNDLE_ID = 'io.malink.gateway.host'
export const MACOS_GATEWAY_HOST_NAME = 'Malink Gateway Host'
export const MACOS_GATEWAY_HOST_EXECUTABLE = 'MalinkGatewayHost'
export const MACOS_GATEWAY_HOST_FORMAT_VERSION = 1

export interface MacosGatewayHostInstallOptions {
  appPath?: string
  sourceNodePath: string
}

export interface MacosGatewayHostInstallResult {
  appPath: string
  executablePath: string
  created: boolean
}

interface MacosGatewayHostDependencies {
  platform?: NodeJS.Platform
  run?: (command: string, arguments_: readonly string[]) => Promise<void>
}

interface HostMetadata {
  version: typeof MACOS_GATEWAY_HOST_FORMAT_VERSION
  bundleId: typeof MACOS_GATEWAY_HOST_BUNDLE_ID
  executable: typeof MACOS_GATEWAY_HOST_EXECUTABLE
}

export function defaultMacosGatewayHostAppPath(): string {
  return join(homedir(), 'Applications', `${MACOS_GATEWAY_HOST_NAME}.app`)
}

export function macosGatewayHostExecutablePath(appPath: string): string {
  return join(resolve(appPath), 'Contents', 'MacOS', MACOS_GATEWAY_HOST_EXECUTABLE)
}

export function macosGatewayHostInfoPlist(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleDisplayName</key><string>${MACOS_GATEWAY_HOST_NAME}</string>
  <key>CFBundleExecutable</key><string>${MACOS_GATEWAY_HOST_EXECUTABLE}</string>
  <key>CFBundleIdentifier</key><string>${MACOS_GATEWAY_HOST_BUNDLE_ID}</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>${MACOS_GATEWAY_HOST_NAME}</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key><string>${MACOS_GATEWAY_HOST_FORMAT_VERSION}</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>
  <key>NSDesktopFolderUsageDescription</key>
  <string>Malink needs access to project folders on the Desktop when you explicitly configure them for remote Agent work.</string>
  <key>NSDocumentsFolderUsageDescription</key>
  <string>Malink needs access to projects in Documents so your authorized remote devices can run the configured coding Agent.</string>
  <key>NSDownloadsFolderUsageDescription</key>
  <string>Malink needs access to project files in Downloads only when you explicitly configure that location.</string>
  <key>NSNetworkVolumesUsageDescription</key>
  <string>Malink needs access to projects on network volumes only when you explicitly configure those volumes.</string>
  <key>NSRemovableVolumesUsageDescription</key>
  <string>Malink needs access to projects on removable volumes only when you explicitly configure those volumes.</string>
</dict>
</plist>
`
}

export function macosGatewayHostEntitlements(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.cs.allow-jit</key><true/>
  <key>com.apple.security.cs.disable-library-validation</key><true/>
</dict>
</plist>
`
}

export async function installMacosGatewayHost(
  options: MacosGatewayHostInstallOptions,
  dependencies: MacosGatewayHostDependencies = {},
): Promise<MacosGatewayHostInstallResult> {
  if ((dependencies.platform ?? process.platform) !== 'darwin') {
    throw new Error('Malink Gateway Host installation requires macOS')
  }
  const sourceNodePath = resolve(options.sourceNodePath)
  const sourceMetadata = await lstat(sourceNodePath)
  if (sourceMetadata.isSymbolicLink() || !sourceMetadata.isFile()) {
    throw new Error(`Gateway Host Node runtime is not a regular file: ${sourceNodePath}`)
  }
  await access(sourceNodePath, constants.X_OK)

  const appPath = resolve(options.appPath ?? defaultMacosGatewayHostAppPath())
  if (!appPath.endsWith('.app')) {
    throw new Error('Gateway Host path must end in .app')
  }
  const executablePath = macosGatewayHostExecutablePath(appPath)
  const run = dependencies.run ?? runCommand
  if (await pathExists(appPath)) {
    await validateInstalledMacosGatewayHost(appPath, run)
    return { appPath, executablePath, created: false }
  }

  const temporaryAppPath = `${appPath}.next.${process.pid}.${randomUUID()}`
  try {
    await mkdir(join(temporaryAppPath, 'Contents', 'MacOS'), {
      recursive: true,
      mode: 0o755,
    })
    await mkdir(join(temporaryAppPath, 'Contents', 'Resources'), {
      recursive: true,
      mode: 0o755,
    })
    const temporaryExecutable = macosGatewayHostExecutablePath(temporaryAppPath)
    await copyFile(sourceNodePath, temporaryExecutable, constants.COPYFILE_EXCL)
    await chmod(temporaryExecutable, 0o755)
    await writeFile(
      join(temporaryAppPath, 'Contents', 'Info.plist'),
      macosGatewayHostInfoPlist(),
      { mode: 0o644, flag: 'wx' },
    )
    const metadata: HostMetadata = {
      version: MACOS_GATEWAY_HOST_FORMAT_VERSION,
      bundleId: MACOS_GATEWAY_HOST_BUNDLE_ID,
      executable: MACOS_GATEWAY_HOST_EXECUTABLE,
    }
    await writeFile(
      join(temporaryAppPath, 'Contents', 'Resources', 'host.json'),
      `${JSON.stringify(metadata)}\n`,
      { mode: 0o644, flag: 'wx' },
    )
    const entitlementsPath = join(
      temporaryAppPath,
      'Contents',
      'Resources',
      'host.entitlements.plist',
    )
    await writeFile(
      entitlementsPath,
      macosGatewayHostEntitlements(),
      { mode: 0o644, flag: 'wx' },
    )
    await run('/usr/bin/codesign', [
      '--force',
      '--sign',
      '-',
      '--identifier',
      MACOS_GATEWAY_HOST_BUNDLE_ID,
      '--options',
      'runtime',
      '--entitlements',
      entitlementsPath,
      '--timestamp=none',
      temporaryAppPath,
    ])
    await validateInstalledMacosGatewayHost(temporaryAppPath, run)
    await mkdir(dirname(appPath), { recursive: true, mode: 0o755 })
    await rename(temporaryAppPath, appPath)
    await validateInstalledMacosGatewayHost(appPath, run)
    return { appPath, executablePath, created: true }
  } finally {
    await rm(temporaryAppPath, { recursive: true, force: true })
  }
}

export async function validateInstalledMacosGatewayHost(
  appPathInput: string,
  run: (command: string, arguments_: readonly string[]) => Promise<void> = runCommand,
): Promise<void> {
  const appPath = resolve(appPathInput)
  const appMetadata = await lstat(appPath)
  if (appMetadata.isSymbolicLink() || !appMetadata.isDirectory()) {
    throw new Error(`Gateway Host is not a regular app bundle: ${appPath}`)
  }
  const executablePath = macosGatewayHostExecutablePath(appPath)
  const executableMetadata = await lstat(executablePath)
  if (executableMetadata.isSymbolicLink() || !executableMetadata.isFile()) {
    throw new Error(`Gateway Host executable is not a regular file: ${executablePath}`)
  }
  await access(executablePath, constants.X_OK)
  const plist = await readFile(join(appPath, 'Contents', 'Info.plist'), 'utf8')
  if (plist !== macosGatewayHostInfoPlist()) {
    throw new Error(
      `Gateway Host metadata differs from the supported stable identity: ${appPath}`,
    )
  }
  const entitlements = await readFile(
    join(appPath, 'Contents', 'Resources', 'host.entitlements.plist'),
    'utf8',
  )
  if (entitlements !== macosGatewayHostEntitlements()) {
    throw new Error(`Gateway Host entitlements are invalid: ${appPath}`)
  }
  const metadata = JSON.parse(await readFile(
    join(appPath, 'Contents', 'Resources', 'host.json'),
    'utf8',
  )) as Partial<HostMetadata>
  if (
    metadata.version !== MACOS_GATEWAY_HOST_FORMAT_VERSION
    || metadata.bundleId !== MACOS_GATEWAY_HOST_BUNDLE_ID
    || metadata.executable !== MACOS_GATEWAY_HOST_EXECUTABLE
  ) {
    throw new Error(`Gateway Host version metadata is invalid: ${appPath}`)
  }
  await run('/usr/bin/codesign', ['--verify', '--strict', '--verbose=2', appPath])
  await run(executablePath, [
    '--input-type=module',
    '--eval',
    'if (typeof process.versions.node !== "string") process.exitCode = 1',
  ])
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

function runCommand(command: string, arguments_: readonly string[]): Promise<void> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, [...arguments_], { stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', code => {
      if (code === 0) resolveRun()
      else reject(new Error(`${command} exited with ${code}`))
    })
  })
}
