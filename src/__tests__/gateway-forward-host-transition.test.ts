import { mkdtemp, mkdir, writeFile, readFile, readlink, rm, realpath, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it } from 'vitest'
import { pinForwardGatewayHost } from '@/ops/gatewayForwardHostTransition'
import { createGatewayForwardOnlyBackup, verifyGatewayForwardOnlyBackup } from '@/ops/gatewayForwardOnlyBackup'
import { bootstrapGatewayForwardUpgrade } from '@/ops/bootstrapGatewayForwardUpgrade'
import { recoverGatewayForwardUpgrade } from '@/ops/gatewayForwardRecoveryCli'

it('refuses bootstrap before any filesystem or process action without explicit risk confirmation', async () => {
  await expect(bootstrapGatewayForwardUpgrade('/not-an-installation', 'new', false)).rejects.toThrow('--allow-forward-only')
})

it('can inspect local recovery state without a running supervisor and refuses to resume a completed update', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forward-local-'))
  try {
    const state = { version: 1, gatewayNodeId: 'node', dataDirectory: join(root, 'data'), generation: 3,
      activeRelease: 'new', phase: 'steady', forwardOnly: true, backupPath: '/backup', targetWriteStarted: true }
    await writeFile(join(root, 'execution-tracks.json'), JSON.stringify(state))
    expect(await recoverGatewayForwardUpgrade(root, 'status')).toEqual(state)
    await expect(recoverGatewayForwardUpgrade(root, 'resume')).rejects.toThrow('no interrupted')
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('pins the new supervisor durably, clears incompatible fallback, and requests reload only from the old Host', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forward-host-'))
  try {
    const target = join(root, 'releases/new')
    await mkdir(join(target, 'ops'), { recursive: true })
    await writeFile(join(target, 'ops/gatewayUpdateSupervisorMain.js'), '// sealed fixture')
    await writeFile(join(root, 'execution-tracks-config.json'), JSON.stringify({ defaultRelease: 'old', previousRelease: 'older', controlProjectId: 'control' }))
    await symlink('releases/old', join(root, 'current'))
    let reloads = 0
    const input = { installRoot: root, targetRelease: 'new', targetDirectory: target,
      runningHostEntrypoint: '/old/host.js', requestReload: () => { reloads++ } }
    expect(await pinForwardGatewayHost(input)).toBe(false)
    expect(await readlink(join(root, 'current'))).toBe('releases/new')
    expect(JSON.parse(await readFile(join(root, 'execution-tracks-config.json'), 'utf8')))
      .toEqual({ defaultRelease: 'new', controlProjectId: 'control' })
    expect(await pinForwardGatewayHost({ ...input, runningHostEntrypoint: await realpath(join(target, 'ops/gatewayUpdateSupervisorMain.js')) })).toBe(true)
    expect(reloads).toBe(1)
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('detects backup corruption before an interrupted upgrade can grant its writer', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forward-verify-'))
  try {
    const data = join(root, 'data'); await mkdir(data)
    await writeFile(join(data, 'journal'), 'accepted command')
    const backup = await createGatewayForwardOnlyBackup({ dataDirectory: data, installRoot: join(root, 'install'),
      releaseId: 'new', targetBuildId: 'new-build', previousTarget: 'releases/old', createdAt: 1 })
    await verifyGatewayForwardOnlyBackup(backup)
    await writeFile(join(backup, 'gateway-data/journal'), 'corrupt')
    await expect(verifyGatewayForwardOnlyBackup(backup)).rejects.toThrow('Backup verification failed')
  } finally { await rm(root, { recursive: true, force: true }) }
})
