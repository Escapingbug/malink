import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { isGatewayAgentUpdateCliEntry } from '@/ops/gatewayAgentUpdateCli'

let temporaryDirectory: string | undefined

afterEach(async () => {
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true })
  temporaryDirectory = undefined
})

describe.skipIf(process.platform === 'win32')('Gateway Agent update CLI entry detection', () => {
  it('runs when Node invokes the bundled CLI through the current release symlink', async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'malink-gateway-cli-entry-'))
    const releaseCli = join(temporaryDirectory, 'release-cli.js')
    const currentCli = join(temporaryDirectory, 'current-cli.js')
    await writeFile(releaseCli, '// fixture\n')
    await symlink(releaseCli, currentCli)

    expect(isGatewayAgentUpdateCliEntry(pathToFileURL(releaseCli).href, currentCli)).toBe(true)
  })

  it('does not run when imported by a different entrypoint', async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'malink-gateway-cli-import-'))
    const releaseCli = join(temporaryDirectory, 'release-cli.js')
    const importer = join(temporaryDirectory, 'importer.js')
    await writeFile(releaseCli, '// fixture\n')
    await writeFile(importer, '// fixture\n')

    expect(isGatewayAgentUpdateCliEntry(pathToFileURL(releaseCli).href, importer)).toBe(false)
  })
})
