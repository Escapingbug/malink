import { AtomicJsonFile } from '@malink/security/node'

/** Provider fork has no idempotency key. Persist intent before invoking it. */
export class SessionForkStore {
  private readonly file: AtomicJsonFile<Record<string, { providerSessionId?: string }>>
  constructor(path: string) { this.file = new AtomicJsonFile(path) }

  async forkOnce(key: string, create: () => Promise<string>): Promise<string> {
    const claim = await this.file.transaction(() => ({}), state => {
      if (Object.hasOwn(state, key)) return { result: state[key]!, changed: false }
      state[key] = {}
      return { result: null, changed: true }
    })
    if (claim) {
      if (claim.providerSessionId) return claim.providerSessionId
      throw new Error('The previous native fork result is unknown. It will not be repeated automatically. Inspect provider history before creating another branch.')
    }
    const providerSessionId = await create()
    await this.file.transaction(() => ({}), state => {
      state[key] = { providerSessionId }
      return { result: undefined, changed: true }
    })
    return providerSessionId
  }
}
