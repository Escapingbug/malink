package id.my.anciety.malink.web

import org.junit.Assert.assertFalse
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
        assertTrue(webBootstrapFailureDetail("critical_http_404").contains("required interface file"))
        assertFalse(webBootstrapFailureDetail("critical_http_404").contains("critical_http"))
    }
}
