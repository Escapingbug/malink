import { createHash, randomUUID } from 'node:crypto'
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
} from 'node:fs/promises'
import { constants, createReadStream } from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import {
  canonicalJson,
  canonicalJsonBytes,
  gatewayUpdateStatusSchema,
  signedGatewayAgentUpdatePromptSchema,
  signedGatewayReleaseManifestSchema,
  type GatewayAgentUpdatePrompt,
  type GatewayReleaseManifest,
  type GatewayUpdateStatus,
  type PairingPublicKey,
  type SignedGatewayAgentUpdatePrompt,
  type SignedGatewayReleaseManifest,
} from '@malink/protocol'
import {
  base64UrlDecode,
  publicKeyId,
  toArrayBuffer,
  webCrypto,
} from '@malink/security'
import { AtomicJsonFile } from '@malink/security/node'
import {
  activateMacosGatewayRelease,
  validateMacosGatewayRelease,
  type MacosGatewayReleaseOptions,
} from './macosGatewayRelease.js'
import { GATEWAY_STATE_CATALOG } from '@/gateway/matrix/stateUpgradeCatalog'

interface GatewayUpdateSupervisorState {
  version: 1
  status: GatewayUpdateStatus
  staged?: SignedGatewayReleaseManifest
  agentUpdate?: SignedGatewayAgentUpdatePrompt
  agentSeal?: GatewayAgentReleaseSeal
  agentOwnerCommandId?: string
  previousTarget?: string
  scheduledAt?: number
}

interface GatewayAgentReleaseSeal {
  version: 1
  updateHash: string
  files: Array<{
    path: string
    size: number
    sha256: string
    executable?: true
  }>
}

export interface GatewayAgentUpdateInstruction {
  releaseId: string
  buildId: string
  versionName: string
  repository: GatewayAgentUpdatePrompt['repository']
  prompt: string
  workspaceDirectory: string
  sourceDirectory: string
  candidateDirectory: string
  submitCommand: string
}

export interface GatewayAgentUpdateBeginResult {
  status: GatewayUpdateStatus
  started: boolean
}

export interface GatewayUpdateSupervisorConfig {
  installRoot: string
  manifestBaseUrl?: string
  agentPromptBaseUrl?: string
  trustedSigner: PairingPublicKey
  launchAgentPath: string
  serviceLabel: string
  gatewayAdminSocketPath: string
  updateSocketPath?: string
  currentBuildId?: string
  activationDelayMs?: number
  healthTimeoutMs?: number
  probationMs?: number
  syncFreshnessMs?: number
  manifestFetchTimeoutMs?: number
  fileFetchTimeoutMs?: number
}

export interface GatewayUpdateSupervisorDependencies {
  fetch?: typeof fetch
  now?: () => number
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>
  activate?: (options: MacosGatewayReleaseOptions) => Promise<void>
  onCommitted?: () => void | Promise<void>
  onLog?: (message: string) => void
}

export class GatewayUpdateSupervisor {
  private readonly installRoot: string
  private readonly releasesRoot: string
  private readonly agentUpdatesRoot: string
  private readonly stateFile: AtomicJsonFile<GatewayUpdateSupervisorState>
  private timer: ReturnType<typeof setTimeout> | null = null
  private activation: Promise<void> | null = null
  private requestChain: Promise<void> = Promise.resolve()

  constructor(
    private readonly config: GatewayUpdateSupervisorConfig,
    private readonly dependencies: GatewayUpdateSupervisorDependencies = {},
  ) {
    this.installRoot = resolve(config.installRoot)
    this.releasesRoot = join(this.installRoot, 'releases')
    this.agentUpdatesRoot = join(this.installRoot, 'agent-updates')
    this.stateFile = new AtomicJsonFile(join(this.installRoot, 'supervisor-state.json'))
    if (!config.manifestBaseUrl && !config.agentPromptBaseUrl) {
      throw new Error('A Gateway update Prompt or legacy manifest base URL is required')
    }
    if (config.manifestBaseUrl) {
      const manifestBase = new URL(config.manifestBaseUrl)
      if (
        (manifestBase.protocol !== 'https:' && !isLoopbackHttp(manifestBase))
        || manifestBase.username
        || manifestBase.password
        || manifestBase.search
        || manifestBase.hash
      ) {
        throw new Error('Gateway release manifest base must be credential-free HTTPS')
      }
    }
    if (config.agentPromptBaseUrl) {
      const promptBase = new URL(config.agentPromptBaseUrl)
      if (
        (promptBase.protocol !== 'https:' && !isLoopbackHttp(promptBase))
        || promptBase.username
        || promptBase.password
        || promptBase.search
        || promptBase.hash
      ) {
        throw new Error('Gateway Agent update Prompt base must be credential-free HTTPS')
      }
    }
  }

  async initialize(): Promise<void> {
    await mkdir(this.releasesRoot, { recursive: true, mode: 0o700 })
    await mkdir(this.agentUpdatesRoot, { recursive: true, mode: 0o700 })
    const state = await this.readState()
    if (state.status.phase === 'scheduled' && state.scheduledAt !== undefined) {
      this.armActivation(state.scheduledAt)
      return
    }
    if (state.status.phase === 'activating' || state.status.phase === 'probation') {
      await this.recoverInterruptedActivation(state)
    }
  }

  async status(): Promise<GatewayUpdateStatus> {
    const installedBuildId = await this.installedBuildId()
    return this.stateFile.transaction(defaultState, state => {
      validateState(state)
      const changed = installedBuildId !== undefined
        && state.status.currentBuildId !== installedBuildId
        && [
          'idle',
          'staging',
          'agent_required',
          'agent_running',
          'agent_validating',
          'staged',
          'failed',
        ].includes(state.status.phase)
      if (changed) state.status.currentBuildId = installedBuildId
      return { result: structuredClone(state.status), changed }
    })
  }

  async stage(releaseId: string): Promise<GatewayUpdateStatus> {
    return this.serializeRequest(() => this.config.agentPromptBaseUrl
      ? this.prepareAgentUpdateOnce(releaseId)
      : this.stageOnce(releaseId))
  }

  async agentInstruction(releaseId: string): Promise<GatewayAgentUpdateInstruction> {
    requireReleaseId(releaseId)
    const state = await this.readState()
    if (!state.agentUpdate || state.agentUpdate.update.releaseId !== releaseId) {
      throw new Error(`Gateway Agent update ${releaseId} is not prepared`)
    }
    if (!['agent_required', 'agent_running', 'failed'].includes(state.status.phase)) {
      throw new Error(`Gateway Agent update ${releaseId} is ${state.status.phase}`)
    }
    return this.agentInstructionFor(state.agentUpdate)
  }

