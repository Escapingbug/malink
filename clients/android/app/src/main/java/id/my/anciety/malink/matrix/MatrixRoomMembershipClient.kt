package id.my.anciety.malink.matrix

import java.net.URI
import java.net.URLEncoder

/** Joins a Workspace room only after its root-signed directory was accepted. */
class MatrixRoomMembershipClient(
    private val transport: MatrixLoginTokenTransport = RestrictedHttpsMatrixLoginTokenTransport(),
) {
    suspend fun join(session: StoredMatrixSession, roomId: String) {
        val binding = session.roomBindings.singleOrNull { it.roomId == roomId }
        if (binding != null) return
        require(roomId.length <= 512 && roomId.startsWith("!") && roomId.none(Char::isISOControl)) {
            "Workspace room ID is invalid."
        }
        val homeserver = MatrixIdentifiers.normalizeHomeserver(session.homeserverUrl)
        val body = "{}".toByteArray()
        val response = try {
            transport.postJson(
                URI(
                    "$homeserver/_matrix/client/v3/join/" +
                        URLEncoder.encode(roomId, Charsets.UTF_8.name()).replace("+", "%20"),
                ),
                session.accessToken,
                body,
            )
        } finally {
            body.fill(0)
        }
        try {
            if (response.status !in 200..299) {
                throw MatrixApplicationReadException(response.status, null)
            }
        } finally {
            response.body.fill(0)
        }
    }
}
