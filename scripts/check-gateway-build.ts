import { resolve } from 'node:path'
import { validateGatewayBundleImports } from '../src/ops/macosGatewayRelease.js'

await validateGatewayBundleImports(resolve('dist'), resolve('.'), true)
process.stdout.write('Verified production Gateway bundle imports.\n')