  async beginAgentUpdate(
    releaseId: string,
    maintenanceSessionId: string,
    ownerCommandId: string,
  ): Promise<GatewayAgentUpdateBeginResult> {
    return this.serializeRequest(async () => {
      requireReleaseId(releaseId)
      if (!maintenanceSessionId || maintenanceSessionId.length > 256) {
        throw new Error('Gateway maintenance session ID is invalid')
      }
      if (!ownerCommandId || ownerCommandId.length > 256) {
        throw new Error('Gateway maintenance owner command ID is invalid')
      }
      let started = false
      const status = await this.writeState(state => {
        if (!state.agentUpdate || state.agentUpdate.update.releaseId !== releaseId) {
          throw new Error(`Gateway Agent update ${releaseId} is not prepared`)
        }
        if (!['agent_required', 'agent_running', 'failed'].includes(state.status.phase)) {
          throw new Error(`Gateway Agent update ${releaseId} is ${state.status.phase}`)
        }
        if (
          state.status.phase === 'agent_running'
          && state.agentOwnerCommandId !== ownerCommandId
        ) return
        started = true
        state.agentOwnerCommandId = ownerCommandId
        state.status = {
          ...state.status,
          phase: 'agent_running',
          maintenanceSessionId,
          detail: 'A local maintenance Agent is preparing the signed update Prompt',
          updatedAt: this.now(),
        }
      })
      return { status, started }
    })
  }

  async submitAgentRelease(releaseId: string): Promise<GatewayUpdateStatus> {
    return this.serializeRequest(() => this.submitAgentReleaseOnce(releaseId))
  }

  async failAgentUpdate(
    releaseId: string,
    ownerCommandId: string,
    detail: string,
  ): Promise<GatewayUpdateStatus> {
    return this.serializeRequest(() => this.writeState(state => {
      requireReleaseId(releaseId)
      if (!ownerCommandId || ownerCommandId.length > 256) {
        throw new Error('Gateway maintenance owner command ID is invalid')
      }
      if (
        state.agentUpdate?.update.releaseId !== releaseId
        || state.status.phase !== 'agent_running'
        || state.agentOwnerCommandId !== ownerCommandId
      ) return
      state.agentOwnerCommandId = undefined
      state.status = {
        ...state.status,
        phase: 'failed',
        detail: statusDetail(detail),
        updatedAt: this.now(),
      }
    }))
  }

  private async prepareAgentUpdateOnce(releaseId: string): Promise<GatewayUpdateStatus> {
    requireReleaseId(releaseId)
    const current = await this.readState()
    if (
      current.status.releaseId === releaseId
      && ['agent_required', 'agent_running', 'staged', 'scheduled', 'activating', 'probation', 'committed']
        .includes(current.status.phase)
    ) {
      return structuredClone(current.status)
    }
    if (
      current.status.phase === 'scheduled'
      || current.status.phase === 'activating'
      || current.status.phase === 'probation'
    ) {
      throw new Error(`Cannot prepare an Agent update while update is ${current.status.phase}`)
    }
    const updateId = randomUUID()
    const currentBuildId = await this.installedBuildId()
    await this.writeState(state => {
      state.staged = undefined
      state.agentUpdate = undefined
      state.agentSeal = undefined
      state.agentOwnerCommandId = undefined
      state.status = {
        version: 1,
        phase: 'staging',
        updateId,
        releaseId,
        ...(currentBuildId ? { currentBuildId } : {}),
        detail: 'Downloading and verifying the signed Gateway update Prompt',
        updatedAt: this.now(),
      }
    })
    try {
      const signed = await this.fetchAndVerifyAgentPrompt(releaseId)
      if (currentBuildId && signed.update.buildId === currentBuildId) {
        return await this.writeState(state => {
          state.status = {
            version: 1,
            phase: 'committed',
            updateId,
            releaseId,
            targetBuildId: signed.update.buildId,
            currentBuildId,
            updatedAt: this.now(),
          }
        })
      }
      await this.prepareAgentWorkspace(signed)
      return await this.writeState(state => {
        state.agentUpdate = signed
        state.status = {
          version: 1,
          phase: 'agent_required',
          updateId,
          releaseId,
          targetBuildId: signed.update.buildId,
          ...(currentBuildId ? { currentBuildId } : {}),
          detail: 'The signed update Prompt is ready for a local maintenance Agent',
          updatedAt: this.now(),
        }
      })
    } catch (error) {
      await this.writeState(state => {
        state.status = {
          version: 1,
          phase: 'failed',
          updateId,
          releaseId,
          detail: statusDetail(error),
          ...(currentBuildId ? { currentBuildId } : {}),
          updatedAt: this.now(),
        }
      })
      throw error
    }
  }

  private async submitAgentReleaseOnce(releaseId: string): Promise<GatewayUpdateStatus> {
    requireReleaseId(releaseId)
    const state = await this.readState()
    if (
      state.status.releaseId === releaseId
      && ['staged', 'scheduled', 'activating', 'probation', 'committed']
        .includes(state.status.phase)
    ) {
      return structuredClone(state.status)
    }
    if (!state.agentUpdate || state.agentUpdate.update.releaseId !== releaseId) {
      throw new Error(`Gateway Agent update ${releaseId} is not prepared`)
    }
    if (!['agent_required', 'agent_running', 'failed'].includes(state.status.phase)) {
      throw new Error(`Cannot submit an Agent update while update is ${state.status.phase}`)
    }
    await this.writeState(current => {
      current.status = {
        ...current.status,
        phase: 'agent_validating',
        detail: 'The supervisor is sealing and validating the Agent-built release',
        updatedAt: this.now(),
      }
    })
    try {
      const seal = await this.stageAgentCandidate(state.agentUpdate)
      return await this.writeState(current => {
        current.agentSeal = seal
        current.status = {
          ...current.status,
          phase: 'staged',
          detail: 'The Agent-built release passed local supervisor validation',
          updatedAt: this.now(),
        }
      })
    } catch (error) {
      await this.writeState(current => {
        current.status = {
          ...current.status,
          phase: 'failed',
          detail: statusDetail(error),
          updatedAt: this.now(),
        }
      })
      throw error
    }
  }

  private async stageOnce(releaseId: string): Promise<GatewayUpdateStatus> {
    requireReleaseId(releaseId)
    const current = await this.readState()
    if (
      current.status.releaseId === releaseId
      && ['staged', 'scheduled', 'activating', 'probation', 'committed']
        .includes(current.status.phase)
    ) {
      return structuredClone(current.status)
    }
    if (
      current.status.phase === 'scheduled'
      || current.status.phase === 'activating'
      || current.status.phase === 'probation'
    ) {
      throw new Error(`Cannot stage a release while update is ${current.status.phase}`)
    }
    const updateId = randomUUID()
    const currentBuildId = await this.installedBuildId()
    await this.writeState(state => {
      state.agentUpdate = undefined
      state.agentSeal = undefined
      state.agentOwnerCommandId = undefined
      state.status = {
        version: 1,
        phase: 'staging',
        updateId,
        releaseId,
        ...(currentBuildId ? { currentBuildId } : {}),
        updatedAt: this.now(),
      }
    })
    try {
      const signed = await this.fetchAndVerifyManifest(releaseId)
      if (currentBuildId && signed.manifest.buildId === currentBuildId) {
        return await this.writeState(state => {
          state.staged = undefined
          state.status = {
            version: 1,
            phase: 'committed',
            updateId,
            releaseId,
            targetBuildId: signed.manifest.buildId,
            currentBuildId,
            updatedAt: this.now(),
          }
        })
      }
      await this.stageManifest(signed)
      return await this.writeState(state => {
        state.staged = signed
        state.agentUpdate = undefined
        state.agentSeal = undefined
        state.agentOwnerCommandId = undefined
        state.status = {
          version: 1,
          phase: 'staged',
          updateId,
          releaseId,
          targetBuildId: signed.manifest.buildId,
          ...(currentBuildId ? { currentBuildId } : {}),
          updatedAt: this.now(),
        }
      })
    } catch (error) {
      await this.writeState(state => {
        state.status = {
          version: 1,
          phase: 'failed',
          updateId,
          releaseId,
          detail: statusDetail(error),
          ...(currentBuildId ? { currentBuildId } : {}),
          updatedAt: this.now(),
        }
      })
      throw error
    }
  }

