import {
    MatrixMlp3GatewayRunner,
    type MatrixGatewayConfig,
    type MatrixMlp3GatewayDependencies,
} from '@/gateway/matrix'

/**
 * Programmatic Matrix daemon entry. Credentials and trusted device keys are
 * deliberately supplied as a configuration object by the desktop installer or
 * service host; this module never falls back to ambient Telegram config.
 */
export async function startMatrixDaemon(
    config: MatrixGatewayConfig,
    dependencies: MatrixMlp3GatewayDependencies = {},
): Promise<MatrixMlp3GatewayRunner> {
    const runner = new MatrixMlp3GatewayRunner(config, dependencies)
    await runner.start()
    return runner
}
