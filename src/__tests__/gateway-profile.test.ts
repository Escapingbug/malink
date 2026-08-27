import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  FileGatewayNodeProfileStore,
  gatewayNodeShortId,
} from '@/gateway/pairing'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory =>
    rm(directory, { recursive: true, force: true })))
})

describe('Gateway node profile', () => {
  it('persists the first name and updates it atomically', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'malink-gateway-profile-'))
    temporaryDirectories.push(directory)
    const path = join(directory, 'profile.json')
    const store = new FileGatewayNodeProfileStore(path, 'gateway-node-12345678')

    await expect(store.loadOrCreate(' office-mac ', 100)).resolves.toEqual({
      version: 1,
      gatewayNodeId: 'gateway-node-12345678',
      gatewayName: 'office-mac',
      computerName: 'office-mac',
      createdAt: 100,
      updatedAt: 100,
    })
    await expect(store.loadOrCreate('ignored-default', 200)).resolves.toMatchObject({
      gatewayName: 'office-mac',
      createdAt: 100,
      updatedAt: 100,
    })
    await expect(store.rename('Office Mac mini', 300)).resolves.toMatchObject({
      gatewayName: 'Office Mac mini',
      computerName: 'office-mac',
      createdAt: 100,
      updatedAt: 300,
    })
    await expect(store.updateComputerName('Alice-MacBook', 400)).resolves.toMatchObject({
      gatewayName: 'Office Mac mini',
      computerName: 'Alice-MacBook',
      updatedAt: 400,
    })
    await expect(store.rename('Clock rollback', 50)).rejects.toThrow(
      'cannot precede its creation',
    )
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({
      gatewayNodeId: 'gateway-node-12345678',
      gatewayName: 'Office Mac mini',
      computerName: 'Alice-MacBook',
    })
  })

  it('rejects invalid names and creates a stable short node ID', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'malink-gateway-profile-'))
    temporaryDirectories.push(directory)
    const store = new FileGatewayNodeProfileStore(
      join(directory, 'profile.json'),
      'c7134bb0-32ee-4861-89cc-b5b6bfab2910',
    )

    expect(() => store.loadOrCreate('   ')).toThrow('Gateway name')
    expect(gatewayNodeShortId('c7134bb0-32ee-4861-89cc-b5b6bfab2910')).toBe('BFAB2910')
  })

  it('upgrades profiles created before computer names were recorded', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'malink-gateway-profile-legacy-'))
    temporaryDirectories.push(directory)
    const path = join(directory, 'profile.json')
    await writeFile(path, JSON.stringify({
      version: 1,
      gatewayNodeId: 'gateway-node-legacy',
      gatewayName: 'Studio Gateway',
      createdAt: 100,
      updatedAt: 100,
    }))
    const store = new FileGatewayNodeProfileStore(path, 'gateway-node-legacy')

    await expect(store.loadOrCreate('ignored-default', 200)).resolves.toMatchObject({
      gatewayName: 'Studio Gateway',
      computerName: 'Studio Gateway',
    })
    await expect(store.updateComputerName('studio-mac', 300)).resolves.toMatchObject({
      gatewayName: 'Studio Gateway',
      computerName: 'studio-mac',
      updatedAt: 300,
    })
  })
})