  async scheduleApply(releaseId: string): Promise<GatewayUpdateStatus> {
    return this.serializeRequest(() => this.scheduleApplyOnce(releaseId))
  }

  private async scheduleApplyOnce(releaseId: string): Promise<GatewayUpdateStatus> {
    requireReleaseId(releaseId)
    const stagedState = await this.readState()
    if (
      stagedState.status.releaseId === releaseId
      && ['scheduled', 'activating', 'probation', 'committed']
        .includes(stagedState.status.phase)
    ) {
      return structuredClone(stagedState.status)
    }
    const legacyRelease = stagedState.staged?.manifest.releaseId === releaseId
      ? stagedState.staged
      : undefined
    const agentRelease = stagedState.agentUpdate?.update.releaseId === releaseId
      && stagedState.agentSeal
      ? { signed: stagedState.agentUpdate, seal: stagedState.agentSeal }
      : undefined
    if (!legacyRelease && !agentRelease) {
      throw new Error(`Gateway release ${releaseId} is not staged`)
    }
    if (stagedState.status.phase !== 'staged') {
      throw new Error(`Cannot schedule a release while update is ${stagedState.status.phase}`)
    }
    const stagedDirectory = join(this.releasesRoot, releaseId)
    if (legacyRelease) {
      const installedManifest = signedGatewayReleaseManifestSchema.parse(JSON.parse(await readFile(
        join(stagedDirectory, 'release-manifest.json'),
        'utf8',
      )))
      if (canonicalJson(installedManifest) !== canonicalJson(legacyRelease)) {
        throw new Error(`Staged Gateway release ${releaseId} manifest changed after verification`)
      }
      await verifyStagedManifest(stagedDirectory, legacyRelease.manifest)
    } else if (agentRelease) {
      const installedPrompt = signedGatewayAgentUpdatePromptSchema.parse(JSON.parse(await readFile(
        join(stagedDirectory, 'release-prompt.json'),
        'utf8',
      )))
      const installedSeal = parseAgentReleaseSeal(JSON.parse(await readFile(
        join(stagedDirectory, 'release-seal.json'),
        'utf8',
      )))
      if (
        canonicalJson(installedPrompt) !== canonicalJson(agentRelease.signed)
        || canonicalJson(installedSeal) !== canonicalJson(agentRelease.seal)
      ) {
        throw new Error(`Staged Gateway Agent release ${releaseId} changed after validation`)
      }
      await verifyAgentSealedRelease(stagedDirectory, agentRelease.signed, agentRelease.seal)
    }
    const targetBuildId = legacyRelease?.manifest.buildId ?? agentRelease!.signed.update.buildId
    const currentLink = join(this.installRoot, 'current')
    const previousTarget = await readlink(currentLink)
    const previousReleaseId = basename(resolve(dirname(currentLink), previousTarget))
    const currentBuildId = await this.installedBuildId()
    const scheduledAt = this.now() + (this.config.activationDelayMs ?? 5_000)
    const status = await this.writeState(state => {
      const hasRelease = state.staged?.manifest.releaseId === releaseId
        || (state.agentUpdate?.update.releaseId === releaseId && state.agentSeal !== undefined)
      if (!hasRelease) {
        throw new Error(`Gateway release ${releaseId} is not staged`)
      }
      if (state.status.phase !== 'staged') {
        throw new Error(`Cannot schedule a release while update is ${state.status.phase}`)
      }
      state.previousTarget = previousTarget
      state.scheduledAt = scheduledAt
      state.status = {
        version: 1,
        phase: 'scheduled',
        updateId: state.status.updateId ?? randomUUID(),
        releaseId,
        targetBuildId,
        ...(currentBuildId ? { currentBuildId } : {}),
        previousReleaseId,
        ...(state.status.maintenanceSessionId
          ? { maintenanceSessionId: state.status.maintenanceSessionId }
          : {}),
        updatedAt: this.now(),
      }
    })
    this.armActivation(scheduledAt)
    return status
  }

  async stop(): Promise<void> {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    await this.requestChain
    await this.activation
  }

