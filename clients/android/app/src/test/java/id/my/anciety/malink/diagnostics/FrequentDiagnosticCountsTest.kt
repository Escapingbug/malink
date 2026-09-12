package id.my.anciety.malink.diagnostics

import org.junit.Assert.*
import org.junit.Test

class FrequentDiagnosticCountsTest {
    @Test fun `frequent events batch without timers and retain exact counts`() {
        val counts = FrequentDiagnosticCounts()
        repeat(100) {
            assertTrue(counts.accept("matrix.application_timeline.event_duplicate", mapOf("kind" to "v3_project_envelope"), it.toLong()))
        }
        assertEquals("", counts.drain(59_999))
        val line = counts.drain(60_000)
        assertTrue(line.contains("kind=v3_project_envelope count=100 elapsed_ms=60000"))
        assertEquals("", counts.drain(60_001, force = true))
    }

    @Test fun `errors stay immediate and export includes partial window`() {
        val counts = FrequentDiagnosticCounts()
        assertFalse(counts.accept("matrix.driver.sync_failure", mapOf("error" to "IOException"), 0))
        assertFalse(counts.accept("matrix.driver.room_list_state", mapOf("stage" to "ERROR"), 0))
        assertTrue(counts.accept("matrix.driver.sync_update", emptyMap(), 10))
        assertTrue(counts.drain(20, force = true).contains("count=1 elapsed_ms=10"))
    }
}
