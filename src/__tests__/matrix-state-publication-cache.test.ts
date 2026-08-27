import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FileMatrixStatePublicationCache } from '@/gateway/matrix/fileMatrixStatePublicationCache'

describe('FileMatrixStatePublicationCache', () => {
  it('persists exact semantic acknowledgements across Gateway restart', async () => {
    const path = join(
      await mkdtemp(join(tmpdir(), 'malink-state-publication-cache-')),
      'cache.json',
    )
    const content = { kind: 'signed-document', revision: 4, nested: { enabled: true } }
    const first = new FileMatrixStatePublicationCache(path)

    await expect(first.isPublished(
      '!project:example.org', 'io.malink.workspace.test', 'workspace-1', content,
    )).resolves.toBe(false)
    await first.markPublished(
      '!project:example.org', 'io.malink.workspace.test', 'workspace-1', content,
    )

    const restarted = new FileMatrixStatePublicationCache(path)
    await expect(restarted.isPublished(
      '!project:example.org', 'io.malink.workspace.test', 'workspace-1', {
        nested: { enabled: true }, revision: 4, kind: 'signed-document',
      },
    )).resolves.toBe(true)
    await expect(restarted.isPublished(
      '!project:example.org', 'io.malink.workspace.test', 'workspace-1', {
        ...content, revision: 5,
      },
    )).resolves.toBe(false)
    await expect(restarted.isPublished(
      '!another:example.org', 'io.malink.workspace.test', 'workspace-1', content,
    )).resolves.toBe(false)
  })
})
