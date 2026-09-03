package id.my.anciety.malink.client

import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class GatewayCommandCompatibilityTest {
    @Test
    fun `retirement requires the first compatible or a later signed release build`() {
        assertFalse(gatewayBuildSupportsWorkspaceRetirement(null))
        assertFalse(gatewayBuildSupportsWorkspaceRetirement("development"))
        assertFalse(
            gatewayBuildSupportsWorkspaceRetirement(
                "gateway-2026.09.03-061645Z-8b2afef",
            ),
        )
        assertTrue(gatewayBuildSupportsWorkspaceRetirement(GATEWAY_RETIRE_MINIMUM_BUILD))
        assertTrue(
            gatewayBuildSupportsWorkspaceRetirement(
                "gateway-2026.09.04-000001Z-abcdef0",
            ),
        )
    }

    @Test
    fun `legacy authority is rejected before a retirement enters the native outbox`() {
        val error = assertThrows(IllegalStateException::class.java) {
            requireGatewayRetirementAuthorityCompatible(
                signedDirectory = directory("gateway-2026.09.03-061645Z-8b2afef"),
                authorityProjectId = "project-online",
                retiredGatewayNodeId = "gateway-offline",
            )
        }

        assertTrue(error.message.orEmpty().contains("Update Online Mac"))
        assertTrue(error.message.orEmpty().contains("verified result"))
    }

    @Test
    fun `compatible authority accepts a retirement routed through another node`() {
        requireGatewayRetirementAuthorityCompatible(
            signedDirectory = directory(GATEWAY_RETIRE_MINIMUM_BUILD),
            authorityProjectId = "project-online",
            retiredGatewayNodeId = "gateway-offline",
        )
    }

    private fun directory(buildId: String) = buildJsonObject {
        put("directory", buildJsonObject {
            put("gateways", buildJsonArray {
                add(buildJsonObject {
                    put("gatewayNodeId", "gateway-online")
                    put("gatewayName", "Online Mac")
                    put("buildId", buildId)
                    put("projects", buildJsonArray {
                        add(buildJsonObject { put("projectId", "project-online") })
                    })
                })
                add(buildJsonObject {
                    put("gatewayNodeId", "gateway-offline")
                    put("gatewayName", "Offline Mac")
                    put("buildId", buildId)
                    put("projects", buildJsonArray {
                        add(buildJsonObject { put("projectId", "project-offline") })
                    })
                })
            })
        })
    }
}
