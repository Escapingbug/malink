package id.my.anciety.malink.client

import id.my.anciety.malink.matrix.MatrixIdentifiers
import id.my.anciety.malink.matrix.PublicMatrixSession
import id.my.anciety.malink.security.malink.GatewayTrust
import id.my.anciety.malink.security.malink.MatrixTransportBinding
import id.my.anciety.malink.security.malink.MatrixMlp3Protocol
import id.my.anciety.malink.security.malink.PairingSecurity
import id.my.anciety.malink.security.malink.SignedPairingOffer
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * Distinguishes a missing/replaced Matrix login from a new, untrusted device.
 *
 * The Malink device identity and pinned Gateway key survive this repair. A
 * fresh Matrix login may replace only the device-side transport, and only an
 * invitation from the already pinned Gateway route can authorize that change.
 */
internal object MatrixSessionRepairPolicy {
    /**
     * A repair keeps the pinned Gateway identity and can reuse Room State that
     * this newly bootstrapped Matrix connection already authenticated with that
     * identity. A first-time pairing has no such trust boundary and must wait
     * for a post-pairing authoritative refresh.
     */
    fun retainSynchronizedGatewayState(
        repairingSession: Boolean,
        synchronizedBeforeTrustCommit: Boolean,
    ): Boolean = repairingSession && synchronizedBeforeTrustCommit

    fun required(trust: GatewayTrust?, session: PublicMatrixSession?): Boolean {
        return requiredForTransport(trust?.certificate?.deviceTransport, session)
    }

    fun requiredForTransport(
        expected: MatrixTransportBinding?,
        session: PublicMatrixSession?,
    ): Boolean {
        if (expected == null) return false
        if (session == null) return true
        return MatrixIdentifiers.normalizeHomeserver(expected.homeserver) !=
            MatrixIdentifiers.normalizeHomeserver(session.homeserver) ||
            expected.roomId != session.roomBinding.roomId ||
            expected.userId != session.userId ||
            expected.deviceId != session.matrixDeviceId
    }

    fun requirePinnedOffer(trust: GatewayTrust, offer: SignedPairingOffer) {
        require(offer.offer.gatewayId == trust.gatewayId) {
            "Connection repair must use an invitation from the approved Gateway."
        }
        require(offer.offer.gatewayKey.keyId == trust.gatewayKey.keyId) {
            "Connection repair cannot replace the approved Gateway identity."
        }
        require(sameTransport(offer.offer.gatewayTransport, trust.transportTrust.currentTransport)) {
            "Connection repair must use the Gateway's currently approved Matrix route."
        }
    }

    /**
     * Account convergence may be authorized by any node in the already signed
     * Workspace directory. Joined Gateway nodes share the Workspace root key,
     * but retain distinct Matrix transports and node IDs.
     */
    fun requireWorkspaceOffer(
        trust: GatewayTrust,
        offer: SignedPairingOffer,
        signedDirectory: JsonObject? = trust.response.response.gatewayDirectory,
    ) {
        require(offer.offer.gatewayId == trust.gatewayId) {
            "Account rejoin must use an invitation from the approved Workspace."
        }
        require(offer.offer.gatewayKey.keyId == trust.gatewayKey.keyId) {
            "Account rejoin cannot replace the approved Workspace identity."
        }
        PairingSecurity.verifyOffer(offer, trust.gatewayKey)
        val availableDirectory = signedDirectory ?: throw IllegalArgumentException(
                "The signed Workspace Gateway directory is unavailable.",
            )
        val directory = MatrixMlp3Protocol.verifyWorkspaceGatewayDirectory(
            availableDirectory,
            trust.gatewayKey,
            trust.gatewayId,
        )
        val nodeId = offer.offer.gatewayNodeId ?: offer.offer.gatewayId
        val descriptor = (directory["gateways"] as JsonArray)
            .map { it as JsonObject }
            .firstOrNull { it["gatewayNodeId"]?.jsonPrimitive?.content == nodeId }
            ?: throw IllegalArgumentException(
                "The invitation Gateway is not in the signed Workspace directory.",
            )
        require(descriptor["publicKey"] == offer.offer.gatewayKey.toJson()) {
            "The invitation Gateway key does not match the signed Workspace directory."
        }
        require(descriptor["transport"] == offer.offer.gatewayTransport.toJson()) {
            "The invitation Gateway route does not match the signed Workspace directory."
        }
    }

    fun requireReplacement(trust: GatewayTrust, replacement: MatrixTransportBinding) {
        val previous = trust.certificate.deviceTransport
        require(
            replacement.deviceId != previous.deviceId || replacement.ed25519 != previous.ed25519,
        ) { "Connection repair must replace the lost Matrix device credentials." }
    }

    private fun sameTransport(left: MatrixTransportBinding, right: MatrixTransportBinding): Boolean =
        MatrixIdentifiers.normalizeHomeserver(left.homeserver) ==
            MatrixIdentifiers.normalizeHomeserver(right.homeserver) &&
            left.roomId == right.roomId &&
            left.userId == right.userId &&
            left.deviceId == right.deviceId &&
            left.ed25519 == right.ed25519
}
