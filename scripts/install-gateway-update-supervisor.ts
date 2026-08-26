import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  access,
  chmod,
  mkdir,
  readFile,
  rename,
  stat,
  writeFile,
} from 'node:fs/promises'
import { constants } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  canonicalJson,
  canonicalJsonBytes,
  pairingPublicKeySchema,
  signedGatewayReleaseManifestSchema,
  type PairingPublicKey,
} from '@malink/protocol'
import {
  base64UrlDecode,
  publicKeyId,
  toArrayBuffer,
  webCrypto,
} from '@malink/security'

interface InstallOptions {
  installRoot: string
  gatewayLaunchAgent: string
  gatewayServiceLabel: string
  gatewayAdminSocket: string
  manifestBaseUrl: string
  signerFile: string
  supervisorLaunchAgent: string
  supervisorServiceLabel: string
  updateSocket: string
  currentBuildId?: string
}

type ResolvedInstallOptions = InstallOptions & { currentBuildId: string }

export async function installGatewayUpdateSupervisor(options: InstallOptions): Promise<void> {
  if (process.platform !== 'darwin') throw new Error('Gateway update supervisor installation requires macOS')
  const installRoot = resolve(options.installRoot)
  const currentRoot = join(installRoot, 'current')
  for (const path of [
    join(currentRoot, 'runtime', 'node'),
    join(currentRoot, 'ops', 'matrix-local-gateway.js'),
    join(currentRoot, 'ops', 'gatewayUpdateSupervisorMain.js'),
    resolve(options.gatewayLaunchAgent),
  ]) {
    const metadata = await stat(path)
    if (!metadata.isFile()) throw new Error(`Required Gateway installation file is missing: ${path}`)
  }
  const manifestBase = new URL(options.manifestBaseUrl)
  const loopback = manifestBase.protocol === 'http:'
    && (manifestBase.hostname === '127.0.0.1' || manifestBase.hostname === 'localhost')
  if (
    (manifestBase.protocol !== 'https:' && !loopback)
    || manifestBase.username
    || manifestBase.password
    || manifestBase.search
    || manifestBase.hash
  ) {
    throw new Error('Gateway release manifest base must be credential-free HTTPS')
  }
  const signer = pairingPublicKeySchema.parse(JSON.parse(await readFile(
    resolve(options.signerFile),
    'utf8',
  )))
  const currentBuildId = await resolveCurrentBuildId(
    currentRoot,
    signer,
    options.currentBuildId,
  )
  await mkdir(installRoot, { recursive: true, mode: 0o700 })
  const pinnedSignerPath = join(installRoot, 'release-signer.json')
  await writePinnedSigner(pinnedSignerPath, `${JSON.stringify(signer)}\n`)
  const supervisorPlist = supervisorLaunchAgentPlist({
    ...options,
    currentBuildId,
    installRoot,
    signerFile: pinnedSignerPath,
    supervisorLaunchAgent: resolve(options.supervisorLaunchAgent),
    gatewayLaunchAgent: resolve(options.gatewayLaunchAgent),
    gatewayAdminSocket: resolve(options.gatewayAdminSocket),
    updateSocket: resolve(options.updateSocket),
  })
  await atomicWrite(resolve(options.supervisorLaunchAgent), supervisorPlist, 0o644)
  await setLaunchAgentEnvironment(
    resolve(options.gatewayLaunchAgent),
    'MALINK_GATEWAY_UPDATE_SOCKET',
    resolve(options.updateSocket),
  )
  await setLaunchAgentEnvironment(
    resolve(options.gatewayLaunchAgent),
    'MALINK_GATEWAY_BUILD_ID',
    currentBuildId,
  )
  const domain = `gui/${process.getuid?.() ?? 0}`
  await run('/bin/launchctl', [
    'bootout',
    `${domain}/${options.supervisorServiceLabel}`,
  ]).catch(() => undefined)
  await run('/bin/launchctl', [
    'bootstrap',
    domain,
    resolve(options.supervisorLaunchAgent),
  ])
  await run('/bin/launchctl', [
    'kickstart',
    '-k',
    `${domain}/${options.supervisorServiceLabel}`,
  ])
  await waitForFile(resolve(options.updateSocket), 10_000)
  // The Gateway reads its supervisor socket at process start. Restart only
  // after the independent supervisor is ready, so this one-time installation
  // cannot leave the remote path without an update owner.
  await run('/bin/launchctl', [
    'bootout',
    `${domain}/${options.gatewayServiceLabel}`,
  ]).catch(() => undefined)
  await run('/bin/launchctl', [
    'bootstrap',
    domain,
    resolve(options.gatewayLaunchAgent),
  ])
  await run('/bin/launchctl', [
    'kickstart',
    '-k',
    `${domain}/${options.gatewayServiceLabel}`,
  ])
}