  private armActivation(scheduledAt: number): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      const activation = this.activateScheduled()
      const tracked = activation.catch(error => {
        this.log(`[gateway-update] activation failed: ${formatError(error)}`)
      }).finally(() => {
        if (this.activation === tracked) this.activation = null
      })
      this.activation = tracked
    }, Math.max(0, scheduledAt - this.now()))
    this.timer.unref?.()
  }

  private async activateScheduled(): Promise<void> {
    const state = await this.readState()
    if (state.status.phase !== 'scheduled') return
    const target = state.staged?.manifest ?? state.agentUpdate?.update
    if (!target) return
    const previousReleaseId = state.status.previousReleaseId
    await this.writeState(current => {
      current.status = {
        ...current.status,
        phase: 'activating',
        updatedAt: this.now(),
      }
    })
    try {
      const activate = this.dependencies.activate ?? (options =>
        activateMacosGatewayRelease(options, {
          onActivated: async () => {
            await this.writeState(current => {
              current.status = {
                ...current.status,
                phase: 'probation',
                updatedAt: this.now(),
              }
            })
          },
        }))
      await activate({
        releaseDirectory: join(this.releasesRoot, target.releaseId),
        installRoot: this.installRoot,
        launchAgentPath: this.config.launchAgentPath,
        serviceLabel: this.config.serviceLabel,
        adminSocketPath: this.config.gatewayAdminSocketPath,
        healthTimeoutMs: this.config.healthTimeoutMs ?? 60_000,
        expectedBuildId: target.buildId,
        ...(state.status.currentBuildId
          ? { rollbackBuildId: state.status.currentBuildId }
          : {}),
        requireDeepHealth: true,
        syncFreshnessMs: this.config.syncFreshnessMs ?? 45_000,
        probationMs: this.config.probationMs ?? 60_000,
      })
      await this.writeState(current => {
        current.scheduledAt = undefined
        current.previousTarget = undefined
        current.status = {
          version: 1,
          phase: 'committed',
          updateId: state.status.updateId,
          releaseId: target.releaseId,
          targetBuildId: target.buildId,
          currentBuildId: target.buildId,
          ...(previousReleaseId ? { previousReleaseId } : {}),
          ...(state.status.maintenanceSessionId
            ? { maintenanceSessionId: state.status.maintenanceSessionId }
            : {}),
          updatedAt: this.now(),
        }
      })
      await Promise.resolve(this.dependencies.onCommitted?.()).catch(error => {
        this.log(`[gateway-update] post-commit supervisor reload failed: ${formatError(error)}`)
      })
    } catch (error) {
      const rolledBack = /rolled back/iu.test(formatError(error))
      await this.writeState(current => {
        current.scheduledAt = undefined
        current.status = {
          ...current.status,
          phase: rolledBack ? 'rolled_back' : 'repair_required',
          detail: statusDetail(error),
          updatedAt: this.now(),
        }
      })
      throw error
    }
  }

  private async recoverInterruptedActivation(state: GatewayUpdateSupervisorState): Promise<void> {
    if (!state.previousTarget) {
      await this.writeState(current => {
        current.status = {
          ...current.status,
          phase: 'repair_required',
          detail: 'Supervisor restarted during activation without a previous release target',
          updatedAt: this.now(),
        }
      })
      return
    }
    const previousDirectory = resolve(dirname(join(this.installRoot, 'current')), state.previousTarget)
    try {
      await (this.dependencies.activate ?? (options => activateMacosGatewayRelease(options)))({
        releaseDirectory: previousDirectory,
        installRoot: this.installRoot,
        launchAgentPath: this.config.launchAgentPath,
        serviceLabel: this.config.serviceLabel,
        adminSocketPath: this.config.gatewayAdminSocketPath,
        healthTimeoutMs: this.config.healthTimeoutMs ?? 60_000,
        ...(state.status.currentBuildId
          ? { expectedBuildId: state.status.currentBuildId }
          : {}),
        requireDeepHealth: true,
        syncFreshnessMs: this.config.syncFreshnessMs ?? 45_000,
      })
      await this.writeState(current => {
        current.status = {
          ...current.status,
          phase: 'rolled_back',
          detail: 'Supervisor restarted during activation and restored the previous release',
          updatedAt: this.now(),
        }
      })
    } catch (error) {
      await this.writeState(current => {
        current.status = {
          ...current.status,
          phase: 'repair_required',
          detail: statusDetail(`Interrupted activation recovery failed: ${formatError(error)}`),
          updatedAt: this.now(),
        }
      })
    }
  }

  private async fetchAndVerifyAgentPrompt(
    releaseId: string,
  ): Promise<SignedGatewayAgentUpdatePrompt> {
    const configuredBase = this.config.agentPromptBaseUrl
    if (!configuredBase) throw new Error('Gateway Agent update Prompt delivery is not configured')
    const base = new URL(configuredBase.endsWith('/') ? configuredBase : `${configuredBase}/`)
    const url = new URL(`${encodeURIComponent(releaseId)}.json`, base)
    if (url.origin !== base.origin) throw new Error('Gateway Agent update Prompt escaped its origin')
    const text = await withFetchTimeout(
      this.config.manifestFetchTimeoutMs ?? 30_000,
      'Gateway Agent update Prompt download',
      signal => this.retryTransientFetch('Agent update Prompt download', signal, async () => {
        const response = await (this.dependencies.fetch ?? fetch)(url, {
          signal,
          headers: { 'accept-encoding': 'identity' },
        })
        if (response.url && new URL(response.url).origin !== base.origin) {
          throw new Error('Gateway Agent update Prompt redirected to an untrusted origin')
        }
        if (!response.ok) {
          throw fetchStatusError('Gateway Agent update Prompt', response.status)
        }
        return readBoundedText(response, 128 * 1024, 'Gateway Agent update Prompt')
      }),
    )
    let input: unknown
    try {
      input = JSON.parse(text)
    } catch (error) {
      throw new Error('Gateway Agent update Prompt is invalid JSON', { cause: error })
    }
    const signed = signedGatewayAgentUpdatePromptSchema.parse(input)
    if (signed.update.releaseId !== releaseId) {
      throw new Error('Gateway Agent update Prompt ID does not match the request')
    }
    await this.verifyAgentPrompt(signed)
    return signed
  }

  private async verifyAgentPrompt(signed: SignedGatewayAgentUpdatePrompt): Promise<void> {
    const trustedKeyId = await publicKeyId(this.config.trustedSigner.publicKey)
    if (
      signed.signer.keyId !== trustedKeyId
      || signed.signature.keyId !== trustedKeyId
      || canonicalJson(signed.signer) !== canonicalJson(this.config.trustedSigner)
    ) {
      throw new Error('Gateway Agent update Prompt signer is not trusted')
    }
    const key = await webCrypto().subtle.importKey(
      'jwk',
      signed.signer.publicKey,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    )
    const verified = await webCrypto().subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      toArrayBuffer(base64UrlDecode(signed.signature.value)),
      toArrayBuffer(canonicalJsonBytes(signed.update)),
    )
    if (!verified) throw new Error('Gateway Agent update Prompt signature is invalid')
    assertRollbackCompatibleState(signed.update)
  }

  private async prepareAgentWorkspace(signed: SignedGatewayAgentUpdatePrompt): Promise<void> {
    const workspace = this.agentWorkspace(signed.update.releaseId)
    try {
      const existing = signedGatewayAgentUpdatePromptSchema.parse(JSON.parse(await readFile(
        join(workspace, 'update-prompt.json'),
        'utf8',
      )))
      if (canonicalJson(existing) !== canonicalJson(signed)) {
        throw new Error(`Gateway Agent update ${signed.update.releaseId} is immutable`)
      }
      await lstat(join(workspace, 'candidate'))
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const temporary = await mkdtemp(join(this.agentUpdatesRoot, `.prepare-${signed.update.releaseId}-`))
    try {
      const candidate = join(temporary, 'candidate')
      const source = join(temporary, 'source')
      await mkdir(candidate, { recursive: true, mode: 0o700 })
      await mkdir(source, { recursive: true, mode: 0o700 })
      const reusableRelease = await this.reusableReleaseDirectory()
      if (reusableRelease) {
        await copyAgentReleaseTree(reusableRelease, candidate, { ignoreReleaseMetadata: true })
      }
      await writeDurableFile(
        join(temporary, 'update-prompt.json'),
        `${JSON.stringify(signed)}\n`,
      )
      await rename(temporary, workspace)
      await syncDirectory(this.agentUpdatesRoot)
    } catch (error) {
      await rm(temporary, { recursive: true, force: true })
      throw error
    }
  }

  private agentInstructionFor(
    signed: SignedGatewayAgentUpdatePrompt,
  ): GatewayAgentUpdateInstruction {
    const workspaceDirectory = this.agentWorkspace(signed.update.releaseId)
    const runtime = join(this.installRoot, 'current', 'runtime', 'node')
    const cli = join(this.installRoot, 'current', 'ops', 'gatewayAgentUpdateCli.js')
    const socket = this.config.updateSocketPath
      ? resolve(this.config.updateSocketPath)
      : join(this.installRoot, 'update-supervisor.sock')
    return {
      releaseId: signed.update.releaseId,
      buildId: signed.update.buildId,
      versionName: signed.update.versionName,
      repository: structuredClone(signed.update.repository),
      prompt: signed.update.prompt,
      workspaceDirectory,
      sourceDirectory: join(workspaceDirectory, 'source'),
      candidateDirectory: join(workspaceDirectory, 'candidate'),
      submitCommand: [
        shellQuote(runtime),
        shellQuote(cli),
        'submit',
        '--socket',
        shellQuote(socket),
        '--release-id',
        shellQuote(signed.update.releaseId),
      ].join(' '),
    }
  }

  private agentWorkspace(releaseId: string): string {
    return join(this.agentUpdatesRoot, releaseId)
  }

  private async stageAgentCandidate(
    signed: SignedGatewayAgentUpdatePrompt,
  ): Promise<GatewayAgentReleaseSeal> {
    const releaseId = signed.update.releaseId
    const destination = join(this.releasesRoot, releaseId)
    try {
      const installedPrompt = signedGatewayAgentUpdatePromptSchema.parse(JSON.parse(await readFile(
        join(destination, 'release-prompt.json'),
        'utf8',
      )))
      const installedSeal = parseAgentReleaseSeal(JSON.parse(await readFile(
        join(destination, 'release-seal.json'),
        'utf8',
      )))
      if (canonicalJson(installedPrompt) !== canonicalJson(signed)) {
        throw new Error(`Installed Gateway Agent release ${releaseId} is immutable`)
      }
      await verifyAgentSealedRelease(destination, signed, installedSeal)
      return installedSeal
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const candidate = join(this.agentWorkspace(releaseId), 'candidate')
    const temporary = await mkdtemp(join(this.releasesRoot, `.stage-agent-${releaseId}-`))
    try {
      await copyAgentReleaseTree(candidate, temporary)
      await validateAgentReleaseEntrypoints(temporary)
      const seal = await createAgentReleaseSeal(temporary, signed)
      await writeDurableFile(
        join(temporary, 'release-prompt.json'),
        `${JSON.stringify(signed)}\n`,
      )
      await writeDurableFile(
        join(temporary, 'release-seal.json'),
        `${JSON.stringify(seal)}\n`,
      )
      await verifyAgentSealedRelease(temporary, signed, seal)
      await rename(temporary, destination)
      await syncDirectory(this.releasesRoot)
      return seal
    } catch (error) {
      await rm(temporary, { recursive: true, force: true })
      throw error
    }
  }

  private async fetchAndVerifyManifest(releaseId: string): Promise<SignedGatewayReleaseManifest> {
    const configuredBase = this.config.manifestBaseUrl
    if (!configuredBase) throw new Error('Legacy Gateway artifact delivery is not configured')
    const base = new URL(configuredBase.endsWith('/')
      ? configuredBase
      : `${configuredBase}/`)
    const url = new URL(`${encodeURIComponent(releaseId)}.json`, base)
    if (url.origin !== base.origin) throw new Error('Gateway release manifest escaped its origin')
    const text = await withFetchTimeout(
      this.config.manifestFetchTimeoutMs ?? 30_000,
      'Gateway release manifest download',
      signal => this.retryTransientFetch('manifest download', signal, async () => {
        const response = await (this.dependencies.fetch ?? fetch)(url, {
          signal,
          headers: { 'accept-encoding': 'identity' },
        })
        if (response.url && new URL(response.url).origin !== base.origin) {
          throw new Error('Gateway release manifest redirected to an untrusted origin')
        }
        if (!response.ok) {
          throw fetchStatusError('Gateway release manifest', response.status)
        }
        return readBoundedText(response, 1024 * 1024, 'Gateway release manifest')
      }),
    )
    let input: unknown
    try {
      input = JSON.parse(text)
    } catch (error) {
      throw new Error('Gateway release manifest is invalid JSON', { cause: error })
    }
    const signed = signedGatewayReleaseManifestSchema.parse(input)
    if (signed.manifest.releaseId !== releaseId) {
      throw new Error('Gateway release manifest ID does not match the request')
    }
    await this.verifyManifest(signed)
    return signed
  }

  private async verifyManifest(signed: SignedGatewayReleaseManifest): Promise<void> {
    const trustedKeyId = await publicKeyId(this.config.trustedSigner.publicKey)
    if (
      signed.signer.keyId !== trustedKeyId
      || signed.signature.keyId !== trustedKeyId
      || canonicalJson(signed.signer) !== canonicalJson(this.config.trustedSigner)
    ) {
      throw new Error('Gateway release manifest signer is not trusted')
    }
    const key = await webCrypto().subtle.importKey(
      'jwk',
      signed.signer.publicKey,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    )
    const verified = await webCrypto().subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      toArrayBuffer(base64UrlDecode(signed.signature.value)),
      toArrayBuffer(canonicalJsonBytes(signed.manifest)),
    )
    if (!verified) throw new Error('Gateway release manifest signature is invalid')
    if (signed.manifest.platform !== 'darwin' || signed.manifest.architecture !== process.arch) {
      throw new Error(
        `Gateway release targets ${signed.manifest.platform}/${signed.manifest.architecture}, `
        + `not ${process.platform}/${process.arch}`,
      )
    }
    const configuredBase = this.config.manifestBaseUrl
    if (!configuredBase) throw new Error('Legacy Gateway artifact delivery is not configured')
    const manifestOrigin = new URL(configuredBase).origin
    for (const file of signed.manifest.files) {
      if (new URL(file.url).origin !== manifestOrigin) {
        throw new Error(`Gateway release file ${file.path} uses an untrusted origin`)
      }
    }
    assertRollbackCompatibleState(signed.manifest)
  }

  private async stageManifest(signed: SignedGatewayReleaseManifest): Promise<void> {
    const manifest = signed.manifest
    const destination = join(this.releasesRoot, manifest.releaseId)
    try {
      const current = signedGatewayReleaseManifestSchema.parse(JSON.parse(
        await readFile(join(destination, 'release-manifest.json'), 'utf8'),
      ))
      if (canonicalJson(current) !== canonicalJson(signed)) {
        throw new Error(`Installed Gateway release ${manifest.releaseId} is immutable`)
      }
      await verifyStagedManifest(destination, manifest)
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }

    const temporary = await mkdtemp(join(this.releasesRoot, `.stage-${manifest.releaseId}-`))
    try {
      const reusableRelease = await this.reusableReleaseDirectory()
      let reusedFiles = 0
      let reusedBytes = 0
      let downloadedFiles = 0
      let downloadedBytes = 0
      for (const file of manifest.files) {
        const reused = reusableRelease
          ? await this.reuseFile(file, reusableRelease, temporary)
          : false
        if (reused) {
          reusedFiles += 1
          reusedBytes += file.size
          continue
        }
        await this.downloadFile(file, temporary)
        downloadedFiles += 1
        downloadedBytes += file.size
      }
      await writeDurableFile(
        join(temporary, 'release-manifest.json'),
        `${JSON.stringify(signed)}\n`,
      )
      await verifyStagedManifest(temporary, manifest)
      await rename(temporary, destination)
      await syncDirectory(this.releasesRoot)
      this.log(
        `[gateway-update] staged ${manifest.releaseId}: `
        + `reused ${reusedFiles} files (${reusedBytes} bytes), `
        + `downloaded ${downloadedFiles} files (${downloadedBytes} bytes)`,
      )
    } catch (error) {
      await rm(temporary, { recursive: true, force: true })
      throw error
    }
  }

  private async reusableReleaseDirectory(): Promise<string | undefined> {
    try {
      const releasesRoot = await realpath(this.releasesRoot)
      const current = await realpath(join(this.installRoot, 'current'))
      const relativePath = relative(releasesRoot, current)
      if (
        relativePath === ''
        || relativePath === '..'
        || relativePath.startsWith(`..${sep}`)
      ) {
        this.log('[gateway-update] active release is outside the managed releases directory')
        return undefined
      }
      const metadata = await lstat(current)
      if (!metadata.isDirectory()) return undefined
      return current
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }

  private async reuseFile(
    file: GatewayReleaseManifest['files'][number],
    sourceRoot: string,
    destinationRoot: string,
  ): Promise<boolean> {
    const source = join(sourceRoot, file.path)
    const destination = join(destinationRoot, file.path)
    try {
      const [resolvedSource, metadata] = await Promise.all([
        realpath(source),
        lstat(source),
      ])
      if (
        resolvedSource !== source
        || !metadata.isFile()
        || metadata.size !== file.size
      ) {
        return false
      }
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
      await copyFile(
        source,
        destination,
        constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE,
      )
      if (await hashFile(destination) !== file.sha256) {
        await rm(destination, { force: true })
        return false
      }
      await chmod(destination, file.executable ? 0o755 : 0o600)
      return true
    } catch (error) {
      await rm(destination, { force: true })
      if (['ENOENT', 'ELOOP', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) {
        return false
      }
      throw error
    }
  }

  private async downloadFile(
    file: GatewayReleaseManifest['files'][number],
    root: string,
  ): Promise<void> {
    const destination = join(root, file.path)
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
    await withFetchTimeout(
      this.config.fileFetchTimeoutMs ?? 10 * 60_000,
      `Gateway release file ${file.path} download`,
      signal => this.retryTransientFetch(`file ${file.path} download`, signal, async () => {
        await rm(destination, { force: true })
        try {
          const response = await (this.dependencies.fetch ?? fetch)(file.url, {
            signal,
            headers: { 'accept-encoding': 'identity' },
          })
          if (response.url && new URL(response.url).origin !== new URL(file.url).origin) {
            throw new Error(`Gateway release file ${file.path} redirected to an untrusted origin`)
          }
          if (!response.ok) {
            throw fetchStatusError(`Gateway release file ${file.path}`, response.status)
          }
          if (!response.body) {
            throw new RetryableGatewayUpdateFetchError(
              `Gateway release file ${file.path} has no response body`,
            )
          }
          const advertisedLength = response.headers.get('content-length')
          const contentEncoding = response.headers.get('content-encoding')?.trim().toLowerCase()
          if (
            advertisedLength !== null
            && (!contentEncoding || contentEncoding === 'identity')
            && Number(advertisedLength) !== file.size
          ) {
            throw new RetryableGatewayUpdateFetchError(
              `Gateway release file ${file.path} has an unexpected length`,
            )
          }
          const handle = await open(destination, 'wx', 0o600)
          const reader = response.body.getReader()
          const hash = createHash('sha256')
          let bytes = 0
          try {
            while (true) {
              const { done, value } = await reader.read()
              if (done) break
              bytes += value.byteLength
              if (bytes > file.size) {
                throw new RetryableGatewayUpdateFetchError(
                  `Gateway release file ${file.path} is oversized`,
                )
              }
              hash.update(value)
              await writeAll(handle, value)
            }
            await handle.sync()
          } catch (error) {
            await reader.cancel().catch(() => undefined)
            throw error
          } finally {
            await handle.close()
            reader.releaseLock()
          }
          if (bytes !== file.size || hash.digest('hex') !== file.sha256) {
            throw new RetryableGatewayUpdateFetchError(
              `Gateway release file ${file.path} failed integrity verification`,
            )
          }
        } catch (error) {
          await rm(destination, { force: true })
          throw error
        }
      }),
    )
    await chmod(destination, file.executable ? 0o755 : 0o600)
  }

  private async retryTransientFetch<T>(
    label: string,
    signal: AbortSignal,
    operation: () => Promise<T>,
  ): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await operation()
      } catch (error) {
        if (
          signal.aborted
          || attempt >= 4
          || !isTransientGatewayUpdateFetchError(error)
        ) {
          throw error
        }
        const retryAfterMs = transientRetryDelay(attempt)
        this.log(
          `[gateway-update] ${label} failed transiently; `
          + `retrying in ${retryAfterMs}ms: ${formatError(error)}`,
        )
        await (this.dependencies.sleep ?? wait)(retryAfterMs, signal)
      }
    }
  }

  private readState(): Promise<GatewayUpdateSupervisorState> {
    return this.stateFile.transaction(defaultState, state => {
      validateState(state)
      return { result: structuredClone(state), changed: false }
    })
  }

  private writeState(
    mutate: (state: GatewayUpdateSupervisorState) => void,
  ): Promise<GatewayUpdateStatus> {
    return this.stateFile.transaction(defaultState, state => {
      validateState(state)
      mutate(state)
      validateState(state)
      return { result: structuredClone(state.status), changed: true }
    })
  }

  private now(): number {
    return this.dependencies.now?.() ?? Date.now()
  }

  private serializeRequest<T>(operation: () => Promise<T>): Promise<T> {
    const running = this.requestChain.then(operation, operation)
    this.requestChain = running.then(() => undefined, () => undefined)
    return running
  }

  private async installedBuildId(): Promise<string | undefined> {
    try {
      const signedPrompt = signedGatewayAgentUpdatePromptSchema.parse(JSON.parse(await readFile(
        join(this.installRoot, 'current', 'release-prompt.json'),
        'utf8',
      )))
      await this.verifyAgentPrompt(signedPrompt)
      return signedPrompt.update.buildId
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error('The active Gateway Agent update Prompt is invalid', { cause: error })
      }
    }
    try {
      const signed = signedGatewayReleaseManifestSchema.parse(JSON.parse(await readFile(
        join(this.installRoot, 'current', 'release-manifest.json'),
        'utf8',
      )))
      return signed.manifest.buildId
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return this.config.currentBuildId
      throw new Error('The active Gateway release manifest is invalid', { cause: error })
    }
  }

  private log(message: string): void {
    this.dependencies.onLog?.(message)
  }
}

