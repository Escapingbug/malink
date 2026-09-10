import { GatewayAdminClient } from '@/gateway/admin'
import { GatewayExecutionTrackProcessHost, type GatewayTrackRelease } from './gatewayExecutionTrackHost'

// Only the stable local Host can open this IPC channel. No network listener,
// Matrix login, business store, or Agent is created while waiting in standby.
if (!process.send) throw new Error('Execution worker requires the local Host IPC channel')
let host: GatewayExecutionTrackProcessHost | undefined
let release: GatewayTrackRelease | undefined
let directory = ''
let nodeId = ''
let chain = Promise.resolve()
let closing = false
process.on('message', (raw: unknown) => {
  const message = raw as { id?: number; operation?: string; release?: GatewayTrackRelease;
    dataDirectory?: string; gatewayNodeId?: string; adminSocket?: string }
  if (!Number.isSafeInteger(message.id) || closing) return
  chain = chain.then(async () => {
    try {
      if (message.operation === 'initialize') {
        if (host || !message.release || !message.dataDirectory || !message.gatewayNodeId || !message.adminSocket) throw new Error('Invalid worker initialization')
        release = message.release
        directory = message.dataDirectory
        nodeId = message.gatewayNodeId
        const admin = new GatewayAdminClient({ socketPath: message.adminSocket, timeoutMs: 5000 })
        host = new GatewayExecutionTrackProcessHost(directory, {
          resolveRelease: async id => { if (id !== release!.releaseId) throw new Error('Worker release is pinned'); return release! },
          validateCompatibility: async () => {}, // Admission is performed by the stable supervisor before IPC.
          readHealth: async () => {
            const status = await admin.status()
            return { buildId: status.buildId ?? '', gatewayNodeId: status.gatewayNodeId ?? '',
              matrixReady: status.matrixReady === true, deploymentFenced: status.deploymentFenced === true }
          },
          drain: async () => { await admin.sealForDeployment('when_idle') },
          log: message => process.stderr.write(message), timeoutMs: 30_000,
        })
        await host.ensureStandby(release.releaseId)
      } else {
        if (!host || !release) throw new Error('Worker has not been initialized')
        if (message.operation === 'activate') await host.activate(release.releaseId, directory, nodeId)
        else if (message.operation === 'release') await host.releaseExecution(release.releaseId)
        else if (message.operation === 'health') await host.verifyActive(release.releaseId, directory, nodeId)
        else throw new Error('Unknown execution worker operation')
      }
      if (process.connected) process.send!({ id: message.id, ok: true })
    } catch (error) {
      if (process.connected) process.send!({ id: message.id, error: error instanceof Error ? error.message : String(error) })
    }
  })
})
const close = () => {
  if (closing) return
  closing = true
  void (host?.controllerDisconnected() ?? Promise.resolve()).finally(() => process.exit(0))
}
process.once('disconnect', close)
process.once('SIGTERM', close)
process.once('SIGINT', close)