function supervisorLaunchAgentPlist(options: ResolvedInstallOptions): string {
  const currentRoot = join(options.installRoot, 'current')
  const environment: Record<string, string> = {
    MALINK_GATEWAY_INSTALL_ROOT: options.installRoot,
    MALINK_GATEWAY_RELEASE_SIGNER_FILE: options.signerFile,
    MALINK_GATEWAY_RELEASE_MANIFEST_BASE_URL: options.manifestBaseUrl,
    MALINK_GATEWAY_LAUNCH_AGENT: options.gatewayLaunchAgent,
    MALINK_GATEWAY_SERVICE_LABEL: options.gatewayServiceLabel,
    MALINK_GATEWAY_ADMIN_SOCKET: options.gatewayAdminSocket,
    MALINK_GATEWAY_UPDATE_SOCKET: options.updateSocket,
    MALINK_GATEWAY_BUILD_ID: options.currentBuildId,
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xml(options.supervisorServiceLabel)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(join(currentRoot, 'runtime', 'node'))}</string>
    <string>${xml(join(currentRoot, 'ops', 'gatewayUpdateSupervisorMain.js'))}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${Object.entries(environment).map(([key, value]) =>
    `    <key>${xml(key)}</key><string>${xml(value)}</string>`).join('\n')}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${xml(join(options.installRoot, 'update-supervisor.log'))}</string>
  <key>StandardErrorPath</key><string>${xml(join(options.installRoot, 'update-supervisor.error.log'))}</string>
</dict>
</plist>
`
}

async function resolveCurrentBuildId(
  currentRoot: string,
  trustedSigner: PairingPublicKey,
  configured: string | undefined,
): Promise<string> {
  try {
    const signed = signedGatewayReleaseManifestSchema.parse(JSON.parse(await readFile(
      join(currentRoot, 'release-manifest.json'),
      'utf8',
    )))
    const trustedKeyId = await publicKeyId(trustedSigner.publicKey)
    if (
      signed.signer.keyId !== trustedKeyId
      || signed.signature.keyId !== trustedKeyId
      || canonicalJson(signed.signer) !== canonicalJson(trustedSigner)
    ) {
      throw new Error('The current Gateway release manifest does not use the pinned signer')
    }
    const key = await webCrypto().subtle.importKey(
      'jwk',
      signed.signer.publicKey,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    )
    const valid = await webCrypto().subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      toArrayBuffer(base64UrlDecode(signed.signature.value)),
      toArrayBuffer(canonicalJsonBytes(signed.manifest)),
    )
    if (!valid) throw new Error('The current Gateway release manifest signature is invalid')
    return signed.manifest.buildId
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const fallback = configured?.trim()
  if (!fallback || fallback.length > 256) {
    throw new Error(
      'The current Gateway has no signed release manifest; provide --current-build-id '
      + 'so the first online update can prove rollback restored the baseline build',
    )
  }
  return fallback
}

async function setLaunchAgentEnvironment(path: string, key: string, value: string): Promise<void> {
  await run('/usr/libexec/PlistBuddy', ['-c', 'Add :EnvironmentVariables dict', path])
    .catch(() => undefined)
  const entry = `:EnvironmentVariables:${key}`
  await run('/usr/libexec/PlistBuddy', ['-c', `Set ${entry} ${plistValue(value)}`, path])
    .catch(async () => run('/usr/libexec/PlistBuddy', [
      '-c',
      `Add ${entry} string ${plistValue(value)}`,
      path,
    ]))
}

function plistValue(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}

async function writePinnedSigner(path: string, content: string): Promise<void> {
  try {
    const current = await readFile(path, 'utf8')
    if (current !== content) {
      throw new Error(
        `A different Gateway release signer is already pinned at ${path}; `
        + 'key rotation requires an explicit offline migration',
      )
    }
    return
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  await atomicWrite(path, content, 0o600)
}

async function atomicWrite(path: string, content: string, mode: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.next.${process.pid}.${randomUUID()}`
  await writeFile(temporary, content, { mode, flag: 'wx' })
  await rename(temporary, path)
  await chmod(path, mode)
}

async function waitForFile(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  do {
    try {
      await access(path, constants.F_OK)
      return
    } catch {
      await new Promise(resolveDelay => setTimeout(resolveDelay, 100))
    }
  } while (Date.now() < deadline)
  throw new Error(`Gateway update supervisor socket did not appear: ${path}`)
}

function run(command: string, arguments_: readonly string[]): Promise<void> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, arguments_, { stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', code => {
      if (code === 0) resolveRun()
      else reject(new Error(`${command} exited with ${code}`))
    })
  })
}

function xml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

function parseArguments(argv: readonly string[]): InstallOptions {
  const values = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index]!
    const value = argv[index + 1]
    if (!name.startsWith('--') || !value || value.startsWith('--')) {
      throw new Error(`Invalid installer argument near ${name}`)
    }
    values.set(name.slice(2), value)
    index += 1
  }
  const required = (name: string): string => {
    const value = values.get(name)?.trim()
    if (!value) throw new Error(`Missing --${name}`)
    return value
  }
  const installRoot = resolve(required('install-root'))
  return {
    installRoot,
    gatewayLaunchAgent: resolve(required('gateway-launch-agent')),
    gatewayServiceLabel: required('gateway-service-label'),
    gatewayAdminSocket: resolve(required('gateway-admin-socket')),
    manifestBaseUrl: required('manifest-base-url'),
    signerFile: resolve(required('signer-file')),
    supervisorLaunchAgent: resolve(
      values.get('supervisor-launch-agent')
        ?? join(homedir(), 'Library', 'LaunchAgents', 'io.malink.gateway-update-supervisor.plist'),
    ),
    supervisorServiceLabel: values.get('supervisor-service-label')
      ?? 'io.malink.gateway-update-supervisor',
    updateSocket: resolve(values.get('update-socket')
      ?? join(installRoot, 'update-supervisor.sock')),
    ...(values.get('current-build-id')?.trim()
      ? { currentBuildId: values.get('current-build-id')!.trim() }
      : {}),
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await installGatewayUpdateSupervisor(parseArguments(process.argv.slice(2)))
  process.stdout.write('Gateway update supervisor is installed and the Gateway is connected to it.\n')
}
