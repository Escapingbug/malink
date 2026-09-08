package id.my.anciety.malink.web

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class WebBootstrapPolicyTest {
    @Test
    fun `classifies executable and style resources as bootstrap critical`() {
        assertTrue(isCriticalWebBootstrapPath("/malink/assets/index-hash.js"))
        assertTrue(isCriticalWebBootstrapPath("/malink/assets/index-hash.CSS"))
        assertTrue(isCriticalWebBootstrapPath("/malink/assets/crypto.wasm"))
    }

    @Test
    fun `leaves optional static resources out of bootstrap recovery`() {
        assertFalse(isCriticalWebBootstrapPath("/malink/favicon.svg"))
        assertFalse(isCriticalWebBootstrapPath("/malink/photo.png"))
        assertFalse(isCriticalWebBootstrapPath(null))
    }

    @Test
    fun `turns internal bootstrap reasons into actionable explanations`() {
        assertTrue(webBootstrapFailureDetail("bridge_timeout").contains("did not start in time"))
        assertTrue(webBootstrapFailureDetail("bridge_missing").contains("secure native bridge"))
        assertTrue(webBootstrapFailureDetail("interface_not_rendered").contains("did not start"))
        assertTrue(webBootstrapFailureDetail("critical_http_404").contains("required interface file"))
        assertFalse(webBootstrapFailureDetail("critical_http_404").contains("critical_http"))
    }

    @Test
    fun `parses bounded bootstrap probe without retaining page data`() {
        assertEquals(
            WebBootstrapProbe(
                bridgeAvailable = true,
                documentComplete = true,
                rootPopulated = false,
                serviceWorkerControlled = true,
            ),
            parseWebBootstrapProbe("\"bridge|complete|empty|controlled\""),
        )
        assertNull(parseWebBootstrapProbe(null))
        assertNull(parseWebBootstrapProbe("{}"))
        assertNull(parseWebBootstrapProbe("\"unknown|complete|empty|controlled\""))
    }

    @Test
    fun `classifies timeout from bridge and rendered root probes`() {
        assertEquals(
            "bridge_missing",
            webBootstrapTimeoutReason(
                WebBootstrapProbe(false, true, false, true),
            ),
        )
        assertEquals(
            "interface_not_rendered",
            webBootstrapTimeoutReason(
                WebBootstrapProbe(true, true, false, true),
            ),
        )
        assertEquals(
            "bridge_timeout",
            webBootstrapTimeoutReason(
                WebBootstrapProbe(true, true, true, false),
            ),
        )
        assertEquals("bridge_timeout", webBootstrapTimeoutReason(null))
    }
}
