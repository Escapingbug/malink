package id.my.anciety.malink.web

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class NativeDisconnectPresentationTest {
    @Test
    fun `ordinary disconnect opens reconnect while account revoke stays in setup`() {
        assertEquals(
            NativeDisconnectPresentation.STOPPED,
            nativeDisconnectPresentation("stop"),
        )
        assertEquals(
            NativeDisconnectPresentation.ACCOUNT_SETUP,
            nativeDisconnectPresentation("revoke"),
        )
    }

    @Test
    fun `unknown disconnect modes fail closed`() {
        assertThrows(IllegalArgumentException::class.java) {
            nativeDisconnectPresentation("unknown")
        }
    }
}
