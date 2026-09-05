package id.my.anciety.malink.client

import org.junit.Assert.assertEquals
import org.junit.Test

class NativeClientPowerPolicyTest {
    @Test
    fun `pairing expiry sleeps until the deadline instead of polling every second`() {
        assertEquals(45_000L, pendingPairingExpiryDelayMs(now = 1_000L, expiresAt = 46_000L))
        assertEquals(0L, pendingPairingExpiryDelayMs(now = 46_000L, expiresAt = 46_000L))
    }

    @Test
    fun `long pairing recovery checks at most once per day`() {
        assertEquals(
            24L * 60 * 60_000,
            pendingPairingExpiryDelayMs(
                now = 1_000L,
                expiresAt = 400L * 24 * 60 * 60_000,
            ),
        )
    }

    @Test
    fun `authoritative projection recovery settles to one retry per minute`() {
        assertEquals(1_000L, authoritativeStateRefreshRetryDelayMs(1))
        assertEquals(2_000L, authoritativeStateRefreshRetryDelayMs(2))
        assertEquals(5_000L, authoritativeStateRefreshRetryDelayMs(3))
        assertEquals(10_000L, authoritativeStateRefreshRetryDelayMs(4))
        assertEquals(30_000L, authoritativeStateRefreshRetryDelayMs(5))
        assertEquals(60_000L, authoritativeStateRefreshRetryDelayMs(6))
        assertEquals(60_000L, authoritativeStateRefreshRetryDelayMs(100))
    }

    @Test
    fun `successful projection snapshot never becomes a polling loop`() {
        val partial = matrixMlp3WorkspaceProjectionProgress(
            expectedProjectIds = setOf("project-ready", "project-missing"),
            keyedProjectIds = setOf("project-ready"),
            projectedProjectIds = setOf("project-ready"),
            capabilityProjectIds = emptySet(),
        )

        assertEquals(false, shouldRetryMatrixMlp3ProjectionRefresh(true, partial))
    }

    @Test
    fun `failed projection read retries only when no signed project is usable`() {
        val cached = matrixMlp3WorkspaceProjectionProgress(
            expectedProjectIds = setOf("project-ready", "project-missing"),
            keyedProjectIds = setOf("project-ready"),
            projectedProjectIds = setOf("project-ready"),
            capabilityProjectIds = emptySet(),
        )
        val empty = matrixMlp3WorkspaceProjectionProgress(
            expectedProjectIds = setOf("project-missing"),
            keyedProjectIds = emptySet(),
            projectedProjectIds = emptySet(),
            capabilityProjectIds = emptySet(),
        )

        assertEquals(false, shouldRetryMatrixMlp3ProjectionRefresh(false, cached))
        assertEquals(true, shouldRetryMatrixMlp3ProjectionRefresh(false, empty))
    }
}
