package id.my.anciety.malink.client

import id.my.anciety.malink.diagnostics.DiagnosticRecorder
import id.my.anciety.malink.matrix.JvmAesGcmCipher
import id.my.anciety.malink.matrix.MatrixDecryptedEvent
import id.my.anciety.malink.security.malink.MatrixMlp3ProjectKey
import id.my.anciety.malink.security.malink.MatrixMlp3ProjectKeyGrant
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class MatrixMlp3NativeStorageTest {
    @Test
    fun `prepared command retry reuses the exact first signed ciphertext after restart`() {
        val blob = MemoryMatrixMlp3BlobStore()
        val first = buildJsonObject {
            put("msgtype", "m.notice")
            put("signature", "first-nondeterministic-signature")
            put("ciphertext", "first-ciphertext")
        }
        val replacement = buildJsonObject {
            put("msgtype", "m.notice")
            put("signature", "different-signature")
            put("ciphertext", "different-ciphertext")
        }
        val store = AtomicEncryptedMatrixMlp3CommandContentStore(blob, JvmAesGcmCipher(), "account-a")

        assertEquals(first, store.putIfAbsent("command-1", first))
        assertEquals(first, store.putIfAbsent("command-1", replacement))

        val restored = AtomicEncryptedMatrixMlp3CommandContentStore(blob, JvmAesGcmCipher(), "account-a")
        assertEquals(first, restored.get("command-1"))
        assertFalse(blob.bytes!!.toString(Charsets.UTF_8).contains("first-ciphertext"))
        restored.remove("command-1")
        assertNull(restored.get("command-1"))
    }

    @Test
    fun `poison event is quarantined without blocking later raw events`() {
        val blob = MemoryMatrixMlp3BlobStore()
        val store = AtomicEncryptedMatrixMlp3InboxStore(blob, JvmAesGcmCipher(), "account-a")
        val poison = event("\$poison", "not-json")
        val valid = event("\$valid", "{\"type\":\"m.room.message\"}")

        assertTrue(store.put(poison))
        assertTrue(store.put(valid))
        assertFalse(store.put(valid))
        store.quarantine(poison.eventId, IllegalArgumentException("secret must not persist"))
        assertFalse(store.put(poison))
        assertEquals(listOf(valid.eventId), store.pending().map { it.event.eventId })

        store.projected(valid.eventId)
        assertTrue(store.pending().isEmpty())
        store.flushProjected()
        AtomicEncryptedMatrixMlp3InboxStore(blob, JvmAesGcmCipher(), "account-a")
            .validateStoredState()
        assertFalse(blob.bytes!!.toString(Charsets.UTF_8).contains("secret must not persist"))
    }

    @Test
    fun `projected inbox cleanup is coalesced until new input or lifecycle flush`() {
        val blob = MemoryMatrixMlp3BlobStore()
        val store = AtomicEncryptedMatrixMlp3InboxStore(blob, JvmAesGcmCipher(), "account-a")
        val first = event("\$first", "{\"kind\":\"event\"}")
        val second = event("\$second", "{\"kind\":\"event\"}")

        assertTrue(store.put(first))
        assertEquals(1, blob.writeCount)
        store.projected(first.eventId)
        assertEquals(1, blob.writeCount)
        assertEquals(
            listOf(first.eventId),
            AtomicEncryptedMatrixMlp3InboxStore(blob, JvmAesGcmCipher(), "account-a")
                .pending()
                .map { it.event.eventId },
        )

        assertTrue(store.put(second))
        assertEquals(2, blob.writeCount)
        assertEquals(
            listOf(second.eventId),
            AtomicEncryptedMatrixMlp3InboxStore(blob, JvmAesGcmCipher(), "account-a")
                .pending()
                .map { it.event.eventId },
        )

        store.projected(second.eventId)
        store.flushProjected()
        assertNull(blob.bytes)
    }

    @Test
    fun `a later key grant unlocks an earlier deferred event`() = runBlocking {
        val blob = MemoryMatrixMlp3BlobStore()
        val store = AtomicEncryptedMatrixMlp3InboxStore(blob, JvmAesGcmCipher(), "account-a")
        val dependent = event("\$dependent", "{\"kind\":\"event\"}")
        val grant = event("\$grant", "{\"kind\":\"key_grant\"}")
        store.put(dependent)
        store.put(grant)
        var keyReady = false
        val attempts = mutableListOf<String>()

        drainMatrixMlp3Inbox(store) { record ->
            attempts += record.event.eventId
            when (record.event.eventId) {
                grant.eventId -> {
                    keyReady = true
                    store.projected(record.event.eventId)
                    MatrixMlp3InboxProjectionStep.ADVANCED
                }
                dependent.eventId -> if (keyReady) {
                    store.projected(record.event.eventId)
                    MatrixMlp3InboxProjectionStep.ADVANCED
                } else {
                    MatrixMlp3InboxProjectionStep.DEFERRED
                }
                else -> error("Unexpected event")
            }
        }

        assertEquals(listOf("\$dependent", "\$grant", "\$dependent"), attempts)
        assertTrue(store.pending().isEmpty())
    }

    @Test
    fun `task notification outbox retries once and deduplicates across restart`() {
        val blob = MemoryMatrixMlp3BlobStore()
        val value = MatrixMlp3TaskNotification(
            eventId = "terminal-event-1",
            commandId = "remote-command-1",
            outcome = "succeeded",
            sessionId = "session-1",
        )
        var attempts = 0
        val firstStore = AtomicEncryptedMatrixMlp3TaskNotificationStore(
            blob,
            JvmAesGcmCipher(),
            "account-a",
        )
        MatrixMlp3TaskNotificationCoordinator(firstStore) {
            attempts += 1
            throw IllegalStateException("simulated Android notification failure")
        }.accept(value)

        assertEquals(1, attempts)
        assertEquals(listOf(value), firstStore.pending())
        assertFalse(blob.bytes!!.toString(Charsets.UTF_8).contains("remote-command-1"))

        val restoredStore = AtomicEncryptedMatrixMlp3TaskNotificationStore(
            blob,
            JvmAesGcmCipher(),
            "account-a",
        )
        val delivered = mutableListOf<MatrixMlp3TaskNotification>()
        val restored = MatrixMlp3TaskNotificationCoordinator(restoredStore) { delivered += it }
        restored.drain()
        restored.accept(value)

        assertEquals(listOf(value), delivered)
        assertTrue(restoredStore.pending().isEmpty())
        AtomicEncryptedMatrixMlp3TaskNotificationStore(
            blob,
            JvmAesGcmCipher(),
            "account-a",
        ).validateStoredState()
    }

    @Test
    fun `task notification delivery remains pending when its durable commit fails`() {
        val blob = MemoryMatrixMlp3BlobStore()
        val store = AtomicEncryptedMatrixMlp3TaskNotificationStore(
            blob,
            JvmAesGcmCipher(),
            "account-a",
        )
        val value = MatrixMlp3TaskNotification(
            eventId = "terminal-event-1",
            commandId = "remote-command-1",
            outcome = "failed",
            sessionId = "session-1",
        )
        assertTrue(store.enqueue(value))
        blob.failWrites = true

        assertThrows(IllegalStateException::class.java) {
            store.delivered(value.eventId)
        }
        assertEquals(listOf(value), store.pending())
    }

    @Test
    fun `project keys and projection survive encrypted restart with account binding`() {
        val keyBlob = MemoryMatrixMlp3BlobStore()
        val projectionBlob = MemoryMatrixMlp3BlobStore()
        val grant = MatrixMlp3ProjectKeyGrant(
            workspaceId = "workspace-1",
            projectId = "project-1",
            roomId = "!room:example.org",
            deviceId = "device-1",
            certificateId = "certificate-1",
            activeKeyId = "key-1",
            keys = listOf(MatrixMlp3ProjectKey("key-1", ByteArray(32) { it.toByte() }, 1234)),
        )
        val projection = buildJsonObject {
            put("schemaVersion", 1)
            put("marker", "durable-view")
        }
        AtomicEncryptedMatrixMlp3ProjectKeyStore(keyBlob, JvmAesGcmCipher(), "account-a").save(grant)
        AtomicEncryptedMatrixMlp3ProjectionStore(
            projectionBlob,
            JvmAesGcmCipher(),
            "account-a",
        ).save(projection)

        val restoredGrant = AtomicEncryptedMatrixMlp3ProjectKeyStore(
            keyBlob,
            JvmAesGcmCipher(),
            "account-a",
        ).value()!!
        assertEquals(grant.activeKeyId, restoredGrant.activeKeyId)
        assertArrayEquals(grant.activeKey().key, restoredGrant.activeKey().key)
        assertEquals(
            projection,
            AtomicEncryptedMatrixMlp3ProjectionStore(
                projectionBlob,
                JvmAesGcmCipher(),
                "account-a",
            ).load(),
        )
    }

    @Test
    fun `project key store retains a primary and recovered history room for one project`() {
        val blob = MemoryMatrixMlp3BlobStore()
        val primary = MatrixMlp3ProjectKeyGrant(
            workspaceId = "workspace-1",
            projectId = "project-1",
            roomId = "!project:example.org",
            deviceId = "device-1",
            certificateId = "certificate-1",
            activeKeyId = "key-project",
            keys = listOf(MatrixMlp3ProjectKey("key-project", ByteArray(32) { 1 }, 1)),
        )
        val history = MatrixMlp3ProjectKeyGrant(
            workspaceId = "workspace-1",
            projectId = "project-1",
            roomId = "!history:example.org",
            deviceId = "device-1",
            certificateId = "certificate-1",
            activeKeyId = "key-history",
            keys = listOf(MatrixMlp3ProjectKey("key-history", ByteArray(32) { 2 }, 2)),
        )
        AtomicEncryptedMatrixMlp3ProjectKeyStore(blob, JvmAesGcmCipher(), "account-a").apply {
            save(primary)
            save(history)
        }

        val restored = AtomicEncryptedMatrixMlp3ProjectKeyStore(
            blob,
            JvmAesGcmCipher(),
            "account-a",
        )
        assertEquals(2, restored.values().size)
        assertEquals("key-history", restored.valueForRoom(history.roomId)?.activeKeyId)
        assertEquals(
            "key-project",
            restored.valueForProject("project-1", setOf(history.roomId))?.activeKeyId,
        )
        assertNull(restored.value())
    }

    @Test
    fun `projection cache write failure does not escape into event processing`() {
        val blob = MemoryMatrixMlp3BlobStore().apply { failWrites = true }
        val recorder = RecordingDiagnostics()
        val projection = MatrixMlp3NativeProjection(
            gatewayId = { "gateway-1" },
            activeDeviceCount = { 1 },
        )

        assertFalse(persistMatrixMlp3ProjectionCache(
            projection,
            AtomicEncryptedMatrixMlp3ProjectionStore(
                blob,
                JvmAesGcmCipher(),
                "account-a",
            ),
            recorder,
            "gateway_event",
        ))
        assertEquals(
            listOf("matrix.v3_projection.cache_write_failed"),
            recorder.events.map { it.first },
        )
        assertEquals("gateway_event", recorder.events.single().second["reason"])
    }

    @Test
    fun `projection store reports its actual cache limit`() {
        val value = buildJsonObject {
            put("payload", "x".repeat(AtomicEncryptedMatrixMlp3ProjectionStore.MAX_BYTES))
        }
        val store = AtomicEncryptedMatrixMlp3ProjectionStore(
            MemoryMatrixMlp3BlobStore(),
            JvmAesGcmCipher(),
            "account-a",
        )

        val error = try {
            store.save(value)
            null
        } catch (candidate: MatrixMlp3ProjectionTooLargeException) {
            candidate
        }
        assertTrue(error != null)
        assertTrue(error!!.actualBytes > error.maximumBytes)
        assertEquals(AtomicEncryptedMatrixMlp3ProjectionStore.MAX_BYTES, error.maximumBytes)
    }

    private fun event(eventId: String, rawJson: String) = MatrixDecryptedEvent(
        roomId = "!room:example.org",
        eventId = eventId,
        sender = "@gateway:example.org",
        timestamp = 1234,
        rawJson = rawJson,
    )

    private class MemoryMatrixMlp3BlobStore : MatrixMlp3BlobStore {
        var bytes: ByteArray? = null
        var writeCount = 0
        var failWrites = false

        override fun read(): ByteArray? = bytes?.copyOf()

        override fun write(bytes: ByteArray) {
            writeCount += 1
            if (failWrites) throw IllegalStateException("simulated cache write failure")
            this.bytes = bytes.copyOf()
        }

        override fun delete() {
            bytes = null
        }
    }

    private class RecordingDiagnostics : DiagnosticRecorder {
        val events = mutableListOf<Pair<String, Map<String, String>>>()

        override fun record(event: String, attributes: Map<String, String>) {
            events += event to attributes
        }
    }
}
