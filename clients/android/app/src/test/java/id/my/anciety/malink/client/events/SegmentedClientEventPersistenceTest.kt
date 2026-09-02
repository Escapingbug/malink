package id.my.anciety.malink.client.events

import id.my.anciety.malink.matrix.JvmAesGcmCipher
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SegmentedClientEventPersistenceTest {
    @Test
    fun `migrates the legacy blob then rewrites only the changed tail page`() {
        val legacy = InMemoryClientEventPersistence()
        val original = hub(legacy)
        original.publish(ClientEventType.STATUS_CHANGED, JsonPrimitive("ready"), occurredAt = 10)
        original.upsertMessage(
            "session-1",
            ClientMessage(
                eventId = "message-1",
                sender = "gateway-1",
                timestamp = 20,
                encrypted = true,
                kind = ClientMessageKind.AGENT,
                format = ClientMessageFormat.MARKDOWN,
                text = "hello",
                sessionId = "session-1",
            ),
            occurredAt = 20,
        )
        val expected = legacy.load()!!.let { bytes ->
            try {
                ClientEventStateCodec.decode(bytes)
            } finally {
                bytes.fill(0)
            }
        }
        val blobs = MemorySegmentBlobs()
        val segmented = SegmentedEncryptedClientEventPersistence(
            blobs,
            JvmAesGcmCipher(),
            "account-a",
            legacy,
            testBoundary = Unit,
        )

        val migrated = segmented.load()!!.let { bytes ->
            try {
                ClientEventStateCodec.decode(bytes)
            } finally {
                bytes.fill(0)
            }
        }

        assertEquals(expected, migrated)
        assertNull(legacy.load())
        assertTrue(blobs.values.keys.contains("manifest"))
        val writesBeforeAppend = blobs.writeCount

        val restored = hub(segmented)
        val appended = restored.publish(
            ClientEventType.STATUS_CHANGED,
            JsonPrimitive("syncing"),
            occurredAt = 30,
        )

        assertEquals(2, blobs.writeCount - writesBeforeAppend)
        val afterRestart = hub(SegmentedEncryptedClientEventPersistence(
            blobs,
            JvmAesGcmCipher(),
            "account-a",
            testBoundary = Unit,
        ))
        assertEquals(appended.cursor, afterRestart.snapshot().cursor)
    }

    @Test
    fun `structured byte budget evicts old records before committing a manifest`() {
        val blobs = MemorySegmentBlobs()
        val persistence = SegmentedEncryptedClientEventPersistence(
            blobs,
            JvmAesGcmCipher(),
            "account-a",
            testBoundary = Unit,
        )
        val hub = hub(persistence, maxPersistedStateBytes = 4 * 1024)

        repeat(12) { index ->
            hub.upsertMessage(
                "session-1",
                ClientMessage(
                    eventId = "message-$index",
                    sender = "gateway-1",
                    timestamp = index.toLong(),
                    encrypted = true,
                    kind = ClientMessageKind.AGENT,
                    format = ClientMessageFormat.MARKDOWN,
                    text = "x".repeat(900),
                    sessionId = "session-1",
                ),
                occurredAt = index.toLong(),
            )
        }

        val restored = hub(persistence, maxPersistedStateBytes = 4 * 1024)
        val page = restored.historyPage("session-1", limit = 20)
        assertTrue(page.messages.size < 12)
        assertEquals("message-11", page.messages.last().eventId)
    }

    private fun hub(
        persistence: ClientEventPersistence,
        maxPersistedStateBytes: Int = 3 * 1024 * 1024,
    ) = ClientEventHub(
        persistence = persistence,
        initialSnapshot = ClientSnapshot(
            deviceId = "device-1",
            cursor = "initial",
            generatedAt = 0,
            lifecycle = ClientLifecycle(LifecyclePhase.STOPPED, 0),
            foregroundService = ForegroundServiceState(
                active = false,
                notificationVisible = false,
            ),
            trust = PublicTrustState.Unpaired,
        ),
        maxPersistedStateBytes = maxPersistedStateBytes,
        cursorGenerator = object : OpaqueCursorGenerator {
            private var next = 0
            override fun next(): String = "cursor.${++next}"
        },
        now = { 1_000 },
    )

    private class MemorySegmentBlobs : ClientEventSegmentBlobStore {
        val values = linkedMapOf<String, ByteArray>()
        var writeCount = 0

        override fun read(key: String): ByteArray? = values[key]?.copyOf()

        override fun write(key: String, bytes: ByteArray) {
            writeCount += 1
            values[key] = bytes.copyOf()
        }

        override fun exists(key: String): Boolean = key in values

        override fun keys(): Set<String> = values.keys.filterTo(linkedSetOf()) { it != "manifest" }

        override fun delete(key: String) {
            values.remove(key)?.fill(0)
        }

        override fun clear() {
            values.values.forEach { it.fill(0) }
            values.clear()
        }
    }
}
