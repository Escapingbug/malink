import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import {
  access,
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  symlink,
} from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type { GatewayDeploymentSlot } from '@malink/protocol'
import { AtomicJsonFile } from '@malink/security/node'
import { GatewayAdminClient, type GatewayAdminStatus } from '@/gateway/admin'
import {
  FileGatewayIdentityStore,
  FileGatewayNodeProfileStore,
  FileWorkspaceGatewayDirectory,
} from '@/gateway/pairing'
import { loginMatrixGatewayWithToken } from '@/gateway/matrix/login'
import { validateMacosGatewayRelease } from './macosGatewayRelease.js'
import {
  buildGatewayDeploymentHandoff,
} from './gatewayDeploymentHandoff.js'
import type { GatewayDeploymentTransition } from './gatewayDeploymentCoordinator.js'

const FOUNDATION_FILES = [
  'workspace-gateways.json',
  'workspace-device-authorization.json',
  'trusted-devices.json',
  'privilege-client.json',
] as const

type HostPhase =
  | 'preparing'
  | 'trial'
  | 'sealed'
  | 'validating'
  | 'transferred'
  | 'committing'
  | 'ownership_committed'
  | 'complete'

interface GatewayBlueGreenHostState {
  version: 1
  phase: HostPhase
  updateId: string
  sourceGatewayNodeId: string
  candidateGatewayNodeId: string
  workspaceId: string
  releaseId: string
  buildId: string
  releaseDirectory: string
  candidateDirectory: string
  candidateAdminSocket: string
  candidateLaunchAgent: string
  candidateServiceLabel: string
  trialRoomId?: string
  sourceProjectCount: number
  sourceSessionCount: number
  candidateProjectCount: number
  candidateSessionCount: number
  promotedProjectCount?: number
  promotedSessionCount?: number
  handoffDirectory?: string
  sourceArchiveDirectory?: string
  updatedAt: number
}

interface GatewayBlueGreenHostFile {
  version: 1
  deployment?: GatewayBlueGreenHostState
}

export interface MacosGatewayBlueGreenHostConfig {
  installRoot: string
  activeDataDirectory: string
  activeAdminSocketPath: string
  activeLaunchAgentPath: string
  activeServiceLabel: string
  updateSocketPath: string
  healthTimeoutMs?: number
  syncFreshnessMs?: number
  platform?: NodeJS.Platform
  uid?: number
}

export interface MacosGatewayBlueGreenHostDependencies {
  fetch?: typeof fetch
  now?: () => number
  sleep?: (milliseconds: number) => Promise<void>
  launchctl?: (arguments_: readonly string[]) => Promise<void>
  isServiceLoaded?: (service: string) => Promise<boolean>
  readStatus?: (socketPath: string) => Promise<GatewayAdminStatus>
  buildHandoff?: typeof buildGatewayDeploymentHandoff
  onCommitted?: () => void
  onLog?: (message: string) => void
}

/**
 * Owns the two real launchd Gateway processes used by one blue/green update.
 * Coordinator state decides the semantic phase; this file records only the
 * concrete resources needed to recover a process or filesystem interruption.
 */
export class MacosGatewayBlueGreenHost {
  private readonly installRoot: string
  private readonly activeDataDirectory: string
  private readonly stateFile: AtomicJsonFile<GatewayBlueGreenHostFile>

  constructor(
    private readonly config: MacosGatewayBlueGreenHostConfig,
    private readonly dependencies: MacosGatewayBlueGreenHostDependencies = {},
  ) {
    if ((config.platform ?? process.platform) !== 'darwin') {
      throw new Error('Blue/green Gateway process hosting currently requires macOS launchd')
    }
    this.installRoot = resolve(config.installRoot)
    this.activeDataDirectory = resolve(config.activeDataDirectory)
    this.stateFile = new AtomicJsonFile(join(this.installRoot, 'deployment-host-state.json'))
  }

