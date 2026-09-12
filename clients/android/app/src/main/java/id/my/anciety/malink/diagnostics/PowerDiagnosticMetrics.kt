package id.my.anciety.malink.diagnostics

/** Bounded counters only; the diagnostic log owns synchronization and flushing. */
internal class PowerDiagnosticMetrics {
    private data class Totals(var count: Long = 0, var millis: Long = 0, var bytes: Long = 0)
    private val totals = linkedMapOf<String, Totals>()
    private var start: Long? = null

    fun accept(event: String, attributes: Map<String, String>, now: Long): Boolean {
        if (event !in EVENTS) return false
        val millis = attributes["elapsed_ms"]?.toLongOrNull()?.coerceAtLeast(0) ?: 0
        val bytes = attributes["bytes"]?.toLongOrNull()?.coerceAtLeast(0) ?: 0
        val value = totals.getOrPut(event) { Totals() }
        value.count++
        value.millis += millis
        value.bytes += bytes
        if (start == null) start = now
        return true
    }

    fun drain(now: Long, force: Boolean = false): String {
        val since = start ?: return ""
        if (!force && now - since < 60_000) return ""
        val timestamp = java.time.Instant.ofEpochMilli(now).toString()
        val result = totals.entries.joinToString("") { (event, value) ->
            DiagnosticLine.encode(timestamp, event, mapOf(
                "count" to value.count.toString(), "elapsed_ms" to value.millis.toString(),
                "bytes" to value.bytes.toString(),
            )) + "\n"
        }
        totals.clear()
        start = null
        return result
    }

    private companion object {
        val EVENTS = setOf("power.raw_inbox", "power.event_processing", "power.projection_checkpoint",
            "power.checkpoint_skipped", "power.presentation_resume", "power.presentation_delivery")
    }
}
