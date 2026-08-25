package id.my.anciety.malink.security.malink

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class GatewayTransportTrustTest {
    private val pinnedKey = PairingPublicKey(
        KEY_ID,
        EcPublicJwk(GATEWAY_X, GATEWAY_Y, ext = true, keyOps = listOf("verify")),
    )
    private val rotation = GatewayTransportCodec.parseRotation(ROTATION_FIXTURE)
    private val snapshot = GatewayTransportCodec.parseSnapshot(SNAPSHOT_FIXTURE)

    @Test
    fun `verifies TypeScript rotation and snapshot fixtures and advances trust`() {
        val initial = GatewayTransportTrustState(
            gatewayId = "gateway-1",
            gatewayKey = pinnedKey,
            currentTransport = rotation.rotation.previousTransport,
            lastIssuedAt = NOW,
        )
        val rotated = initial.applyRotation(rotation, NOW + 30 * DAY)
        assertEquals("GATEWAY2", rotated.currentTransport.deviceId)
        assertEquals(rotation.rotation.issuedAt, rotated.lastIssuedAt)

        val recovered = rotated.applySnapshot(snapshot, NOW + 30 * DAY)
        assertEquals("GATEWAY3", recovered.currentTransport.deviceId)
        assertEquals(snapshot.snapshot.issuedAt, recovered.lastIssuedAt)
    }

    @Test
    fun `rejects replay wrong pin changed scope invalid signature and expiry`() {
        assertCode(SecurityErrorCode.REPLAY) {
            GatewayTransportSecurity.verifyRotation(
                rotation,
                pinnedKey,
                "gateway-1",
                rotation.rotation.previousTransport,
                issuedAfter = rotation.rotation.issuedAt,
                now = NOW,
            )
        }

        val attacker = TestP256Identity.generate().publicIdentity
        assertCode(SecurityErrorCode.BINDING_MISMATCH) {
            GatewayTransportSecurity.verifyRotation(
                rotation,
                attacker,
                "gateway-1",
                rotation.rotation.previousTransport,
                now = NOW,
            )
        }

        assertCode(SecurityErrorCode.BINDING_MISMATCH) {
            GatewayTransportSecurity.verifySnapshot(
                snapshot,
                pinnedKey,
                "gateway-1",
                snapshot.snapshot.transport.copy(roomId = "!attacker:example.org"),
                now = NOW,
            )
        }

        val changed = Base64Url.decode(rotation.signature.value).also {
            it[0] = (it[0].toInt() xor 1).toByte()
        }
        assertCode(SecurityErrorCode.INVALID_SIGNATURE) {
            GatewayTransportSecurity.verifyRotation(
                rotation.copy(signature = rotation.signature.copy(value = Base64Url.encode(changed))),
                pinnedKey,
                "gateway-1",
                rotation.rotation.previousTransport,
                now = NOW,
            )
        }

        assertCode(SecurityErrorCode.EXPIRED) {
            GatewayTransportSecurity.verifyRotation(
                rotation,
                pinnedKey,
                "gateway-1",
                rotation.rotation.previousTransport,
                now = rotation.rotation.expiresAt,
            )
        }
    }

    @Test
    fun `strict codecs reject unknown fields and non-device rotations`() {
        assertThrows(IllegalArgumentException::class.java) {
            GatewayTransportCodec.parseRotation(
                ROTATION_FIXTURE.replaceFirst("\"rotation\":{", "\"rotation\":{\"unknown\":true,"),
            )
        }
        val unchanged = ROTATION_FIXTURE
            .replace("\"deviceId\":\"GATEWAY2\"", "\"deviceId\":\"GATEWAY1\"")
            .replace(
                "\"ed25519\":\"replacement-ed25519-fingerprint\"",
                "\"ed25519\":\"gateway-ed25519-fingerprint\"",
            )
        assertThrows(IllegalArgumentException::class.java) {
            GatewayTransportCodec.parseRotation(unchanged)
        }
    }

    private fun assertCode(code: SecurityErrorCode, block: () -> Unit) {
        val error = assertThrows(MalinkSecurityException::class.java, block)
        assertEquals(code, error.code)
    }

    private companion object {
        const val NOW = 1_800_000_000_000L
        const val DAY = 24 * 60 * 60_000L
        const val KEY_ID = "MsGTFCvsPKYo6KybfH4t9cOai5kX99MDFyG5fJ4cs94"
        const val GATEWAY_X = "1siSvHSRoOQTkfn_uzHGRR7mlrF14hRSidQrrkSjQ7w"
        const val GATEWAY_Y = "JLwmVQAUZvm_JOBQI6wBY_h7sNz5TuA2ICpclQk3twA"
        const val ROTATION_FIXTURE = """{"rotation":{"kind":"malink.gateway.device-rotation","version":1,"rotationId":"rotation-cross-1","gatewayId":"gateway-1","gatewayKeyId":"MsGTFCvsPKYo6KybfH4t9cOai5kX99MDFyG5fJ4cs94","previousTransport":{"homeserver":"https://matrix.example.org","roomId":"!private:example.org","userId":"@gateway:example.org","deviceId":"GATEWAY1","ed25519":"gateway-ed25519-fingerprint"},"nextTransport":{"homeserver":"https://matrix.example.org","roomId":"!private:example.org","userId":"@gateway:example.org","deviceId":"GATEWAY2","ed25519":"replacement-ed25519-fingerprint"},"issuedAt":1800000000010,"expiresAt":1831622400000},"signature":{"algorithm":"ES256","keyId":"MsGTFCvsPKYo6KybfH4t9cOai5kX99MDFyG5fJ4cs94","value":"UijuS6jO1QyhiXNW8xTxdUBH4mNeeMiZYvrOusHFkWNlDVsfPVZieGYWHr0tv9jx831Wntgm57ZSh1n2uOv6xw"}}"""
        const val SNAPSHOT_FIXTURE = """{"snapshot":{"kind":"malink.gateway.transport-snapshot","version":1,"snapshotId":"snapshot-cross-1","gatewayId":"gateway-1","gatewayKeyId":"MsGTFCvsPKYo6KybfH4t9cOai5kX99MDFyG5fJ4cs94","transport":{"homeserver":"https://matrix.example.org","roomId":"!private:example.org","userId":"@gateway:example.org","deviceId":"GATEWAY3","ed25519":"snapshot-ed25519-fingerprint"},"issuedAt":1800000000020,"expiresAt":1831622400000},"signature":{"algorithm":"ES256","keyId":"MsGTFCvsPKYo6KybfH4t9cOai5kX99MDFyG5fJ4cs94","value":"HaDJXiVCTNu9BFbpEaQcY7X4Z-EhmMgC7rkj3ZLgM4gtIvcUfLxFfpSTC42Mm_lhW9P4kGbuR-HkUFrw6O4ZxQ"}}"""
    }
}
