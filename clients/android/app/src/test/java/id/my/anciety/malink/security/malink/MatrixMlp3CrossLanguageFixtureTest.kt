package id.my.anciety.malink.security.malink

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

/** Static fixture generated only by packages/security's TypeScript implementation. */
class MatrixMlp3CrossLanguageFixtureTest {
    private val root = Json.parseToJsonElement(FIXTURE).jsonObject
    private val gatewayKey = PairingPublicKey(
        GATEWAY_ID,
        EcPublicJwk(GATEWAY_X, GATEWAY_Y),
    )
    private val recipient = TestP256Identity.fromPrivateJwk(
        EcPublicJwk(RECIPIENT_X, RECIPIENT_Y),
        RECIPIENT_D,
    )

    @Test
    fun `opens TypeScript MLP3 key grant and signed project event`() {
        val grant = MatrixMlp3Protocol.openProjectKeyGrant(
            state = root.getValue("state").jsonObject,
            identity = recipient,
            gatewayKey = gatewayKey,
            expectedWorkspaceId = WORKSPACE_ID,
            expectedRoomId = ROOM_ID,
            expectedCertificateId = CERTIFICATE_ID,
        )

        assertEquals(PROJECT_ID, grant.projectId)
        assertEquals("project-key-cross-v3", grant.activeKeyId)
        assertArrayEquals(ByteArray(32) { it.toByte() }, grant.activeKey().key)

        val opened = MatrixMlp3Protocol.openContent(
            extension = root.getValue("extension").jsonObject,
            roomId = ROOM_ID,
            projectId = PROJECT_ID,
            keys = grant,
        )
        assertEquals("event-cross-v3", opened.logicalEventId)
        assertEquals(
            "signed_event",
            opened.plaintext.getValue("kind").jsonPrimitive.content,
        )
        val signed = opened.plaintext.getValue("value").jsonObject
        val event = MatrixMlp3Protocol.verifyGatewayEvent(
            signed,
            gatewayKey,
            WORKSPACE_ID,
            PROJECT_ID,
        )
        assertEquals(
            "TypeScript v3 fixture 😀",
            event.getValue("payload").jsonObject.getValue("body").jsonPrimitive.content,
        )
    }

    @Test
    fun `TypeScript MLP3 fixture is bound to room certificate and Gateway signature`() {
        assertThrows(IllegalArgumentException::class.java) {
            MatrixMlp3Protocol.openProjectKeyGrant(
                root.getValue("state").jsonObject,
                recipient,
                gatewayKey,
                WORKSPACE_ID,
                "!other:example.org",
                CERTIFICATE_ID,
            )
        }
        val grant = MatrixMlp3Protocol.openProjectKeyGrant(
            root.getValue("state").jsonObject,
            recipient,
            gatewayKey,
            WORKSPACE_ID,
            ROOM_ID,
            CERTIFICATE_ID,
        )
        assertThrows(IllegalArgumentException::class.java) {
            MatrixMlp3Protocol.openContent(
                root.getValue("extension").jsonObject,
                "!other:example.org",
                PROJECT_ID,
                grant,
            )
        }
        val opened = MatrixMlp3Protocol.openContent(
            root.getValue("extension").jsonObject,
            ROOM_ID,
            PROJECT_ID,
            grant,
        )
        val signed = opened.plaintext.getValue("value").jsonObject
        val wrongGateway = TestP256Identity.generate().publicIdentity
        assertThrows(MalinkSecurityException::class.java) {
            MatrixMlp3Protocol.verifyGatewayEvent(
                signed,
                wrongGateway,
                WORKSPACE_ID,
                PROJECT_ID,
            )
        }
    }

