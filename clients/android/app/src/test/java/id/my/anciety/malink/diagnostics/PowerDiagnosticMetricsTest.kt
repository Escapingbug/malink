package id.my.anciety.malink.diagnostics

import org.junit.Assert.*
import org.junit.Test

class PowerDiagnosticMetricsTest {
    @Test fun `metrics sum measured work and bytes without per-event logging`() {
        val metrics = PowerDiagnosticMetrics()
        repeat(10) { assertTrue(metrics.accept("power.projection_checkpoint",
            mapOf("elapsed_ms" to "4", "bytes" to "100"), 0)) }
        assertEquals("", metrics.drain(59_999))
        val output = metrics.drain(60_000)
        assertTrue(output.contains("bytes=1000 count=10 elapsed_ms=40"))
        assertEquals("", metrics.drain(60_001, true))
        assertFalse(metrics.accept("matrix.failure", emptyMap(), 0))
    }
}
