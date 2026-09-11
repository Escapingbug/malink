import {
  extensionCryptoBridgeResponseSchema, extensionCryptoIdentitySchema, extensionCiphertextSchema, extensionCryptoRequestSchema, type ExtensionCiphertext, type ExtensionCryptoIdentity,
  type ExtensionCryptoRequest, type ExtensionCryptoResult,
} from '@malink/protocol'

export interface ExtensionCryptoClient {
  readonly identity: ExtensionCryptoIdentity
  encrypt(plaintext: string): Promise<ExtensionCiphertext>
  decrypt(ciphertext: ExtensionCiphertext): Promise<string>
  close(): void
}

/** Use the dedicated port received in a host-origin-validated launch message. */
export async function connectExtensionCrypto(port: MessagePort): Promise<ExtensionCryptoClient> {
  const pending = new Map<string, { resolve(value: ExtensionCryptoResult): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>()
  let closed = false
  const receive = (event: MessageEvent) => {
    const parsed = extensionCryptoBridgeResponseSchema.safeParse(event.data)
    if (!parsed.success) return
    const response = parsed.data
    const waiter = pending.get(response.requestId)
    if (!waiter) return
    pending.delete(response.requestId)
    clearTimeout(waiter.timer)
    if (response.error) waiter.reject(new Error(`Malink extension crypto: ${response.error}`))
    else waiter.resolve(response.result!)
  }
  port.addEventListener('message', receive)
  port.start()
  const close = () => {
    closed = true
    port.removeEventListener('message', receive)
    for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(new Error('Extension crypto closed')) }
    pending.clear()
  }
  function request(request: ExtensionCryptoRequest): Promise<ExtensionCryptoResult> {
    request = extensionCryptoRequestSchema.parse(request)
    if (closed) return Promise.reject(new Error('Extension crypto closed'))
    if (pending.size >= 16) return Promise.reject(new Error('Too many extension crypto requests'))
    return new Promise((resolve, reject) => {
      const requestId = crypto.randomUUID()
      const timer = setTimeout(() => { pending.delete(requestId); reject(new Error('Extension crypto request timed out')) }, 60_000)
      pending.set(requestId, { resolve, reject, timer })
      try { port.postMessage({ protocol: 'io.malink.client-integration', version: 1, requestId, request }) }
      catch (error) { pending.delete(requestId); clearTimeout(timer); reject(error) }
    })
  }
  try {
    const identity = extensionCryptoIdentitySchema.parse(await request({ type: 'crypto.connect' }))
    return { identity,
      encrypt: async plaintext => extensionCiphertextSchema.parse(await request({ type: 'crypto.encrypt', plaintext })),
      decrypt: async ciphertext => {
        const value = await request({ type: 'crypto.decrypt', ciphertext })
        if (typeof value !== 'string') throw new Error('Invalid extension plaintext response')
        return value
      },
      close,
    }
  } catch (error) { close(); throw error }
}
