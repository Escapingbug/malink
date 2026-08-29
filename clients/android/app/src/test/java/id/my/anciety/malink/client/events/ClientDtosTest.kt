package id.my.anciety.malink.client.events

import org.junit.Assert.assertEquals
import org.junit.Test

class ClientDtosTest {
    @Test
    fun `public command error accepts the durable four KiB diagnostic boundary`() {
        val message = "x".repeat(4_096)

        assertEquals(
            message,
            PublicCommandError("gateway_failed", message, retryable = false).message,
        )
    }
}
