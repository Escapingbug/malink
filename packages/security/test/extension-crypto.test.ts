import { describe, expect, it } from 'vitest'
import { ExtensionCrypto, createExtensionCryptoGrantRequest, generateExtensionCryptoKeyRing, sealExtensionCryptoGrant,
  generateMlp3ProjectKey, sealMlp3Envelope, generateDeviceKeyPair, signMlp3Command } from '../src/index.js'
import { ExtensionCryptoServer } from '../src/node/extension-crypto-server.js'
import type { Mlp3Command } from '@malink/protocol'

const corrupt = (s: string) => (s[0] === 'A' ? 'B' : 'A') + s.slice(1)

describe('extension E2EE', () => {
  it('round-trips Unicode and empty data between independent extension endpoints without exposing keys', async () => {
    const ring = generateExtensionCryptoKeyRing('alpha')
    const server = new ExtensionCrypto(ring, 'alpha')
    const pending = await createExtensionCryptoGrantRequest('alpha')
    const grant = await sealExtensionCryptoGrant(ring, pending.request)
    expect(JSON.stringify(grant)).not.toContain(ring.keys[0].key)
    const client = await pending.accept(grant)
    expect(client.identity).toEqual(server.identity)
    expect(JSON.stringify(client)).not.toContain(ring.keys[0].key)
    for (const plaintext of ['', '扩展加密 🔐\nhello']) {
      await expect(client.decrypt(await server.encrypt(plaintext))).resolves.toBe(plaintext)
      await expect(server.decrypt(await client.encrypt(plaintext))).resolves.toBe(plaintext)
    }
    await expect(pending.accept(grant)).rejects.toThrow('consumed')
  })
  it('rejects other extension/domain, tampering, unknown epoch and oversized UTF-8', async () => {
    const ring = generateExtensionCryptoKeyRing('alpha')
    const alpha = new ExtensionCrypto(ring, 'alpha')
    const beta = new ExtensionCrypto(generateExtensionCryptoKeyRing('beta'), 'beta')
    const other = new ExtensionCrypto(generateExtensionCryptoKeyRing('alpha'), 'alpha')
    const data = await alpha.encrypt('sensitive')
    await expect(beta.decrypt(data)).rejects.toThrow()
    await expect(other.decrypt(data)).rejects.toThrow()
    for (const modified of [{ ...data, ciphertext: corrupt(data.ciphertext) }, { ...data, nonce: corrupt(data.nonce) },
      { ...data, keyEpoch: 2 }, { ...data, version: 2 }, { ...data, kind: 'malink.project-envelope' }]) {
      await expect(alpha.decrypt(modified)).rejects.toThrow()
    }
    await expect(alpha.encrypt('密'.repeat(50_000))).rejects.toThrow('too large')
  })
  it('cannot decrypt a Malink main-data envelope', async () => {
    const device = await generateDeviceKeyPair()
    const command: Mlp3Command = { kind: 'malink.command', version: 3, workspaceId: 'w', projectId: 'p',
      deviceId: 'd', certificateId: 'c', commandId: 'cmd', createdAt: 1, operation: 'project.delete', payload: { operation: 'project.delete' } }
    const envelope = await sealMlp3Envelope({ plaintext: { kind: 'signed_command', value: await signMlp3Command(command, device.privateKey, device.keyId) },
      projectKey: generateMlp3ProjectKey(), roomId: '!room', projectId: 'p', keyId: 'key', logicalEventId: 'cmd' })
    await expect(new ExtensionCrypto(generateExtensionCryptoKeyRing('alpha'), 'alpha').decrypt(envelope)).rejects.toThrow()
  })
  it('binds grants to the extension, request and ephemeral recipient', async () => {
    const ring = generateExtensionCryptoKeyRing('alpha')
    const first = await createExtensionCryptoGrantRequest('alpha')
    const second = await createExtensionCryptoGrantRequest('alpha')
    const grant = await sealExtensionCryptoGrant(ring, first.request)
    await expect(second.accept(grant)).rejects.toThrow()
    await expect(second.accept({ ...grant, requestId: second.request.requestId })).rejects.toThrow()
    await expect(first.accept({ ...grant, extensionId: 'beta' })).rejects.toThrow()
    await expect(first.accept({ ...grant, ciphertext: corrupt(grant.ciphertext) })).rejects.toThrow()
    await expect(sealExtensionCryptoGrant(ring, { ...first.request, extensionId: 'beta' })).rejects.toThrow()
  })
  it('authenticates local provisioning and refuses rollback or another extension identity', async () => {
    const token = 'x'.repeat(32)
    const server = new ExtensionCryptoServer('alpha', token)
    const ring = generateExtensionCryptoKeyRing('alpha')
    const request = (body: unknown, auth = token) => new Request('http://127.0.0.1/v1/crypto/configure', {
      method: 'POST', headers: { authorization: `Bearer ${auth}` }, body: JSON.stringify(body),
    })
    expect(() => server.crypto).toThrow()
    expect((await server.provision(request(ring, 'wrong'))).status).toBe(401)
    expect((await server.provision(request(ring))).status).toBe(200)
    expect((await server.provision(request(generateExtensionCryptoKeyRing('beta')))).status).toBe(400)
    expect((await server.provision(request(generateExtensionCryptoKeyRing('alpha')))).status).toBe(400)
    const key = generateExtensionCryptoKeyRing('alpha').keys[0].key
    const rotated = { ...ring, activeEpoch: 2, keys: [...ring.keys, { epoch: 2, key }] }
    expect((await server.provision(request(rotated))).status).toBe(200)
    expect((await server.provision(request(ring))).status).toBe(400)
    await expect(server.crypto.decrypt(await new ExtensionCrypto(ring, 'alpha').encrypt('old'))).resolves.toBe('old')
  })
})
