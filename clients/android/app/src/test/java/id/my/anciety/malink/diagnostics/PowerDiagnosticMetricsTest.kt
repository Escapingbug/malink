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

    @Test fun `groups by event type phase and mutation cause and tracks maximum`() {
        val metrics = PowerDiagnosticMetrics()
        val attributes = mapOf("type" to "gateway.update", "phase" to "background",
            "changed" to "false", "checkpoint" to "true", "caused" to "true")
        metrics.accept("power.projection_result", attributes + ("elapsed_ms" to "5"), 0)
        metrics.accept("power.projection_result", attributes + ("elapsed_ms" to "12"), 100)
        metrics.accept("power.projection_result", attributes + ("phase" to "foreground"), 200)
        val lines = metrics.drain(60_000).trim().lines()
        assertEquals(2, lines.size)
        assertTrue(lines[0].contains("count=2 elapsed_ms=17 max_ms=12 phase=background"))
        assertTrue(lines[0].contains("caused=true changed=false checkpoint=true"))
        assertTrue(lines[0].contains("type=gateway.update window_ms=60000"))
        assertTrue(lines[1].contains("phase=foreground"))
    }

    @Test fun `dimension overflow stays aggregated and excludes unrelated content`() {
        val metrics = PowerDiagnosticMetrics()
        repeat(1_000) {
            assertTrue(metrics.accept("power.checkpoint_request", mapOf(
                "reason" to "reason_$it", "body" to "private-message", "room" to "private-room"), 0))
        }
        val output = metrics.drain(60_000)
        assertEquals(97, output.trim().lines().size)
        assertTrue(output.contains("count=904"))
        assertTrue(output.contains("reason=overflow"))
        assertFalse(output.contains("private"))
    }

    @Test fun `forced flush sanitizes dimensions and resets window`() {
        val metrics = PowerDiagnosticMetrics()
        metrics.accept("power.event_stage", mapOf("stage" to "bad\nvalue", "elapsed_ms" to "-1"), 100)
        val output = metrics.drain(200, true)
        assertTrue(output.contains("elapsed_ms=0 max_ms=0 stage=invalid window_ms=100"))
        assertEquals("", metrics.drain(300, true))
        metrics.accept("power.event_stage", emptyMap(), 400)
        assertTrue(metrics.drain(450, true).contains("window_ms=50"))
    }
}
