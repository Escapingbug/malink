import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FileGatewayProjectCatalog } from '@/gateway/matrix/fileGatewayProjectCatalog'

describe('FileGatewayProjectCatalog', () => {
  it('retains dynamic projects across configured-root refreshes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'malink-project-catalog-'))
    const path = join(directory, 'projects.json')
    const catalog = new FileGatewayProjectCatalog(path, 'gateway-node-1')
    await catalog.initialize([{
      roomId: '!root:example.org',
      conversationId: 'root',
      cwd: '/srv/root',
      providerName: 'codex',
    }])
    await catalog.add({
      roomId: '!dynamic:example.org',
      conversationId: 'dynamic',
      projectId: 'project-dynamic',
      projectName: 'Dynamic',
      cwd: '/srv/dynamic',
      providerName: 'codex',
    })

    const restarted = new FileGatewayProjectCatalog(path, 'gateway-node-1')
    await restarted.initialize([{
      roomId: '!root:example.org',
      conversationId: 'root',
      cwd: '/srv/root-renamed',
      providerName: 'codex',
    }])

    expect(await restarted.list()).toEqual(expect.arrayContaining([
      expect.objectContaining({ roomId: '!root:example.org', cwd: '/srv/root-renamed' }),
      expect.objectContaining({ roomId: '!dynamic:example.org', projectId: 'project-dynamic' }),
    ]))
    expect(await restarted.findByProjectId('project-dynamic')).toMatchObject({
      projectName: 'Dynamic',
    })
  })

  it('rejects conflicting routes for an existing project identity', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'malink-project-catalog-conflict-'))
    const catalog = new FileGatewayProjectCatalog(
      join(directory, 'projects.json'),
      'gateway-node-1',
    )
    await catalog.initialize([])
    await catalog.add({
      roomId: '!first:example.org',
      conversationId: 'first',
      projectId: 'project-1',
      cwd: '/srv/first',
      providerName: 'codex',
    })
    await expect(catalog.add({
      roomId: '!second:example.org',
      conversationId: 'second',
      projectId: 'project-1',
      cwd: '/srv/second',
      providerName: 'codex',
    })).rejects.toThrow(/conflicts/u)
  })
})