const AGENT_RELEASE_METADATA = new Set([
  'release-manifest.json',
  'release-prompt.json',
  'release-seal.json',
])
const MAX_AGENT_RELEASE_FILES = 10_000
const MAX_AGENT_RELEASE_BYTES = 1024 * 1024 * 1024

async function copyAgentReleaseTree(
  sourceRoot: string,
  destinationRoot: string,
  options: { ignoreReleaseMetadata?: boolean } = {},
): Promise<void> {
  let files = 0
  let bytes = 0
  const visit = async (sourceDirectory: string, destinationDirectory: string): Promise<void> => {
    await mkdir(destinationDirectory, { recursive: true, mode: 0o700 })
    const entries = await readdir(sourceDirectory, { withFileTypes: true })
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const source = join(sourceDirectory, entry.name)
      const path = relative(sourceRoot, source).split(sep).join('/')
      const destination = join(destinationRoot, ...path.split('/'))
      if (AGENT_RELEASE_METADATA.has(path)) {
        if (options.ignoreReleaseMetadata) continue
        throw new Error(`Agent-built Gateway release contains reserved metadata: ${path}`)
      }
      if (entry.isSymbolicLink()) {
        throw new Error(`Agent-built Gateway release contains a symbolic link: ${path}`)
      }
      if (entry.isDirectory()) {
        await visit(source, destination)
        continue
      }
      if (!entry.isFile()) {
        throw new Error(`Agent-built Gateway release contains a non-regular file: ${path}`)
      }
      const metadata = await lstat(source)
      if (metadata.size < 1) throw new Error(`Agent-built Gateway release file is empty: ${path}`)
      files += 1
      bytes += metadata.size
      if (files > MAX_AGENT_RELEASE_FILES || bytes > MAX_AGENT_RELEASE_BYTES) {
        throw new Error('Agent-built Gateway release exceeds its file-count or size limit')
      }
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
      await copyFile(
        source,
        destination,
        constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE,
      )
      await chmod(destination, (metadata.mode & 0o111) !== 0 ? 0o755 : 0o600)
    }
  }
  await visit(sourceRoot, destinationRoot)
}

