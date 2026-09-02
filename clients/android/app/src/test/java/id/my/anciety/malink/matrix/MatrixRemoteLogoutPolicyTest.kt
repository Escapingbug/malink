package id.my.anciety.malink.matrix

import java.io.IOException
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

class MatrixRemoteLogoutPolicyTest {
    @Test
    fun `offline Matrix skips remote logout without blocking account removal`() = runBlocking {
        var called = false
        val outcome = attemptMatrixRemoteLogout(false, 100) { called = true }

        assertEquals(MatrixRemoteLogoutOutcome.SKIPPED_OFFLINE, outcome)
        assertFalse(called)
    }

    @Test
    fun `remote logout failure is a bounded best effort result`() = runBlocking {
        assertEquals(
            MatrixRemoteLogoutOutcome.FAILED,
            attemptMatrixRemoteLogout(true, 100) { throw IOException("offline") },
        )
        assertEquals(
            MatrixRemoteLogoutOutcome.TIMED_OUT,
            attemptMatrixRemoteLogout(true, 1) { delay(100) },
        )
    }

    @Test
    fun `confirmed remote logout is recorded without changing local policy`() = runBlocking {
        assertEquals(
            MatrixRemoteLogoutOutcome.CONFIRMED,
            attemptMatrixRemoteLogout(true, 100) {},
        )
    }
}
