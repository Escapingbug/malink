import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({
    test: {
        // This suite verifies Malink transport/runtime integration only.
        // Extension implementations live and test in their owning projects;
        // they must never enter this suite through a broad file glob.
        include: [
            'e2e/device-onboarding-first-command.test.ts',
            'e2e/native-login-token-bridge.test.ts',
            'e2e/native-offline-history-reconnect.test.ts',
            'e2e/native-session-lifecycle-conflict.test.ts',
        ],
        testTimeout: 60_000,
        hookTimeout: 60_000,
        globals: true,
        sequence: { concurrent: false },
    },
    resolve: {
        alias: {
            '@': resolve(__dirname, 'src'),
            '@malink/native-bridge': resolve(__dirname, 'packages/native-bridge/src/index.ts'),
        },
    },
})
