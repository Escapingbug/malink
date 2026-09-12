package id.my.anciety.malink.diagnostics

/** Called under the log lock. No timer or background wakeup is needed. */
internal class FrequentDiagnosticCounts {
    private val counts = linkedMapOf<String, Long>()
    private var startedAt: Long? = null

    fun accept(event: String, attributes: Map<String, String>, now: Long): Boolean {
        if (event !in EVENTS && !(event == "matrix.driver.room_list_state" &&
                attributes["stage"] == "RUNNING")) return false
        // Keep only validated, bounded keys; errors and state transitions are
        // never aggregated. Preserve kind/stage breakdowns for power diagnosis.
        val key = DiagnosticLine.encode("", event, attributes).trim()
        if (key !in counts && counts.size >= 64) return false
        if (startedAt == null) startedAt = now
        counts[key] = (counts[key] ?: 0L) + 1L
        return true
    }

    fun drain(now: Long, force: Boolean = false): String {
        val start = startedAt ?: return ""
        if (!force && now - start < 60_000) return ""
        val timestamp = java.time.Instant.ofEpochMilli(now).toString()
        val result = counts.entries.joinToString("", transform = { (key, count) ->
            "$timestamp $key count=$count elapsed_ms=${(now - start).coerceAtLeast(0)}\n"
        })
        counts.clear()
        startedAt = null
        return result
    }

    private companion object {
        val EVENTS = setOf(
            "matrix.driver.sync_update",
            "matrix.application_timeline.event_received",
            "matrix.application_timeline.event_duplicate",
        )
    }
}
