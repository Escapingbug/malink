package id.my.anciety.malink.client

import id.my.anciety.malink.client.command.CommandCompletion
import id.my.anciety.malink.client.command.CommandOutcome
import id.my.anciety.malink.client.command.CommandOperation
import id.my.anciety.malink.client.command.CommandState
import id.my.anciety.malink.client.command.CommandView
import id.my.anciety.malink.security.malink.MatrixTransportBinding
import id.my.anciety.malink.security.malink.PairingOperation
import id.my.anciety.malink.security.malink.PairingPublicKey
import id.my.anciety.malink.security.malink.PairingRequest
import id.my.anciety.malink.security.malink.SignedPairingRequest
import id.my.anciety.malink.security.malink.TestP256Identity
import java.util.UUID
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class GatewayStateSyncPolicyTest {
    @Test
    fun `canonical Matrix revision suppresses command completion fallback`() {
        assertEquals(true, requiresGatewayConvergence(null, 4))
        assertEquals(true, requiresGatewayConvergence(3, 4))
        assertEquals(false, requiresGatewayConvergence(4, 4))
        assertEquals(false, requiresGatewayConvergence(5, 4))
        assertThrows(IllegalArgumentException::class.java) {
            requiresGatewayConvergence(0, -1)
        }
    }

    @Test
    fun `command recovery retries use bounded backoff`() {
        assertEquals(5_000L, commandRecoveryDelayMs(0))
        assertEquals(15_000L, commandRecoveryDelayMs(1))
        assertEquals(30_000L, commandRecoveryDelayMs(2))
        assertEquals(60_000L, commandRecoveryDelayMs(3))
        assertEquals(60_000L, commandRecoveryDelayMs(100))
        assertThrows(IllegalArgumentException::class.java) {
            commandRecoveryDelayMs(-1)
        }
    }

    @Test
    fun `published command asks the Gateway journal before scanning Matrix history`() = runBlocking {
        val steps = mutableListOf<String>()

        recoverPublishedCommandDelivery(
            isTerminal = { false },
            submitReconciliation = { steps += "journal" },
            scanTimeline = { steps += "timeline" },
        )

        assertEquals(listOf("journal", "timeline"), steps)
    }

    @Test
    fun `timeline timeout cannot cancel a submitted Gateway journal probe`() = runBlocking {
        val steps = mutableListOf<String>()
        val timelineFailures = mutableListOf<String>()

        recoverPublishedCommandDelivery(
            isTerminal = { false },
            submitReconciliation = { steps += "journal" },
            scanTimeline = {
                steps += "timeline"
                withTimeout(1) { delay(50) }
            },
            onTimelineFailure = { timelineFailures += it::class.java.simpleName },
        )

        assertEquals(listOf("journal", "timeline"), steps)
        assertEquals(listOf("TimeoutCancellationException"), timelineFailures)
    }

    @Test
    fun `failed journal submission retries after the legacy timeline fallback`() = runBlocking {
        val steps = mutableListOf<String>()
        val journalFailures = mutableListOf<String>()
        var attempts = 0

        recoverPublishedCommandDelivery(
            isTerminal = { false },
            submitReconciliation = {
                attempts += 1
                steps += "journal-$attempts"
                if (attempts == 1) throw IllegalStateException("send interrupted")
            },
            scanTimeline = { steps += "timeline" },
            onReconciliationFailure = { journalFailures += it.message.orEmpty() },
        )

        assertEquals(listOf("journal-1", "timeline", "journal-2"), steps)
        assertEquals(listOf("send interrupted"), journalFailures)
    }

    @Test
    fun `only an authoritative removed project retires a recovered command`() {
        assertEquals(
            true,
            shouldRetireRecoveredCommandForRemovedProject(
                CommandState.PUBLISHED,
                gatewayStateSynchronized = true,
                targetProjectId = "project-removed",
                targetStillAuthorized = false,
            ),
        )
        assertEquals(
            false,
            shouldRetireRecoveredCommandForRemovedProject(
                CommandState.PUBLISHED,
                gatewayStateSynchronized = false,
                targetProjectId = "project-removed",
                targetStillAuthorized = false,
            ),
        )
        assertEquals(
            false,
            shouldRetireRecoveredCommandForRemovedProject(
                CommandState.PUBLISHED,
                gatewayStateSynchronized = true,
                targetProjectId = "project-active",
                targetStillAuthorized = true,
            ),
        )
        assertEquals(
            false,
            shouldRetireRecoveredCommandForRemovedProject(
                CommandState.SUCCEEDED,
                gatewayStateSynchronized = true,
                targetProjectId = "project-removed",
                targetStillAuthorized = false,
            ),
        )
    }

    @Test
    fun `authoritative state convergence retries quickly then settles at a bounded interval`() {
        assertEquals(1_000L, authoritativeStateRefreshDelayMs(0))
        assertEquals(2_000L, authoritativeStateRefreshDelayMs(1))
        assertEquals(5_000L, authoritativeStateRefreshDelayMs(2))
        assertEquals(10_000L, authoritativeStateRefreshDelayMs(3))
        assertEquals(30_000L, authoritativeStateRefreshDelayMs(4))
        assertEquals(30_000L, authoritativeStateRefreshDelayMs(100))
        assertThrows(IllegalArgumentException::class.java) {
            authoritativeStateRefreshDelayMs(-1)
        }
    }

    @Test
    fun `pairing transaction retries the identical request on a bounded schedule`() {
        assertEquals(2_000L, pairingRequestRetryDelayMs(0))
        assertEquals(5_000L, pairingRequestRetryDelayMs(1))
        assertEquals(10_000L, pairingRequestRetryDelayMs(2))
        assertEquals(10_000L, pairingRequestRetryDelayMs(100))
        assertThrows(IllegalArgumentException::class.java) {
            pairingRequestRetryDelayMs(-1)
        }
    }

    @Test
    fun `confirmed pairing recovery follows the durable authorization lifetime`() {
        val identity = TestP256Identity.generate()
        val request = SignedPairingRequest(
            PairingRequest(
                requestId = "request-one",
                offerId = "offer-one",
                offerDigest = "A".repeat(43),
                gatewayId = "gateway-one",
                deviceId = identity.publicIdentity.keyId,
                deviceName = "Phone",
                deviceKey = identity.publicIdentity,
                deviceTransport = MatrixTransportBinding(
                    "https://matrix.example.org",
                    "!room:example.org",
                    "@phone:example.org",
                    "PHONE",
                    "A".repeat(43),
                ),
                requestedOperations = listOf(PairingOperation.PROMPT),
                issuedAt = 1_800_000_000_000L,
                expiresAt = 1_800_000_120_000L,
            ),
            id.my.anciety.malink.security.malink.PairingSignature(
                identity.publicIdentity.keyId,
                "A".repeat(86),
            ),
        )

        assertEquals(
            1_800_000_000_000L + 366L * 24 * 60 * 60_000,
            pairingRecoveryExpiresAt(request),
        )
    }

    @Test
    fun `only recovery-required commands are resumed in submission order`() {
        val commands = listOf(
            command("published", 2, CommandState.PUBLISHED),
            command("later", 3, CommandState.RECOVERY_REQUIRED),
            command("earlier", 1, CommandState.RECOVERY_REQUIRED),
            command("done", 4, CommandState.SUCCEEDED),
        )

        assertEquals(listOf("earlier", "later"), recoverableCommandIds(commands))
    }

    @Test
    fun `queued commands whose send job never started are resumed in submission order`() {
        val commands = listOf(
            command("later", 4, CommandState.QUEUED),
            command("ignored", 2, CommandState.RECOVERY_REQUIRED),
            command("earlier", 3, CommandState.QUEUED),
        )

        assertEquals(listOf("earlier", "later"), queuedCommandIds(commands))
    }

    private fun command(id: String, sequence: Long, state: CommandState): CommandView {
        val completion = if (state.isTerminal) {
            CommandCompletion(id, sequence, 4, CommandOutcome.SUCCEEDED)
        } else {
            null
        }
        return CommandView(
            operationId = "operation-$id",
            commandId = id,
            idempotencyKey = UUID.randomUUID().toString(),
            state = state,
            submittedAt = sequence,
            updatedAt = sequence,
            sequence = sequence,
            revision = if (state == CommandState.PUBLISHED || state.isTerminal) 4 else null,
            completion = completion,
        )
    }
}
