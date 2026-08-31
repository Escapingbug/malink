package id.my.anciety.malink.config

import id.my.anciety.malink.BuildConfig
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeFalse
import org.junit.Assume.assumeTrue
import org.junit.Test

class StaticServiceEndpointTest {
    @Test
    fun `GitHub Pages is the production Official static service`() {
        assumeFalse(BuildConfig.ALLOW_INSECURE_E2E_LOOPBACK)
        assertEquals(
            "https://escapingbug.github.io/malink/",
            StaticServiceEndpoint.parse(BuildConfig.APP_ORIGIN).baseUrl,
        )
    }

    @Test
    fun `the e2e build uses only its explicit loopback static service`() {
        assumeTrue(BuildConfig.ALLOW_INSECURE_E2E_LOOPBACK)
        val endpoint = StaticServiceEndpoint.parse(
            BuildConfig.APP_ORIGIN,
            allowLoopbackHttp = true,
        )

        assertEquals("http", endpoint.origin.substringBefore(":"))
        assertTrue(endpoint.origin.startsWith("http://127.0.0.1:"))
    }

    @Test
    fun `normalizes a root or path based static service`() {
        assertEquals(
            "https://static.example/",
            StaticServiceEndpoint.parse("https://STATIC.example").baseUrl,
        )
        val nested = StaticServiceEndpoint.parse("https://static.example/malink")
        assertEquals("https://static.example/malink/", nested.baseUrl)
        assertEquals(
            "https://static.example/malink/version.json",
            nested.resolve("version.json").toString(),
        )
    }

    @Test
    fun `rejects unsafe static service URLs`() {
        listOf(
            "http://static.example",
            "https://user@static.example",
            "https://static.example/path?token=secret",
            "https://static.example/path#fragment",
            "https://static.example/a/../b",
        ).forEach { input ->
            assertThrows(IllegalArgumentException::class.java) {
                StaticServiceEndpoint.parse(input)
            }
        }
    }

    @Test
    fun `rejects update paths that escape or add URL components`() {
        val endpoint = StaticServiceEndpoint.parse("https://static.example/malink/")
        listOf(
            "../version.json",
            "native-updates/../version.json",
            "native-updates//version.json",
            "version.json?token=secret",
            "version.json#fragment",
            "https://attacker.example/version.json",
        ).forEach { path ->
            assertThrows(IllegalArgumentException::class.java) {
                endpoint.resolve(path)
            }
        }
    }

    @Test
    fun `allows explicit loopback HTTP only for test builds`() {
        assertThrows(IllegalArgumentException::class.java) {
            StaticServiceEndpoint.parse("http://127.0.0.1:4173")
        }
        assertEquals(
            "http://127.0.0.1:4173/",
            StaticServiceEndpoint.parse(
                "http://127.0.0.1:4173",
                allowLoopbackHttp = true,
            ).baseUrl,
        )
    }

    @Test
    fun `a saved custom choice becomes Official when it matches the new Official address`() {
        val official = StaticServiceEndpoint.parse("https://escapingbug.github.io/malink/")

        assertFalse(shouldUseCustomStaticService(true, official, official))
        assertFalse(shouldUseCustomStaticService(false, official, official))
        assertTrue(shouldUseCustomStaticService(
            true,
            StaticServiceEndpoint.parse("https://mirror.example/malink/"),
            official,
        ))
    }
}
