package id.my.anciety.malink.web

import java.io.ByteArrayInputStream
import java.util.Base64
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class AuthorizationTransferImportTest {
    @Test
    fun `reads and encodes a bounded authorization file`() {
        val contents = "{\"kind\":\"malink.authorization-transfer\"}\n".toByteArray()

        val read = readAuthorizationTransfer(ByteArrayInputStream(contents))
        val fragment = authorizationTransferFragment(read)

        assertArrayEquals(contents, read)
        assertArrayEquals(contents, Base64.getUrlDecoder().decode(fragment))
    }

    @Test
    fun `rejects empty and oversized authorization files`() {
        assertThrows(IllegalArgumentException::class.java) {
            readAuthorizationTransfer(ByteArrayInputStream(byteArrayOf()))
        }
        val oversized = ByteArray(MAX_AUTHORIZATION_TRANSFER_BYTES + 1)
        val error = assertThrows(IllegalArgumentException::class.java) {
            readAuthorizationTransfer(ByteArrayInputStream(oversized))
        }
        assertEquals("The authorization file is too large.", error.message)
        assertThrows(IllegalArgumentException::class.java) {
            authorizationTransferFragment(oversized)
        }
    }
}
