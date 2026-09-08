package id.my.anciety.malink.web

internal data class WebBootstrapProbe(
    val bridgeAvailable: Boolean,
    val documentComplete: Boolean,
    val rootPopulated: Boolean,
    val serviceWorkerControlled: Boolean,
)

/** Resources without which the hosted Android presentation cannot start. */
internal fun isCriticalWebBootstrapPath(path: String?): Boolean {
    val normalized = path?.lowercase() ?: return false
    return normalized.endsWith(".js") ||
        normalized.endsWith(".css") ||
        normalized.endsWith(".wasm")
}

internal fun parseWebBootstrapProbe(encoded: String?): WebBootstrapProbe? {
    val normalized = encoded?.trim() ?: return null
    if (normalized.length < 2 || normalized.first() != '"' || normalized.last() != '"') return null
    val token = normalized.substring(1, normalized.length - 1)
    val parts = token.split('|')
    if (parts.size != 4) return null
    if (
        parts[0] !in setOf("bridge", "missing") ||
        parts[1] !in setOf("complete", "incomplete") ||
        parts[2] !in setOf("populated", "empty") ||
        parts[3] !in setOf("controlled", "uncontrolled")
    ) return null
    return WebBootstrapProbe(
        bridgeAvailable = parts[0] == "bridge",
        documentComplete = parts[1] == "complete",
        rootPopulated = parts[2] == "populated",
        serviceWorkerControlled = parts[3] == "controlled",
    )
}

internal fun webBootstrapTimeoutReason(probe: WebBootstrapProbe?): String = when {
    probe == null -> "bridge_timeout"
    !probe.bridgeAvailable -> "bridge_missing"
    probe.documentComplete && !probe.rootPopulated -> "interface_not_rendered"
    else -> "bridge_timeout"
}

internal fun webBootstrapFailureDetail(reason: String): String = when {
    reason == "bridge_missing" ->
        "Android System WebView loaded the page but did not expose Malink's secure native bridge."
    reason == "interface_not_rendered" ->
        "The hosted page loaded, but its application interface did not start."
    reason == "bridge_timeout" ->
        "The hosted interface loaded, but its secure Android connection did not start in time."
    reason == "main_resource_unavailable" || reason.startsWith("main_http_") ->
        "The selected PWA page could not be downloaded successfully."
    reason == "critical_resource_unavailable" || reason.startsWith("critical_http_") ->
        "A required interface file could not be downloaded successfully."
    else ->
        "The hosted interface did not complete its secure Android startup."
}
