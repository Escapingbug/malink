import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { acquireGatewayDataDirectoryLock } from '../../gateway/matrix/gatewayDataDirectoryLock'

const root = process.env.MALINK_MATRIX_DATA_DIR!
const lock = await acquireGatewayDataDirectoryLock(root)
const business = JSON.parse(await readFile(join(root, 'business.json'), 'utf8'))
business.starts.push(process.env.MALINK_GATEWAY_BUILD_ID)
await writeFile(join(root, 'business.json'), JSON.stringify(business))
await writeFile(join(root, 'health.json'), JSON.stringify({
  buildId: process.env.MALINK_GATEWAY_BUILD_ID, gatewayNodeId: 'stable-node',
  matrixReady: true, deploymentFenced: false,
}))
const timer = setInterval(() => {}, 1000)
const server = process.env.MALINK_GATEWAY_ADMIN_SOCKET ? createServer(async (_request, response) => {
  if (_request.url === '/v1/deployment/seal' && process.env.TEST_SEAL_DELAY_MS) {
    await new Promise(resolve => setTimeout(resolve, Number(process.env.TEST_SEAL_DELAY_MS)))
  }
  response.setHeader('content-type', 'application/json')
  response.end(await readFile(join(root, 'health.json'), 'utf8'))
}) : undefined
if (server) await new Promise<void>(resolve => server.listen(process.env.MALINK_GATEWAY_ADMIN_SOCKET, resolve))
process.once('SIGTERM', () => {
  server?.close()
  void lock.release().then(() => { clearInterval(timer); process.exit(0) })
})