  async prepareCandidate(
    transition: GatewayDeploymentTransition,
  ): Promise<GatewayDeploymentSlot> {
    let existing = await this.readDeployment()
    // A completed host transaction is historical rollback material, not a
    // live candidate. Release the two-slot lease before starting the next
    // update while leaving its archived old data on disk.
    if (existing?.phase === 'complete') {
      await this.clearDeployment()
      existing = undefined
    }
    if (existing) {
      if (existing.updateId !== transition.updateId) {
        throw new Error('Another concrete Gateway candidate already exists on this computer')
      }
      if (existing.phase === 'trial') return this.candidateSlot(existing)
      await this.cleanupUncommitted(existing)
    }
    const state = this.initialState(transition)
    await this.writeDeployment(state)
    try {
      await validateMacosGatewayRelease(state.releaseDirectory)
      await mkdir(state.candidateDirectory, { recursive: true, mode: 0o700 })
      await mkdir(dirname(state.candidateAdminSocket), { recursive: true, mode: 0o700 })
      await this.copyFoundation(state.candidateDirectory)

      const sourceIdentity = await new FileGatewayIdentityStore(
        join(this.activeDataDirectory, 'gateway-identity.json'),
      ).loadExisting()
      if (
        sourceIdentity.workspaceId !== state.workspaceId
        && state.workspaceId !== ''
      ) throw new Error('Active Gateway identity changed during candidate preparation')
      if (sourceIdentity.gatewayNodeId !== state.sourceGatewayNodeId) {
        throw new Error('Active Gateway identity changed during candidate preparation')
      }
      state.workspaceId = sourceIdentity.workspaceId
      state.updatedAt = this.now()
      await this.writeDeployment(state)
      const candidateIdentity = await new FileGatewayIdentityStore(
        join(state.candidateDirectory, 'gateway-identity.json'),
      ).joinWorkspace(
        sourceIdentity.workspaceId,
        sourceIdentity.serialized,
        state.candidateGatewayNodeId,
        this.now(),
      )

      const sourceProfile = await readRecord(join(this.activeDataDirectory, 'gateway-profile.json'))
      const computerName = requiredString(
        sourceProfile.computerName ?? sourceProfile.gatewayName,
        'active Gateway computer name',
      )
      const sourceName = requiredString(sourceProfile.gatewayName, 'active Gateway name')
      const profile = new FileGatewayNodeProfileStore(
        join(state.candidateDirectory, 'gateway-profile.json'),
        candidateIdentity.gatewayNodeId,
      )
      await profile.loadOrCreate(candidateName(sourceName), this.now())
      await profile.updateComputerName(computerName, this.now())

      const matrixLogin = await new GatewayAdminClient({
        socketPath: this.config.activeAdminSocketPath,
        timeoutMs: 30_000,
      }).issueDeploymentMatrixLogin()
      if (matrixLogin.status !== 'ready') {
        throw new Error(
          `Active Gateway could not issue an isolated Matrix login (${matrixLogin.status})`,
        )
      }
      const loginUser = matrixLoginUser(matrixLogin.invitation.userId)
      const login = await loginMatrixGatewayWithToken({
        homeserver: matrixLogin.invitation.homeserver,
        loginToken: matrixLogin.invitation.loginToken,
        expectedUserId: matrixLogin.invitation.userId,
        loginUser,
        deviceId: `MALINK_CANDIDATE_${randomUUID().replaceAll('-', '').slice(0, 16).toUpperCase()}`,
        deviceDisplayName: `${candidateName(sourceName)} trial`,
        sessionPath: join(state.candidateDirectory, 'matrix-session.json'),
        fetch: this.dependencies.fetch,
      })
      const trialRoomId = await createEncryptedTrialRoom(
        matrixLogin.invitation.homeserver,
        login.access_token,
        candidateName(sourceName),
        this.dependencies.fetch ?? fetch,
      )
      const sourceCatalog = await readProjectCatalog(this.activeDataDirectory)
      const sourceRoom = sourceCatalog.projects[0]
      if (!sourceRoom) throw new Error('Active Gateway has no project route for candidate trial')
      const candidateProjectId = `gateway-trial-${transition.updateId}`
      await writePrivateJson(join(state.candidateDirectory, 'matrix-fixture.json'), {
        homeserver: matrixLogin.invitation.homeserver,
        roomId: trialRoomId,
        gatewayId: state.workspaceId,
        gateway: { userId: login.user_id },
      })
      await writePrivateJson(join(state.candidateDirectory, 'gateway-projects.json'), {
        version: 1,
        gatewayNodeId: state.candidateGatewayNodeId,
        projects: [{
          roomId: trialRoomId,
          conversationId: trialRoomId,
          projectId: candidateProjectId,
          projectName: `${requiredString(sourceRoom.projectName ?? 'Gateway', 'project name')
            .slice(0, 122)} trial`,
          cwd: requiredString(sourceRoom.cwd, 'project working directory'),
          providerName: requiredString(sourceRoom.providerName, 'project provider'),
        }],
      })
      await writePrivateJson(join(state.candidateDirectory, 'gateway-shadow-rooms.json'),
        sourceCatalog.projects.map(project => requiredString(project.roomId, 'project room ID')))
      state.trialRoomId = trialRoomId
      state.candidateProjectCount = 1
      state.updatedAt = this.now()
      await this.writeDeployment(state)

      await this.writeCandidateLaunchAgent(state, state.candidateDirectory, false)
      await this.startService(state.candidateServiceLabel, state.candidateLaunchAgent)
      await this.waitForHealth(state.candidateAdminSocket, {
        gatewayNodeId: state.candidateGatewayNodeId,
        buildId: state.buildId,
        projectCount: 1,
        sessionCount: 0,
        shadowRoomCount: state.sourceProjectCount,
        requireRunning: true,
        deploymentFenced: false,
      })

      // Merge the candidate's root-signed descriptor locally as well as over
      // Matrix, so discard and promotion remain deterministic during outages.
      const candidateDirectory = new FileWorkspaceGatewayDirectory(
        join(state.candidateDirectory, 'workspace-gateways.json'),
        candidateIdentity,
      )
      const sourceDirectory = new FileWorkspaceGatewayDirectory(
        join(this.activeDataDirectory, 'workspace-gateways.json'),
        sourceIdentity,
      )
      const signed = await candidateDirectory.load()
      if (!signed) throw new Error('Candidate did not create a Workspace directory')
      await sourceDirectory.merge(signed)
      // Preparation is not complete until authorized clients can discover and
      // join the isolated trial project through the active control room.
      await new GatewayAdminClient({
        socketPath: this.config.activeAdminSocketPath,
        timeoutMs: 30_000,
      }).syncDeploymentState()

      state.phase = 'trial'
      state.updatedAt = this.now()
      await this.writeDeployment(state)
      this.log(`candidate ${state.candidateGatewayNodeId} is Matrix-ready for trial`)
      return this.candidateSlot(state)
    } catch (error) {
      await this.removeCandidateFromDirectory(state).catch(directoryError => {
        this.log(`candidate directory cleanup deferred: ${formatError(directoryError)}`)
      })
      await this.cleanupUncommitted(state).catch(cleanupError => {
        this.log(`candidate cleanup failed: ${formatError(cleanupError)}`)
      })
      await this.clearDeployment().catch(() => undefined)
      throw error
    }
  }

  async discardCandidate(transition: GatewayDeploymentTransition): Promise<void> {
    // prepareCandidate owns best-effort cleanup of its partially created
    // resources before it rejects. The coordinator deliberately follows with
    // discardCandidate, so an already-cleared host transaction is success,
    // not a second cleanup failure that requires operator repair.
    if (!await this.readDeployment()) return
    const state = await this.requireDeployment(transition)
    if (isCommittedPhase(state.phase)) {
      throw new Error('A committed Gateway candidate cannot be discarded')
    }
    await this.stopService(state.candidateServiceLabel)
    await rm(state.candidateAdminSocket, { force: true })
    await this.removeCandidateFromDirectory(state)
    await this.logoutCandidate(state.candidateDirectory)
    await rm(this.updateRoot(state.updateId), { recursive: true, force: true })
    await this.clearDeployment()
    this.log(`discarded candidate ${state.candidateGatewayNodeId}`)
  }

