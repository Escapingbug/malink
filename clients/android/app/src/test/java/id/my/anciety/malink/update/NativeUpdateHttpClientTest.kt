package id.my.anciety.malink.update

import java.io.ByteArrayInputStream
import java.io.File
import java.net.HttpURLConnection
import java.net.URI
import java.net.URL
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class NativeUpdateHttpClientTest {
    @Test
    fun `GitHub Release download follows one trusted redirect and preserves resume range`() {
        val release = URI(
            "https://github.com/Escapingbug/malink/releases/download/" +
                "android-alpha-42/malink.apk",
        )
        val asset = URI(
            "https://release-assets.githubusercontent.com/release/42/malink.apk?signature=test",
        )
        val redirect = FakeConnection(
            release.toURL(),
            302,
            location = asset.toString(),
        )
        val content = FakeConnection(
            asset.toURL(),
            HttpURLConnection.HTTP_PARTIAL,
            bytes = "tail".toByteArray(),
        )
        val target = temporaryFile("head")
        try {
            NativeUpdateHttpClient(connectionFactory = { uri ->
                when (uri) {
                    release -> redirect
                    asset -> content
                    else -> error("Unexpected URI: $uri")
                }
            }).download(
                release,
                target,
                expectedBytes = 8,
                source = NativeUpdateArtifactSource.GITHUB_RELEASE,
            ) {}

            assertEquals("headtail", target.readText())
            assertEquals("bytes=4-", redirect.getRequestProperty("Range"))
            assertEquals("bytes=4-", content.getRequestProperty("Range"))
            assertTrue(redirect.disconnected)
            assertTrue(content.disconnected)
        } finally {
            target.delete()
        }
    }

    @Test
    fun `static artifacts cannot redirect away from their selected service`() {
        val original = URI("https://updates.example/native-updates/releases/android/alpha/42/a.apk")
        val connection = FakeConnection(
            original.toURL(),
            302,
            location = "https://release-assets.githubusercontent.com/release/42/a.apk",
        )
        val target = temporaryFile("")
        try {
            val error = assertThrows(NativeUpdateDownloadException::class.java) {
                NativeUpdateHttpClient(connectionFactory = { connection }).download(
                    original,
                    target,
                    expectedBytes = 1,
                    source = NativeUpdateArtifactSource.STATIC_SERVICE,
                ) {}
            }
            assertEquals("artifact_redirect_forbidden", error.detailCode)
        } finally {
            target.delete()
        }
    }

    @Test
    fun `GitHub Release redirects fail closed outside GitHub asset origins`() {
        val current = URI(
            "https://github.com/Escapingbug/malink/releases/download/" +
                "android-alpha-42/malink.apk",
        )
        listOf(
            "http://release-assets.githubusercontent.com/release/42/malink.apk",
            "https://attacker.example/malink.apk",
            "https://user@release-assets.githubusercontent.com/malink.apk",
            "https://release-assets.githubusercontent.com:444/malink.apk",
        ).forEach { location ->
            val error = assertThrows(NativeUpdateDownloadException::class.java) {
                resolveArtifactRedirect(
                    NativeUpdateArtifactSource.GITHUB_RELEASE,
                    current,
                    location,
                    redirectsFollowed = 0,
                )
            }
            assertEquals("artifact_redirect_origin_untrusted", error.detailCode)
        }
    }

    @Test
    fun `GitHub Release redirects are bounded`() {
        val current = URI(
            "https://github.com/Escapingbug/malink/releases/download/" +
                "android-alpha-42/malink.apk",
        )
        val error = assertThrows(NativeUpdateDownloadException::class.java) {
            resolveArtifactRedirect(
                NativeUpdateArtifactSource.GITHUB_RELEASE,
                current,
                "https://release-assets.githubusercontent.com/release/42/malink.apk",
                NativeUpdateHttpClient.MAX_ARTIFACT_REDIRECTS,
            )
        }
        assertEquals("artifact_redirect_limit_exceeded", error.detailCode)
    }

    private fun temporaryFile(contents: String): File =
        File.createTempFile("malink-update-", ".apk").apply { writeText(contents) }
}

private class FakeConnection(
    url: URL,
    private val status: Int,
    private val bytes: ByteArray = byteArrayOf(),
    private val location: String? = null,
) : HttpURLConnection(url) {
    var disconnected = false
        private set

    override fun connect() = Unit

    override fun disconnect() {
        disconnected = true
    }

    override fun usingProxy(): Boolean = false

    override fun getResponseCode(): Int = status

    override fun getHeaderField(name: String?): String? =
        if (name.equals("Location", ignoreCase = true)) location else null

    override fun getContentLengthLong(): Long = bytes.size.toLong()

    override fun getInputStream() = ByteArrayInputStream(bytes)
}
