package id.my.anciety.malink.client

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

internal const val GATEWAY_RETIRE_MINIMUM_BUILD =
    "gateway-2026.09.03-081840Z-44d8e8a"

private val timestampedGatewayBuild =
    Regex("^gateway-(\\d{4}\\.\\d{2}\\.\\d{2}-\\d{6}Z)-[0-9a-f]{7,64}$")

internal fun gatewayBuildSupportsWorkspaceRetirement(buildId: String?): Boolean {
    if (buildId == null) return false
    if (buildId == GATEWAY_RETIRE_MINIMUM_BUILD) return true
    val candidate = timestampedGatewayBuild.matchEntire(buildId)?.groupValues?.get(1)
    val minimum = timestampedGatewayBuild
        .matchEntire(GATEWAY_RETIRE_MINIMUM_BUILD)
        ?.groupValues
        ?.get(1)
    return candidate != null && minimum != null && candidate > minimum
}

internal fun requireGatewayRetirementAuthorityCompatible(
    signedDirectory: JsonObject?,
    authorityProjectId: String?,
    retiredGatewayNodeId: String,
) {
    requireNotNull(authorityProjectId) {
        "Select another Workspace computer before removing this one."
    }
    val directory = signedDirectory?.get("directory") as? JsonObject
        ?: throw IllegalStateException(
            "The Workspace computer list is still synchronizing. Try again after it loads.",
        )
    val gateways = directory["gateways"] as? JsonArray
        ?: throw IllegalStateException("The Workspace computer list is unavailable.")
    val authority = gateways
        .mapNotNull { it as? JsonObject }
        .firstOrNull { gateway ->
            val projects = gateway["projects"] as? JsonArray ?: JsonArray(emptyList())
            projects.any { project ->
                ((project as? JsonObject)?.get("projectId") as? JsonPrimitive)
                    ?.contentOrNull == authorityProjectId
            }
        }
        ?: throw IllegalStateException(
            "The selected removal computer is no longer available. Refresh the Workspace.",
        )
    val authorityNodeId = (authority["gatewayNodeId"] as? JsonPrimitive)?.contentOrNull
    require(authorityNodeId != retiredGatewayNodeId) {
        "Another Workspace computer must authorize this removal."
    }
    val buildId = (authority["buildId"] as? JsonPrimitive)?.contentOrNull
    if (!gatewayBuildSupportsWorkspaceRetirement(buildId)) {
        val gatewayName = (authority["gatewayName"] as? JsonPrimitive)
            ?.contentOrNull
            ?.takeIf(String::isNotBlank)
            ?: "the online Gateway"
        throw IllegalStateException(
            "Update $gatewayName before removing this computer. Its current Gateway version " +
                "cannot return a verified result for this action.",
        )
    }
}
