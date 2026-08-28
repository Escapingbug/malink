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
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  canonicalJson,
  canonicalJsonBytes,
  pairingPublicKeySchema,
  signedGatewayAgentUpdatePromptSchema,
  signedGatewayReleaseManifestSchema,
  type PairingPublicKey,
} from '@malink/protocol'
import {
  base64UrlDecode,
  publicKeyId,
  toArrayBuffer,
  webCrypto,
} from '@malink/security'
import {
  defaultMacosGatewayHostAppPath,
  installMacosGatewayHost,
} from '../src/ops/macosGatewayHost.js'
import { assertLocalDirectoryAccess } from '../src/ops/localFilesystemAccess.js'

interface InstallOptions {
  installRoot: string
  gatewayLaunchAgent: string
  gatewayServiceLabel: string
  gatewayAdminSocket: string
  manifestBaseUrl?: string
  agentPromptBaseUrl?: string
  signerFile: string
  supervisorLaunchAgent: string
  supervisorServiceLabel: string
  updateSocket: string
  currentBuildId?: string
  gatewayHostApp?: string
  gatewayHostPreflightPaths?: readonly string[]
  gatewayHostPreflightTimeoutMs?: number
}

type ResolvedInstallOptions = InstallOptions & {
  currentBuildId: string
  gatewayHostApp: string
  gatewayHostExecutable: string
}

export interface GatewayUpdateSupervisorInstallResult {
  gatewayHostApp: string
  gatewayHostExecutable: string
  gatewayHostCreated: boolean
  gatewayHostPreflightPaths: string[]
}

export async function installGatewayUpdateSupervisor(
  options: InstallOptions,
): Promise<GatewayUpdateSupervisorInstallResult> {
  if (process.platform !== 'darwin') throw new Error('Gateway update supervisor installation requires macOS')
  const installRoot = resolve(options.installRoot)
  const currentRoot = join(installRoot, 'current')
  for (const path of [
    join(currentRoot, 'runtime', 'node'),
    join(currentRoot, 'ops', 'matrix-local-gateway.js'),
    join(currentRoot, 'mcp', 'stdio.js'),
    join(currentRoot, 'ops', 'gatewayUpdateSupervisorMain.js'),
    ...(options.agentPromptBaseUrl
      ? [join(currentRoot, 'ops', 'gatewayAgentUpdateCli.js')]
      : []),
    resolve(options.gatewayLaunchAgent),
  ]) {
    const metadata = await stat(path)
    if (!metadata.isFile()) throw new Error(`Required Gateway installation file is missing: ${path}`)
  }
  if (!options.manifestBaseUrl && !options.agentPromptBaseUrl) {
    throw new Error('A Gateway update Prompt or legacy manifest base URL is required')
  }
  if (options.manifestBaseUrl) {
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
  }
  if (options.agentPromptBaseUrl) {
    const promptBase = new URL(options.agentPromptBaseUrl)
    const promptLoopback = promptBase.protocol === 'http:'
      && (promptBase.hostname === '127.0.0.1' || promptBase.hostname === 'localhost')
    if (
      (promptBase.protocol !== 'https:' && !promptLoopback)
      || promptBase.username
      || promptBase.password
      || promptBase.search
      || promptBase.hash
    ) {
      throw new Error('Gateway Agent update Prompt base must be credential-free HTTPS')
    }
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
  const gatewayHost = await installMacosGatewayHost({
    appPath: options.gatewayHostApp ?? defaultMacosGatewayHostAppPath(),
    sourceNodePath: join(currentRoot, 'runtime', 'node'),
  })
  await validateGatewayHostNativeModules(gatewayHost.executablePath)
  const gatewayHostPreflightPaths = (
    options.gatewayHostPreflightPaths?.length
      ? options.gatewayHostPreflightPaths
      : [join(homedir(), 'Documents')]
  ).map(path => resolve(path))
  for (const path of gatewayHostPreflightPaths) {
    await assertLocalDirectoryAccess(path, {
      allowCreate: false,
      nodeExecutable: gatewayHost.executablePath,
      timeoutMs: options.gatewayHostPreflightTimeoutMs ?? 10_000,
    })
  }
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
    gatewayHostApp: gatewayHost.appPath,
    gatewayHostExecutable: gatewayHost.executablePath,
  })
  await atomicWrite(resolve(options.supervisorLaunchAgent), supervisorPlist, 0o644)
  await setLaunchAgentProgramExecutable(
    resolve(options.gatewayLaunchAgent),
    gatewayHost.executablePath,
  )
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
  await setLaunchAgentEnvironment(
    resolve(options.gatewayLaunchAgent),
    'MALINK_GATEWAY_HOST_APP',
    gatewayHost.appPath,
  )
  const domain = `gui/${process.getuid?.() ?? 0}`
  await run('/bin/launchctl', [
    'bootout',
    `${domain}/${options.supervisorServiceLabel}`,
  ]).catch(() => undefined)
  await bootstrapLaunchAgent(domain, resolve(options.supervisorLaunchAgent))
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
  await bootstrapLaunchAgent(domain, resolve(options.gatewayLaunchAgent))
  await run('/bin/launchctl', [
    'kickstart',
    '-k',
    `${domain}/${options.gatewayServiceLabel}`,
  ])
  return {
    gatewayHostApp: gatewayHost.appPath,
    gatewayHostExecutable: gatewayHost.executablePath,
    gatewayHostCreated: gatewayHost.created,
    gatewayHostPreflightPaths,
  }
}

