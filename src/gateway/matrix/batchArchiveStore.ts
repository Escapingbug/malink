import { mkdir, open, readFile, rename } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { batchArchiveProgressSchema, type BatchArchiveProgress } from '@malink/protocol'

/** One immutable command owns each checkpoint; updates are fsynced before publication. */
export class BatchArchiveStore {
  private chain: Promise<unknown> = Promise.resolve()
  constructor(private readonly root: string) {}
  private path(key: string) { return join(this.root, `${createHash('sha256').update(key).digest('hex')}.json`) }
  async read(key: string): Promise<BatchArchiveProgress | undefined> {
    try { return batchArchiveProgressSchema.parse(JSON.parse(await readFile(this.path(key), 'utf8'))) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
  }
  write(key: string, value: BatchArchiveProgress, previousRevision: number): Promise<void> {
    const task = this.chain.then(async () => {
      const current = await this.read(key)
      if ((current?.revision ?? 0) !== previousRevision) throw new Error('Archive batch checkpoint revision conflict')
      batchArchiveProgressSchema.parse(value)
      await mkdir(this.root, { recursive: true, mode: 0o700 })
      const temporary = `${this.path(key)}.${randomUUID()}.tmp`
      const file = await open(temporary, 'wx', 0o600)
      try { await file.writeFile(JSON.stringify(value)); await file.sync() } finally { await file.close() }
      await rename(temporary, this.path(key))
      const directory = await open(this.root, 'r')
      try { await directory.sync() } finally { await directory.close() }
    })
    this.chain = task.catch(() => undefined)
    return task
  }
}