  async drainDeployments(
    transition: GatewayDeploymentTransition & { mode: 'when_idle' | 'force' },
  ): Promise<{
    activeTurns: number
    active: GatewayDeploymentSlot
    candidate: GatewayDeploymentSlot
  }> {
    const state = await this.requireDeployment(transition)
    const readStatus = (path: string) => this.readStatus(path).catch(() => undefined)
    const [sourceBefore, candidateBefore] = await Promise.all([
      readStatus(this.config.activeAdminSocketPath),
      readStatus(state.candidateAdminSocket),
    ])
    state.sourceProjectCount = optionalCount(
      sourceBefore?.projectCount,
      state.sourceProjectCount,
      'active Gateway project count',
    )
    state.sourceSessionCount = optionalCount(
      sourceBefore?.sessionCount,
      state.sourceSessionCount,
      'active Gateway session count',
    )
    state.candidateProjectCount = optionalCount(
      candidateBefore?.projectCount,
      state.candidateProjectCount,
      'candidate Gateway project count',
    )
    state.candidateSessionCount = optionalCount(
      candidateBefore?.sessionCount,
      state.candidateSessionCount,
      'candidate Gateway session count',
    )
    state.updatedAt = this.now()
    await this.writeDeployment(state)
    await Promise.all([
      new GatewayAdminClient({
        socketPath: this.config.activeAdminSocketPath,
        timeoutMs: this.config.healthTimeoutMs ?? 180_000,
      }).sealForDeployment(transition.mode),
      new GatewayAdminClient({
        socketPath: state.candidateAdminSocket,
        timeoutMs: this.config.healthTimeoutMs ?? 180_000,
      }).sealForDeployment(transition.mode),
    ])
    state.phase = 'sealed'
    state.updatedAt = this.now()
    await this.writeDeployment(state)
    return {
      activeTurns: (sourceBefore?.activeTurns ?? 0) + (candidateBefore?.activeTurns ?? 0),
      active: {
        ...transition.active,
        projectCount: state.sourceProjectCount,
        sessionCount: state.sourceSessionCount,
      },
      candidate: this.candidateSlot(state),
    }
  }

  async transferState(
    transition: GatewayDeploymentTransition,
  ): Promise<GatewayDeploymentSlot> {
    const state = await this.requireDeployment(transition)
    if (state.phase !== 'sealed' && state.phase !== 'validating' && state.phase !== 'transferred') {
      throw new Error(`Gateway handoff cannot transfer while concrete host is ${state.phase}`)
    }
    if (state.phase === 'transferred' && state.handoffDirectory) {
      return this.promotedCandidateSlot(state)
    }
    const result = await (this.dependencies.buildHandoff ?? buildGatewayDeploymentHandoff)({
      sourceDirectory: this.activeDataDirectory,
      candidateDirectory: state.candidateDirectory,
      transactionRoot: join(this.installRoot, 'deployment-handoffs'),
      updateId: state.updateId,
      candidateGatewayNodeId: state.candidateGatewayNodeId,
      workspaceId: state.workspaceId,
      now: this.now(),
    })
    state.phase = 'validating'
    state.handoffDirectory = result.targetDirectory
    state.promotedProjectCount = result.projectCount
    state.promotedSessionCount = result.sessionCount
    state.updatedAt = this.now()
    await this.writeDeployment(state)

    await this.stopService(state.candidateServiceLabel)
    await this.writeCandidateLaunchAgent(state, result.targetDirectory, true)
    await this.startService(state.candidateServiceLabel, state.candidateLaunchAgent)
    try {
      await this.waitForHealth(state.candidateAdminSocket, {
        gatewayNodeId: state.candidateGatewayNodeId,
        buildId: state.buildId,
        projectCount: result.projectCount,
        sessionCount: result.sessionCount,
        requireRunning: true,
        deploymentFenced: true,
      })
    } finally {
      await this.stopService(state.candidateServiceLabel)
    }
    state.phase = 'transferred'
    state.updatedAt = this.now()
    await this.writeDeployment(state)
    this.log(
      `validated merged candidate with ${result.projectCount} project(s) and `
      + `${result.sessionCount} session(s)`,
    )
    return this.promotedCandidateSlot(state)
  }

  async commitCandidate(transition: GatewayDeploymentTransition): Promise<void> {
    const state = await this.requireDeployment(transition)
    if (state.phase === 'complete') return
    if (state.phase !== 'transferred' && state.phase !== 'ownership_committed') {
      throw new Error(`Gateway ownership cannot commit while concrete host is ${state.phase}`)
    }
    if (state.phase === 'transferred') {
      state.phase = 'committing'
      state.updatedAt = this.now()
      await this.writeDeployment(state)
      await this.commitLocalDirectoryOwnership(state)
      state.phase = 'ownership_committed'
      state.updatedAt = this.now()
      await this.writeDeployment(state)
    }
    await this.completeCommittedActivation(state)
  }

  async rollbackPreCommit(transition: GatewayDeploymentTransition): Promise<{
    active: GatewayDeploymentSlot
    candidate: GatewayDeploymentSlot
  }> {
    const state = await this.requireDeployment(transition)
    if (isCommittedPhase(state.phase) || await this.directoryShowsCommittedOwnership(state)) {
      throw new Error('Gateway ownership already committed; pre-commit rollback is forbidden')
    }
    await this.stopService(state.candidateServiceLabel)
    if (state.handoffDirectory) {
      await rm(state.handoffDirectory, { recursive: true, force: true })
      delete state.handoffDirectory
    }
    await this.writeCandidateLaunchAgent(state, state.candidateDirectory, false)
    await Promise.all([
      this.restartService(this.config.activeServiceLabel, this.config.activeLaunchAgentPath),
      this.startService(state.candidateServiceLabel, state.candidateLaunchAgent),
    ])
    const [sourceHealth, candidateHealth] = await Promise.all([
      this.waitForHealth(this.config.activeAdminSocketPath, {
        gatewayNodeId: state.sourceGatewayNodeId,
        buildId: transition.active.buildId,
        projectCount: state.sourceProjectCount,
        sessionCount: state.sourceSessionCount,
        requireRunning: true,
        deploymentFenced: false,
      }),
      this.waitForHealth(state.candidateAdminSocket, {
        gatewayNodeId: state.candidateGatewayNodeId,
        buildId: state.buildId,
        projectCount: state.candidateProjectCount,
        sessionCount: state.candidateSessionCount,
        shadowRoomCount: state.sourceProjectCount,
        requireRunning: true,
        deploymentFenced: false,
      }),
    ])
    state.sourceProjectCount = requiredCount(
      sourceHealth.projectCount,
      'active Gateway project count',
    )
    state.sourceSessionCount = requiredCount(
      sourceHealth.sessionCount,
      'active Gateway session count',
    )
    state.candidateProjectCount = requiredCount(
      candidateHealth.projectCount,
      'candidate Gateway project count',
    )
    state.candidateSessionCount = requiredCount(
      candidateHealth.sessionCount,
      'candidate Gateway session count',
    )
    state.phase = 'trial'
    delete state.promotedProjectCount
    delete state.promotedSessionCount
    state.updatedAt = this.now()
    await this.writeDeployment(state)
    return {
      active: {
        ...transition.active,
        projectCount: state.sourceProjectCount,
        sessionCount: state.sourceSessionCount,
      },
      candidate: this.candidateSlot(state),
    }
  }