async function validateAgentReleaseEntrypoints(releaseDirectory: string): Promise<void> {
  await validateMacosGatewayRelease(releaseDirectory)
  for (const relativePath of [
    'ops/gatewayUpdateSupervisorMain.js',
    'ops/gatewayAgentUpdateCli.js',
  ]) {
    const path = join(releaseDirectory, ...relativePath.split('/'))
    const metadata = await lstat(path)
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new Error(`Agent-built Gateway release path is not a regular file: ${relativePath}`)
    }
  }
}

async function createAgentReleaseSeal(
  releaseDirectory: string,
  signed: SignedGatewayAgentUpdatePrompt,
): Promise<GatewayAgentReleaseSeal> {
  const files: GatewayAgentReleaseSeal['files'] = []
  let totalBytes = 0
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = join(directory, entry.name)
      const path = relative(releaseDirectory, absolute).split(sep).join('/')
      if (AGENT_RELEASE_METADATA.has(path)) continue
      if (entry.isSymbolicLink()) {
        throw new Error(`Agent-built Gateway release contains a symbolic link: ${path}`)
      }
      if (entry.isDirectory()) {
        await visit(absolute)
        continue
      }
      if (!entry.isFile()) {
        throw new Error(`Agent-built Gateway release contains a non-regular file: ${path}`)
      }
      const metadata = await lstat(absolute)
      if (metadata.size < 1) throw new Error(`Agent-built Gateway release file is empty: ${path}`)
      totalBytes += metadata.size
      if (files.length >= MAX_AGENT_RELEASE_FILES || totalBytes > MAX_AGENT_RELEASE_BYTES) {
        throw new Error('Agent-built Gateway release exceeds its file-count or size limit')
      }
      files.push({
        path,
        size: metadata.size,
        sha256: await hashFile(absolute),
        ...((metadata.mode & 0o111) !== 0 ? { executable: true as const } : {}),
      })
    }
  }
  await visit(releaseDirectory)
  return {
    version: 1,
    updateHash: createHash('sha256').update(canonicalJsonBytes(signed.update)).digest('hex'),
    files,
  }
}

