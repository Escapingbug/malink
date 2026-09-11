import { MessageChannel } from 'node:worker_threads'
import { describe, expect, it, vi } from 'vitest'
import { ExtensionCrypto, generateExtensionCryptoKeyRing, connectExtensionCrypto } from '@malink/security'
import { createExtensionCryptoHost } from './extensionCryptoHost'
const request = (id: string, request: unknown) => ({ protocol: 'io.malink.client-integration', version: 1, requestId: id, request })
describe('extension crypto frame bridge', () => {
  it('runs the public SDK over a real MessageChannel and renews expired host handles', async () => {
    const crypto = new ExtensionCrypto(generateExtensionCryptoKeyRing('a'), 'a')
    const ports = new MessageChannel()
    const close = vi.fn()
    const connect = vi.fn(async () => ({ identity: crypto.identity, encrypt: crypto.encrypt.bind(crypto), decrypt: crypto.decrypt.bind(crypto), close }))
    const host = createExtensionCryptoHost({ enabled: true, connect, reply: value => ports.port1.postMessage(value) })
    ports.port1.on('message', value => { void host.receive(value) })
    const client = await connectExtensionCrypto(ports.port2 as unknown as MessagePort)
    try {
      expect(client.identity.extensionId).toBe('a')
      const ciphertext = await client.encrypt('SDK 加密')
      expect(await client.decrypt(ciphertext)).toBe('SDK 加密')
      expect(await client.decrypt(await client.encrypt(''))).toBe('')
      const now = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 4 * 60_000 + 1)
      try { await client.encrypt('renewed') } finally { now.mockRestore() }
      expect(connect).toHaveBeenCalledTimes(2)
      expect(close).toHaveBeenCalled()
    } finally { client.close(); host.close(); ports.port1.close(); ports.port2.close() }
  })

  it('binds requests to its handle and refuses injected extension IDs, duplicates and cross-extension ciphertext', async () => {
    const crypto = new ExtensionCrypto(generateExtensionCryptoKeyRing('a'), 'a')
    const reply = vi.fn()
    const close = vi.fn()
    const connect = vi.fn(async () => ({ identity: crypto.identity, encrypt: crypto.encrypt.bind(crypto), decrypt: crypto.decrypt.bind(crypto), close }))
    const host = createExtensionCryptoHost({ enabled: true, connect, reply })
    expect(await host.receive(request('bad', { type: 'crypto.connect', extensionId: 'b' }))).toBe(false)
    await host.receive(request('connect', { type: 'crypto.connect' }))
    expect(reply.mock.lastCall?.[0].result.extensionId).toBe('a')
    await host.receive(request('connect', { type: 'crypto.connect' }))
    expect(reply.mock.lastCall?.[0].error).toBe('invalid_request')
    const foreign = await new ExtensionCrypto(generateExtensionCryptoKeyRing('b'), 'b').encrypt('secret')
    await host.receive(request('decrypt', { type: 'crypto.decrypt', ciphertext: foreign }))
    expect(reply.mock.lastCall?.[0].error).toBe('crypto_failed')
    host.close()
    const count = reply.mock.calls.length
    await host.receive(request('after-close', { type: 'crypto.connect' }))
    expect(reply).toHaveBeenCalledTimes(count)
  })
  it('requires explicit capability and discards results after frame close', async () => {
    const reply = vi.fn()
    const connect = vi.fn()
    const denied = createExtensionCryptoHost({ enabled: false, connect, reply })
    await denied.receive(request('1', { type: 'crypto.connect' }))
    expect(connect).not.toHaveBeenCalled()
    expect(reply.mock.lastCall?.[0].error).toBe('denied')
    const crypto = new ExtensionCrypto(generateExtensionCryptoKeyRing('a'), 'a')
    const close = vi.fn()
    let resolve!: (value: any) => void
    const host = createExtensionCryptoHost({ enabled: true, reply, connect: () => new Promise(r => { resolve = r }) })
    const work = host.receive(request('2', { type: 'crypto.connect' }))
    host.close()
    resolve({ identity: crypto.identity, close })
    await work
    expect(close).toHaveBeenCalled()
    expect(reply).toHaveBeenCalledTimes(1)
  })
})