  async recoverPreparation(
    transition: GatewayDeploymentTransition,
  ): Promise<GatewayDeploymentSlot | null> {
    const state = await this.readDeployment()
    if (!state || state.updateId !== transition.updateId) return null
    if (state.phase === 'trial') {
      await this.waitForHealth(state.candidateAdminSocket, {
        gatewayNodeId: state.candidateGatewayNodeId,
        buildId: state.buildId,
        requireRunning: true,
      })
      return this.candidateSlot(state)
    }
    if (isCommittedPhase(state.phase) || await this.directoryShowsCommittedOwnership(state)) {
      throw new Error('Interrupted preparation crossed the Gateway ownership commit')
    }
    await this.cleanupUncommitted(state)
    await this.clearDeployment()
    return null
  }

  async recoverCommit(
    transition: GatewayDeploymentTransition,
  ): Promise<'committed' | 'not_committed' | 'unknown'> {
    const state = await this.readDeployment()
    if (!state || state.updateId !== transition.updateId) return 'unknown'
    try {
      if (isCommittedPhase(state.phase) || await this.directoryShowsCommittedOwnership(state)) {
        state.phase = 'ownership_committed'
        await this.writeDeployment(state)
        await this.completeCommittedActivation(state)
        return 'committed'
      }
      return 'not_committed'
    } catch (error) {
      this.log(`commit recovery remains fenced: ${formatError(error)}`)
      return 'unknown'
    }
  }

  private async completeCommittedActivation(state: GatewayBlueGreenHostState): Promise<void> {
    const handoffDirectory = state.handoffDirectory
    const archive = state.sourceArchiveDirectory
      ?? join(this.updateRoot(state.updateId), 'source-archive')
    state.sourceArchiveDirectory = archive
    await this.writeDeployment(state)
    await Promise.all([
      this.stopService(this.config.activeServiceLabel),
      this.stopService(state.candidateServiceLabel),
    ])
    if (await pathExists(handoffDirectory ?? '')) {
      if (await pathExists(this.activeDataDirectory) && !await pathExists(archive)) {
        await mkdir(dirname(archive), { recursive: true, mode: 0o700 })
        await rename(this.activeDataDirectory, archive)
      }
      if (!await pathExists(this.activeDataDirectory)) {
        await rename(requiredString(handoffDirectory, 'handoff directory'), this.activeDataDirectory)
      }
    }
    if (!await this.directoryShowsCommittedOwnership({
      ...state,
      handoffDirectory: this.activeDataDirectory,
    })) throw new Error('Promoted Gateway data is not installed at the active data path')
    await replaceSymlink(join(this.installRoot, 'current'), state.releaseDirectory)
    const activePlist = await readFile(this.config.activeLaunchAgentPath, 'utf8')
    const nextPlist = setPlistEnvironmentStrings(activePlist, {
      MALINK_MATRIX_DATA_DIR: this.activeDataDirectory,
      MALINK_MATRIX_FIXTURE: join(this.activeDataDirectory, 'matrix-fixture.json'),
      MALINK_MATRIX_GATEWAY_SESSION_FILE: join(this.activeDataDirectory, 'matrix-session.json'),
      MALINK_GATEWAY_ADMIN_SOCKET: this.config.activeAdminSocketPath,
      MALINK_GATEWAY_UPDATE_SOCKET: this.config.updateSocketPath,
      MALINK_GATEWAY_BUILD_ID: state.buildId,
      MALINK_GATEWAY_BLUE_GREEN: '1',
    })
    await atomicWrite(this.config.activeLaunchAgentPath, removePlistEnvironmentString(
      nextPlist,
      'MALINK_GATEWAY_HANDOFF_PENDING',
    ), 0o644)
    await this.restartService(this.config.activeServiceLabel, this.config.activeLaunchAgentPath)
    await this.waitForHealth(this.config.activeAdminSocketPath, {
      gatewayNodeId: state.candidateGatewayNodeId,
      buildId: state.buildId,
      projectCount: requiredCount(
        state.promotedProjectCount,
        'promoted Gateway project count',
      ),
      sessionCount: requiredCount(
        state.promotedSessionCount,
        'promoted Gateway session count',
      ),
      requireRunning: true,
      deploymentFenced: false,
    })
    await this.logoutCandidate(archive)
    state.phase = 'complete'
    state.handoffDirectory = this.activeDataDirectory
    state.updatedAt = this.now()
    await this.writeDeployment(state)
    await rm(state.candidateLaunchAgent, { force: true })
    await rm(state.candidateAdminSocket, { force: true })
    if (state.candidateDirectory !== this.activeDataDirectory) {
      await rm(state.candidateDirectory, { recursive: true, force: true })
    }
    this.log(`committed all Gateway routes to ${state.candidateGatewayNodeId}`)
    this.dependencies.onCommitted?.()
  }

  private async commitLocalDirectoryOwnership(state: GatewayBlueGreenHostState): Promise<void> {
    const target = requiredString(state.handoffDirectory, 'handoff directory')
    const identity = await new FileGatewayIdentityStore(
      join(target, 'gateway-identity.json'),
    ).loadExisting()
    if (identity.gatewayNodeId !== state.candidateGatewayNodeId) {
      throw new Error('Handoff identity is not the candidate Gateway')
    }
    const catalog = await readProjectCatalog(target)
    const profile = await readRecord(join(target, 'gateway-profile.json'))
    const directory = new FileWorkspaceGatewayDirectory(
      join(target, 'workspace-gateways.json'),
      identity,
    )
    await directory.promoteLocalOwnership(
      state.sourceGatewayNodeId,
      catalog.projects.map(project => ({
        projectId: requiredString(project.projectId, 'project ID'),
        roomId: requiredString(project.roomId, 'project room ID'),
        conversationId: requiredString(project.conversationId, 'conversation ID'),
      })),
      {
        computerName: requiredString(
          profile.computerName ?? profile.gatewayName,
          'Gateway computer name',
        ),
        buildId: state.buildId,
      },
      this.now(),
    )
  }

