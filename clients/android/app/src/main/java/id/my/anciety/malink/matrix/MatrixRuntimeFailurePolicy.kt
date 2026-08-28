package id.my.anciety.malink.matrix

import kotlin.random.Random
import org.matrix.rustcomponents.sdk.InternalException

internal data class MatrixRuntimeFailureDecision(
    val detailCode: String,
    val blocked: Boolean,
)

internal class MatrixSyncServiceBuildException(cause: Throwable) :
    IllegalStateException("The Matrix sync service configuration is invalid.", cause)

internal object MatrixRuntimeFailurePolicy {
    fun decide(error: Throwable): MatrixRuntimeFailureDecision = when (error) {
        is MatrixSyncServiceBuildException -> MatrixRuntimeFailureDecision(
            detailCode = "matrix_sync_service_build_failed",
            blocked = true,
        )
        is InternalException -> MatrixRuntimeFailureDecision(
            detailCode = "matrix_sdk_internal_failure",
            blocked = true,
        )
        else -> MatrixRuntimeFailureDecision(
            detailCode = "matrix_runtime_failed",
            blocked = false,
        )
    }
}

internal object MatrixSyncRestartPolicy {
    fun decide(reason: MatrixSyncRestartReason): MatrixRuntimeFailureDecision =
        MatrixRuntimeFailureDecision(reason.detailCode, blocked = false)
}

/**
 * Bounded exponential retry delays keep an unavailable homeserver from turning
 * a persistent Android connection into a tight radio/CPU wakeup loop. Network
 * callbacks and explicit system-wake recovery still bypass this delay.
 */
internal object MatrixRetryBackoff {
    fun transportDelayMs(
        completedFailures: Int,
        jitterUnit: Double = Random.nextDouble(),
    ): Long = jitteredDelay(
        baseDelayMs(
            completedFailures,
            initialMs = 5_000L,
            maximumBaseMs = 240_000L,
        ),
        jitterUnit,
    )

    fun requestDelayMs(
        completedFailures: Int,
        jitterUnit: Double = Random.nextDouble(),
    ): Long = jitteredDelay(
        baseDelayMs(
            completedFailures,
            initialMs = 1_000L,
            maximumBaseMs = 48_000L,
        ),
        jitterUnit,
    )

    private fun baseDelayMs(
        completedFailures: Int,
        initialMs: Long,
        maximumBaseMs: Long,
    ): Long {
        require(completedFailures >= 0)
        var delayMs = initialMs
        repeat(completedFailures.coerceAtMost(30)) {
            delayMs = (delayMs * 2).coerceAtMost(maximumBaseMs)
        }
        return delayMs
    }

    private fun jitteredDelay(baseMs: Long, jitterUnit: Double): Long {
        require(jitterUnit in 0.0..1.0)
        val multiplier = 0.75 + (0.5 * jitterUnit)
        return (baseMs * multiplier).toLong().coerceAtLeast(1_000L)
    }
}
