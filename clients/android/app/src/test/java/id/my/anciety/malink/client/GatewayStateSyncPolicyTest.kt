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
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class GatewayStateSyncPolicyTest {
    @Test
    fun `authoritative session lifecycle safely resolves matching mutations`() {
        assertEquals(
            true,
            projectedSessionLifecycleSatisfies(CommandOperation.SESSION_ARCHIVE, "archived"),
        )
        assertEquals(
            true,
            projectedSessionLifecycleSatisfies(CommandOperation.SESSION_DELETE, "deleted"),
        )
        assertEquals(
            true,
            projectedSessionLifecycleSatisfies(CommandOperation.SESSION_RESTORE, "active"),
        )
        assertEquals(
            false,
            projectedSessionLifecycleSatisfies(CommandOperation.SESSION_RESTORE, "archived"),
        )
        assertEquals(
            false,
            projectedSessionLifecycleSatisfies(CommandOperation.PROMPT, "active"),
        )
    }

    @Test
    fun `only permanent command delivery failures may retire an unaccepted command`() {
        assertEquals(
            true,
            commandDeliveryFailureIsPermanentlyUnsendable(IllegalArgumentException("invalid")),
        )
        assertEquals(
            false,
            commandDeliveryFailureIsPermanentlyUnsendable(java.io.IOException("offline")),
        )
        assertEquals(
            false,
            commandDeliveryFailureIsPermanentlyUnsendable(IllegalStateException("rejected")),
        )
    }

    @Test
    fun `pairing waits for the native Matrix transport instead of losing an early confirmation`() = runBlocking {
        val ready = CompletableDeferred<String>()
        val waiting = async {
            awaitPairingTransportIdentity(
                current = { null },
                ready = ready,
                timeoutMs = 1_000,
            )
        }

        delay(10)
        assertEquals(false, waiting.isCompleted)
        ready.complete("matrix-device-ready")

        assertEquals("matrix-device-ready", waiting.await())
    }

    @Test
    fun `pairing uses the latest available transport without waiting`() = runBlocking {
        val ready = CompletableDeferred<String>().also { it.complete("stale-device") }

        assertEquals(
            "current-device",
            awaitPairingTransportIdentity(
                current = { "current-device" },
                ready = ready,
                timeoutMs = 1_000,
            ),
        )
    }

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
    fun `accepted Gateway journal probe recovers a signed reply omitted by the live timeline`() = runBlocking {
        val steps = mutableListOf<String>()

        recoverPublishedCommandDelivery(
            isTerminal = { false },
            submitReconciliation = { steps += "journal" },
            awaitReconciliation = { steps += "wait" },
            scanTimeline = { steps += "timeline" },
        )

        assertEquals(listOf("journal", "wait", "timeline"), steps)
    }

    @Test
    fun `published command gives a signed journal result priority over timeline scanning`() = runBlocking {
        val steps = mutableListOf<String>()
        var terminal = false

        recoverPublishedCommandDelivery(
            isTerminal = { terminal },
            submitReconciliation = { steps += "journal" },
            awaitReconciliation = {
                steps += "wait"
                terminal = true
            },
            scanTimeline = { steps += "timeline" },
        )

        assertEquals(listOf("journal", "wait"), steps)
    }

    @Test
    fun `legacy timeline timeout cannot prevent a second Gateway journal attempt`() = runBlocking {
        val steps = mutableListOf<String>()
        val timelineFailures = mutableListOf<String>()
        var attempts = 0

        recoverPublishedCommandDelivery(
            isTerminal = { false },
            submitReconciliation = {
                attempts += 1
                steps += "journal-$attempts"
                if (attempts == 1) throw IllegalStateException("send interrupted")
            },
            scanTimeline = {
                steps += "timeline"
                withTimeout(1) { delay(50) }
            },
            onTimelineFailure = { timelineFailures += it::class.java.simpleName },
        )

        assertEquals(listOf("journal-1", "timeline", "journal-2"), steps)
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
    fun `legacy timeline recovery skips concurrent callers instead of queuing them`() = runBlocking {
        val gate = LegacyTimelineRecoveryGate()
        val entered = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        val first = async {
            gate.runIfIdle {
                entered.complete(Unit)
                release.await()
            }
        }

        entered.await()
        assertEquals(false, gate.runIfIdle { error("A busy recovery must not run.") })
        release.complete(Unit)
        assertEquals(true, first.await())
        assertEquals(true, gate.runIfIdle { })
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
    fun `published recovery reuses an already synchronized Gateway projection`() {
        assertEquals(false, requiresProjectionRefreshForCommandRecovery(true))
        assertEquals(true, requiresProjectionRefreshForCommandRecovery(false))
    }

    @Test
    fun `journal reconciliation wait is bounded and observes terminal state`() = runBlocking {
        var checks = 0

        val terminal = awaitPublishedCommandReconciliation(
            isTerminal = {
                checks += 1
                checks >= 2
            },
            timeoutMs = 1_000,
            pollIntervalMs = 1,
        )

        assertEquals(true, terminal)
        assertEquals(true, checks >= 2)
    }

    @Test
    fun `journal reconciliation wait reports a still pending result without scanning`() = runBlocking {
        val terminal = awaitPublishedCommandReconciliation(
            isTerminal = { false },
            timeoutMs = 1,
            pollIntervalMs = 1,
        )

        assertEquals(false, terminal)
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

    @Test
    fun `published commands resume journal recovery without a WebView`() {
        val commands = listOf(
            command("later", 4, CommandState.RUNNING),
            command("ignored", 2, CommandState.RECOVERY_REQUIRED),
            command("earlier", 3, CommandState.PUBLISHED),
        )

        assertEquals(listOf("earlier", "later"), publishedRecoveryCommandIds(commands))
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
