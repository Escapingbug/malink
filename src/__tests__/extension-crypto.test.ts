import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ExtensionCrypto, createExtensionCryptoGrantRequest, generateDeviceKeyPair, exportDeviceKeyPair } from '@malink/security'
import { ExtensionCryptoService } from '../gateway/extensions/crypto.js'
import { SessionExtensionRegistry, type SessionExtensionProvider } from '../runtime/sessionExtensions.js'
import type { MatrixGatewayTrustedDevice } from '../gateway/matrix/config.js'
import type { ExtensionCryptoKeyRing } from '@malink/protocol'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true }))) })
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'malink-extension-'))
  directories.push(dir)
  const key = await exportDeviceKeyPair(await generateDeviceKeyPair())
  const device: MatrixGatewayTrustedDevice = { deviceId: 'device1', deviceName: 'one', matrixDeviceId: 'mx1', matrixUserId: '@one:test', matrixDeviceKeys: [],
    publicKey: key.publicKey, allowedRoomIds: ['!one', '!two'], allowedOperations: ['device.invite'], certificateExpiresAt: 10_000, sequenceEpoch: 'cert1' }
  let devices = [device, { ...device, deviceId: 'device2', sequenceEpoch: 'cert2' }]
  const rings = new Map<string, ExtensionCryptoKeyRing>()
  const resolvers = new Map<string, () => Promise<ExtensionCryptoKeyRing>>()
  const providers = ['alpha', 'beta'].map(id => ({
    descriptor: { id, name: id, description: id, version: '1', settings: [], clientIntegration: {
      origin: `https://${id}.example`, bridgeVersion: 1, routes: [{ id: 'main', path: '/' }], capabilities: ['host.crypto'],
    } },
    configureCrypto: vi.fn(async (ring: ExtensionCryptoKeyRing) => { rings.set(id, ring) }),
    setCryptoResolver: (resolver: () => Promise<ExtensionCryptoKeyRing>) => { resolvers.set(id, resolver) },
    normalizeConfig: () => ({}), create: () => { throw new Error('unused') },
  } satisfies SessionExtensionProvider))
  const registry = new SessionExtensionRegistry(providers)
  const path = join(dir, 'keys.json')
  const service = new ExtensionCryptoService(path, registry, async () => devices, () => 1)
  await service.initialize()
  const connect = async (id: string, deviceId = 'device1', cert = 'cert1') => {
    const request = await createExtensionCryptoGrantRequest(id)
    return request.accept(await service.grant(request.request, deviceId, cert))
  }
  return { dir, path, registry, service, rings, providers, connect, resolvers, device, setDevices: (next: MatrixGatewayTrustedDevice[]) => { devices = next } }
}
describe('Gateway extension crypto authorization and persistence', () => {
  it('shares one domain across projects/devices, isolates extensions, and survives restart', async () => {
    const f = await fixture()
    const a = await f.connect('alpha')
    const b = await f.connect('alpha', 'device2', 'cert2')
    expect(a.identity).toEqual(b.identity)
    await expect(b.decrypt(await a.encrypt('shared'))).resolves.toBe('shared')
    const beta = await f.connect('beta')
    await expect(beta.decrypt(await a.encrypt('private'))).rejects.toThrow()
    const restarted = new ExtensionCryptoService(f.path, f.registry, async () => [f.device], () => 1)
    await restarted.initialize()
    expect(f.rings.get('alpha')?.cryptoDomainId).toBe(a.identity.cryptoDomainId)
    if (process.platform !== 'win32') expect((await stat(f.path)).mode & 0o777).toBe(0o600)
  })
  it('revokes device access, rotates future writes, retains historical readability, and rejects stale certificates', async () => {
    const f = await fixture()
    const revoked = await f.connect('alpha', 'device2', 'cert2')
    const old = await revoked.encrypt('history')
    f.setDevices([f.device])
    await expect(f.connect('alpha', 'device2', 'cert2')).rejects.toThrow('authorization')
    await expect(f.connect('alpha', 'device1', 'old-cert')).rejects.toThrow('authorization')
    const current = await f.connect('alpha')
    expect(current.identity.keyEpoch).toBe(2)
    await expect(current.decrypt(old)).resolves.toBe('history')
    await expect(revoked.decrypt(await current.encrypt('new'))).rejects.toThrow()
    const local = new ExtensionCrypto(f.rings.get('alpha')!, 'alpha')
    await expect(local.decrypt(await current.encrypt('client'))).resolves.toBe('client')
  })
  it('fails closed for uninstalled extensions and restricted or expired devices', async () => {
    const f = await fixture()
    await expect(f.connect('missing')).rejects.toThrow('not installed')
    f.setDevices([{ ...f.device, allowedOperations: ['prompt'] }])
    await expect(f.connect('alpha')).rejects.toThrow('authorization')
    f.setDevices([{ ...f.device, certificateExpiresAt: 0 }])
    await expect(f.connect('alpha')).rejects.toThrow('authorization')
  })
})
