package id.my.anciety.malink.client.command

import id.my.anciety.malink.security.EncryptedPayload
import id.my.anciety.malink.security.SecretCipher
import id.my.anciety.malink.security.SecretEnvelope
import java.security.SecureRandom
import java.util.UUID
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class EncryptedCommandOutboxStoreTest {
    @Test
    fun `encrypted store round trips an uncertain command without plaintext leakage`() {
        val blob = MemoryBlobStore()
        val store = EncryptedAtomicCommandOutboxStore(blob, JvmAesGcmCipher(), "account-a")
        val outbox = DurableCommandOutbox(store, IncrementingClock(), IncrementingIds())
        val receipt = outbox.enqueue(UUID.randomUUID().toString(), prompt("highly secret prompt"))
        val transmission = checkNotNull(outbox.claimForTransmission(receipt.commandId))

        assertFalse(checkNotNull(blob.value).toString(Charsets.UTF_8).contains("highly secret prompt"))
        assertEquals(transmission.issuedAt, checkNotNull(store.load()).commands.single().createdAt)
        val restored = DurableCommandOutbox(store, IncrementingClock(), IncrementingIds())
        assertEquals(CommandState.RECOVERY_REQUIRED, restored.get(receipt.commandId)?.state)
    }

    @Test
    fun `encrypted store binds ciphertext to the native account`() {
        val blob = MemoryBlobStore()
        val cipher = JvmAesGcmCipher()
        EncryptedAtomicCommandOutboxStore(blob, cipher, "account-a").save(CommandOutboxSnapshot())

        assertThrows(Exception::class.java) {
            EncryptedAtomicCommandOutboxStore(blob, cipher, "account-b").load()
        }
        assertTrue(blob.value != null)
    }

    @Test
    fun `encrypted store persists multiple independent published commands`() {
        val blob = MemoryBlobStore()
        val cipher = JvmAesGcmCipher()
        val store = EncryptedAtomicCommandOutboxStore(blob, cipher, "account-a")
        val outbox = DurableCommandOutbox(store, IncrementingClock(), IncrementingIds())
        val first = outbox.enqueue(UUID.randomUUID().toString(), prompt("one"), projectId = "project-a")
        val second = outbox.enqueue(UUID.randomUUID().toString(), prompt("two"), projectId = "project-b")
        outbox.claimForTransmission(first.commandId)
        outbox.claimForTransmission(second.commandId)
        outbox.recordPublished(first.commandId, "\$event-one")
        outbox.recordPublished(second.commandId, "\$event-two")

        val restored = DurableCommandOutbox(store, IncrementingClock(), IncrementingIds())

        assertEquals(CommandState.PUBLISHED, restored.get(first.commandId)?.state)
        assertEquals(CommandState.PUBLISHED, restored.get(second.commandId)?.state)
    }

    @Test
    fun `current schema rejects a submitted command without a creation timestamp`() {
        val store = InMemoryCommandOutboxStore()
        val outbox = DurableCommandOutbox(store, IncrementingClock(), IncrementingIds())
        val receipt = outbox.enqueue(UUID.randomUUID().toString(), sessionCreate())
        outbox.claimForTransmission(receipt.commandId)
        val corrupted = CommandOutboxCodec.encode(checkNotNull(store.load()))
            .toString(Charsets.UTF_8)
            .replace(Regex("\"createdAt\":[0-9]+"), "\"createdAt\":null")
            .toByteArray(Charsets.UTF_8)

        assertThrows(IllegalArgumentException::class.java) { CommandOutboxCodec.decode(corrupted) }
    }

    @Test
    fun `schema version validation rejects integer overflow`() {
        val corrupted = """{"schemaVersion":4294967301,"commands":[],"released":[]}"""
            .toByteArray(Charsets.UTF_8)

        assertThrows(IllegalArgumentException::class.java) { CommandOutboxCodec.decode(corrupted) }
    }

    @Test
    fun `schema version validation rejects a numeric string`() {
        val corrupted = """{"schemaVersion":"6","commands":[],"released":[]}"""
            .toByteArray(Charsets.UTF_8)

        assertThrows(IllegalArgumentException::class.java) { CommandOutboxCodec.decode(corrupted) }
    }

    @Test
    fun `schema five command state migrates without sequence or revision semantics`() {
        val firstId = "legacy-command-one"
        val secondId = "legacy-command-two"
        val legacy = legacySchemaFive(
            legacyCommand(firstId, "legacy-operation-one", UUID.randomUUID().toString(), 1),
            legacyCommand(secondId, "legacy-operation-two", UUID.randomUUID().toString(), 2),
        )

        val decoded = CommandOutboxCodec.decodeForStorage(legacy)

        assertEquals(CommandOutboxMigration(5, 0), decoded.migration)
        assertEquals(listOf(firstId, secondId), decoded.snapshot.commands.map { it.commandId })
        assertTrue(decoded.snapshot.commands.all { it.state == CommandState.PUBLISHED })
        assertTrue(decoded.snapshot.commands.all { it.createdAt == 1_000L })
    }

    @Test
    fun `schema two submitted command without exact signing time is quarantined`() {
        val commandId = "legacy-unsafe-command"
        val key = UUID.randomUUID().toString()
        val legacy = legacySchemaTwo(commandId, key)

        val decoded = CommandOutboxCodec.decodeForStorage(legacy)

        assertEquals(CommandOutboxMigration(2, 1), decoded.migration)
        assertTrue(decoded.snapshot.commands.isEmpty())
        assertEquals(commandId, decoded.snapshot.released.single().commandId)
        assertEquals(key, decoded.snapshot.released.single().idempotencyKey)
    }

    @Test
    fun `encrypted store atomically rewrites schema five to event stream schema`() {
        val blob = MemoryBlobStore()
        val cipher = JvmAesGcmCipher()
        val scope = "account-a"
        val legacy = legacySchemaFive(
            legacyCommand(
                "legacy-command",
                "legacy-operation",
                UUID.randomUUID().toString(),
                1,
            ),
        )
        blob.value = encryptOutbox(legacy, cipher, scope)
        val migrations = mutableListOf<CommandOutboxMigration>()

        val migrated = EncryptedAtomicCommandOutboxStore(blob, cipher, scope, migrations::add).load()

        assertEquals(CommandOutboxMigration(5, 0), migrations.single())
        assertEquals(CommandState.PUBLISHED, checkNotNull(migrated).commands.single().state)
        val rewritten = decryptOutbox(checkNotNull(blob.value), cipher, scope)
        assertTrue(rewritten.toString(Charsets.UTF_8).contains("\"schemaVersion\":6"))
        assertFalse(rewritten.toString(Charsets.UTF_8).contains("lastAcknowledgedSequence"))
    }

    @Test
    fun `failed atomic migration preserves the complete legacy blob`() {
        val blob = MemoryBlobStore()
        val cipher = JvmAesGcmCipher()
        val scope = "account-a"
        val legacy = legacySchemaFive(
            legacyCommand(
                "legacy-command",
                "legacy-operation",
                UUID.randomUUID().toString(),
                1,
            ),
        )
        val original = encryptOutbox(legacy, cipher, scope)
        blob.value = original.copyOf()
        blob.failNextWrite = true

        assertThrows(IllegalStateException::class.java) {
            EncryptedAtomicCommandOutboxStore(blob, cipher, scope).load()
        }
        assertArrayEquals(original, blob.value)
    }

    private fun prompt(text: String) = buildJsonObject {
        put("operation", "prompt")
        put("sessionId", "session-1")
        put("text", text)
    }

    private fun sessionCreate() = buildJsonObject { put("operation", "session.create") }

    private fun legacySchemaFive(vararg commands: kotlinx.serialization.json.JsonObject): ByteArray =
        buildJsonObject {
            put("schemaVersion", 5)
            put("lastAcknowledgedSequence", 0)
            put("lastRevision", 0)
            put("revisionEpoch", JsonNull)
            put("revisionEpochGeneration", JsonNull)
            put("commands", buildJsonArray { commands.forEach(::add) })
            put("released", buildJsonArray {})
        }.toString().toByteArray(Charsets.UTF_8)

    private fun legacyCommand(
        commandId: String,
        operationId: String,
        idempotencyKey: String,
        sequence: Long,
    ) = buildJsonObject {
        put("operationId", operationId)
        put("commandId", commandId)
        put("retiredCommandIds", buildJsonArray {})
        put("idempotencyKey", idempotencyKey)
        put("requestFingerprint", "a".repeat(64))
        put("state", "accepted")
        put("submittedAt", 1_000)
        put("updatedAt", 1_001)
        put("sessionId", JsonNull)
        put("projectId", "project-$sequence")
        put("sequence", sequence)
        put("baseRevision", 0)
        put("revisionEpoch", JsonNull)
        put("revisionEpochGeneration", JsonNull)
        put("authenticationIssuedAt", 1_000)
        put("authenticationNonce", "b".repeat(64))
        put("revision", 0)
        put("cancelRequested", false)
        put("completion", JsonNull)
        put("expectedRevision", JsonNull)
        put("payload", sessionCreate())
    }

    private fun legacySchemaTwo(commandId: String, idempotencyKey: String): ByteArray =
        buildJsonObject {
            put("schemaVersion", 2)
            put("lastAcknowledgedSequence", 0)
            put("lastRevision", 0)
            put("commands", buildJsonArray {
                add(buildJsonObject {
                    put("operationId", "legacy-unsafe-operation")
                    put("commandId", commandId)
                    put("retiredCommandIds", buildJsonArray {})
                    put("idempotencyKey", idempotencyKey)
                    put("requestFingerprint", "c".repeat(64))
                    put("state", "transmitting")
                    put("submittedAt", 1_000)
                    put("updatedAt", 1_001)
                    put("sessionId", JsonNull)
                    put("sequence", 1)
                    put("baseRevision", 0)
                    put("authenticationIssuedAt", JsonNull)
                    put("authenticationNonce", JsonNull)
                    put("revision", JsonNull)
                    put("cancelRequested", false)
                    put("completion", JsonNull)
                    put("expectedRevision", JsonNull)
                    put("payload", sessionCreate())
                })
            })
            put("released", buildJsonArray {})
        }.toString().toByteArray(Charsets.UTF_8)

    private class MemoryBlobStore : CommandOutboxBlobStore {
        var value: ByteArray? = null
        var failNextWrite = false
        override fun exists(): Boolean = value != null
        override fun read(): ByteArray = checkNotNull(value).copyOf()
        override fun write(bytes: ByteArray) {
            if (failNextWrite) {
                failNextWrite = false
                throw IllegalStateException("simulated atomic write failure")
            }
            value = bytes.copyOf()
        }
        override fun delete() {
            value = null
        }
    }

    private fun encryptOutbox(plaintext: ByteArray, cipher: SecretCipher, scope: String): ByteArray {
        val associatedData = "malink.command.outbox.v1\u0000$scope".toByteArray(Charsets.UTF_8)
        val encrypted = cipher.encrypt(plaintext, associatedData)
        return try {
            SecretEnvelope.encode(encrypted)
        } finally {
            encrypted.iv.fill(0)
            encrypted.ciphertext.fill(0)
        }
    }

    private fun decryptOutbox(encrypted: ByteArray, cipher: SecretCipher, scope: String): ByteArray {
        val associatedData = "malink.command.outbox.v1\u0000$scope".toByteArray(Charsets.UTF_8)
        val envelope = SecretEnvelope.decode(encrypted)
        return try {
            cipher.decrypt(envelope, associatedData)
        } finally {
            envelope.iv.fill(0)
            envelope.ciphertext.fill(0)
        }
    }

    private class JvmAesGcmCipher : SecretCipher {
        private val key: SecretKey = KeyGenerator.getInstance("AES").run {
            init(256, SecureRandom())
            generateKey()
        }

        override fun encrypt(plaintext: ByteArray, associatedData: ByteArray): EncryptedPayload {
            val iv = ByteArray(12).also(SecureRandom()::nextBytes)
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.ENCRYPT_MODE, key, GCMParameterSpec(128, iv))
            cipher.updateAAD(associatedData)
            return EncryptedPayload(iv, cipher.doFinal(plaintext))
        }

        override fun decrypt(payload: EncryptedPayload, associatedData: ByteArray): ByteArray {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, payload.iv))
            cipher.updateAAD(associatedData)
            return cipher.doFinal(payload.ciphertext)
        }
    }

    private class IncrementingClock : CommandClock {
        private var next = 1_000L
        override fun now(): Long = next++
    }

    private class IncrementingIds : CommandIdFactory {
        private var next = 1
        override fun newId(): String = "generated-${next++}"
    }
}
