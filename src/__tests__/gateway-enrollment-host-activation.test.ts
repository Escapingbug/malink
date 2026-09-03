import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  activateEnrolledGatewayHost,
  type GatewayEnrollmentHostActivationDependencies,
} from '@/ops/gatewayEnrollmentHostActivation'
import type { GatewayAdminStatus } from '@/gateway/admin'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory =>
    rm(directory, { recursive: true, force: true }),
  ))
})

describe('Gateway enrollment Host activation', () => {
  it('switches the Gateway and supervisor to the enrolled directory and proves health', async () => {
    const fixture = await activationFixture()
    const launchctl = vi.fn(async () => undefined)
    const status = gatewayStatus(fixture.gatewayNodeId)

    const result = await activateEnrolledGatewayHost({
      dataDirectory: fixture.dataDirectory,
      fixturePath: fixture.fixturePath,
      gatewayNodeId: fixture.gatewayNodeId,
      healthTimeoutMs: 1_000,
    }, dependencies(fixture.homeDirectory, launchctl, async socketPath => {
      if (socketPath === join(fixture.previousDataDirectory, 'admin.sock')) {
        return gatewayStatus('previous-node')
      }
      return status
    }))

    expect(result).toMatchObject({
      state: 'activated',
      dataDirectory: fixture.dataDirectory,
      adminSocketPath: join(fixture.dataDirectory, 'admin.sock'),
      serviceLabel: 'com.malink.matrix-gateway',
    })
    const gatewayPlist = await readFile(fixture.gatewayLaunchAgent, 'utf8')
    expect(gatewayPlist).toContain(`<string>${fixture.dataDirectory}</string>`)
    expect(gatewayPlist).toContain(`<string>${fixture.fixturePath}</string>`)
    expect(gatewayPlist).toContain(`<string>${join(fixture.dataDirectory, 'admin.sock')}</string>`)
    expect(gatewayPlist).toContain(`<string>${fixture.gatewayLoginUser}</string>`)
    const supervisorPlist = await readFile(fixture.supervisorLaunchAgent, 'utf8')
    expect(supervisorPlist).toContain(`<string>${fixture.dataDirectory}</string>`)
    expect(supervisorPlist).toContain(`<string>${join(fixture.dataDirectory, 'admin.sock')}</string>`)
    expect(launchctl).toHaveBeenCalledWith([
      'kickstart',
      '-k',
      'gui/501/com.malink.matrix-gateway',
    ])
  })

  it('does not interrupt an existing Gateway with unfinished work', async () => {
    const fixture = await activationFixture()
    const originalGatewayPlist = await readFile(fixture.gatewayLaunchAgent, 'utf8')
    const launchctl = vi.fn(async () => undefined)

    await expect(activateEnrolledGatewayHost({
      dataDirectory: fixture.dataDirectory,
      fixturePath: fixture.fixturePath,
      gatewayNodeId: fixture.gatewayNodeId,
    }, dependencies(fixture.homeDirectory, launchctl, async () => ({
      ...gatewayStatus('previous-node'),
      activeTurns: 1,
      unfinishedCommands: 1,
    })))).rejects.toThrow(/existing Gateway Host is still working/u)

    expect(await readFile(fixture.gatewayLaunchAgent, 'utf8')).toBe(originalGatewayPlist)
    expect(launchctl).not.toHaveBeenCalled()
  })

  it('rejects an enrolled Matrix session that does not match its fixture', async () => {
    const fixture = await activationFixture()
    const originalGatewayPlist = await readFile(fixture.gatewayLaunchAgent, 'utf8')
    const launchctl = vi.fn(async () => undefined)
    await writeFile(join(fixture.dataDirectory, 'matrix-session.json'), JSON.stringify({
      version: 1,
      homeserver: 'https://matrix.example',
      loginUser: 'other_gateway',
      user_id: '@other_gateway:matrix.example',
      access_token: 'tampered-session',
      device_id: 'OTHER_GATEWAY',
    }))

    await expect(activateEnrolledGatewayHost({
      dataDirectory: fixture.dataDirectory,
      fixturePath: fixture.fixturePath,
      gatewayNodeId: fixture.gatewayNodeId,
    }, dependencies(fixture.homeDirectory, launchctl, async () =>
      gatewayStatus('previous-node')))).rejects.toThrow(
      /session does not match its enrollment configuration/u,
    )

    expect(await readFile(fixture.gatewayLaunchAgent, 'utf8')).toBe(originalGatewayPlist)
    expect(launchctl).not.toHaveBeenCalled()
  })

  it('restores both LaunchAgents when the enrolled Gateway cannot become healthy', async () => {
    const fixture = await activationFixture()
    const originalGatewayPlist = await readFile(fixture.gatewayLaunchAgent, 'utf8')
    const originalSupervisorPlist = await readFile(fixture.supervisorLaunchAgent, 'utf8')
    const launchctl = vi.fn(async () => undefined)

    await expect(activateEnrolledGatewayHost({
      dataDirectory: fixture.dataDirectory,
      fixturePath: fixture.fixturePath,
      gatewayNodeId: fixture.gatewayNodeId,
      healthTimeoutMs: 1,
    }, dependencies(fixture.homeDirectory, launchctl, async socketPath => {
      if (socketPath === join(fixture.previousDataDirectory, 'admin.sock')) {
        return gatewayStatus('previous-node')
      }
      throw new Error('admin socket unavailable')
    }))).rejects.toThrow(/previous Gateway Host configuration was restored/u)

    expect(await readFile(fixture.gatewayLaunchAgent, 'utf8')).toBe(originalGatewayPlist)
    expect(await readFile(fixture.supervisorLaunchAgent, 'utf8')).toBe(originalSupervisorPlist)
  })

  it('keeps enrollment complete and reports manual activation off macOS', async () => {
    const fixture = await activationFixture()

    const result = await activateEnrolledGatewayHost({
      dataDirectory: fixture.dataDirectory,
      fixturePath: fixture.fixturePath,
      gatewayNodeId: fixture.gatewayNodeId,
    }, {
      platform: 'linux',
      homeDirectory: fixture.homeDirectory,
    })

    expect(result).toMatchObject({
      state: 'manual',
      detail: expect.stringContaining('requires macOS launchd'),
    })
  })
})