function supervisorLaunchAgentPlist(options: ResolvedInstallOptions): string {
  const currentRoot = join(options.installRoot, 'current')
  const environment: Record<string, string> = {
    MALINK_GATEWAY_INSTALL_ROOT: options.installRoot,
    MALINK_GATEWAY_RELEASE_SIGNER_FILE: options.signerFile,
    ...(options.manifestBaseUrl
      ? { MALINK_GATEWAY_RELEASE_MANIFEST_BASE_URL: options.manifestBaseUrl }
      : {}),
    ...(options.agentPromptBaseUrl
      ? { MALINK_GATEWAY_AGENT_UPDATE_PROMPT_BASE_URL: options.agentPromptBaseUrl }
      : {}),
    MALINK_GATEWAY_LAUNCH_AGENT: options.gatewayLaunchAgent,
    MALINK_GATEWAY_SERVICE_LABEL: options.gatewayServiceLabel,
    MALINK_GATEWAY_ADMIN_SOCKET: options.gatewayAdminSocket,
    MALINK_GATEWAY_UPDATE_SOCKET: options.updateSocket,
    MALINK_GATEWAY_BUILD_ID: options.currentBuildId,
    MALINK_GATEWAY_HOST_APP: options.gatewayHostApp,
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xml(options.supervisorServiceLabel)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(options.gatewayHostExecutable)}</string>
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
    const signed = signedGatewayAgentUpdatePromptSchema.parse(JSON.parse(await readFile(
      join(currentRoot, 'release-prompt.json'),
      'utf8',
    )))
    await verifySignedReleaseMetadata(
      signed.signer,
      signed.signature,
      signed.update,
      trustedSigner,
      'Gateway Agent update Prompt',
    )
    return signed.update.buildId
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  try {
    const signed = signedGatewayReleaseManifestSchema.parse(JSON.parse(await readFile(
      join(currentRoot, 'release-manifest.json'),
      'utf8',
    )))
    await verifySignedReleaseMetadata(
      signed.signer,
      signed.signature,
      signed.manifest,
      trustedSigner,
      'Gateway release manifest',
    )
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

async function verifySignedReleaseMetadata(
  signer: PairingPublicKey,
  signature: { keyId: string; algorithm: 'ES256'; value: string },
  payload: unknown,
  trustedSigner: PairingPublicKey,
  label: string,
): Promise<void> {
  const trustedKeyId = await publicKeyId(trustedSigner.publicKey)
  if (
    signer.keyId !== trustedKeyId
    || signature.keyId !== trustedKeyId
    || canonicalJson(signer) !== canonicalJson(trustedSigner)
  ) {
    throw new Error(`The current ${label} does not use the pinned signer`)
  }
  const key = await webCrypto().subtle.importKey(
    'jwk',
    signer.publicKey,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify'],
  )
  const valid = await webCrypto().subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    toArrayBuffer(base64UrlDecode(signature.value)),
    toArrayBuffer(canonicalJsonBytes(payload)),
  )
  if (!valid) throw new Error(`The current ${label} signature is invalid`)
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

async function setLaunchAgentProgramExecutable(path: string, executable: string): Promise<void> {
  await run('/usr/libexec/PlistBuddy', [
    '-c',
    `Set :ProgramArguments:0 ${plistValue(executable)}`,
    path,
  ])
  await run('/usr/libexec/PlistBuddy', [
    '-c',
    `Set :Program ${plistValue(executable)}`,
    path,
  ])
    .catch(() => undefined)
}

async function validateGatewayHostNativeModules(executable: string): Promise<void> {
  const entrypoint = createRequire(import.meta.url).resolve(
    '@matrix-org/matrix-sdk-crypto-nodejs',
  )
  await run(executable, [
    '--input-type=module',
    '--eval',
    `await import(${JSON.stringify(pathToFileURL(entrypoint).href)})`,
  ])
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

async function bootstrapLaunchAgent(domain: string, plistPath: string): Promise<void> {
  let lastError: unknown = new Error('launchctl bootstrap did not run')
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await run('/bin/launchctl', ['bootstrap', domain, plistPath])
      return
    } catch (error) {
      lastError = error
    }
    if (attempt < 4) {
      await new Promise(resolveDelay => setTimeout(resolveDelay, 250 * (attempt + 1)))
    }
  }
  throw lastError
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
  const gatewayHostPreflightPaths: string[] = []
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index]!
    const value = argv[index + 1]
    if (!name.startsWith('--') || !value || value.startsWith('--')) {
      throw new Error(`Invalid installer argument near ${name}`)
    }
    if (name === '--gateway-host-preflight-path') {
      gatewayHostPreflightPaths.push(resolve(value))
    } else {
      values.set(name.slice(2), value)
    }
    index += 1
  }
  const required = (name: string): string => {
    const value = values.get(name)?.trim()
    if (!value) throw new Error(`Missing --${name}`)
    return value
  }
  const installRoot = resolve(required('install-root'))
  const gatewayHostPreflightTimeoutMs = Number(
    values.get('gateway-host-preflight-timeout-ms') ?? 10_000,
  )
  if (
    !Number.isSafeInteger(gatewayHostPreflightTimeoutMs)
    || gatewayHostPreflightTimeoutMs < 100
    || gatewayHostPreflightTimeoutMs > 120_000
  ) {
    throw new Error(
      '--gateway-host-preflight-timeout-ms must be an integer between 100 and 120000',
    )
  }
  return {
    installRoot,
    gatewayLaunchAgent: resolve(required('gateway-launch-agent')),
    gatewayServiceLabel: required('gateway-service-label'),
    gatewayAdminSocket: resolve(required('gateway-admin-socket')),
    ...(values.get('manifest-base-url')?.trim()
      ? { manifestBaseUrl: values.get('manifest-base-url')!.trim() }
      : {}),
    ...(values.get('agent-prompt-base-url')?.trim()
      ? { agentPromptBaseUrl: values.get('agent-prompt-base-url')!.trim() }
      : {}),
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
    gatewayHostApp: resolve(
      values.get('gateway-host-app') ?? defaultMacosGatewayHostAppPath(),
    ),
    ...(gatewayHostPreflightPaths.length > 0 ? { gatewayHostPreflightPaths } : {}),
    gatewayHostPreflightTimeoutMs,
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await installGatewayUpdateSupervisor(parseArguments(process.argv.slice(2)))
  process.stdout.write(
    'Gateway update supervisor is installed and the Gateway is connected to it.\n'
    + `Gateway permission host: ${result.gatewayHostApp}\n`
    + `Verified local access: ${result.gatewayHostPreflightPaths.join(', ')}\n`
    + 'Confirm that this app is enabled in System Settings > Privacy & Security > '
    + 'Full Disk Access, then run the Gateway Host doctor before relying on '
    + 'unattended remote access.\n',
  )
}