  private async directoryShowsCommittedOwnership(state: GatewayBlueGreenHostState): Promise<boolean> {
    const paths = [state.handoffDirectory, this.activeDataDirectory].filter(
      (value): value is string => Boolean(value),
    )
    for (const directory of paths) {
      try {
        const value = await readRecord(join(directory, 'workspace-gateways.json'))
        const gateways = record(value.gateways)
        const removed = Array.isArray(value.removedGatewayNodeIds)
          ? value.removedGatewayNodeIds
          : []
        if (
          gateways?.[state.candidateGatewayNodeId]
          && !gateways[state.sourceGatewayNodeId]
          && removed.includes(state.sourceGatewayNodeId)
        ) return true
      } catch (error) {
        if (!isNodeError(error, 'ENOENT')) throw error
      }
    }
    return false
  }

  private async removeCandidateFromDirectory(state: GatewayBlueGreenHostState): Promise<void> {
    const sourceIdentity = await new FileGatewayIdentityStore(
      join(this.activeDataDirectory, 'gateway-identity.json'),
    ).loadExisting()
    const source = new FileWorkspaceGatewayDirectory(
      join(this.activeDataDirectory, 'workspace-gateways.json'),
      sourceIdentity,
    )
    try {
      const candidateIdentity = await new FileGatewayIdentityStore(
        join(state.candidateDirectory, 'gateway-identity.json'),
      ).loadExisting()
      const candidate = new FileWorkspaceGatewayDirectory(
        join(state.candidateDirectory, 'workspace-gateways.json'),
        candidateIdentity,
      )
      const signed = await candidate.load()
      if (signed) await source.merge(signed)
    } catch (error) {
      if (!isNodeError(error, 'ENOENT')) throw error
    }
    const current = await source.load()
    if (current?.directory.gateways.some(gateway =>
      gateway.gatewayNodeId === state.candidateGatewayNodeId)) {
      await source.remove(state.candidateGatewayNodeId, this.now())
    }
  }

  private async cleanupUncommitted(state: GatewayBlueGreenHostState): Promise<void> {
    if (isCommittedPhase(state.phase)) return
    await this.stopService(state.candidateServiceLabel).catch(() => undefined)
    await rm(state.candidateAdminSocket, { force: true }).catch(() => undefined)
    await this.logoutCandidate(state.candidateDirectory).catch(() => undefined)
    await rm(this.updateRoot(state.updateId), { recursive: true, force: true })
    if (state.handoffDirectory) {
      await rm(state.handoffDirectory, { recursive: true, force: true })
    }
  }

  private async copyFoundation(candidateDirectory: string): Promise<void> {
    for (const name of FOUNDATION_FILES) {
      const source = join(this.activeDataDirectory, name)
      if (!await pathExists(source)) continue
      const metadata = await lstat(source)
      if (metadata.isSymbolicLink() || !metadata.isFile()) {
        throw new Error(`Gateway foundation path is not a regular file: ${source}`)
      }
      const destination = join(candidateDirectory, name)
      await copyFile(source, destination, constants.COPYFILE_EXCL)
      await chmod(destination, 0o600)
    }
  }

  private initialState(transition: GatewayDeploymentTransition): GatewayBlueGreenHostState {
    requirePathSegment(transition.updateId, 'Gateway update ID')
    requirePathSegment(transition.candidate.releaseId ?? '', 'Gateway release ID')
    const updateRoot = this.updateRoot(transition.updateId)
    return {
      version: 1,
      phase: 'preparing',
      updateId: transition.updateId,
      sourceGatewayNodeId: transition.active.gatewayNodeId,
      candidateGatewayNodeId: transition.candidate.gatewayNodeId,
      workspaceId: '',
      releaseId: transition.candidate.releaseId!,
      buildId: transition.candidate.buildId,
      releaseDirectory: join(this.installRoot, 'releases', transition.candidate.releaseId!),
      candidateDirectory: join(updateRoot, 'candidate-data'),
      candidateAdminSocket: macosGatewayCandidateAdminSocketPath(
        this.installRoot,
        transition.updateId,
      ),
      candidateLaunchAgent: join(updateRoot, 'candidate.plist'),
      candidateServiceLabel: candidateServiceLabel(
        this.config.activeServiceLabel,
        transition.updateId,
      ),
      sourceProjectCount: transition.active.projectCount,
      sourceSessionCount: transition.active.sessionCount,
      candidateProjectCount: 0,
      candidateSessionCount: 0,
      updatedAt: this.now(),
    }
  }

  private async requireDeployment(
    transition: GatewayDeploymentTransition,
  ): Promise<GatewayBlueGreenHostState> {
    const state = await this.readDeployment()
    if (
      !state
      || state.updateId !== transition.updateId
      || state.sourceGatewayNodeId !== transition.active.gatewayNodeId
      || state.candidateGatewayNodeId !== transition.candidate.gatewayNodeId
      || state.buildId !== transition.candidate.buildId
    ) throw new Error('Concrete Gateway deployment does not match the durable coordinator')
    return state
  }

  private candidateSlot(state: GatewayBlueGreenHostState): GatewayDeploymentSlot {
    return {
      gatewayNodeId: state.candidateGatewayNodeId,
      releaseId: state.releaseId,
      buildId: state.buildId,
      projectCount: state.candidateProjectCount,
      sessionCount: state.candidateSessionCount,
    }
  }

  private promotedCandidateSlot(state: GatewayBlueGreenHostState): GatewayDeploymentSlot {
    return {
      gatewayNodeId: state.candidateGatewayNodeId,
      releaseId: state.releaseId,
      buildId: state.buildId,
      projectCount: requiredCount(
        state.promotedProjectCount,
        'promoted Gateway project count',
      ),
      sessionCount: requiredCount(
        state.promotedSessionCount,
        'promoted Gateway session count',
      ),
    }
  }

