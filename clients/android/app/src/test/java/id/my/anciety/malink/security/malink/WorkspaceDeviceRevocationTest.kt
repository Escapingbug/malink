package id.my.anciety.malink.security.malink

import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class WorkspaceDeviceRevocationTest {
    @Test
    fun `accepts only the root-signed revocation for this Workspace`() {
        val gateway = TestP256Identity.generate()
        val revocation = buildJsonObject {
            put("kind", "malink.workspace.device-revocation")
            put("version", 1)
            put("revocationId", "revocation-1")
            put("workspaceId", "workspace-1")
            put("deviceId", "device-1")
            put("certificateId", "certificate-1")
            put("reason", "replaced")
            put("issuedAt", 1_000)
        }
        val preimage = buildJsonObject {
            put("domain", "malink.workspace.device-revocation.v1")
            put("document", revocation)
        }
        val signed = buildJsonObject {
            put("revocation", revocation)
            put("signature", buildJsonObject {
                put("algorithm", "ES256")
                put("keyId", gateway.publicIdentity.keyId)
                put("value", Base64Url.encode(gateway.sign(CanonicalJson.bytes(preimage))))
            })
        }

        val verified = MatrixMlp3Protocol.verifyWorkspaceDeviceRevocation(
            signed,
            gateway.publicIdentity,
            "workspace-1",
        )

        assertEquals("device-1", verified.getValue("deviceId").toString().trim('"'))
        assertThrows(IllegalArgumentException::class.java) {
            MatrixMlp3Protocol.verifyWorkspaceDeviceRevocation(
                signed,
                gateway.publicIdentity,
                "another-workspace",
            )
        }
    }
}
