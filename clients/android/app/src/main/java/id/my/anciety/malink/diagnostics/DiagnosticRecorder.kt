package id.my.anciety.malink.diagnostics

interface DiagnosticRecorder {
    fun record(event: String, attributes: Map<String, String> = emptyMap())

    data object None : DiagnosticRecorder {
        override fun record(event: String, attributes: Map<String, String>) = Unit
    }
}

internal object DiagnosticLine {
    private val safeToken = Regex("^[A-Za-z0-9._:+/-]{1,160}$")
    private val allowedAttributes = setOf(
        "accepted",
        "action",
        "attempt",
        "appended",
        "available",
        "bridge",
        "candidates",
        "changed",
        "code",
        "count",
        "detail",
        "document_complete",
        "error",
        "events",
        "expected",
        "failed",
        "fingerprint",
        "has_more",
        "importance",
        "keyed",
        "kind",
        "limit",
        "line",
        "loaded",
        "main_frame",
        "missing",
        "package",
        "paged",
        "phase",
        "projected",
        "reason",
        "received",
        "request",
        "rooms",
        "retry_after_ms",
        "root_populated",
        "running",
        "quarantined",
        "rejected",
        "schema",
        "source",
        "stage",
        "status",
        "string_message",
        "targets",
        "terminals",
        "threads",
        "transport_ready",
        "trusted_origin",
        "trusted_page",
        "type",
        "version",
        "worker_controlled",
        "pss_kb",
        "rss_kb",
    )

    fun encode(timestamp: String, event: String, attributes: Map<String, String>): String {
        val safeEvent = requireSafe(event, "event")
        val fields = attributes.toSortedMap().map { (key, value) ->
            require(key in allowedAttributes) { "attribute name is not approved for diagnostics." }
            "$key=${requireSafe(value, "attribute value")}"
        }
        return (listOf(timestamp, safeEvent) + fields).joinToString(" ")
    }

    private fun requireSafe(value: String, label: String): String {
        require(safeToken.matches(value)) { "$label is not safe for diagnostic output." }
        return value
    }
}
