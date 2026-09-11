import { AtomicJsonFile } from '@malink/security/node'
import { base64UrlEncode, generateExtensionCryptoKeyRing, sealExtensionCryptoGrant } from '@malink/security'
import { extensionCryptoKeyRingSchema, type ExtensionCryptoKeyRing, type ExtensionCryptoGrantRequest } from '@malink/protocol'
import type { SessionExtensionRegistry } from '../../runtime/sessionExtensions.js'
import type { MatrixGatewayTrustedDevice } from '../matrix/config.js'

interface State { version: 1; extensions: Record<string, { ring: ExtensionCryptoKeyRing; recipients: string[] }> }

/** This store is extension-scoped, never keyed by project, room or Workspace. */
export class ExtensionCryptoService {
  private readonly file: AtomicJsonFile<State>
  constructor(path: string, private readonly registry: SessionExtensionRegistry,
    private readonly devices: () => Promise<readonly MatrixGatewayTrustedDevice[]>,
    private readonly now: () => number = Date.now) {
    this.file = new AtomicJsonFile(path, { fileMode: 0o600, directoryMode: 0o700 })
  }
  async initialize(): Promise<void> {
    for (const descriptor of this.registry.descriptors()) {
      if (descriptor.clientIntegration?.capabilities.includes('host.crypto')) {
        this.registry.setCryptoResolver(descriptor.id, () => this.keyRing(descriptor.id))
        await this.registry.configureCrypto(descriptor.id, await this.keyRing(descriptor.id))
      }
    }
  }
  async grant(request: ExtensionCryptoGrantRequest, deviceId: string, certificateId: string) {
    const device = (await this.devices()).find(candidate => candidate.deviceId === deviceId)
    if (!device || device.sequenceEpoch !== certificateId || !this.allowed(device)) {
      throw new Error('Extension crypto device authorization is unavailable')
    }
    const ring = await this.keyRing(request.extensionId)
    await this.registry.configureCrypto(request.extensionId, ring)
    return sealExtensionCryptoGrant(ring, request)
  }
  private allowed(device: MatrixGatewayTrustedDevice): boolean {
    return device.certificateExpiresAt > this.now() && (!device.allowedOperations
      || device.allowedOperations.includes('device.invite')
      || device.allowedOperations.includes('extension.crypto.grant'))
  }
  private async keyRing(extensionId: string): Promise<ExtensionCryptoKeyRing> {
    if (!this.registry.descriptors().some(extension => extension.id === extensionId
      && extension.clientIntegration?.capabilities.includes('host.crypto'))) {
      throw new Error('Extension crypto is not installed or enabled')
    }
    const recipients = (await this.devices()).filter(device => this.allowed(device))
      .map(device => JSON.stringify([device.deviceId, device.sequenceEpoch, device.publicKey])).sort()
    return this.file.transaction(() => ({ version: 1, extensions: {} }), state => {
      if (state.version !== 1 || !state.extensions || Array.isArray(state.extensions)) throw new Error('Invalid extension crypto store')
      const previous = Object.hasOwn(state.extensions, extensionId) ? state.extensions[extensionId] : undefined
      let ring = previous ? extensionCryptoKeyRingSchema.parse(previous.ring) : generateExtensionCryptoKeyRing(extensionId)
      if (ring.extensionId !== extensionId) throw new Error('Extension crypto store binding mismatch')
      if (previous) {
        if (!Array.isArray(previous.recipients) || !previous.recipients.every(value => typeof value === 'string')) throw new Error('Invalid extension recipients')
        if (previous.recipients.some(recipient => !recipients.includes(recipient))) {
          const epoch = ring.activeEpoch + 1
          ring = extensionCryptoKeyRingSchema.parse({ ...ring, activeEpoch: epoch,
            keys: [...ring.keys, { epoch, key: base64UrlEncode(crypto.getRandomValues(new Uint8Array(32))) }] })
        }
      }
      Object.defineProperty(state.extensions, extensionId, { value: { ring, recipients }, enumerable: true, writable: true, configurable: true })
      return { result: ring, changed: !previous || JSON.stringify(previous) !== JSON.stringify({ ring, recipients }) }
    })
  }
}
