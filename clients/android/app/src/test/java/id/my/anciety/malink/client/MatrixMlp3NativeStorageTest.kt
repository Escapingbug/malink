package id.my.anciety.malink.client

import id.my.anciety.malink.diagnostics.DiagnosticRecorder
import id.my.anciety.malink.matrix.JvmAesGcmCipher
import id.my.anciety.malink.matrix.MatrixDecryptedEvent
import id.my.anciety.malink.security.SecretEnvelope
import id.my.anciety.malink.security.malink.Base64Url
import id.my.anciety.malink.security.malink.CanonicalJson
import id.my.anciety.malink.security.malink.MatrixMlp3ProjectKey
import id.my.anciety.malink.security.malink.MatrixMlp3ProjectKeyGrant
import kotlinx.serialization.json.buildJsonArray
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
    fun `projection cache reads both canonical legacy and unsorted local JSON`() {
        val blob = MemoryMatrixMlp3BlobStore()
        val cipher = JvmAesGcmCipher()
        val value = buildJsonObject { put("z", "历史\n😀"); put("a", 7) }
        val aad = "malink.matrix-v3-projection.v1\u0000account-a".toByteArray()
        val legacy = cipher.encrypt(CanonicalJson.bytes(value), aad)
        blob.write(SecretEnvelope.encode(legacy))
        val store = AtomicEncryptedMatrixMlp3ProjectionStore(blob, cipher, "account-a")
        assertEquals(value, store.load())
        assertEquals(value.toString().toByteArray(Charsets.UTF_8).size, store.save(value))
        assertEquals(value, store.load())
    }

    @Test
    fun `fresh delivery restores legacy timeout quarantine after restart`() {
        for (segmented in listOf(false, true)) {
            val blob = MemoryMatrixMlp3BlobStore()
            val records = if (segmented) MemoryMatrixMlp3RecordBlobStore() else null
            val cipher = JvmAesGcmCipher()
            val timedOut = event("\$timeout", "{\"type\":\"m.room.message\"}")
            val store = AtomicEncryptedMatrixMlp3InboxStore(blob, records, cipher, "account-a")
            store.put(timedOut)
            store.quarantine(timedOut.eventId, java.net.SocketTimeoutException())
            val restored = AtomicEncryptedMatrixMlp3InboxStore(blob, records, cipher, "account-a")
            assertTrue(restored.put(timedOut))
            assertEquals(listOf(timedOut), restored.pending().map { it.event })
            assertFalse(restored.put(timedOut))
            val restarted = AtomicEncryptedMatrixMlp3InboxStore(blob, records, cipher, "account-a")
            assertEquals(listOf(timedOut), restarted.pending().map { it.event })
        }
    }

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
    fun `quarantining an inbox larger than four MiB remains encrypted and restartable`() {
        val blob = MemoryMatrixMlp3BlobStore()
        val store = AtomicEncryptedMatrixMlp3InboxStore(blob, JvmAesGcmCipher(), "account-a")
        val raw = "{\"body\":\"${"x".repeat(430 * 1024)}\"}"
        val events = (0 until 10).map { index -> event("\$large-$index", raw) }
        events.forEach { assertTrue(store.put(it)) }
        assertTrue(blob.bytes!!.size > 4 * 1024 * 1024)

        events.forEach { event ->
            store.quarantine(event.eventId, IllegalArgumentException("poison"))
        }
        assertTrue(blob.bytes!!.size < 32 * 1024)

        val restored = AtomicEncryptedMatrixMlp3InboxStore(
            blob,
            JvmAesGcmCipher(),
            "account-a",
        )
        assertTrue(restored.pending().isEmpty())
        events.forEach { event -> assertFalse(restored.put(event)) }
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
    fun `legacy inbox stays sealed while new events use a bounded encrypted segment`() {
        val legacy = MemoryMatrixMlp3BlobStore()
        val records = MemoryMatrixMlp3RecordBlobStore()
        val cipher = JvmAesGcmCipher()
        val first = event("\$first", "{\"body\":\"${"x".repeat(256 * 1024)}\"}")
        val second = event("\$second", "{\"kind\":\"event\"}")
        AtomicEncryptedMatrixMlp3InboxStore(legacy, cipher, "account-a").also {
            assertTrue(it.put(first))
            assertTrue(it.put(second))
        }
        assertTrue(legacy.bytes!!.size > 256 * 1024)

        val segmented = AtomicEncryptedMatrixMlp3InboxStore(
            legacy,
            records,
            cipher,
            "account-a",
        )
        assertTrue(legacy.bytes!!.size > 256 * 1024)
        assertEquals(0, records.bytes.size)
        assertEquals(0, records.writeCount)

        val third = event("\$third", "{\"kind\":\"terminal\"}")
        assertTrue(segmented.put(third))
        assertEquals(1, records.writeCount)
        assertEquals(1, records.bytes.size)
        assertEquals(2, legacy.writeCount)
        segmented.projected(third.eventId)
        assertEquals(1, records.bytes.size)
        segmented.flushProjected()
        assertEquals(0, records.bytes.size)

        val restored = AtomicEncryptedMatrixMlp3InboxStore(
            legacy,
            records,
            cipher,
            "account-a",
        )
        assertEquals(listOf(first.eventId, second.eventId), restored.pending().map { it.event.eventId })
        assertFalse(restored.put(first))
        assertEquals(1, records.writeCount)
    }

    @Test
    fun `reupgrade gives an exact duplicate one segmented durable owner`() {
        val legacy = MemoryMatrixMlp3BlobStore()
        val segments = MemoryMatrixMlp3RecordBlobStore()
        val cipher = JvmAesGcmCipher()
        val duplicate = event("\$duplicate", "{\"kind\":\"event\"}")
        AtomicEncryptedMatrixMlp3InboxStore(legacy, segments, cipher, "account-a").also {
            assertTrue(it.put(duplicate))
        }
        AtomicEncryptedMatrixMlp3InboxStore(legacy, cipher, "account-a").also {
            assertTrue(it.put(duplicate))
        }

        val upgraded = AtomicEncryptedMatrixMlp3InboxStore(
            legacy,
            segments,
            cipher,
            "account-a",
        )
        assertNull(legacy.bytes)
        assertEquals(listOf(duplicate.eventId), upgraded.pending().map { it.event.eventId })

        upgraded.projected(duplicate.eventId)
        upgraded.flushProjected()
        assertTrue(segments.bytes.isEmpty())
        assertTrue(
            AtomicEncryptedMatrixMlp3InboxStore(legacy, segments, cipher, "account-a")
                .pending()
                .isEmpty(),
        )
    }

    @Test
    fun `reupgrade keeps quarantine over a legacy pending duplicate`() {
        val legacy = MemoryMatrixMlp3BlobStore()
        val segments = MemoryMatrixMlp3RecordBlobStore()
        val cipher = JvmAesGcmCipher()
        val duplicate = event("\$quarantined-duplicate", "{\"kind\":\"poison\"}")
        AtomicEncryptedMatrixMlp3InboxStore(legacy, segments, cipher, "account-a").also {
            assertTrue(it.put(duplicate))
            it.quarantine(duplicate.eventId, IllegalArgumentException("poison"))
        }
        AtomicEncryptedMatrixMlp3InboxStore(legacy, cipher, "account-a").also {
            assertTrue(it.put(duplicate))
        }

        val upgraded = AtomicEncryptedMatrixMlp3InboxStore(
            legacy,
            segments,
            cipher,
            "account-a",
        )
        assertNull(legacy.bytes)
        assertTrue(upgraded.pending().isEmpty())
        assertFalse(upgraded.put(duplicate))
        AtomicEncryptedMatrixMlp3InboxStore(legacy, segments, cipher, "account-a")
            .validateStoredState()
    }

    @Test
    fun `individual event key keeps one deterministic owner across store copies`() {
        val cipher = JvmAesGcmCipher()
        val largeRaw = """{"body":"${"x".repeat(140 * 1024)}"}"""
        fun segmentKey(firstEventId: String): String {
            val segments = MemoryMatrixMlp3RecordBlobStore()
            AtomicEncryptedMatrixMlp3InboxStore(
                MemoryMatrixMlp3BlobStore(),
                segments,
                cipher,
                "account-a",
            ).put(event(firstEventId, largeRaw))
            return segments.bytes.keys.single()
        }
        val ownerIds = listOf("\$owner-a", "\$owner-b").sortedBy(::segmentKey)
        val duplicate = event("\$crash-safe-duplicate", """{"body":"same"}""")
        fun seededSegment(ownerId: String, quarantineDuplicate: Boolean) =
            MemoryMatrixMlp3RecordBlobStore().also { segments ->
                AtomicEncryptedMatrixMlp3InboxStore(
                    MemoryMatrixMlp3BlobStore(),
                    segments,
                    cipher,
                    "account-a",
                ).also { store ->
                    assertTrue(store.put(event(ownerId, largeRaw)))
                    assertTrue(store.put(duplicate))
                    if (quarantineDuplicate) {
                        store.quarantine(duplicate.eventId, IllegalArgumentException("poison"))
                    }
                }
            }
        val pendingOwner = seededSegment(ownerIds[0], quarantineDuplicate = false)
        val quarantineOwner = seededSegment(ownerIds[1], quarantineDuplicate = true)
        val combined = MemoryMatrixMlp3RecordBlobStore().also { segments ->
            segments.bytes.putAll(pendingOwner.bytes)
            segments.bytes.putAll(quarantineOwner.bytes)
        }

        val restored = AtomicEncryptedMatrixMlp3InboxStore(
            MemoryMatrixMlp3BlobStore(),
            combined,
            cipher,
            "account-a",
        )
        assertFalse(restored.pending().any { it.event.eventId == duplicate.eventId })
        assertFalse(restored.put(duplicate))
        assertEquals(3, combined.bytes.size)
    }

    @Test
    fun `reupgrade accepts equivalent pending Matrix JSON with changed transient metadata`() {
        val legacy = MemoryMatrixMlp3BlobStore()
        val segments = MemoryMatrixMlp3RecordBlobStore()
        val cipher = JvmAesGcmCipher()
        AtomicEncryptedMatrixMlp3InboxStore(legacy, segments, cipher, "account-a").also {
            assertTrue(
                it.put(
                    event(
                        "\$equivalent",
                        """{"type":"m.room.message","content":{"body":"same"},"room_id":"!room:example.org","user_id":"@gateway:example.org","age":1,"prev_content":{"body":"old-a"},"replaces_state":"${'$'}old-state","unsigned":{"age":1}}""",
                    ),
                ),
            )
        }
        AtomicEncryptedMatrixMlp3InboxStore(legacy, cipher, "account-a").also {
            assertTrue(
                it.put(
                    event(
                        "\$equivalent",
                        """{"unsigned":{"age":2},"prev_content":{"body":"old-b"},"age":2,"content":{"body":"same"},"type":"m.room.message"}""",
                    ),
                ),
            )
        }

        val upgraded = AtomicEncryptedMatrixMlp3InboxStore(
            legacy,
            segments,
            cipher,
            "account-a",
        )
        assertNull(legacy.bytes)
        assertEquals(listOf("\$equivalent"), upgraded.pending().map { it.event.eventId })
        upgraded.projected("\$equivalent")
        upgraded.flushProjected()
        assertTrue(segments.bytes.isEmpty())
    }

    @Test
    fun `reupgrade rejects redundant raw identity that disagrees with the durable event`() {
        val legacy = MemoryMatrixMlp3BlobStore()
        val segments = MemoryMatrixMlp3RecordBlobStore()
        val cipher = JvmAesGcmCipher()
        AtomicEncryptedMatrixMlp3InboxStore(legacy, segments, cipher, "account-a").also {
            assertTrue(
                it.put(
                    event(
                        "\$identity-conflict",
                        """{"type":"m.room.message","content":{"body":"same"},"user_id":"@other:example.org"}""",
                    ),
                ),
            )
        }
        AtomicEncryptedMatrixMlp3InboxStore(legacy, cipher, "account-a").also {
            assertTrue(
                it.put(
                    event(
                        "\$identity-conflict",
                        """{"type":"m.room.message","content":{"body":"same"}}""",
                    ),
                ),
            )
        }

        val error = assertThrows(IllegalArgumentException::class.java) {
            AtomicEncryptedMatrixMlp3InboxStore(legacy, segments, cipher, "account-a")
        }
        assertEquals("The MLP/3 inbox contains conflicting durable records.", error.message)
    }

    @Test
    fun `reupgrade rejects different pending payloads for one event id`() {
        val legacy = MemoryMatrixMlp3BlobStore()
        val segments = MemoryMatrixMlp3RecordBlobStore()
        val cipher = JvmAesGcmCipher()
        AtomicEncryptedMatrixMlp3InboxStore(legacy, segments, cipher, "account-a").also {
            assertTrue(it.put(event("\$conflict", "{\"body\":\"first\"}")))
        }
        AtomicEncryptedMatrixMlp3InboxStore(legacy, cipher, "account-a").also {
            assertTrue(it.put(event("\$conflict", "{\"body\":\"second\"}")))
        }

        val error = assertThrows(IllegalArgumentException::class.java) {
            AtomicEncryptedMatrixMlp3InboxStore(legacy, segments, cipher, "account-a")
        }
        assertEquals("The MLP/3 inbox contains conflicting durable records.", error.message)
    }

    @Test
    fun `new inbox events use independent encrypted records`() {
        val legacy = MemoryMatrixMlp3BlobStore()
        val segments = MemoryMatrixMlp3RecordBlobStore()
        val cipher = JvmAesGcmCipher()
        val store = AtomicEncryptedMatrixMlp3InboxStore(
            legacy,
            segments,
            cipher,
            "account-a",
        )
        val raw = "{\"body\":\"${"x".repeat(140 * 1024)}\"}"
        val first = event("\$first", raw)
        val second = event("\$second", raw)

        assertTrue(store.put(first))
        assertEquals(1, segments.writeCount)
        assertEquals(1, segments.bytes.size)
        assertTrue(store.put(second))
        assertEquals(2, segments.writeCount)
        assertEquals(2, segments.bytes.size)
        assertNull(legacy.bytes)

        store.projected(first.eventId)
        store.flushProjected()
        assertEquals(2, segments.writeCount)
        assertEquals(1, segments.bytes.size)
        assertEquals(
            listOf(second.eventId),
            AtomicEncryptedMatrixMlp3InboxStore(
                legacy,
                segments,
                cipher,
                "account-a",
            ).pending().map { it.event.eventId },
        )
    }

    @Test
    fun `new input does not rewrite an empty record awaiting batched cleanup`() {
        val legacy = MemoryMatrixMlp3BlobStore()
        val segments = MemoryMatrixMlp3RecordBlobStore()
        val cipher = JvmAesGcmCipher()
        val store = AtomicEncryptedMatrixMlp3InboxStore(
            legacy,
            segments,
            cipher,
            "account-a",
        )
        val first = event("\$first", "{\"kind\":\"event\"}")
        val second = event("\$second", "{\"kind\":\"event\"}")

        assertTrue(store.put(first))
        store.projected(first.eventId)
        assertTrue(store.put(second))
        assertEquals(2, segments.writeCount)
        assertEquals(2, segments.bytes.size)

        store.flushProjected()
        assertEquals(2, segments.writeCount)
        assertEquals(1, segments.bytes.size)
        assertEquals(
            listOf(second.eventId),
            AtomicEncryptedMatrixMlp3InboxStore(
                legacy,
                segments,
                cipher,
                "account-a",
            ).pending().map { it.event.eventId },
        )
    }

    @Test
    fun `projecting one independent record keeps the other record`() {
        val legacy = MemoryMatrixMlp3BlobStore()
        val segments = MemoryMatrixMlp3RecordBlobStore()
        val cipher = JvmAesGcmCipher()
        val first = event("\$first", "{\"kind\":\"first\"}")
        val second = event("\$second", "{\"kind\":\"second\"}")
        val store = AtomicEncryptedMatrixMlp3InboxStore(
            legacy,
            segments,
            cipher,
            "account-a",
        )

        assertTrue(store.put(first))
        assertTrue(store.put(second))
        assertEquals(2, segments.bytes.size)

        store.projected(first.eventId)
        store.flushProjected()

        assertEquals(2, segments.writeCount)
        assertEquals(1, segments.bytes.size)
        val restored = AtomicEncryptedMatrixMlp3InboxStore(
            legacy,
            segments,
            cipher,
            "account-a",
        )
        assertEquals(listOf(second.eventId), restored.pending().map { it.event.eventId })
        restored.projected(second.eventId)
        restored.flushProjected()
        assertTrue(segments.bytes.isEmpty())
    }

    @Test
    fun `uncheckpointed projected records survive a process death`() = runBlocking {
        val blob = MemoryMatrixMlp3BlobStore()
        val cipher = JvmAesGcmCipher()
        val store = AtomicEncryptedMatrixMlp3InboxStore(blob, cipher, "account-a")
        store.put(event("\$pending-checkpoint", "{}"))
        drainMatrixMlp3Inbox(store, flushProjected = false) { record ->
            store.projected(record.event.eventId)
            MatrixMlp3InboxProjectionStep.ADVANCED
        }
        assertTrue(store.pending().isEmpty())
        assertEquals(1, AtomicEncryptedMatrixMlp3InboxStore(blob, cipher, "account-a").pending().size)
        store.flushProjected()
        assertTrue(AtomicEncryptedMatrixMlp3InboxStore(blob, cipher, "account-a").pending().isEmpty())
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
        assertNull(blob.bytes)
    }

    @Test
    fun `task notification outbox retries once and deduplicates across restart`() {
        val blob = MemoryMatrixMlp3BlobStore()
        val value = MatrixMlp3TaskNotification(
            eventId = "terminal-event-1",
            commandId = "remote-command-1",
            outcome = "succeeded",
            sessionId = "session-1",
            body = "Implemented the requested fix.",
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
        assertFalse(blob.bytes!!.toString(Charsets.UTF_8).contains("Implemented the requested fix."))

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
    fun `task notification store migrates legacy records without losing delivery`() {
        val blob = MemoryMatrixMlp3BlobStore()
        val cipher = JvmAesGcmCipher()
        val associatedData = "malink.matrix-v3-task-notifications.v1\u0000account-a".toByteArray()
        val plaintext = CanonicalJson.bytes(buildJsonObject {
            put("schemaVersion", 1)
            put("pending", buildJsonArray {
                add(buildJsonObject {
                    put("eventId", "legacy-terminal-1")
                    put("commandId", "legacy-command-1")
                    put("outcome", "succeeded")
                    put("sessionId", "session-1")
                })
            })
            put("deliveredEventIds", buildJsonArray {})
        })
        val envelope = cipher.encrypt(plaintext, associatedData)
        blob.write(SecretEnvelope.encode(envelope))
        envelope.iv.fill(0)
        envelope.ciphertext.fill(0)
        plaintext.fill(0)

        val store = AtomicEncryptedMatrixMlp3TaskNotificationStore(blob, cipher, "account-a")
        assertEquals(null, store.pending().single().body)
        store.migrateStoredState()

        val restored = AtomicEncryptedMatrixMlp3TaskNotificationStore(blob, cipher, "account-a")
        assertEquals("legacy-terminal-1", restored.pending().single().eventId)
        assertEquals(null, restored.pending().single().body)
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
    fun `legacy project indexed keys with one room migrate without dropping either grant`() {
        val blob = MemoryMatrixMlp3BlobStore()
        val cipher = JvmAesGcmCipher()
        val first = projectKeyGrant("project-old", "key-old", 1)
        val second = projectKeyGrant("project-current", "key-current", 2)
        writeLegacyProjectKeyStore(blob, cipher, "account-a", listOf(first, second))

        AtomicEncryptedMatrixMlp3ProjectKeyStore(blob, cipher, "account-a").apply {
            assertEquals(2, values().size)
            assertNull(valueForRoom(first.roomId))
            assertEquals(
                first.activeKeyId,
                valueForRoom(first.roomId, first.projectId)?.activeKeyId,
            )
            assertEquals(
                second.activeKeyId,
                valueForRoom(second.roomId, second.projectId)?.activeKeyId,
            )
            migrateStoredState()
        }

        AtomicEncryptedMatrixMlp3ProjectKeyStore(blob, cipher, "account-a").apply {
            assertEquals(2, values().size)
            assertEquals(setOf("project-old", "project-current"), projectIds())
            assertEquals(
                first.activeKeyId,
                valueForRoom(first.roomId, first.projectId)?.activeKeyId,
            )
            assertEquals(
                second.activeKeyId,
                valueForRoom(second.roomId, second.projectId)?.activeKeyId,
            )
        }
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

    private fun projectKeyGrant(projectId: String, keyId: String, marker: Byte) =
        MatrixMlp3ProjectKeyGrant(
            workspaceId = "workspace-1",
            projectId = projectId,
            roomId = "!shared-room:example.org",
            deviceId = "device-1",
            certificateId = "certificate-1",
            activeKeyId = keyId,
            keys = listOf(MatrixMlp3ProjectKey(keyId, ByteArray(32) { marker }, marker.toLong())),
        )

    private fun writeLegacyProjectKeyStore(
        blob: MemoryMatrixMlp3BlobStore,
        cipher: JvmAesGcmCipher,
        scope: String,
        grants: List<MatrixMlp3ProjectKeyGrant>,
    ) {
        val plaintext = CanonicalJson.bytes(buildJsonObject {
            put("schemaVersion", 2)
            put("grants", buildJsonArray {
                grants.forEach { grant ->
                    add(buildJsonObject {
                        put("schemaVersion", 1)
                        put("workspaceId", grant.workspaceId)
                        put("projectId", grant.projectId)
                        put("roomId", grant.roomId)
                        put("deviceId", grant.deviceId)
                        put("certificateId", grant.certificateId)
                        put("activeKeyId", grant.activeKeyId)
                        put("keys", buildJsonArray {
                            grant.keys.forEach { key ->
                                add(buildJsonObject {
                                    put("keyId", key.keyId)
                                    put("key", Base64Url.encode(key.key))
                                    put("createdAt", key.createdAt)
                                })
                            }
                        })
                    })
                }
            })
        })
        val associatedData = "malink.matrix-v3-project-keys.v1\u0000$scope".toByteArray()
        val encrypted = cipher.encrypt(plaintext, associatedData)
        try {
            blob.write(SecretEnvelope.encode(encrypted))
        } finally {
            plaintext.fill(0)
            encrypted.iv.fill(0)
            encrypted.ciphertext.fill(0)
        }
    }

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

    private class MemoryMatrixMlp3RecordBlobStore : MatrixMlp3RecordBlobStore {
        val bytes = linkedMapOf<String, ByteArray>()
        var writeCount = 0
        var failWrites = false

        override fun readAll(): Map<String, ByteArray> = bytes.mapValues { it.value.copyOf() }

        override fun write(key: String, bytes: ByteArray) {
            writeCount += 1
            if (failWrites) throw IllegalStateException("simulated record write failure")
            this.bytes[key] = bytes.copyOf()
        }

        override fun delete(key: String) {
            bytes.remove(key)
        }

        override fun clear() {
            bytes.clear()
        }
    }

    private class RecordingDiagnostics : DiagnosticRecorder {
        val events = mutableListOf<Pair<String, Map<String, String>>>()

        override fun record(event: String, attributes: Map<String, String>) {
            events += event to attributes
        }
    }
}
