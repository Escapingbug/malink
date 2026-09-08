package id.my.anciety.malink.web

/** Resources without which the hosted Android presentation cannot start. */
internal fun isCriticalWebBootstrapPath(path: String?): Boolean {
    val normalized = path?.lowercase() ?: return false
    return normalized.endsWith(".js") ||
        normalized.endsWith(".css") ||
        normalized.endsWith(".wasm")
}

internal fun webBootstrapFailureDetail(reason: String): String = when {
    reason == "bridge_timeout" ->
        "The hosted interface loaded, but its secure Android connection did not start in time."
    reason == "main_resource_unavailable" || reason.startsWith("main_http_") ->
        "The selected PWA page could not be downloaded successfully."
    reason == "critical_resource_unavailable" || reason.startsWith("critical_http_") ->
        "A required interface file could not be downloaded successfully."
    else ->
        "The hosted interface did not complete its secure Android startup."
}
