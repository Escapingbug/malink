package id.my.anciety.malink.diagnostics

import org.junit.Assert.*
import org.junit.Test

class CrashDiagnosticsTest {
    @Test fun recordsCodeLocationsWithoutMessages() {
        val lines = mutableListOf<String>()
        val recorder = object : DiagnosticRecorder {
            override fun record(event: String, attributes: Map<String, String>) {
                lines += DiagnosticLine.encode("now", event, attributes)
            }
        }
        val error = IllegalStateException("secret-token-and-message", IllegalArgumentException("private"))
        recordCrash(error, recorder)
        assertTrue(lines.any { it.contains("IllegalStateException") })
        assertTrue(lines.any { it.contains("IllegalArgumentException") })
        assertTrue(lines.any { it.contains("process.crash_frame") })
        assertFalse(lines.any { it.contains("secret-token") || it.contains("private") })
        assertTrue(lines.size <= 85)
    }
}
