package id.my.anciety.malink.web

internal data class WebBootstrapProbe(
    val bridgeAvailable: Boolean,
    val documentComplete: Boolean,
    val rootPopulated: Boolean,
    val serviceWorkerControlled: Boolean,
    val startupPhase: String? = null,
    val startupFailureCode: String? = null,
)

private val STARTUP_PHASES = setOf(
    "booting",
    "preparing-state",
    "rendering-workspace",
    "ready",
    "failed",
)
private val STARTUP_FAILURE_CODE = Regex("^ui-start-[0-9a-f]{8}$")

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
    if (parts.size != 4 && parts.size != 6) return null
    if (
        parts[0] !in setOf("bridge", "missing") ||
        parts[1] !in setOf("complete", "incomplete") ||
        parts[2] !in setOf("populated", "empty") ||
        parts[3] !in setOf("controlled", "uncontrolled") ||
        (parts.size == 6 && parts[4] != "unknown" && parts[4] !in STARTUP_PHASES) ||
        (parts.size == 6 && parts[5] != "none" && !STARTUP_FAILURE_CODE.matches(parts[5]))
    ) return null
    return WebBootstrapProbe(
        bridgeAvailable = parts[0] == "bridge",
        documentComplete = parts[1] == "complete",
        rootPopulated = parts[2] == "populated",
        serviceWorkerControlled = parts[3] == "controlled",
        startupPhase = parts.getOrNull(4)?.takeUnless { it == "unknown" },
        startupFailureCode = parts.getOrNull(5)?.takeUnless { it == "none" },
    )
}

internal fun webBootstrapTimeoutReason(probe: WebBootstrapProbe?): String = when {
    probe == null -> "bridge_timeout"
    !probe.bridgeAvailable -> "bridge_missing"
    probe.startupPhase == "failed" -> "interface_failed"
    probe.documentComplete && !probe.rootPopulated -> "interface_not_rendered"
    else -> "bridge_timeout"
}

internal fun webBootstrapFailureDetail(reason: String): String = when {
    reason == "bridge_missing" ->
        "Android System WebView loaded the page but did not expose Malink's secure native bridge."
    reason == "interface_not_rendered" ->
        "The hosted page loaded, but its application interface did not start."
    reason == "interface_failed" ->
        "The hosted interface reported that workspace startup failed."
    reason == "bridge_timeout" ->
        "The hosted interface loaded, but its secure Android connection did not start in time."
    reason == "main_resource_unavailable" || reason.startsWith("main_http_") ->
        "The selected PWA page could not be downloaded successfully."
    reason == "critical_resource_unavailable" || reason.startsWith("critical_http_") ->
        "A required interface file could not be downloaded successfully."
    else ->
        "The hosted interface did not complete its secure Android startup."
}

internal fun pwaStartupFailureCodeFromConsole(message: String?): String? =
    message
        ?.let { Regex("\\[malink/startup:(ui-start-[0-9a-f]{8})]").find(it) }
        ?.groupValues
        ?.getOrNull(1)