async function verifyAgentSealedRelease(
  releaseDirectory: string,
  signed: SignedGatewayAgentUpdatePrompt,
  expectedSeal: GatewayAgentReleaseSeal,
): Promise<void> {
  await validateAgentReleaseEntrypoints(releaseDirectory)
  const installedPrompt = signedGatewayAgentUpdatePromptSchema.parse(JSON.parse(await readFile(
    join(releaseDirectory, 'release-prompt.json'),
    'utf8',
  )))
  if (canonicalJson(installedPrompt) !== canonicalJson(signed)) {
    throw new Error('Agent-built Gateway release Prompt changed after validation')
  }
  const observedSeal = await createAgentReleaseSeal(releaseDirectory, signed)
  if (canonicalJson(observedSeal) !== canonicalJson(expectedSeal)) {
    throw new Error('Agent-built Gateway release changed after supervisor sealing')
  }
}

function parseAgentReleaseSeal(input: unknown): GatewayAgentReleaseSeal {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Gateway Agent release seal is invalid')
  }
  const candidate = input as Partial<GatewayAgentReleaseSeal>
  if (
    candidate.version !== 1
    || typeof candidate.updateHash !== 'string'
    || !/^[0-9a-f]{64}$/u.test(candidate.updateHash)
    || !Array.isArray(candidate.files)
    || candidate.files.length < 1
    || candidate.files.length > MAX_AGENT_RELEASE_FILES
  ) {
    throw new Error('Gateway Agent release seal is invalid')
  }
  const paths = new Set<string>()
  let totalBytes = 0
  for (const file of candidate.files) {
    if (
      !file
      || typeof file.path !== 'string'
      || !isSafeRelativeReleasePath(file.path)
      || typeof file.size !== 'number'
      || !Number.isSafeInteger(file.size)
      || file.size < 1
      || typeof file.sha256 !== 'string'
      || !/^[0-9a-f]{64}$/u.test(file.sha256)
      || (file.executable !== undefined && file.executable !== true)
      || paths.has(file.path)
    ) {
      throw new Error('Gateway Agent release seal is invalid')
    }
    paths.add(file.path)
    totalBytes += file.size
  }
  if (totalBytes > MAX_AGENT_RELEASE_BYTES) {
    throw new Error('Gateway Agent release seal exceeds its size limit')
  }
  return structuredClone(candidate as GatewayAgentReleaseSeal)
}

