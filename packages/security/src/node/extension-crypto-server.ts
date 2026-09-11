import { timingSafeEqual } from 'node:crypto'
import { extensionCryptoKeyRingSchema } from '@malink/protocol'
import { ExtensionCrypto } from '../extension-crypto.js'

/** Mount on the same loopback-only authenticated server as the extension hooks. */
export class ExtensionCryptoServer {
  #crypto?: ExtensionCrypto
  #lastRing?: string
  constructor(private readonly extensionId: string, private readonly bearerToken: string) {
    if (Buffer.byteLength(bearerToken) < 32) throw new Error('Extension bearer token is too short')
  }
  get crypto(): ExtensionCrypto {
    if (!this.#crypto) throw new Error('Malink has not provisioned extension encryption')
    return this.#crypto
  }
  async provision(request: Request): Promise<Response> {
    const received = Buffer.from(request.headers.get('authorization') ?? '')
    const expected = Buffer.from(`Bearer ${this.bearerToken}`)
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) return new Response(null, { status: 401 })
    if (request.method !== 'POST' || new URL(request.url).pathname !== '/v1/crypto/configure') return new Response(null, { status: 404 })
    if (!request.body) return new Response(null, { status: 400 })
    const reader = request.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      while (true) {
        const part = await reader.read()
        if (part.done) break
        size += part.value.length
        if (size > 32 * 1024) { await reader.cancel(); return new Response(null, { status: 413 }) }
        chunks.push(part.value)
      }
      const ring = extensionCryptoKeyRingSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      const next = new ExtensionCrypto(ring, this.extensionId)
      const serialized = JSON.stringify(ring)
      if (this.#crypto && (next.identity.cryptoDomainId !== this.#crypto.identity.cryptoDomainId
        || next.identity.keyEpoch < this.#crypto.identity.keyEpoch
        || (next.identity.keyEpoch === this.#crypto.identity.keyEpoch && serialized !== this.#lastRing))) {
        throw new Error('Extension crypto identity changed or rolled back')
      }
      this.#crypto = next
      this.#lastRing = serialized
      return Response.json({ configured: true, ...next.identity })
    } catch {
      return Response.json({ error: 'Invalid extension crypto provisioning' }, { status: 400 })
    } finally { reader.releaseLock() }
  }
}
