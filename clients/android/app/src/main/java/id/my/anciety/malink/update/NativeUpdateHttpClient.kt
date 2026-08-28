package id.my.anciety.malink.update

import java.io.File
import java.io.RandomAccessFile
import java.net.HttpURLConnection
import java.net.URI
import java.nio.charset.StandardCharsets

internal class NativeUpdateHttpClient(
    private val connectTimeoutMs: Int = 15_000,
    private val readTimeoutMs: Int = 30_000,
    private val connectionFactory: (URI) -> HttpURLConnection = { uri ->
        uri.toURL().openConnection() as HttpURLConnection
    },
) {
    fun readText(uri: URI, maximumBytes: Int): String {
        require(maximumBytes in 1..256 * 1024)
        val connection = open(uri)
        try {
            connection.setRequestProperty("Accept", "application/json")
            val response = connection.responseCode
            if (response != HttpURLConnection.HTTP_OK) {
                throw NativeUpdateDownloadException("manifest_http_$response")
            }
            val advertised = connection.contentLengthLong
            if (advertised > maximumBytes) {
                throw NativeUpdateDownloadException("manifest_size_exceeded")
            }
            val bytes = connection.inputStream.use { input ->
                val output = java.io.ByteArrayOutputStream()
                val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
                while (true) {
                    val count = input.read(buffer)
                    if (count < 0) break
                    if (output.size() + count > maximumBytes) {
                        throw NativeUpdateDownloadException("manifest_size_exceeded")
                    }
                    output.write(buffer, 0, count)
                }
                output.toByteArray()
            }
            return bytes.toString(StandardCharsets.UTF_8)
        } finally {
            connection.disconnect()
        }
    }

    fun download(
        uri: URI,
        target: File,
        expectedBytes: Long,
        source: NativeUpdateArtifactSource,
        onProgress: (downloaded: Long) -> Unit,
    ) {
        require(expectedBytes in 1..NativeClientReleaseParser.MAX_APK_BYTES)
        target.parentFile?.mkdirs()
        var offset = target.takeIf(File::isFile)?.length() ?: 0L
        if (offset < 0 || offset > expectedBytes) {
            target.delete()
            offset = 0
        }
        val opened = openArtifact(uri, source, offset)
        val connection = opened.connection
        try {
            val response = opened.responseCode
            val append = offset > 0 && response == HttpURLConnection.HTTP_PARTIAL
            if (response != HttpURLConnection.HTTP_OK && !append) {
                throw NativeUpdateDownloadException("artifact_http_$response")
            }
            if (!append) offset = 0
            val advertised = connection.contentLengthLong
            if (advertised > expectedBytes || (advertised >= 0 && offset + advertised > expectedBytes)) {
                throw NativeUpdateDownloadException("artifact_size_exceeded")
            }
            RandomAccessFile(target, "rw").use { output ->
                if (append) output.seek(offset) else output.setLength(0)
                connection.inputStream.use { input ->
                    val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
                    var total = offset
                    while (true) {
                        val count = input.read(buffer)
                        if (count < 0) break
                        total += count
                        if (total > expectedBytes) throw NativeUpdateDownloadException("artifact_size_exceeded")
                        output.write(buffer, 0, count)
                        onProgress(total)
                    }
                    output.fd.sync()
                }
            }
            if (target.length() != expectedBytes) {
                throw NativeUpdateDownloadException("artifact_size_mismatch")
            }
        } finally {
            connection.disconnect()
        }
    }

    private fun openArtifact(
        uri: URI,
        source: NativeUpdateArtifactSource,
        offset: Long,
    ): OpenArtifactConnection {
        var current = uri
        repeat(MAX_ARTIFACT_REDIRECTS + 1) { redirectCount ->
            val connection = open(current)
            if (offset > 0) connection.setRequestProperty("Range", "bytes=$offset-")
            val response = try {
                connection.responseCode
            } catch (error: Exception) {
                connection.disconnect()
                throw error
            }
            if (response !in REDIRECT_CODES) {
                return OpenArtifactConnection(connection, response)
            }
            val location = connection.getHeaderField("Location")
            connection.disconnect()
            current = resolveArtifactRedirect(
                source = source,
                current = current,
                location = location,
                redirectsFollowed = redirectCount,
            )
        }
        throw NativeUpdateDownloadException("artifact_redirect_limit_exceeded")
    }

    private fun open(uri: URI): HttpURLConnection = connectionFactory(uri).apply {
        instanceFollowRedirects = false
        useCaches = false
        connectTimeout = connectTimeoutMs
        readTimeout = readTimeoutMs
        setRequestProperty("User-Agent", "MalinkNativeUpdater/1")
    }

    private data class OpenArtifactConnection(
        val connection: HttpURLConnection,
        val responseCode: Int,
    )

    companion object {
        const val MAX_ARTIFACT_REDIRECTS = 3
        val REDIRECT_CODES = setOf(301, 302, 303, 307, 308)
    }
}

internal class NativeUpdateDownloadException(val detailCode: String) : Exception(detailCode)

internal fun resolveArtifactRedirect(
    source: NativeUpdateArtifactSource,
    current: URI,
    location: String?,
    redirectsFollowed: Int,
): URI {
    if (source != NativeUpdateArtifactSource.GITHUB_RELEASE) {
        throw NativeUpdateDownloadException("artifact_redirect_forbidden")
    }
    if (redirectsFollowed >= NativeUpdateHttpClient.MAX_ARTIFACT_REDIRECTS) {
        throw NativeUpdateDownloadException("artifact_redirect_limit_exceeded")
    }
    val next = location?.takeIf(String::isNotBlank)?.let { value ->
        runCatching { current.resolve(value) }.getOrNull()
    } ?: throw NativeUpdateDownloadException("artifact_redirect_location_invalid")
    val host = next.host?.lowercase()
    if (
        !next.scheme.equals("https", ignoreCase = true) ||
        host.isNullOrBlank() ||
        next.rawUserInfo != null ||
        next.rawFragment != null ||
        (next.port != -1 && next.port != 443) ||
        (host != "github.com" && !host.endsWith(".githubusercontent.com"))
    ) {
        throw NativeUpdateDownloadException("artifact_redirect_origin_untrusted")
    }
    if (
        host == "github.com" &&
        (
            next.rawQuery != null ||
                !next.rawPath.startsWith("/Escapingbug/malink/releases/download/")
        )
    ) {
        throw NativeUpdateDownloadException("artifact_redirect_origin_untrusted")
    }
    return next
}
