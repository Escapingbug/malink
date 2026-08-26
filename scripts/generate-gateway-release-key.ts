import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { pairingPublicKeySchema } from '@malink/protocol'
import { exportDeviceKeyPair, generateDeviceKeyPair } from '@malink/security'

export async function generateGatewayReleaseKey(
  privateKeyPath: string,
  publicKeyPath: string,
): Promise<void> {
  const keys = await generateDeviceKeyPair()
  const serialized = await exportDeviceKeyPair(keys)
  const signer = pairingPublicKeySchema.parse({
    version: 1,
    algorithm: 'ES256',
    keyId: serialized.keyId,
    publicKey: serialized.publicKey,
  })
  await writeExclusive(resolve(privateKeyPath), `${JSON.stringify(serialized)}\n`, 0o600)
  try {
    await writeExclusive(resolve(publicKeyPath), `${JSON.stringify(signer)}\n`, 0o644)
  } catch (error) {
    throw new Error(
      `The private release key was created at ${resolve(privateKeyPath)}, `
      + `but the public signer file could not be written: ${formatError(error)}`,
      { cause: error },
    )
  }
}

async function writeExclusive(path: string, content: string, mode: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await writeFile(path, content, { flag: 'wx', mode })
}

function requiredArgument(argv: readonly string[], name: string): string {
  const index = argv.indexOf(`--${name}`)
  const value = index >= 0 ? argv[index + 1] : undefined
  if (!value) throw new Error(`Missing --${name}`)
  return value
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await generateGatewayReleaseKey(
    requiredArgument(process.argv.slice(2), 'private-key'),
    requiredArgument(process.argv.slice(2), 'public-key'),
  )
  process.stdout.write('Gateway release signing key created. Keep the private file offline.\n')
}
