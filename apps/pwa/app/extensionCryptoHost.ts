import { extensionCryptoBridgeRequestSchema, type ExtensionCryptoResult } from '@malink/protocol'
import type { ExtensionCryptoClient } from '@malink/security'

/** One instance per frame load: identity comes from the resolved installed descriptor. */
export function createExtensionCryptoHost(options: {
  enabled: boolean;
  connect(): Promise<ExtensionCryptoClient>;
  reply(value: unknown): void;
}) {
  let closed = false;
  let handle: Promise<ExtensionCryptoClient> | undefined;
  let inflight = 0;
  const seen = new Set<string>();
  let refreshAt = 0;
  return {
    async receive(value: unknown): Promise<boolean> {
      const parsed = extensionCryptoBridgeRequestSchema.safeParse(value);
      if (!parsed.success) return false;
      const { requestId, request } = parsed.data;
      const respond = (result: { result: ExtensionCryptoResult } | { error: string }) => {
        if (!closed) options.reply({ protocol: 'io.malink.client-integration', version: 1,
          type: 'crypto.result', requestId, ...result });
      };
      if (closed) return true;
      if (!options.enabled) { respond({ error: 'denied' }); return true; }
      if (seen.size >= 4096) { respond({ error: 'unavailable' }); return true; }
      if (inflight >= 16 || seen.has(requestId)) { respond({ error: 'invalid_request' }); return true; }
      seen.add(requestId);
      inflight++;
      try {
        if (handle && Date.now() >= refreshAt) {
          void handle.then(crypto => crypto.close(), () => undefined);
          handle = undefined;
        }
        if (!handle) {
          refreshAt = Date.now() + 4 * 60_000;
          handle = options.connect().catch(error => { handle = undefined; throw error; });
        }
        const crypto = await handle;
        if (closed) { crypto.close(); return true; }
        const result = request.type === 'crypto.connect' ? crypto.identity
          : request.type === 'crypto.encrypt' ? await crypto.encrypt(request.plaintext)
          : await crypto.decrypt(request.ciphertext);
        respond({ result });
      } catch {
        respond({ error: 'crypto_failed' });
      } finally { inflight--; }
      return true;
    },
    close() {
      closed = true;
      void handle?.then(crypto => crypto.close(), () => undefined);
      handle = undefined;
      seen.clear();
    },
  };
}
