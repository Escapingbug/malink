import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
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
process.once('SIGTERM', () => {
  void lock.release().then(() => { clearInterval(timer); process.exit(0) })
})
