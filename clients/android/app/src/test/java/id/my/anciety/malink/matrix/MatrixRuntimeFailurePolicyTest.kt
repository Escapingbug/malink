package id.my.anciety.malink.matrix

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.matrix.rustcomponents.sdk.InternalException

class MatrixRuntimeFailurePolicyTest {
    @Test
    fun `sync service build failures are blocked instead of retried`() {
        val decision = MatrixRuntimeFailurePolicy.decide(
            MatrixSyncServiceBuildException(IllegalArgumentException("invalid connection id")),
        )

        assertTrue(decision.blocked)
        assertEquals("matrix_sync_service_build_failed", decision.detailCode)
    }

    @Test
    fun `Rust panic is blocked instead of entering a retry storm`() {
        val decision = MatrixRuntimeFailurePolicy.decide(InternalException("redacted panic"))

        assertTrue(decision.blocked)
        assertEquals("matrix_sdk_internal_failure", decision.detailCode)
    }

    @Test
    fun `ordinary runtime failures remain retryable`() {
        val decision = MatrixRuntimeFailurePolicy.decide(IllegalStateException("offline"))

        assertFalse(decision.blocked)
        assertEquals("matrix_runtime_failed", decision.detailCode)
    }

    @Test
    fun `first response timeouts remain retryable for external supervisors`() {
        val decision = MatrixSyncRestartPolicy.decide(MatrixSyncRestartReason.FIRST_SYNC_TIMEOUT)

        assertFalse(decision.blocked)
        assertEquals("matrix_first_sync_timeout", decision.detailCode)
    }

    @Test
    fun `stopped and stale tasks remain retryable`() {
        listOf(
            MatrixSyncRestartReason.TASK_STOPPED,
            MatrixSyncRestartReason.SYNC_STALE,
        ).forEach { reason ->
            assertFalse(MatrixSyncRestartPolicy.decide(reason).blocked)
        }
    }

    @Test
    fun `transport retry grows exponentially and caps before jitter`() {
        assertEquals(5_000L, MatrixRetryBackoff.transportDelayMs(0, jitterUnit = 0.5))
        assertEquals(10_000L, MatrixRetryBackoff.transportDelayMs(1, jitterUnit = 0.5))
        assertEquals(40_000L, MatrixRetryBackoff.transportDelayMs(3, jitterUnit = 0.5))
        assertEquals(240_000L, MatrixRetryBackoff.transportDelayMs(20, jitterUnit = 0.5))
    }

    @Test
    fun `request retry backs off instead of polling every few seconds forever`() {
        assertEquals(1_000L, MatrixRetryBackoff.requestDelayMs(0, jitterUnit = 0.5))
        assertEquals(8_000L, MatrixRetryBackoff.requestDelayMs(3, jitterUnit = 0.5))
        assertEquals(48_000L, MatrixRetryBackoff.requestDelayMs(20, jitterUnit = 0.5))
    }

    @Test
    fun `retry jitter stays within bounded radio friendly range`() {
        assertEquals(180_000L, MatrixRetryBackoff.transportDelayMs(20, jitterUnit = 0.0))
        assertEquals(300_000L, MatrixRetryBackoff.transportDelayMs(20, jitterUnit = 1.0))
        assertEquals(36_000L, MatrixRetryBackoff.requestDelayMs(20, jitterUnit = 0.0))
        assertEquals(60_000L, MatrixRetryBackoff.requestDelayMs(20, jitterUnit = 1.0))
    }
}
