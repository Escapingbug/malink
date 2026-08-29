package id.my.anciety.malink.client.command

import java.io.IOException
import java.util.ArrayDeque
import java.util.UUID
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class DurableCommandOutboxTest {
    @Test
    fun `restart preserves a queued command before its sender starts`() {
        val fixture = fixture()
        val receipt = fixture.outbox.enqueue(UUID.randomUUID().toString(), payload("session.create"))

        val restored = DurableCommandOutbox(fixture.store, fixture.clock, fixture.ids)
        val transmission = checkNotNull(restored.claimForTransmission(receipt.commandId))

        assertEquals(receipt.commandId, transmission.commandId)
        assertEquals(receipt.operationId, transmission.operationId)
        assertFalse(transmission.recovery)
    }

    @Test
    fun `duplicate idempotency returns the original durable operation`() {
        val fixture = fixture()
        val key = UUID.randomUUID().toString()
        val first = fixture.outbox.enqueue(key, payload("prompt", "hello"), "session-1")

        val duplicate = fixture.outbox.enqueue(
            key,
            buildJsonObject {
                put("text", "hello")
                put("operation", "prompt")
                put("sessionId", "session-1")
            },
            "session-1",
        )

        assertEquals(first, duplicate)
        assertEquals(1, fixture.outbox.list().size)
        assertThrows(CommandIdempotencyConflictException::class.java) {
            fixture.outbox.enqueue(key, payload("prompt", "different"), "session-1")
        }
    }

    @Test
    fun `process restart recovers an uncertain Matrix send with the same identity`() {
        val fixture = fixture()
        val receipt = fixture.outbox.enqueue(UUID.randomUUID().toString(), payload("session.create"))
        val first = checkNotNull(fixture.outbox.claimForTransmission(receipt.commandId))

        val restored = DurableCommandOutbox(fixture.store, fixture.clock, fixture.ids)
        assertEquals(CommandState.RECOVERY_REQUIRED, restored.get(receipt.commandId)?.state)
        val retry = checkNotNull(restored.claimRecovery(receipt.commandId))

        assertEquals(first.commandId, retry.commandId)
        assertEquals(first.operationId, retry.operationId)
        assertEquals(first.issuedAt, retry.issuedAt)
        assertTrue(retry.recovery)
    }

    @Test
    fun `independent commands can be in flight and published concurrently`() {
        val fixture = fixture()
        val first = fixture.outbox.enqueue(UUID.randomUUID().toString(), payload("prompt", "one"))
        val second = fixture.outbox.enqueue(UUID.randomUUID().toString(), payload("prompt", "two"))

        fixture.outbox.claimForTransmission(first.commandId)
        fixture.outbox.claimForTransmission(second.commandId)
        assertTrue(fixture.outbox.recordPublished(first.commandId, "\$event-one"))
        assertTrue(fixture.outbox.recordPublished(second.commandId, "\$event-two"))

        assertEquals(CommandState.PUBLISHED, fixture.outbox.get(first.commandId)?.state)
        assertEquals(CommandState.PUBLISHED, fixture.outbox.get(second.commandId)?.state)
        assertNotEquals(first.commandId, second.commandId)
    }

    @Test
    fun `Matrix publication stops automatic retry and survives restart`() {
        val fixture = fixture()
        val receipt = fixture.outbox.enqueue(UUID.randomUUID().toString(), payload("session.create"))
        val sent = checkNotNull(fixture.outbox.claimForTransmission(receipt.commandId))
        fixture.outbox.recordPublished(receipt.commandId, "\$event-published")

        val restored = DurableCommandOutbox(fixture.store, fixture.clock, fixture.ids)
        assertEquals(CommandState.PUBLISHED, restored.get(receipt.commandId)?.state)
        assertNull(restored.claimRecovery(receipt.commandId))
        assertEquals(sent.issuedAt, fixture.store.load()?.commands?.single()?.createdAt)
    }

    @Test
    fun `signed Gateway progress is not represented as an acknowledgement`() {
        val fixture = fixture()
        val receipt = fixture.outbox.enqueue(UUID.randomUUID().toString(), payload("prompt", "hello"))
        fixture.outbox.claimForTransmission(receipt.commandId)
        fixture.outbox.recordPublished(receipt.commandId, "\$event-progress")

        assertTrue(fixture.outbox.recordProgress(receipt.commandId, "session-1"))
        assertEquals(CommandState.RUNNING, fixture.outbox.get(receipt.commandId)?.state)
    }

    @Test
    fun `terminal event can arrive before the Matrix send call returns`() {
        val fixture = fixture()
        val receipt = fixture.outbox.enqueue(UUID.randomUUID().toString(), payload("session.create"))
        fixture.outbox.claimForTransmission(receipt.commandId)
        val completion = CommandCompletion(
            commandId = receipt.commandId,
            outcome = CommandOutcome.SUCCEEDED,
            sessionId = "session-created",
            result = JsonPrimitive("ok"),
        )

        assertTrue(fixture.outbox.recordCompletion(completion))
        assertFalse(fixture.outbox.recordPublished(receipt.commandId, "\$event-late"))
        assertEquals(CommandState.SUCCEEDED, fixture.outbox.get(receipt.commandId)?.state)
        assertEquals(completion, fixture.outbox.get(receipt.commandId)?.completion)
    }

    @Test
    fun `a conflicting second terminal event is rejected`() {
        val fixture = fixture()
        val receipt = fixture.outbox.enqueue(UUID.randomUUID().toString(), payload("session.create"))
        fixture.outbox.recordCompletion(CommandCompletion(receipt.commandId, outcome = CommandOutcome.SUCCEEDED))

        assertThrows(IllegalStateException::class.java) {
            fixture.outbox.recordCompletion(
                CommandCompletion(receipt.commandId, outcome = CommandOutcome.FAILED),
            )
        }
    }

    @Test
    fun `release keeps an idempotency tombstone across restart`() {
        val fixture = fixture()
        val key = UUID.randomUUID().toString()
        val body = payload("session.create")
        val receipt = fixture.outbox.enqueue(key, body)
        fixture.outbox.recordCompletion(CommandCompletion(receipt.commandId, outcome = CommandOutcome.SUCCEEDED))

        assertTrue(fixture.outbox.release(receipt.commandId))
        assertNull(fixture.outbox.get(receipt.commandId))
        val restored = DurableCommandOutbox(fixture.store, fixture.clock, fixture.ids)
        assertThrows(ReleasedCommandException::class.java) { restored.enqueue(key, body) }
    }

    @Test
    fun `failed durable write leaves the in-memory state unchanged`() {
        val store = FailingStore()
        val outbox = DurableCommandOutbox(store, MutableClock(), QueueIds())
        store.failWrites = true

        assertThrows(IOException::class.java) {
            outbox.enqueue(UUID.randomUUID().toString(), payload("prompt", "not saved"))
        }
        assertTrue(outbox.list().isEmpty())
    }

    @Test
    fun `sensitive command data is redacted from lifecycle strings`() {
        val fixture = fixture()
        val receipt = fixture.outbox.enqueue(
            UUID.randomUUID().toString(),
            payload("prompt", "secret-prompt"),
        )
        val transmission = checkNotNull(fixture.outbox.claimForTransmission(receipt.commandId))
        assertFalse(transmission.toString().contains("secret-prompt"))

        val completion = CommandCompletion(
            receipt.commandId,
            outcome = CommandOutcome.SUCCEEDED,
            result = JsonPrimitive("secret-result"),
        )
        assertFalse(completion.toString().contains("secret-result"))
    }

    @Test
    fun `project route participates in the idempotency fingerprint`() {
        val fixture = fixture()
        val key = UUID.randomUUID().toString()
        fixture.outbox.enqueue(key, payload("project.settings"), projectId = "project-a")

        assertThrows(CommandIdempotencyConflictException::class.java) {
            fixture.outbox.enqueue(key, payload("project.settings"), projectId = "project-b")
        }
    }

    @Test
    fun `published command keeps its project route for terminal timeline recovery`() {
        val fixture = fixture()
        val receipt = fixture.outbox.enqueue(
            UUID.randomUUID().toString(),
            payload("project.settings"),
            projectId = "project-a",
        )
        fixture.outbox.claimForTransmission(receipt.commandId)
        fixture.outbox.recordPublished(receipt.commandId, "\$command-event")

        assertEquals("project-a", fixture.outbox.projectId(receipt.commandId))
        val restored = DurableCommandOutbox(fixture.store, fixture.clock, fixture.ids)
        assertEquals("project-a", restored.projectId(receipt.commandId))
    }

    @Test
    fun `removed project command retires with an idempotency tombstone`() {
        val fixture = fixture()
        val key = UUID.randomUUID().toString()
        val body = payload("project.settings")
        val receipt = fixture.outbox.enqueue(key, body, projectId = "project-removed")
        fixture.outbox.claimForTransmission(receipt.commandId)
        fixture.outbox.recordPublished(receipt.commandId, "\$command-event")

        assertTrue(fixture.outbox.retireUnavailableProjectCommand(receipt.commandId))
        assertNull(fixture.outbox.get(receipt.commandId))
        assertThrows(ReleasedCommandException::class.java) {
            fixture.outbox.enqueue(key, body, projectId = "project-removed")
        }
    }

    private fun fixture(): Fixture {
        val store = InMemoryCommandOutboxStore()
        val clock = MutableClock()
        val ids = QueueIds()
        return Fixture(store, clock, ids, DurableCommandOutbox(store, clock, ids))
    }

    private fun payload(operation: String, text: String? = null) = buildJsonObject {
        put("operation", operation)
        if (operation in setOf(
                "prompt", "cancel", "decision", "session.settings", "session.archive",
                "session.restore", "session.delete",
            )
        ) {
            put("sessionId", "session-1")
        }
        text?.let { put("text", it) }
        if (operation == "project.settings") put("model", "default")
    }

    private data class Fixture(
        val store: InMemoryCommandOutboxStore,
        val clock: MutableClock,
        val ids: QueueIds,
        val outbox: DurableCommandOutbox,
    )

    private class MutableClock : CommandClock {
        private var time = 1_000L
        override fun now(): Long = time++
    }

    private class QueueIds : CommandIdFactory {
        private val values = ArrayDeque<String>()
        private var next = 1
        override fun newId(): String = values.pollFirst() ?: "generated-${next++}"
    }

    private class FailingStore : CommandOutboxStore {
        var failWrites = false
        private var snapshot: CommandOutboxSnapshot? = null

        override fun load(): CommandOutboxSnapshot? = snapshot
        override fun save(snapshot: CommandOutboxSnapshot) {
            if (failWrites) throw IOException("injected durable write failure")
            this.snapshot = snapshot
        }
        override fun clear() {
            snapshot = null
        }
    }
}
