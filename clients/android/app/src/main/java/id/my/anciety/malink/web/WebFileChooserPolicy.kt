package id.my.anciety.malink.web

internal data class WebFileChooserMimePolicy(
    val type: String,
    val acceptedMimeTypes: List<String> = emptyList(),
)

/**
 * Android WebView does not translate an HTML file input's extension filters
 * into MIME types. Keep extension-based inputs visible to DocumentsUI and let
 * the owning parser validate the selected file. MIME-only image inputs remain
 * narrow so ordinary attachment picking keeps its existing presentation.
 */
internal fun webFileChooserMimePolicy(
    rawAcceptTypes: Array<out String>,
): WebFileChooserMimePolicy {
    val tokens = rawAcceptTypes
        .flatMap { it.split(',') }
        .map(String::trim)
        .filter(String::isNotEmpty)
        .map(String::lowercase)
        .distinct()
    if (tokens.any { it.startsWith('.') }) {
        return WebFileChooserMimePolicy(type = "*/*")
    }
    // Android document providers commonly label the custom `.malink-auth`
    // extension as application/octet-stream even when WebView forwards the
    // HTML MIME alternatives. Do not hide the file on that basis; the native
    // authorization importer authenticates and strictly parses its contents.
    if ("application/vnd.malink.authorization+json" in tokens) {
        return WebFileChooserMimePolicy(type = "*/*")
    }

    val mimeTypes = tokens.filter(::isWebFileChooserMimeType)
    if (mimeTypes.isEmpty()) return WebFileChooserMimePolicy(type = "*/*")
    if (mimeTypes.size == 1) return WebFileChooserMimePolicy(type = mimeTypes.single())
    if (mimeTypes.all { it.startsWith("image/") }) {
        return WebFileChooserMimePolicy(
            type = "image/*",
            acceptedMimeTypes = mimeTypes.filterNot { it == "image/*" },
        )
    }
    return WebFileChooserMimePolicy(
        type = "*/*",
        acceptedMimeTypes = mimeTypes,
    )
}

private fun isWebFileChooserMimeType(value: String): Boolean {
    val separator = value.indexOf('/')
    if (separator <= 0 || separator == value.lastIndex) return false
    if (value.indexOf('/', separator + 1) >= 0) return false
    return value.none(Char::isWhitespace)
}