function isSafeRelativeReleasePath(value: string): boolean {
  if (value.startsWith('/') || value.endsWith('/') || value.includes('\\')) return false
  const parts = value.split('/')
  return parts.every(part => part.length > 0 && part !== '.' && part !== '..')
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

async function verifyStagedManifest(
  releaseDirectory: string,
  manifest: GatewayReleaseManifest,
): Promise<void> {
  await validateMacosGatewayRelease(releaseDirectory)
  const expected = new Map(manifest.files.map(file => [file.path, file]))
  const observed = new Set<string>()
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name)
      const path = relative(releaseDirectory, absolute).split(sep).join('/')
      if (entry.isSymbolicLink()) {
        throw new Error(`Staged Gateway release contains a symbolic link: ${path}`)
      }
      if (entry.isDirectory()) {
        const ownsExpectedFile = [...expected.keys()].some(candidate =>
          candidate.startsWith(`${path}/`))
        if (!ownsExpectedFile) {
          throw new Error(`Staged Gateway release contains an unexpected directory: ${path}`)
        }
        await visit(absolute)
        continue
      }
      if (!entry.isFile()) {
        throw new Error(`Staged Gateway release contains a non-regular file: ${path}`)
      }
      if (path === 'release-manifest.json') continue
      const file = expected.get(path)
      if (!file) throw new Error(`Staged Gateway release contains an unexpected file: ${path}`)
      const metadata = await lstat(absolute)
      if (metadata.size !== file.size) {
        throw new Error(`Staged Gateway release file ${path} has an unexpected size`)
      }
      if (file.executable === true && (metadata.mode & 0o111) === 0) {
        throw new Error(`Staged Gateway release file ${path} is not executable`)
      }
      if (await hashFile(absolute) !== file.sha256) {
        throw new Error(`Staged Gateway release file ${path} failed integrity verification`)
      }
      observed.add(path)
    }
  }
  await visit(releaseDirectory)
  for (const path of expected.keys()) {
    if (!observed.has(path)) throw new Error(`Staged Gateway release is missing file ${path}`)
  }
}

function hashFile(path: string): Promise<string> {
  return new Promise((resolveHash, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.once('error', reject)
    stream.on('data', chunk => hash.update(chunk))
    stream.once('end', () => resolveHash(hash.digest('hex')))
  })
}

async function withFetchTimeout<T>(
  timeoutMs: number,
  label: string,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError(`${label} timeout must be positive`)
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  timer.unref?.()
  try {
    return await operation(controller.signal)
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`${label} timed out after ${timeoutMs}ms`)
    throw error
  } finally {
    clearTimeout(timer)
  }
}

class RetryableGatewayUpdateFetchError extends Error {}

function fetchStatusError(label: string, status: number): Error {
  const message = `${label} returned HTTP ${status}`
  return status === 408 || status === 425 || status === 429 || status >= 500
    ? new RetryableGatewayUpdateFetchError(message)
    : new Error(message)
}

function isTransientGatewayUpdateFetchError(error: unknown): boolean {
  return error instanceof RetryableGatewayUpdateFetchError
    || error instanceof TypeError
    || (error instanceof DOMException
      && (error.name === 'AbortError'
        || error.name === 'NetworkError'
        || error.name === 'TimeoutError'))
}

function transientRetryDelay(attempt: number): number {
  return Math.min(4_000, 250 * (2 ** attempt))
}

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolveWait, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new DOMException('The operation was aborted', 'AbortError'))
      return
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolveWait()
    }, milliseconds)
    timer.unref?.()
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(signal.reason ?? new DOMException('The operation was aborted', 'AbortError'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function defaultState(): GatewayUpdateSupervisorState {
  return {
    version: 1,
    status: { version: 1, phase: 'idle', updatedAt: 0 },
  }
}

function validateState(state: GatewayUpdateSupervisorState): void {
  if (state.version !== 1) throw new Error('Unsupported Gateway update supervisor state')
  gatewayUpdateStatusSchema.parse(state.status)
  if (state.staged) signedGatewayReleaseManifestSchema.parse(state.staged)
  if (state.agentUpdate) signedGatewayAgentUpdatePromptSchema.parse(state.agentUpdate)
  if (state.agentSeal) parseAgentReleaseSeal(state.agentSeal)
  if (state.staged && (state.agentUpdate || state.agentSeal)) {
    throw new Error('Gateway update supervisor state mixes artifact and Agent releases')
  }
  if (state.agentSeal && !state.agentUpdate) {
    throw new Error('Gateway update supervisor Agent seal has no signed Prompt')
  }
  if (
    state.agentOwnerCommandId !== undefined
    && (!state.agentOwnerCommandId || state.agentOwnerCommandId.length > 256)
  ) {
    throw new Error('Gateway update supervisor Agent owner command ID is invalid')
  }
  if (state.previousTarget !== undefined && !state.previousTarget) {
    throw new Error('Gateway update supervisor previous target is invalid')
  }
  if (state.scheduledAt !== undefined && !Number.isSafeInteger(state.scheduledAt)) {
    throw new Error('Gateway update supervisor schedule is invalid')
  }
}

function assertRollbackCompatibleState(
  manifest: Pick<GatewayReleaseManifest, 'stateCatalog'>,
): void {
  const currentCatalog = new Map(GATEWAY_STATE_CATALOG.map(entry => [entry.id, entry]))
  const target = new Map(manifest.stateCatalog.map(entry => [entry.id, entry]))
  for (const current of GATEWAY_STATE_CATALOG) {
    const next = target.get(current.id)
    if (!next) throw new Error(`Gateway release omits persistent state ${current.id}`)
    if (next.stateClass !== current.stateClass) {
      throw new Error(`Gateway release changes the safety class of ${current.id}`)
    }
    if (
      (current.stateClass === 'security-critical' || current.stateClass === 'durable-command')
      && next.schemaVersion !== current.schemaVersion
    ) {
      throw new Error(
        `Gateway release changes protected state ${current.id} from schema `
        + `${current.schemaVersion} to ${next.schemaVersion}; automatic rollback is unsafe`,
      )
    }
  }
  for (const next of manifest.stateCatalog) {
    if (currentCatalog.has(next.id)) continue
    if (next.stateClass === 'security-critical' || next.stateClass === 'durable-command') {
      throw new Error(
        `Gateway release introduces protected state ${next.id}; automatic rollback is unsafe`,
      )
    }
  }
}

function requireReleaseId(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value)) {
    throw new Error('Gateway release ID is invalid')
  }
}

function isLoopbackHttp(url: URL): boolean {
  return url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost')
}

async function readBoundedText(
  response: Response,
  maximumBytes: number,
  label: string,
): Promise<string> {
  const advertisedLength = response.headers.get('content-length')
  if (advertisedLength !== null && Number(advertisedLength) > maximumBytes) {
    throw new Error(`${label} exceeds ${maximumBytes} bytes`)
  }
  if (!response.body) throw new Error(`${label} has no response body`)
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > maximumBytes) throw new Error(`${label} exceeds ${maximumBytes} bytes`)
      chunks.push(value)
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined)
    throw error
  } finally {
    reader.releaseLock()
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
}

async function writeAll(
  handle: import('node:fs/promises').FileHandle,
  value: Uint8Array,
): Promise<void> {
  let offset = 0
  while (offset < value.byteLength) {
    const { bytesWritten } = await handle.write(value, offset, value.byteLength - offset)
    if (bytesWritten < 1) throw new Error('Gateway release file write made no progress')
    offset += bytesWritten
  }
}

async function writeDurableFile(path: string, content: string): Promise<void> {
  const handle = await open(path, 'wx', 0o600)
  try {
    await writeAll(handle, new TextEncoder().encode(content))
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function statusDetail(error: unknown): string {
  return formatError(error).slice(0, 4_096) || 'Gateway update failed'
}
