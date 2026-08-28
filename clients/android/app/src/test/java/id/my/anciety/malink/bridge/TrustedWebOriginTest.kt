package id.my.anciety.malink.bridge

import id.my.anciety.malink.config.StaticServiceEndpoint
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.URI

class TrustedWebOriginTest {
    @Test
    fun `accepts only the exact configured origin`() {
        val endpoint = StaticServiceEndpoint.parse("https://static.example")
        val trusted = TrustedWebOrigin(endpoint)
        val configured = URI(endpoint.origin)
        val otherScheme = if (configured.scheme == "https") "http" else "https"
        val otherPort = if (configured.port == 8443) 8444 else 8443

        assertTrue(trusted.isTrustedOrigin(endpoint.origin))
        assertTrue(trusted.isTrustedOrigin("${endpoint.origin}/"))

        assertFalse(trusted.isTrustedOrigin("$otherScheme://${configured.authority}"))
        assertFalse(trusted.isTrustedOrigin("${configured.scheme}://evil.${configured.host}:${configured.port}"))
        assertFalse(trusted.isTrustedOrigin("${configured.scheme}://${configured.host}:$otherPort"))
        assertFalse(trusted.isTrustedOrigin("${configured.scheme}://user@${configured.authority}"))
        assertFalse(trusted.isTrustedOrigin("${endpoint.origin}/app"))
        assertFalse(trusted.isTrustedOrigin("not a uri"))
    }

    @Test
    fun `navigation allows configured paths but rejects lookalikes`() {
        val endpoint = StaticServiceEndpoint.parse("https://static.example/malink/")
        val trusted = TrustedWebOrigin(endpoint)
        val configured = URI(endpoint.origin)

        assertTrue(trusted.isTrustedUrl("${endpoint.baseUrl}session/123?native=1#message"))
        assertFalse(trusted.isTrustedUrl("${endpoint.origin}/other-app/"))
        assertFalse(
            trusted.isTrustedUrl(
                "${configured.scheme}://${configured.host}.evil.example/session/123",
            ),
        )
        assertFalse(
            trusted.isTrustedUrl(
                "${configured.scheme}://${configured.authority}@evil.example/session/123",
            ),
        )
    }
}
