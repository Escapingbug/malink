import { defineConfig } from 'tsup'
import path from 'path'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    daemon: 'src/daemon.ts',
    'matrix-daemon': 'src/matrix-daemon.ts',
    'mcp/stdio': 'src/mcp/stdio.ts',
    'privilege/helperMain': 'src/privilege/helperMain.ts',
    'ops/gatewayUpdateSupervisorMain': 'src/ops/gatewayUpdateSupervisorMain.ts',
    'ops/gatewayAgentUpdateCli': 'src/ops/gatewayAgentUpdateCli.ts',
    'ops/macosGatewayHostDoctor': 'scripts/macos-gateway-host-doctor.ts',
    'ops/matrix-local-gateway': 'scripts/matrix-local-gateway.ts',
  },
  format: ['esm'],
  outDir: 'dist',
  splitting: false,
  sourcemap: true,
  clean: true,
  noExternal: [
    '@malink/protocol',
    '@malink/security',
    'zod',
  ],
  esbuildOptions(options) {
    options.alias = {
      '@': path.resolve('./src')
    }
  }
})