    private companion object {
        const val GATEWAY_ID = "MsGTFCvsPKYo6KybfH4t9cOai5kX99MDFyG5fJ4cs94"
        const val GATEWAY_X = "1siSvHSRoOQTkfn_uzHGRR7mlrF14hRSidQrrkSjQ7w"
        const val GATEWAY_Y = "JLwmVQAUZvm_JOBQI6wBY_h7sNz5TuA2ICpclQk3twA"
        const val RECIPIENT_X = "mWVAu202e4bily57jjvkdi6HGWmzSzGNryF1nmBDIBU"
        const val RECIPIENT_Y = "5wEWEx43GLsL1iSguFuTYCKignMfvdyP3NaVLm7sU7s"
        const val RECIPIENT_D = "YHhLk-Z1ytpzfgmrDGtysPBF6S1y1fb87EduZVIJkSo"
        const val WORKSPACE_ID = "workspace-cross-v3"
        const val PROJECT_ID = "project-cross-v3"
        const val ROOM_ID = "!project-v3:example.org"
        const val CERTIFICATE_ID = "certificate-cross-v3"
        val FIXTURE = """
{"gatewayId":"MsGTFCvsPKYo6KybfH4t9cOai5kX99MDFyG5fJ4cs94","recipient":{"x":"mWVAu202e4bily57jjvkdi6HGWmzSzGNryF1nmBDIBU","y":"5wEWEx43GLsL1iSguFuTYCKignMfvdyP3NaVLm7sU7s","d":"YHhLk-Z1ytpzfgmrDGtysPBF6S1y1fb87EduZVIJkSo","keyId":"gWGL3Um_jFFfOGTMsZ75uZCdCBZYdp_Gc3_WN37W1Tg"},"state":{"kind":"project.key_grant","version":3,"workspaceId":"workspace-cross-v3","projectId":"project-cross-v3","roomId":"!project-v3:example.org","deviceId":"gWGL3Um_jFFfOGTMsZ75uZCdCBZYdp_Gc3_WN37W1Tg","certificateId":"certificate-cross-v3","grantId":"grant-cross-v3","sealedGrant":{"envelope":{"kind":"malink.project-key-grant-envelope","version":3,"grantId":"grant-cross-v3","workspaceId":"workspace-cross-v3","projectId":"project-cross-v3","roomId":"!project-v3:example.org","deviceId":"gWGL3Um_jFFfOGTMsZ75uZCdCBZYdp_Gc3_WN37W1Tg","certificateId":"certificate-cross-v3","senderKeyId":"MsGTFCvsPKYo6KybfH4t9cOai5kX99MDFyG5fJ4cs94","recipientKeyId":"gWGL3Um_jFFfOGTMsZ75uZCdCBZYdp_Gc3_WN37W1Tg","nonce":"vqBSQ55_3DZ0JJKJ","ciphertext":"hsX-XZ3POqljGjgNGiPMKVYxDqwJ00W7VWSgtrgF3GLfJQ6Qvhj1gjl_22Hk_aeQ1pOSvA2KpYXoaewpCSwb84gf6CRikqzqhVdXYjGzH3ScVQ-VsYuVN5HKbXaleBwO_FBuqc0sH1iLPbA4QK5S9QsA-V9TbXR6kHbtppa6rr71FDhP6PmAj4xlJNOvIZ7NJ3BN_DTsC5YDMxmE07jrUvwXSZbch1h6wlhvFWudERUYayC06lOtJtI3dlmIslACykXVoZa67OnMrNdo3oeTU3taybjzIyDRPNEM-5YoMtGH_Gdcs3Ue6wL3UEq4M59D9HrshBpxrmhuy_ngGaNvNQcycH1GAjYWDRpjF1K2LEmqJ0DHzOuXWn5hz49To_7aNNhXd9Fn80dKLKun75g6SfnsSA4SfXqSe1T7r92osiPX1El3Elrw6aWUJoi82kJWjTZtB7QWi2XCZAXrHvAQ19sP7vXj8FJsGMxtJdYPCD63skAoRoqL2bK0qnNEqwu0woLI7hQYYq1mo2sbIWZNMGGSPazhh0DJC_g"},"signature":{"algorithm":"ES256","keyId":"MsGTFCvsPKYo6KybfH4t9cOai5kX99MDFyG5fJ4cs94","value":"dR6z8qdKEl9p2ow0TVrRk1ulWvFMLWpSrDqYDcH9Kx_sdcNC0jZfCU0V-zuje6CJi3PuyDi6tVl7adWmBffdVw"}}},"extension":{"version":3,"envelope":{"kind":"malink.project-envelope","version":3,"roomId":"!project-v3:example.org","projectId":"project-cross-v3","keyId":"project-key-cross-v3","logicalEventId":"event-cross-v3","nonce":"-P6_7dJuZDZ4u0DZ","ciphertext":"jCm_34j2th3jujoG3IK79Rm4ya_VLK5Ka0x7CtrIAtidKnCp9qHsLEsKzbb62oczSCHWmQYMUfAPJnoqTYtP-lbBxED_3vq2ifRZ2Uz64aVkwxN8gzaMWyYkaCFtTwRUX_lErtnDTxZO0UFL7eQbHOuoq-eDcv0abrvHl6FkQxUNYyweKF8JJuVY4B75JVJIbogulaX1fmMWWtOt0RFqd306zAGrKVRhU4HDSr9PwzlCY8T2VtjiSjLRkQPvb_RacrrtYkK97wrZQ1X_nQ9MSU_AHJR1si1mVvbPfcWhjqXQjkTZBYpRbrPHGN24fthZP0qEQOGI_E3SbFf5c-weAwajo1brdFwpvS9eaeBii7Qu-WJOn8WyGkDfrvnThlB-MerJXJzdtlVhWCOpcfB6Wwp3_pyw2gti6o-8-l680KSxeU3urzTx9XGgEryao5AffZJFj2V8JTdxRhIze9ZPJXR299i6FaS2w5jEeDzgJgQk9_JWgyHKSTN1-XZYUYiBYa5s_TZ78UyTwgCfBEAl3yQZsLDr5Rs_IcHKgqQv6wpaFM1wFZzn7rKZuIpkW0wk4UsHifITbZyDAJxowD8Kr4VMLTxmoFuEwni9IIp-IEY9_sT1qymhwrS6sQRmEmxvaocjtJKMftXLcF724jzRA4QVD_6fn8gMylLZTjA1mKqaos18atsd8gD0SqhsImIMcD9yFdUInaVJzm2U2uU0yYOjMunLK_PMB4heKGXAUhscsHUU3MQgB2MUwASY51sW_fSgsQ2F06ea2A3GCz6NM_hr3fT0ucK0PWrRB_d5YwukPbN7J6uRNEFzQKNsBw3jsvKrCwf__XMhX2gI1N7srEBSlOkhA4_lTcfxrtWEd2J94HQa7-6PDxe5B-Bfryi_0-cgAKWwYdqsFN4vP2MZoInUTKP74Ac3yNa-aXqLT45tk1VKVVJFcpupv6uW"}}}
""".trimIndent()
    }
}
