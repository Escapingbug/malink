package id.my.anciety.malink.diagnostics

/** Bounded counters only; the diagnostic log owns synchronization and flushing. */
internal class PowerDiagnosticMetrics {
    private data class Key(val event: String, val dimensions: Map<String, String>)
    private data class Totals(var count: Long = 0, var millis: Long = 0, var bytes: Long = 0, var maxMillis: Long = 0,
        var threadCpuMillis: Long = 0, var hasThreadCpu: Boolean = false)
    private val totals = linkedMapOf<Key, Totals>()
    private var start: Long? = null

    fun accept(event: String, attributes: Map<String, String>, now: Long): Boolean {
        if (event !in EVENTS) return false
        val millis = attributes["elapsed_ms"]?.toLongOrNull()?.coerceAtLeast(0) ?: 0
        val bytes = attributes["bytes"]?.toLongOrNull()?.coerceAtLeast(0) ?: 0
        val dimensions = attributes.filterKeys { it in DIMENSIONS }.mapValues { (_, value) ->
            if (value.matches(SAFE_DIMENSION)) value else "invalid"
        }.toSortedMap()
        val requestedKey = Key(event, dimensions)
        // Never let room/session IDs or unexpected high-cardinality input grow
        // the counter map or fall through to per-event disk logging.
        val key = if (requestedKey in totals || totals.size < 96) requestedKey
            else Key(event, mapOf("reason" to "overflow"))
        val value = totals.getOrPut(key) { Totals() }
        value.count++
        value.millis += millis
        value.bytes += bytes
        value.maxMillis = maxOf(value.maxMillis, millis)
        attributes["thread_cpu_ms"]?.toLongOrNull()?.takeIf { it >= 0 }?.let {
            value.threadCpuMillis += it
            value.hasThreadCpu = true
        }
        if (start == null) start = now
        return true
    }

    fun drain(now: Long, force: Boolean = false): String {
        val since = start ?: return ""
        if (!force && now - since < 60_000) return ""
        val timestamp = java.time.Instant.ofEpochMilli(now).toString()
        val result = totals.entries.joinToString("") { (key, value) ->
            DiagnosticLine.encode(timestamp, key.event, key.dimensions +
                (if (value.hasThreadCpu) mapOf("thread_cpu_ms" to value.threadCpuMillis.toString()) else emptyMap()) + mapOf(
                "count" to value.count.toString(), "elapsed_ms" to value.millis.toString(),
                "bytes" to value.bytes.toString(),
                "max_ms" to value.maxMillis.toString(),
                "window_ms" to (now - since).coerceAtLeast(0).toString(),
            )) + "\n"
        }
        totals.clear()
        start = null
        return result
    }

    private companion object {
        val SAFE_DIMENSION = Regex("[A-Za-z0-9._:+/-]{1,80}")
        val DIMENSIONS = setOf("type", "reason", "phase", "changed", "checkpoint", "caused", "stage")
        val EVENTS = setOf("power.raw_inbox", "power.event_processing", "power.projection_checkpoint",
            "power.checkpoint_skipped", "power.presentation_resume", "power.presentation_delivery",
            "power.projection_result", "power.checkpoint_request", "power.event_stage", "power.deployment_change", "power.storage_stage")
    }
}
