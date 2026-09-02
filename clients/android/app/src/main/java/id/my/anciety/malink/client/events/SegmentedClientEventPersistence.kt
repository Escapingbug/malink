package id.my.anciety.malink.client.events

import android.util.AtomicFile
import id.my.anciety.malink.security.SecretCipher
import id.my.anciety.malink.security.SecretEnvelope
import java.io.File
import java.security.MessageDigest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put

internal interface ClientEventSegmentBlobStore {
    fun read(key: String): ByteArray?
    fun write(key: String, bytes: ByteArray)
    fun exists(key: String): Boolean
    fun keys(): Set<String>
    fun delete(key: String)
    fun clear()
}

private class AtomicClientEventSegmentBlobStore(
    private val root: File,
) : ClientEventSegmentBlobStore {
    private val segmentRoot = File(root, "segments")

    override fun read(key: String): ByteArray? = file(key)
        .takeIf(File::isFile)
        ?.let { AtomicFile(it).readFully() }

    override fun write(key: String, bytes: ByteArray) {
        ensureDirectories()
        val atomic = AtomicFile(file(key))
        val output = atomic.startWrite()
        try {
            output.write(bytes)
            output.fd.sync()
            atomic.finishWrite(output)
        } catch (error: Exception) {
            atomic.failWrite(output)
            throw error
        }
    }

    override fun exists(key: String): Boolean = file(key).isFile

    override fun keys(): Set<String> = segmentRoot.listFiles().orEmpty()
        .filter { it.isFile && it.name.endsWith(".enc") }
        .mapTo(linkedSetOf()) { it.name.removeSuffix(".enc") }

    override fun delete(key: String) = AtomicFile(file(key)).delete()

    override fun clear() {
        root.listFiles().orEmpty().forEach { entry ->
            check(entry.deleteRecursively()) { "Client event storage could not be cleared." }
        }
        check(!root.exists() || root.delete()) { "Client event directory could not be cleared." }
    }

    private fun file(key: String): File = if (key == MANIFEST_KEY) {
        File(root, "manifest.enc")
    } else {
        require(REFERENCE.matches(key)) { "Client event segment reference is invalid." }
        File(segmentRoot, "$key.enc")
    }

    private fun ensureDirectories() {
        check(root.isDirectory || root.mkdirs()) { "Client event directory could not be created." }
        check(segmentRoot.isDirectory || segmentRoot.mkdirs()) {
            "Client event segment directory could not be created."
        }
    }
}

/**
 * Content-addressed encrypted event storage. A normal append rewrites one
 * small tail page plus the manifest instead of the complete event/history
 * projection. The legacy atomic blob is imported once after an APK upgrade.
 */