  private async writeCandidateLaunchAgent(
    state: GatewayBlueGreenHostState,
    dataDirectory: string,
    handoffPending: boolean,
  ): Promise<void> {
    const original = await readFile(this.config.activeLaunchAgentPath, 'utf8')
    let candidate = setPlistString(original, 'Label', state.candidateServiceLabel)
    candidate = replaceGatewayEntrypoint(
      candidate,
      join(state.releaseDirectory, 'ops', 'matrix-local-gateway.js'),
    )
    candidate = setPlistEnvironmentStrings(candidate, {
      MALINK_MATRIX_DATA_DIR: dataDirectory,
      MALINK_MATRIX_FIXTURE: join(dataDirectory, 'matrix-fixture.json'),
      MALINK_MATRIX_GATEWAY_SESSION_FILE: join(dataDirectory, 'matrix-session.json'),
      MALINK_GATEWAY_ADMIN_SOCKET: state.candidateAdminSocket,
      MALINK_GATEWAY_UPDATE_SOCKET: this.config.updateSocketPath,
      MALINK_GATEWAY_BUILD_ID: state.buildId,
      MALINK_GATEWAY_BLUE_GREEN: '1',
      MALINK_GATEWAY_DEPLOYMENT_CANDIDATE: '1',
      MALINK_GATEWAY_SHADOW_ROOMS_FILE: join(dataDirectory, 'gateway-shadow-rooms.json'),
      ...(handoffPending ? { MALINK_GATEWAY_HANDOFF_PENDING: '1' } : {}),
    })
    if (!handoffPending) {
      candidate = removePlistEnvironmentString(candidate, 'MALINK_GATEWAY_HANDOFF_PENDING')
    }
    candidate = replacePlistLogPaths(
      candidate,
      join(this.updateRoot(state.updateId), 'candidate.log'),
      join(this.updateRoot(state.updateId), 'candidate.error.log'),
    )
    await atomicWrite(state.candidateLaunchAgent, candidate, 0o644)
  }

  private async waitForHealth(
    socketPath: string,
    expected: {
      gatewayNodeId: string
      buildId: string
      shadowRoomCount?: number
      projectCount?: number
      sessionCount?: number
      requireRunning: boolean
      deploymentFenced?: boolean
    },
  ): Promise<GatewayAdminStatus> {
    const deadline = this.now() + (this.config.healthTimeoutMs ?? 180_000)
    let lastError: unknown = new Error('Gateway health check did not run')
    while (this.now() < deadline) {
      try {
        const status = await this.readStatus(socketPath)
        if (status.gatewayNodeId !== expected.gatewayNodeId) {
          throw new Error(`Gateway reported another node ${status.gatewayNodeId}`)
        }
        if (status.buildId !== expected.buildId) {
          throw new Error(`Gateway reported build ${status.buildId ?? '(missing)'}`)
        }
        if (expected.requireRunning && status.state !== 'running') {
          throw new Error(`Gateway reported ${status.state}`)
        }
        if (
          expected.projectCount !== undefined
          && status.projectCount !== expected.projectCount
        ) throw new Error('Gateway did not open the complete expected project set')
        if (
          expected.sessionCount !== undefined
          && status.sessionCount !== expected.sessionCount
        ) throw new Error('Gateway did not open the complete expected session set')
        if (
          expected.deploymentFenced !== undefined
          && status.deploymentFenced !== expected.deploymentFenced
        ) throw new Error('Gateway deployment command fence is in the wrong state')
        if (status.matrixReady !== true || typeof status.lastMatrixSyncAt !== 'number') {
          throw new Error('Gateway Matrix synchronization is not ready')
        }
        if (this.now() - status.lastMatrixSyncAt > (this.config.syncFreshnessMs ?? 45_000)) {
          throw new Error('Gateway Matrix synchronization is stale')
        }
        if (
          expected.shadowRoomCount !== undefined
          && status.shadowRoomCount !== expected.shadowRoomCount
        ) throw new Error('Candidate is not shadowing every active project room')
        return status
      } catch (error) {
        lastError = error
      }
      await this.sleep(250)
    }
    throw new Error(`Gateway did not become healthy: ${formatError(lastError)}`)
  }

  private async startService(label: string, plistPath: string): Promise<void> {
    const domain = `gui/${this.config.uid ?? process.getuid?.() ?? 0}`
    const service = `${domain}/${label}`
    await this.stopService(label)
    let lastError: unknown = new Error('launchctl bootstrap did not run')
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await this.launchctl(['bootstrap', domain, plistPath])
        await this.launchctl(['kickstart', '-k', service])
        return
      } catch (error) {
        lastError = error
        await this.sleep(250 * (attempt + 1))
      }
    }
    throw lastError
  }

  private restartService(label: string, plistPath: string): Promise<void> {
    return this.startService(label, plistPath)
  }

  private async stopService(label: string): Promise<void> {
    const domain = `gui/${this.config.uid ?? process.getuid?.() ?? 0}`
    const service = `${domain}/${label}`
    try {
      await this.launchctl(['bootout', service])
    } catch (error) {
      if (await this.isServiceLoaded(service)) throw error
    }
  }

  private readStatus(socketPath: string): Promise<GatewayAdminStatus> {
    return this.dependencies.readStatus?.(socketPath)
      ?? new GatewayAdminClient({ socketPath, timeoutMs: 2_000 }).status()
  }

  private launchctl(arguments_: readonly string[]): Promise<void> {
    return this.dependencies.launchctl?.(arguments_) ?? runLaunchctl(arguments_)
  }

  private isServiceLoaded(service: string): Promise<boolean> {
    return this.dependencies.isServiceLoaded?.(service) ?? launchAgentIsLoaded(service)
  }

  private sleep(milliseconds: number): Promise<void> {
    return this.dependencies.sleep?.(milliseconds)
      ?? new Promise(resolveDelay => setTimeout(resolveDelay, milliseconds))
  }

  private updateRoot(updateId: string): string {
    requirePathSegment(updateId, 'Gateway update ID')
    return join(this.installRoot, 'deployments', updateId)
  }

  private now(): number {
    return this.dependencies.now?.() ?? Date.now()
  }

  private log(message: string): void {
    this.dependencies.onLog?.(`[gateway-blue-green] ${message}`)
  }

  private readDeployment(): Promise<GatewayBlueGreenHostState | undefined> {
    return this.stateFile.transaction(() => ({ version: 1 }), state => {
      validateHostFile(state)
      return {
        result: state.deployment ? structuredClone(state.deployment) : undefined,
        changed: false,
      }
    })
  }

  private writeDeployment(deployment: GatewayBlueGreenHostState): Promise<void> {
    validateHostDeployment(deployment)
    return this.stateFile.transaction(() => ({ version: 1 }), state => {
      validateHostFile(state)
      state.deployment = structuredClone(deployment)
      return { result: undefined, changed: true }
    })
  }

  private clearDeployment(): Promise<void> {
    return this.stateFile.transaction(() => ({ version: 1 }), state => {
      validateHostFile(state)
      const changed = state.deployment !== undefined
      delete state.deployment
      return { result: undefined, changed }
    })
  }

  private async logoutCandidate(directory: string): Promise<void> {
    try {
      const session = await readRecord(join(directory, 'matrix-session.json'))
      const token = requiredString(session.access_token, 'candidate Matrix access token')
      const homeserver = new URL(requiredString(session.homeserver, 'candidate homeserver')).origin
      await (this.dependencies.fetch ?? fetch)(`${homeserver}/_matrix/client/v3/logout`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      })
    } catch (error) {
      if (!isNodeError(error, 'ENOENT')) this.log(`candidate Matrix logout deferred: ${formatError(error)}`)
    }
  }
}

