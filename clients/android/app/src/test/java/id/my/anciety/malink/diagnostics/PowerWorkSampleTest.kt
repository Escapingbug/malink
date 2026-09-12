package id.my.anciety.malink.diagnostics

import org.junit.Assert.*
import org.junit.Test

class PowerWorkSampleTest {
    private class Recorder : DiagnosticRecorder {
        var cpu = -1L
        val samples = mutableListOf<Map<String, String>>()
        override fun threadCpuNanos() = cpu
        override fun record(event: String, attributes: Map<String, String>) {
            assertEquals("power.storage_stage", event)
            samples += attributes
        }
    }

    @Test fun `synchronous stage returns value and reports thread CPU delta`() {
        val recorder = Recorder()
        recorder.cpu = 1_000_000
        val result = recorder.measurePowerWork("checkpoint_build") { recorder.cpu += 8_000_000; 42 }
        assertEquals(42, result)
        assertEquals("8", recorder.samples.single()["thread_cpu_ms"])
        assertEquals("success", recorder.samples.single()["reason"])
        assertEquals("checkpoint_build", recorder.samples.single()["stage"])
    }

    @Test fun `failure remains visible and unsupported CPU is omitted`() {
        val recorder = Recorder()
        val failure = IllegalStateException("private error detail")
        val thrown = assertThrows(IllegalStateException::class.java) {
            recorder.measurePowerWork("raw_write") { throw failure }
        }
        assertSame(failure, thrown)
        assertEquals("failure", recorder.samples.single()["reason"])
        assertFalse(recorder.samples.single().containsKey("thread_cpu_ms"))
        assertFalse(recorder.samples.toString().contains("private"))
    }

    @Test fun `storage CPU aggregates with bounded minute window`() {
        val metrics = PowerDiagnosticMetrics()
        repeat(10) {
            assertTrue(metrics.accept("power.storage_stage", mapOf(
                "stage" to "raw_write", "reason" to "success", "elapsed_ms" to "12", "thread_cpu_ms" to "3",
            ), 0))
        }
        assertEquals("", metrics.drain(59_999))
        val output = metrics.drain(60_000)
        assertTrue(output.contains("count=10 elapsed_ms=120"))
        assertTrue(output.contains("thread_cpu_ms=30"))
        assertEquals(1, output.trim().lines().size)
    }
}