function dependencies(
  homeDirectory: string,
  launchctl: (arguments_: readonly string[]) => Promise<void>,
  readStatus: (socketPath: string) => Promise<GatewayAdminStatus>,
): GatewayEnrollmentHostActivationDependencies {
  return {
    platform: 'darwin',
    homeDirectory,
    uid: 501,
    launchctl,
    isServiceLoaded: async () => false,
    readStatus,
    sleep: async () => undefined,
  }
}

async function activationFixture(): Promise<{
  homeDirectory: string
  dataDirectory: string
  previousDataDirectory: string
  fixturePath: string
  gatewayNodeId: string
  gatewayLoginUser: string
  gatewayLaunchAgent: string
  supervisorLaunchAgent: string
}> {
  const homeDirectory = await mkdtemp(join(tmpdir(), 'malink-enrollment-activation-'))
  temporaryDirectories.push(homeDirectory)
  const launchAgents = join(homeDirectory, 'Library', 'LaunchAgents')
  const dataDirectory = join(homeDirectory, '.malink', 'gateway')
  const previousDataDirectory = join(homeDirectory, '.config', 'malink', 'gateway-data')
  const fixturePath = join(dataDirectory, 'matrix-fixture.json')
  const gatewayNodeId = 'enrolled-gateway-node'
  const gatewayLoginUser = 'enrolled_gateway'
  const gatewayLaunchAgent = join(launchAgents, 'com.malink.matrix-gateway.plist')
  const supervisorLaunchAgent = join(launchAgents, 'io.malink.gateway-update-supervisor.plist')
  await mkdir(dataDirectory, { recursive: true })
  await mkdir(launchAgents, { recursive: true })
  await writeFile(join(dataDirectory, 'gateway-identity.json'), '{}')
  await writeFile(fixturePath, JSON.stringify({
    homeserver: 'https://matrix.example',
    gateway: { userId: '@enrolled_gateway:matrix.example' },
  }))
  await writeFile(join(dataDirectory, 'matrix-session.json'), JSON.stringify({
    version: 1,
    homeserver: 'https://matrix.example',
    loginUser: gatewayLoginUser,
    user_id: '@enrolled_gateway:matrix.example',
    access_token: 'secret-not-read-by-activation',
    device_id: 'ENROLLED_GATEWAY',
  }))
  await writeFile(gatewayLaunchAgent, plist(
    'com.malink.matrix-gateway',
    '/release/ops/matrix-local-gateway.js',
    {
      MALINK_MATRIX_DATA_DIR: previousDataDirectory,
      MALINK_MATRIX_FIXTURE: join(previousDataDirectory, 'matrix-fixture.json'),
    },
  ))
  await writeFile(supervisorLaunchAgent, plist(
    'io.malink.gateway-update-supervisor',
    '/release/ops/gatewayUpdateSupervisorMain.js',
    {
      MALINK_GATEWAY_DATA_DIR: previousDataDirectory,
      MALINK_GATEWAY_ADMIN_SOCKET: join(previousDataDirectory, 'admin.sock'),
    },
  ))
  return {
    homeDirectory,
    dataDirectory,
    previousDataDirectory,
    fixturePath,
    gatewayNodeId,
    gatewayLoginUser,
    gatewayLaunchAgent,
    supervisorLaunchAgent,
  }
}

function plist(
  label: string,
  entrypoint: string,
  environment: Readonly<Record<string, string>>,
): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key><array><string>/host</string><string>${entrypoint}</string></array>
  <key>EnvironmentVariables</key>
  <dict>
${Object.entries(environment).map(([key, value]) =>
    `    <key>${key}</key><string>${value}</string>`).join('\n')}
  </dict>
</dict>
</plist>
`
}

function gatewayStatus(gatewayNodeId: string): GatewayAdminStatus {
  return {
    version: 1,
    gatewayId: 'workspace-1',
    workspaceId: 'workspace-1',
    gatewayNodeId,
    gatewayShortId: 'ABC12345',
    gatewayName: 'Gateway',
    state: 'running',
    pid: 1,
    startedAt: 1,
    activeDeviceCount: 1,
    openInvitationCount: 0,
    activeTurns: 0,
    activeCommands: 0,
    unfinishedCommands: 0,
    matrixReady: true,
    lastMatrixSyncAt: Date.now(),
  }
}
