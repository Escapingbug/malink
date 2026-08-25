package id.my.anciety.malink.matrix

import java.net.URI
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.matrix.rustcomponents.sdk.SlidingSyncVersion

class MatrixRoomMembershipClientTest {
    @Test
    fun `joins a root-authorized additional Workspace room`() = runBlocking {
        lateinit var endpoint: URI
        lateinit var requestBody: ByteArray
        val responseBody = """{"room_id":"!room-b:example.org"}""".toByteArray()
        val client = MatrixRoomMembershipClient(
            MatrixLoginTokenTransport { target, token, body ->
                endpoint = target
                assertEquals("secret-access-token", token)
                requestBody = body
                MatrixHttpResponse(200, responseBody)
            },
        )

        client.join(storedSession(), "!room-b:example.org")

        assertEquals(
            "/_matrix/client/v3/join/%21room-b%3Aexample.org",
            endpoint.rawPath,
        )
        assertTrue(requestBody.all { it == 0.toByte() })
        assertTrue(responseBody.all { it == 0.toByte() })
    }

    private fun storedSession() = StoredMatrixSession(
        accessToken = "secret-access-token",
        refreshToken = null,
        userId = "@alice:example.org",
        deviceId = "MATRIX-DEVICE",
        homeserverUrl = "https://matrix.example.org",
        oauthData = null,
        slidingSyncVersion = SlidingSyncVersion.NATIVE,
        roomBinding = MatrixRoomBinding(
            roomId = "!room-a:example.org",
            gatewayId = "workspace-1",
            conversationId = "conversation-a",
            gatewayUserId = "@gateway:example.org",
            gatewayDeviceId = "GATEWAY-A",
            gatewayDeviceEd25519 = "A".repeat(43),
        ),
    )
}
