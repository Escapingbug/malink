package id.my.anciety.malink.matrix

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.matrix.rustcomponents.sdk.LogLevel
import org.matrix.rustcomponents.sdk.TraceLogPacks

class MatrixSdkPlatformTest {
    @Test
    fun `release tracing keeps warnings without sync profiling`() {
        val policy = matrixSdkTracingPolicy(debug = false)

        assertEquals(LogLevel.WARN, policy.logLevel)
        assertTrue(policy.traceLogPacks.isEmpty())
    }

    @Test
    fun `debug tracing retains sync profiling`() {
        val policy = matrixSdkTracingPolicy(debug = true)

        assertEquals(LogLevel.DEBUG, policy.logLevel)
        assertEquals(listOf(TraceLogPacks.SYNC_PROFILING), policy.traceLogPacks)
    }
}