/**
 * macOS limits sockaddr_un paths to 103 bytes plus the trailing NUL. Keep the
 * runtime socket outside the UUID-named deployment directory so a normal
 * per-user install path cannot make an otherwise valid candidate unstartable.
 */
export function macosGatewayCandidateAdminSocketPath(
  installRootInput: string,
  updateId: string,
): string {
  requirePathSegment(updateId, 'Gateway update ID')
  const digest = createHash('sha256').update(updateId).digest('hex').slice(0, 20)
  const socketPath = join(resolve(installRootInput), 'run', `${digest}.sock`)
  if (Buffer.byteLength(socketPath) > 103) {
    throw new Error(
      `Gateway install path is too long for a macOS Unix socket: ${socketPath}`,
    )
  }
  return socketPath
}

export async function inspectGatewayDeploymentSlot(input: {
  dataDirectory: string
  releaseId?: string
  buildId: string
}): Promise<GatewayDeploymentSlot> {
  const directory = resolve(input.dataDirectory)
  const identity = await new FileGatewayIdentityStore(
    join(directory, 'gateway-identity.json'),
  ).loadExisting()
  const catalog = await readProjectCatalog(directory)
  let sessionCount = 0
  try {
    const runtime = await readRecord(join(
      directory,
      'gateway-replay.jsonl.v3-runtime-state.json',
    ))
    const projects = record(runtime.projects) ?? {}
    for (const value of Object.values(projects)) {
      const sessions = record(value)?.sessions
      if (Array.isArray(sessions)) sessionCount += sessions.length
    }
  } catch (error) {
    if (!isNodeError(error, 'ENOENT')) throw error
  }
  return {
    gatewayNodeId: identity.gatewayNodeId,
    ...(input.releaseId ? { releaseId: input.releaseId } : {}),
    buildId: input.buildId,
    projectCount: catalog.projects.length,
    sessionCount,
  }
}

async function readProjectCatalog(directory: string): Promise<{
  projects: Record<string, unknown>[]
}> {
  const catalog = await readRecord(join(directory, 'gateway-projects.json'))
  if (catalog.version !== 1 || !Array.isArray(catalog.projects)) {
    throw new Error('Gateway project catalog is invalid')
  }
  return {
    projects: catalog.projects.map((value, index) => {
      const project = record(value)
      if (!project) throw new Error(`Gateway project ${index} is invalid`)
      return project
    }),
  }
}

async function createEncryptedTrialRoom(
  homeserver: string,
  accessToken: string,
  gatewayName: string,
  fetchImpl: typeof fetch,
): Promise<string> {
  const response = await fetchImpl(`${new URL(homeserver).origin}/_matrix/client/v3/createRoom`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      visibility: 'private',
      preset: 'private_chat',
      name: `${gatewayName} update trial`,
      initial_state: [{
        type: 'm.room.encryption',
        state_key: '',
        content: { algorithm: 'm.megolm.v1.aes-sha2' },
      }],
    }),
  })
  const body = record(await response.json().catch(() => undefined))
  if (!response.ok || typeof body?.room_id !== 'string' || !body.room_id.startsWith('!')) {
    throw new Error(`Matrix could not create the Gateway trial room (HTTP ${response.status})`)
  }
  return body.room_id
}

function candidateName(sourceName: string): string {
  return `${sourceName.slice(0, 116)} (candidate)`
}

function candidateServiceLabel(active: string, updateId: string): string {
  const suffix = updateId.replace(/[^A-Za-z0-9]/gu, '').slice(0, 24)
  if (!suffix) throw new Error('Gateway update ID cannot form a launchd label')
  return `${active}.candidate.${suffix}`
}

function setPlistString(plist: string, key: string, value: string): string {
  const pattern = new RegExp(
    `(<key>\\s*${escapeRegExp(key)}\\s*<\\/key>\\s*<string>)[\\s\\S]*?(<\\/string>)`,
    'u',
  )
  if (!pattern.test(plist)) throw new Error(`Gateway LaunchAgent ${key} is unavailable`)
  return plist.replace(pattern, `$1${xml(value)}$2`)
}

function setPlistEnvironmentStrings(
  plist: string,
  values: Readonly<Record<string, string>>,
): string {
  const marker = /<key>\s*EnvironmentVariables\s*<\/key>\s*<dict>/u.exec(plist)
  if (!marker || marker.index === undefined) {
    throw new Error('Gateway LaunchAgent has no EnvironmentVariables dictionary')
  }
  const start = marker.index + marker[0].length
  const end = plist.indexOf('</dict>', start)
  if (end < 0) throw new Error('Gateway LaunchAgent environment is malformed')
  let body = plist.slice(start, end)
  for (const [key, value] of Object.entries(values)) {
    const entry = new RegExp(
      `<key>\\s*${escapeRegExp(key)}\\s*<\\/key>\\s*<string>[\\s\\S]*?<\\/string>`,
      'u',
    )
    const replacement = `<key>${key}</key>\n    <string>${xml(value)}</string>`
    body = entry.test(body) ? body.replace(entry, replacement) : `${body}\n    ${replacement}`
  }
  return `${plist.slice(0, start)}${body}${plist.slice(end)}`
}

