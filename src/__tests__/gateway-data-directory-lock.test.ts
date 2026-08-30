import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { acquireGatewayDataDirectoryLock } from '@/gateway/matrix/gatewayDataDirectoryLock'

describe('Gateway data-directory lock', () => {
  it('prevents a second live Gateway from sharing production state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'malink-gateway-lock-'))
    try {
      const first = await acquireGatewayDataDirectoryLock(root, {
        pid: 101,
        token: () => 'first-owner',
        now: () => 1,
        isProcessAlive: pid => pid === 101,
      })
      await expect(acquireGatewayDataDirectoryLock(root, {
        pid: 202,
        token: () => 'second-owner',
        now: () => 2,
        isProcessAlive: pid => pid === 101,
      })).rejects.toThrow(/Another Malink Gateway process \(101\)/u)
      await first.release()
      await expect(readFile(join(root, 'gateway-instance.lock'), 'utf8'))
        .rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('quarantines a stale owner and lets the next Gateway acquire the lock', async () => {
    const root = await mkdtemp(join(tmpdir(), 'malink-gateway-lock-'))
    try {
      await writeFile(join(root, 'gateway-instance.lock'), JSON.stringify({
        version: 1,
        pid: 101,
        token: 'stale-owner',
        acquiredAt: 1,
      }))
      const lock = await acquireGatewayDataDirectoryLock(root, {
        pid: 202,
        token: () => 'replacement-owner',
        now: () => 2,
        isProcessAlive: () => false,
      })
      await expect(readFile(lock.path, 'utf8')).resolves.toContain('replacement-owner')
      await lock.release()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('does not remove a lock that was replaced by another owner', async () => {
    const root = await mkdtemp(join(tmpdir(), 'malink-gateway-lock-'))
    try {
      const first = await acquireGatewayDataDirectoryLock(root, {
        pid: 101,
        token: () => 'first-owner',
        isProcessAlive: () => false,
      })
      await writeFile(first.path, JSON.stringify({
        version: 1,
        pid: 202,
        token: 'replacement-owner',
        acquiredAt: 2,
      }))
      await first.release()
      await expect(readFile(first.path, 'utf8')).resolves.toContain('replacement-owner')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
