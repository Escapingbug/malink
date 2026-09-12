package id.my.anciety.malink.diagnostics

import org.junit.Assert.*
import org.junit.Test

class ProcessPowerMetricsTest {
    @Test fun `CPU is read only at sample boundaries and forced boundaries reset deltas`() {
        var elapsed = 1_000L
        var cpu = 200L
        var reads = 0
        val metrics = ProcessPowerMetrics({ elapsed }, { reads++; cpu })
        elapsed += 59_999
        repeat(100) { assertNull(metrics.sample(false)) }
        assertEquals(1, reads)
        elapsed++
        cpu += 50
        assertEquals(mapOf("window_ms" to "60000", "cpu_ms" to "50"), metrics.sample(false))
        elapsed += 500
        cpu += 2
        assertEquals(mapOf("window_ms" to "500", "cpu_ms" to "2"), metrics.sample(true))
        assertNull(metrics.sample(false))
        assertEquals(3, reads)
    }

    @Test fun `long idle period uses full elapsed window without synthetic CPU usage`() {
        var elapsed = 0L
        val metrics = ProcessPowerMetrics({ elapsed }, { 42L })
        elapsed = 3_600_000
        assertEquals(mapOf("window_ms" to "3600000", "cpu_ms" to "0"), metrics.sample(false))
    }
}