function removePlistEnvironmentString(plist: string, key: string): string {
  const marker = /<key>\s*EnvironmentVariables\s*<\/key>\s*<dict>/u.exec(plist)
  if (!marker || marker.index === undefined) return plist
  const start = marker.index + marker[0].length
  const end = plist.indexOf('</dict>', start)
  if (end < 0) throw new Error('Gateway LaunchAgent environment is malformed')
  const entry = new RegExp(
    `\\s*<key>\\s*${escapeRegExp(key)}\\s*<\\/key>\\s*<string>[\\s\\S]*?<\\/string>`,
    'u',
  )
  const body = plist.slice(start, end).replace(entry, '')
  return `${plist.slice(0, start)}${body}${plist.slice(end)}`
}

function replaceGatewayEntrypoint(plist: string, entrypoint: string): string {
  const pattern = /(<string>)[^<]*\/ops\/matrix-local-gateway\.js(<\/string>)/u
  if (!pattern.test(plist)) throw new Error('Gateway LaunchAgent entrypoint is unavailable')
  return plist.replace(pattern, `$1${xml(entrypoint)}$2`)
}

function replacePlistLogPaths(plist: string, output: string, error: string): string {
  let result = setPlistString(plist, 'StandardOutPath', output)
  result = setPlistString(result, 'StandardErrorPath', error)
  return result
}

async function replaceSymlink(path: string, target: string): Promise<void> {
  const temporary = `${path}.next.${process.pid}.${randomUUID()}`
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await symlink(target, temporary)
  try {
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
}

async function atomicWrite(path: string, content: string, mode: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.next.${process.pid}.${randomUUID()}`
  const handle = await open(temporary, 'wx', mode)
  try {
    await handle.writeFile(content, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  await chmod(temporary, mode)
  await rename(temporary, path)
}

async function writePrivateJson(path: string, value: unknown): Promise<void> {
  await atomicWrite(path, `${JSON.stringify(value)}\n`, 0o600)
}

async function readRecord(path: string): Promise<Record<string, unknown>> {
  const value = JSON.parse(await readFile(path, 'utf8')) as unknown
  const parsed = record(value)
  if (!parsed) throw new Error(`Gateway state is invalid: ${path}`)
  return parsed
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is invalid`)
  return value
}

function matrixLoginUser(userId: string): string {
  const match = userId.match(/^@([^:]+):/u)
  return match?.[1] ?? userId
}

function requirePathSegment(value: string, label: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value)) {
    throw new Error(`${label} is not a safe path segment`)
  }
}

function validateHostFile(state: GatewayBlueGreenHostFile): void {
  if (state.version !== 1) throw new Error('Gateway deployment host state is invalid')
  if (state.deployment) validateHostDeployment(state.deployment)
}

function validateHostDeployment(state: GatewayBlueGreenHostState): void {
  const requiresPromotedCounts = [
    'validating',
    'transferred',
    'committing',
    'ownership_committed',
    'complete',
  ].includes(state.phase)
  if (
    state.version !== 1
    || ![
      'preparing', 'trial', 'sealed', 'validating', 'transferred',
      'committing', 'ownership_committed', 'complete',
    ].includes(state.phase)
    || !state.updateId
    || !state.sourceGatewayNodeId
    || !state.candidateGatewayNodeId
    || state.sourceGatewayNodeId === state.candidateGatewayNodeId
    || (state.phase !== 'preparing' && !state.workspaceId)
    || !state.releaseId
    || !state.buildId
    || !Number.isSafeInteger(state.sourceProjectCount)
    || !Number.isSafeInteger(state.sourceSessionCount)
    || !Number.isSafeInteger(state.candidateProjectCount)
    || !Number.isSafeInteger(state.candidateSessionCount)
    || (state.promotedProjectCount !== undefined
      && !Number.isSafeInteger(state.promotedProjectCount))
    || (state.promotedSessionCount !== undefined
      && !Number.isSafeInteger(state.promotedSessionCount))
    || (requiresPromotedCounts && state.promotedProjectCount === undefined)
    || (requiresPromotedCounts && state.promotedSessionCount === undefined)
    || state.sourceProjectCount < 0
    || state.sourceSessionCount < 0
    || state.candidateProjectCount < 0
    || state.candidateSessionCount < 0
    || (state.promotedProjectCount !== undefined && state.promotedProjectCount < 0)
    || (state.promotedSessionCount !== undefined && state.promotedSessionCount < 0)
  ) throw new Error('Gateway deployment host transaction is invalid')
}

function requiredCount(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${label} is unavailable`)
  }
  return value as number
}

function optionalCount(value: unknown, fallback: number, label: string): number {
  return value === undefined ? fallback : requiredCount(value, label)
}

function isCommittedPhase(phase: HostPhase): boolean {
  return phase === 'ownership_committed' || phase === 'complete'
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error
    && 'code' in error
    && (error as NodeJS.ErrnoException).code === code
}

async function pathExists(path: string): Promise<boolean> {
  if (!path) return false
  try {
    await access(path, constants.F_OK)
    return true
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return false
    throw error
  }
}

function runLaunchctl(arguments_: readonly string[]): Promise<void> {
  return new Promise((resolveRun, reject) => {
    const child = spawn('/bin/launchctl', arguments_, { stdio: 'ignore' })
    child.once('error', reject)
    child.once('exit', code => {
      if (code === 0) resolveRun()
      else reject(new Error(`launchctl ${arguments_.join(' ')} exited with ${code}`))
    })
  })
}

function launchAgentIsLoaded(service: string): Promise<boolean> {
  return new Promise(resolveStatus => {
    const child = spawn('/bin/launchctl', ['print', service], { stdio: 'ignore' })
    child.once('error', () => resolveStatus(false))
    child.once('exit', code => resolveStatus(code === 0))
  })
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

function xml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