internal class SegmentedEncryptedClientEventPersistence private constructor(
    private val storage: ClientEventSegmentBlobStore,
    private val cipher: SecretCipher,
    private val accountScope: String,
    private val legacy: ClientEventPersistence?,
    private val maxPlaintextBytes: Int,
) : ClientEventPersistence, StructuredClientEventPersistence {
    private data class PendingSegment(val reference: String, val bytes: ByteArray)

    constructor(
        root: File,
        cipher: SecretCipher,
        accountScope: String,
        legacy: ClientEventPersistence? = null,
        maxPlaintextBytes: Int = 3 * 1024 * 1024,
    ) : this(
        AtomicClientEventSegmentBlobStore(root),
        cipher,
        accountScope,
        legacy,
        maxPlaintextBytes,
    )

    internal constructor(
        blobs: ClientEventSegmentBlobStore,
        cipher: SecretCipher,
        accountScope: String,
        legacy: ClientEventPersistence? = null,
        maxPlaintextBytes: Int = 3 * 1024 * 1024,
        @Suppress("UNUSED_PARAMETER") testBoundary: Unit,
    ) : this(blobs, cipher, accountScope, legacy, maxPlaintextBytes)

    init {
        require(accountScope.length in 1..512)
        require(maxPlaintextBytes in 16 * 1024..3 * 1024 * 1024)
    }

    @Synchronized
    override fun load(): ByteArray? = loadState()?.let(ClientEventStateCodec::encode)

    @Synchronized
    override fun loadState(): PersistedClientEventState? {
        if (!storage.exists(MANIFEST_KEY)) {
            val legacyBytes = legacy?.load() ?: return null
            return try {
                val state = ClientEventStateCodec.decode(legacyBytes)
                saveState(state, maxPlaintextBytes)
                legacy.clear()
                state
            } finally {
                legacyBytes.fill(0)
            }
        }
        val manifestBytes = readEncrypted(MANIFEST_KEY, MAX_MANIFEST_BYTES)
        val manifest = try {
            Json.parseToJsonElement(manifestBytes.toString(Charsets.UTF_8)).jsonObject
        } finally {
            manifestBytes.fill(0)
        }
        require(manifest.keys == MANIFEST_KEYS) { "Client event manifest shape is invalid." }
        require(manifest.requiredLong("schemaVersion") == 1L)
        val headSequence = manifest.requiredLong("headSequence").also { require(it >= 0) }
        val headCursor = manifest.requiredString("headCursor", 512)
        val historySequence = manifest.requiredLong("historySequence").also { require(it >= 0) }
        val snapshotGeneratedAt = manifest.requiredLong("snapshotGeneratedAt")
        val core = readSegmentObject(manifest.requiredString("snapshotCore", 96))
        val commands = readSegmentArray(manifest.requiredString("commands", 96))
        val gatewayReference = manifest["gatewayState"]
            ?.takeUnless { it is JsonNull }
            ?.jsonPrimitive
            ?.contentOrNull
        val gatewayState = gatewayReference?.let(::readSegmentElement)
        val snapshot = buildJsonObject {
            core.forEach { (key, value) -> put(key, value) }
            put("cursor", headCursor)
            put("generatedAt", snapshotGeneratedAt)
            put("commands", commands)
            gatewayState?.let { put("gatewayState", it) }
        }
        val events = buildJsonArray {
            manifest.getValue("eventSegments").jsonArray.forEach { reference ->
                readSegmentArray(reference.jsonPrimitive.content).forEach(::add)
            }
        }
        val history = buildJsonArray {
            manifest.getValue("historySegments").jsonArray.forEach { entryElement ->
                val entry = entryElement.jsonObject
                require(entry.keys == setOf("sessionId", "segments"))
                entry.requiredString("sessionId", 512)
                entry.getValue("segments").jsonArray.forEach { reference ->
                    readSegmentArray(reference.jsonPrimitive.content).forEach(::add)
                }
            }
        }
        val plaintext = buildJsonObject {
            put("schemaVersion", 1)
            put("headSequence", headSequence)
            put("headCursor", headCursor)
            put("historySequence", historySequence)
            put("events", events)
            put("history", JsonArray(history.sortedWith(compareBy<JsonElement>(
                { it.jsonObject.getValue("message").jsonObject.getValue("timestamp")
                    .jsonPrimitive.longOrNull },
                { it.jsonObject.getValue("sequence").jsonPrimitive.longOrNull },
            ))))
            put("snapshot", snapshot)
        }.toString().toByteArray(Charsets.UTF_8)
        require(plaintext.size <= maxPlaintextBytes) { "Client event state is too large." }
        return try {
            ClientEventStateCodec.decode(plaintext)
        } finally {
            plaintext.fill(0)
        }
    }

    @Synchronized
    override fun save(plaintext: ByteArray) {
        require(plaintext.size <= maxPlaintextBytes) { "Client event state is too large." }
        saveState(ClientEventStateCodec.decode(plaintext), maxPlaintextBytes)
    }

    @Synchronized
    override fun saveState(
        value: PersistedClientEventState,
        maximumPlaintextBytes: Int,
    ) {
        require(maximumPlaintextBytes > 0)
        val pending = mutableListOf<PendingSegment>()
        try {
            val liveReferences = linkedSetOf<String>()
            val snapshot = PublicClientJson.encodeSnapshot(value.snapshot)
            val core = JsonObject(snapshot.filterKeys {
                it !in setOf("cursor", "generatedAt", "commands", "gatewayState")
            })
            val coreReference = prepareSegment(
                "snapshot",
                core.toString().toByteArray(),
                liveReferences,
                pending,
            )
            val commandsReference = prepareSegment(
                "commands",
                snapshot.getValue("commands").toString().toByteArray(),
                liveReferences,
                pending,
            )
            val gatewayReference = snapshot["gatewayState"]?.let { gateway ->
                prepareSegment(
                    "gateway",
                    gateway.toString().toByteArray(),
                    liveReferences,
                    pending,
                )
            }
            val eventReferences = pagesFromNewest(value.events, PAGE_SIZE).map { page ->
                val bytes = buildJsonArray {
                    page.forEach { stored ->
                        add(buildJsonObject {
                            put("sequence", stored.sequence)
                            put("event", PublicClientJson.encodeEvent(stored.event))
                        })
                    }
                }.toString().toByteArray()
                prepareSegment("events", bytes, liveReferences, pending)
            }
            val historyReferences = value.history.groupBy(StoredHistoryMessage::sessionId)
                .toSortedMap()
                .mapValues { (_, values) ->
                    pagesFromNewest(
                        values.sortedWith(compareBy({ it.message.timestamp }, { it.sequence })),
                        PAGE_SIZE,
                    ).map { page ->
                        val bytes = buildJsonArray {
                            page.forEach { stored ->
                                add(buildJsonObject {
                                    put("sequence", stored.sequence)
                                    put("cursor", stored.cursor)
                                    put("sessionId", stored.sessionId)
                                    put("message", PublicClientJson.encodeMessage(stored.message))
                                })
                            }
                        }.toString().toByteArray()
                        prepareSegment("history", bytes, liveReferences, pending)
                    }
                }
            val manifest = buildJsonObject {
                put("schemaVersion", 1)
                put("headSequence", value.headSequence)
                put("headCursor", value.headCursor)
                put("historySequence", value.historySequence)
                put("snapshotGeneratedAt", value.snapshot.generatedAt)
                put("snapshotCore", coreReference)
                put("commands", commandsReference)
                if (gatewayReference == null) put("gatewayState", JsonNull)
                else put("gatewayState", gatewayReference)
                put("eventSegments", buildJsonArray {
                    eventReferences.forEach { add(JsonPrimitive(it)) }
                })
                put("historySegments", buildJsonArray {
                    historyReferences.forEach { (sessionId, references) ->
                        add(buildJsonObject {
                            put("sessionId", sessionId)
                            put("segments", buildJsonArray {
                                references.forEach { add(JsonPrimitive(it)) }
                            })
                        })
                    }
                })
            }.toString().toByteArray(Charsets.UTF_8)
            try {
                val logicalBytes = manifest.size.toLong() +
                    pending.sumOf { it.bytes.size.toLong() }
                if (
                    manifest.size > MAX_MANIFEST_BYTES ||
                    logicalBytes > minOf(maxPlaintextBytes, maximumPlaintextBytes)
                ) {
                    throw ClientEventStateTooLargeException()
                }
                pending.distinctBy(PendingSegment::reference).forEach { segment ->
                    if (!storage.exists(segment.reference)) {
                        writeEncrypted(segment.reference, segment.bytes)
                    }
                }
                writeEncrypted(MANIFEST_KEY, manifest)
                collectGarbage(liveReferences)
            } finally {
                manifest.fill(0)
            }
        } finally {
            pending.forEach { it.bytes.fill(0) }
        }
    }

    @Synchronized
    fun validateStoredState() {
        loadState()
    }

    @Synchronized
    override fun clear() {
        storage.clear()
    }

    private fun prepareSegment(
        kind: String,
        bytes: ByteArray,
        liveReferences: MutableSet<String>,
        pending: MutableList<PendingSegment>,
    ): String {
        if (bytes.size > maxPlaintextBytes) {
            bytes.fill(0)
            throw ClientEventStateTooLargeException()
        }
        val reference = "$kind.${sha256Hex(bytes)}"
        require(REFERENCE.matches(reference))
        liveReferences += reference
        pending += PendingSegment(reference, bytes)
        return reference
    }

    private fun readSegmentElement(reference: String): JsonElement {
        require(REFERENCE.matches(reference)) { "Client event segment reference is invalid." }
        val bytes = readEncrypted(reference, maxPlaintextBytes)
        return try {
            Json.parseToJsonElement(bytes.toString(Charsets.UTF_8))
        } finally {
            bytes.fill(0)
        }
    }

    private fun readSegmentObject(reference: String): JsonObject =
        readSegmentElement(reference).jsonObject

    private fun readSegmentArray(reference: String): JsonArray =
        readSegmentElement(reference).jsonArray

    private fun readEncrypted(key: String, maximumBytes: Int): ByteArray {
        val encrypted = storage.read(key)
            ?: throw IllegalArgumentException("Client event encrypted segment is missing.")
        return try {
            val envelope = SecretEnvelope.decode(encrypted)
            try {
                cipher.decrypt(envelope, associatedData(key)).also {
                    require(it.size <= maximumBytes) { "Client event segment is too large." }
                    if (key != MANIFEST_KEY) {
                        require(key.substringAfter('.') == sha256Hex(it)) {
                            "Client event segment content address is invalid."
                        }
                    }
                }
            } finally {
                envelope.iv.fill(0)
                envelope.ciphertext.fill(0)
            }
        } finally {
            encrypted.fill(0)
        }
    }

    private fun writeEncrypted(key: String, plaintext: ByteArray) {
        val envelope = cipher.encrypt(plaintext, associatedData(key))
        val encrypted = try {
            SecretEnvelope.encode(envelope)
        } finally {
            envelope.iv.fill(0)
            envelope.ciphertext.fill(0)
        }
        try {
            storage.write(key, encrypted)
        } finally {
            encrypted.fill(0)
        }
    }

    private fun associatedData(key: String): ByteArray =
        "malink.client.event-segments.v1\u0000$accountScope\u0000$key".toByteArray()

    private fun collectGarbage(liveReferences: Set<String>) {
        storage.keys().filter { it !in liveReferences }.forEach(storage::delete)
    }

    private fun JsonObject.requiredLong(key: String): Long =
        get(key)?.jsonPrimitive?.longOrNull
            ?: throw IllegalArgumentException("$key is invalid.")

    private fun JsonObject.requiredString(key: String, maximumLength: Int): String =
        get(key)?.jsonPrimitive?.contentOrNull
            ?.takeIf { it.length in 1..maximumLength }
            ?: throw IllegalArgumentException("$key is invalid.")

    private companion object {
        const val PAGE_SIZE = 32
        const val MAX_MANIFEST_BYTES = 1024 * 1024
        val MANIFEST_KEYS = setOf(
            "schemaVersion",
            "headSequence",
            "headCursor",
            "historySequence",
            "snapshotGeneratedAt",
            "snapshotCore",
            "commands",
            "gatewayState",
            "eventSegments",
            "historySegments",
        )
    }
}

private const val MANIFEST_KEY = "manifest"
private val REFERENCE = Regex("^[a-z]+\\.[0-9a-f]{64}$")

private fun <T> pagesFromNewest(values: List<T>, size: Int): List<List<T>> = values
    .asReversed()
    .chunked(size)
    .map(List<T>::asReversed)
    .asReversed()

private fun sha256Hex(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256")
    .digest(bytes)
    .joinToString("") { "%02x".format(it.toInt() and 0xff) }
