import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { SessionForkStore } from '@/gateway/matrix/sessionForkStore'

it('reuses a completed native fork after restart and never repeats an ambiguous mutation', async () => {
  const directory = await mkdtemp('/tmp/malink-fork-')
  try {
    const path = join(directory, 'forks.json')
    const create = vi.fn(async () => 'forked-provider-session')
    await expect(new SessionForkStore(path).forkOnce('command-1', create)).resolves.toBe('forked-provider-session')
    await expect(new SessionForkStore(path).forkOnce('command-1', create)).resolves.toBe('forked-provider-session')
    expect(create).toHaveBeenCalledTimes(1)
    const ambiguous = vi.fn(async (): Promise<string> => { throw new Error('response lost') })
    await expect(new SessionForkStore(path).forkOnce('command-2', ambiguous)).rejects.toThrow('response lost')
    await expect(new SessionForkStore(path).forkOnce('command-2', ambiguous)).rejects.toThrow('will not be repeated')
    expect(ambiguous).toHaveBeenCalledTimes(1)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
