package id.my.anciety.malink.client

import id.my.anciety.malink.client.command.CommandCompletion
import id.my.anciety.malink.client.command.CommandOutcome
import id.my.anciety.malink.client.command.CommandState
import id.my.anciety.malink.client.command.DurableCommandOutbox
import id.my.anciety.malink.client.command.InMemoryCommandOutboxStore
import java.util.UUID
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class SessionLifecycleConcurrentCommandTest {
    @Test
    fun `independent session lifecycle commands remain recoverable across restart`() {
        val store = InMemoryCommandOutboxStore()
        val outbox = DurableCommandOutbox(store)
        val deletion = outbox.enqueue(
            UUID.randomUUID().toString(),
            buildJsonObject {
                put("operation", "session.delete")
                put("sessionId", "session-old")
            },
        )
        val creation = outbox.enqueue(
            UUID.randomUUID().toString(),
            buildJsonObject { put("operation", "session.create") },
        )
        outbox.claimForTransmission(deletion.commandId)
        outbox.claimForTransmission(creation.commandId)
        outbox.recordPublished(deletion.commandId, "\$delete-event")
        outbox.recordPublished(creation.commandId, "\$create-event")

        val restored = DurableCommandOutbox(store)

        assertNotEquals(deletion.commandId, creation.commandId)
        assertEquals(CommandState.PUBLISHED, restored.get(deletion.commandId)?.state)
        assertEquals(CommandState.PUBLISHED, restored.get(creation.commandId)?.state)
        assertTrue(
            restored.recordCompletion(
                CommandCompletion(deletion.commandId, outcome = CommandOutcome.SUCCEEDED),
            ),
        )
        assertTrue(restored.recordProgress(creation.commandId, "session-new"))
        assertEquals(CommandState.RUNNING, restored.get(creation.commandId)?.state)
    }
}
