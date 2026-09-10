package id.my.anciety.malink.client

import android.util.AtomicFile
import id.my.anciety.malink.diagnostics.DiagnosticRecorder
import id.my.anciety.malink.matrix.MatrixDecryptedEvent
import id.my.anciety.malink.security.SecretCipher
import id.my.anciety.malink.security.SecretEnvelope
import id.my.anciety.malink.security.malink.Base64Url
import id.my.anciety.malink.security.malink.CanonicalJson
import id.my.anciety.malink.security.malink.MatrixMlp3ProjectKey
import id.my.anciety.malink.security.malink.MatrixMlp3ProjectKeyGrant
import java.io.File
import java.security.MessageDigest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put

internal enum class MatrixMlp3InboxStatus(val wireName: String) {
    PENDING("pending"),
    QUARANTINED("quarantined"),
}

internal data class MatrixMlp3InboxRecord(
    val event: MatrixDecryptedEvent,
    val status: MatrixMlp3InboxStatus,
    val errorCode: String? = null,
)

internal data class MatrixMlp3TaskNotification(
    val eventId: String,
    val commandId: String,
    val outcome: String,
    val sessionId: String?,
    val body: String? = null,
)

internal enum class MatrixMlp3InboxProjectionStep {
    ADVANCED,
    DEFERRED,
}

/**
 * Matrix state and timeline events are not causally ordered across sync lanes.
 * Continue past deferred records so a later key grant or pointer can unlock an
 * earlier event, then repeat while any record was projected or quarantined.
 */
internal suspend fun drainMatrixMlp3Inbox(
    store: AtomicEncryptedMatrixMlp3InboxStore,
    project: suspend (MatrixMlp3InboxRecord) -> MatrixMlp3InboxProjectionStep,
) {
    try {
        do {
            var advanced = false
            for (record in store.pending()) {
                if (project(record) == MatrixMlp3InboxProjectionStep.ADVANCED) {
                    advanced = true
                }
            }
        } while (advanced && store.pending().isNotEmpty())
    } finally {
        // A process can be killed without reaching NativeClientRuntime.close().
        // Commit the whole replay batch here so already-projected events are
        // not decrypted and projected again on every cold start.
        store.flushProjected()
    }
}

internal interface MatrixMlp3BlobStore {
    fun read(): ByteArray?
    fun write(bytes: ByteArray)
    fun delete()
}

private class AtomicFileMatrixMlp3BlobStore(file: File) : MatrixMlp3BlobStore {
    private val atomic = AtomicFile(file)

    override fun read(): ByteArray? = if (atomic.baseFile.exists()) atomic.readFully() else null

    override fun write(bytes: ByteArray) = atomic.writeExactly(bytes)

    override fun delete() = atomic.delete()
}

internal interface MatrixMlp3RecordBlobStore {
    fun readAll(): Map<String, ByteArray>
    fun write(key: String, bytes: ByteArray)
    fun delete(key: String)
    fun clear()
}

private class AtomicDirectoryMatrixMlp3RecordBlobStore(
    private val directory: File,
) : MatrixMlp3RecordBlobStore {
    override fun readAll(): Map<String, ByteArray> {
        if (!directory.exists()) return emptyMap()
        check(directory.isDirectory) { "The MLP/3 inbox record store is not a directory." }
        val keys = directory.listFiles().orEmpty().mapNotNull { file ->
            when {
                file.isFile && file.name.endsWith(RECORD_SUFFIX) ->
                    file.name.removeSuffix(RECORD_SUFFIX)
                file.isFile && file.name.endsWith("$RECORD_SUFFIX.bak") ->
                    file.name.removeSuffix("$RECORD_SUFFIX.bak")
                else -> null
            }
        }.toSet()
        require(keys.size <= MAX_RECORD_FILES) { "The MLP/3 inbox record store is full." }
        return keys.associateWith { key ->
            require(key.matches(RECORD_KEY_PATTERN)) { "The MLP/3 inbox record key is invalid." }
            AtomicFile(fileFor(key)).readFully()
        }
    }

    override fun write(key: String, bytes: ByteArray) {
        require(key.matches(RECORD_KEY_PATTERN)) { "The MLP/3 inbox record key is invalid." }
        check(directory.isDirectory || directory.mkdirs()) {
            "The MLP/3 inbox record store could not be created."
        }
        AtomicFile(fileFor(key)).writeExactly(bytes)
    }

    override fun delete(key: String) {
        require(key.matches(RECORD_KEY_PATTERN)) { "The MLP/3 inbox record key is invalid." }
        AtomicFile(fileFor(key)).delete()
    }

    override fun clear() {
        check(directory.deleteRecursively()) { "The MLP/3 inbox record store could not be cleared." }
    }

    private fun fileFor(key: String) = File(directory, "$key$RECORD_SUFFIX")

    private companion object {
        const val RECORD_SUFFIX = ".enc"
        const val MAX_RECORD_FILES = 10_100
        val RECORD_KEY_PATTERN = Regex("[A-Za-z0-9_-]{43}")
    }
}

/**
 * Raw Matrix events are committed before parsing or projection. Successfully
 * projected events leave this queue because ClientEventHub is already the
 * durable materialized view; poison events remain quarantined and cannot hold
 * back the following sync event.
 */
internal class AtomicEncryptedMatrixMlp3InboxStore internal constructor(
    private val blob: MatrixMlp3BlobStore,
    private val recordBlobs: MatrixMlp3RecordBlobStore?,
    private val cipher: SecretCipher,
    scope: String,
) {
    private data class LoadedSegment(
        val key: String,
        val records: List<MatrixMlp3InboxRecord>,
    )

    internal constructor(blob: MatrixMlp3BlobStore, cipher: SecretCipher, scope: String) :
        this(blob, null, cipher, scope)

    constructor(
        legacyFile: File,
        recordsDirectory: File,
        cipher: SecretCipher,
        scope: String,
    ) : this(
        AtomicFileMatrixMlp3BlobStore(legacyFile),
        AtomicDirectoryMatrixMlp3RecordBlobStore(recordsDirectory),
        cipher,
        scope,
    )

    // Cryptographic domain strings are wire/storage compatibility values, not
    // the human protocol name, and cannot be renamed without losing old data.
    private val legacyAssociatedData = "malink.matrix-v3-inbox.v1\u0000$scope".toByteArray()
    private val recordAssociatedDataPrefix =
        "malink.matrix-v3-inbox-record.v1\u0000$scope\u0000".toByteArray()
    private var records = linkedMapOf<String, MatrixMlp3InboxRecord>()
    private val legacyEventIds = mutableSetOf<String>()
    private val segmentsByKey =
        linkedMapOf<String, LinkedHashMap<String, MatrixMlp3InboxRecord>>()
    private val segmentKeyByEventId = mutableMapOf<String, String>()
    private val dirtySegmentKeys = linkedSetOf<String>()
    private var legacyCleanupPending = false
    private val recordEncodedBytesByEventId = mutableMapOf<String, Int>()
    private var recordPlaintextBytes = 0L
    private var pendingRecordCount = 0
    private var projectedCleanupPending = false

    init {
        val legacy = loadLegacy()
        val loadedSegments = loadSegments()
        val durableSegments = loadedSegments
        val restored = linkedMapOf<String, MatrixMlp3InboxRecord>()
        val obsoleteSegmentKeys = linkedSetOf<String>()
        val compactedLegacy = legacy.map(::compactQuarantinedRecord)
        compactedLegacy.forEach { record ->
            val previous = restored.putIfAbsent(record.event.eventId, record)
            require(previous == null || previous == record) {
                "The MLP/3 inbox contains conflicting durable records."
            }
            legacyEventIds += record.event.eventId
        }
        durableSegments
            .sortedWith(compareBy<LoadedSegment> { segment ->
                segment.records.minOfOrNull { it.event.timestamp } ?: Long.MAX_VALUE
            }.thenBy(LoadedSegment::key))
            .forEach { segment ->
                val compacted = segment.records.map(::compactQuarantinedRecord)
                val retained = mutableListOf<MatrixMlp3InboxRecord>()
                compacted.forEach { record ->
                    val eventId = record.event.eventId
                    val previous = restored[eventId]
                    when {
                        previous == null -> {
                            restored[eventId] = record
                            retained += record
                            segmentKeyByEventId[eventId] = segment.key
                        }
                        legacyEventIds.remove(eventId) -> {
                            val reconciled = reconcileInboxRecords(previous, record)
                            restored[eventId] = reconciled
                            retained += reconciled
                            segmentKeyByEventId[eventId] = segment.key
                            legacyCleanupPending = true
                        }
                        else -> {
                            val reconciled = reconcileInboxRecords(previous, record)
                            val ownerKey = requireNotNull(segmentKeyByEventId[eventId])
                            val owner = segmentsByKey.getValue(ownerKey)
                            val ownerRecord = owner[eventId]
                            require(ownerRecord != null)
                            if (ownerRecord != reconciled) {
                                owner[eventId] = reconciled
                                dirtySegmentKeys += ownerKey
                            }
                            restored[eventId] = reconciled
                        }
                    }
                }
                if (retained.isEmpty()) {
                    obsoleteSegmentKeys += segment.key
                } else {
                    segmentsByKey[segment.key] = retained.associateByTo(
                        linkedMapOf(),
                        { it.event.eventId },
                    )
                    if (retained != segment.records) dirtySegmentKeys += segment.key
                }
            }
        // Quarantine is a bounded deduplication ledger. Once an event has been
        // rejected, retaining its potentially 512 KiB raw body has no recovery
        // value and makes every later persist rewrite megabytes of poison data.
        // Compact records written by older APKs as soon as the encrypted store
        // is opened; event identity and the bounded diagnostic code remain.
        records = restored
        records.values.forEach { record ->
            val encodedBytes = encodedRecordSize(record)
            recordEncodedBytesByEventId[record.event.eventId] = encodedBytes
            recordPlaintextBytes += encodedBytes
            if (record.status == MatrixMlp3InboxStatus.PENDING) pendingRecordCount += 1
        }
        require(recordPlaintextBytes <= MAX_STORE_BYTES)
        // Persist every surviving owner before clearing an older duplicate.
        // A crash or write failure can therefore leave extra copies for the
        // next startup to reconcile, but can never discard the strongest
        // quarantine state or the only copy of an event.
        dirtySegmentKeys.toList().forEach { segmentKey ->
            persistSegment(segmentKey, segmentsByKey.getValue(segmentKey).values.toList())
            dirtySegmentKeys.remove(segmentKey)
        }
        if (compactedLegacy != legacy || legacyCleanupPending) {
            saveLegacy()
            legacyCleanupPending = false
        }
        obsoleteSegmentKeys.forEach { segmentKey -> recordBlobs?.delete(segmentKey) }
    }

    @Synchronized
    fun put(event: MatrixDecryptedEvent): Boolean {
        val existing = records[event.eventId]
        if (existing?.status == MatrixMlp3InboxStatus.QUARANTINED &&
            isLegacyTransientMatrixMlp3Quarantine(existing.errorCode)
        ) {
            // The old compacted record has no ciphertext left. A fresh Matrix
            // delivery supplies it again, through the normal verify-before-use
            // path. Removing this transient tombstone never accepts the event.
            projected(event.eventId)
            flushProjected()
        }
        if (records.containsKey(event.eventId)) return false
        require(event.rawJson.toByteArray().size <= MAX_EVENT_BYTES) {
            "The MLP/3 raw event is too large."
        }
        require(pendingRecordCount < MAX_PENDING_EVENTS) {
            "The MLP/3 raw inbox is full."
        }
        val record = MatrixMlp3InboxRecord(event, MatrixMlp3InboxStatus.PENDING)
        val encodedBytes = encodedRecordSize(record).toLong()
        require(recordPlaintextBytes + encodedBytes <= MAX_STORE_BYTES) {
            "The MLP/3 raw inbox is too large."
        }
        if (recordBlobs != null) {
            // Each new event owns one append-only encrypted record. Rewriting a
            // shared JSON segment for every concurrent Matrix callback amplified
            // a 32 MiB recovery backlog into continuous 50-150 MiB allocations
            // and starved the projection mutex. Existing v2 segments remain
            // readable and are compacted once at the next replay boundary.
            val targetKey = recordKey(record.event.eventId)
            require(targetKey !in segmentsByKey) {
                "The MLP/3 inbox record key collides with an existing segment."
            }
            persistIndividualRecord(targetKey, record)
            segmentsByKey[targetKey] = linkedMapOf(record.event.eventId to record)
            segmentKeyByEventId[event.eventId] = targetKey
            dirtySegmentKeys.remove(targetKey)
            records[event.eventId] = record
        } else {
            records[event.eventId] = record
            legacyEventIds += event.eventId
            try {
                saveLegacy()
            } catch (error: Exception) {
                records.remove(event.eventId)
                legacyEventIds.remove(event.eventId)
                throw error
            }
        }
        recordEncodedBytesByEventId[event.eventId] = encodedBytes.toInt()
        recordPlaintextBytes += encodedBytes
        pendingRecordCount += 1
        projectedCleanupPending = false
        return true
    }

    @Synchronized
    fun pending(): List<MatrixMlp3InboxRecord> = records.values
        .filter { it.status == MatrixMlp3InboxStatus.PENDING }

    @Synchronized
    fun projected(eventId: String) {
        val record = records.remove(eventId) ?: return
        val segmentKey = segmentKeyByEventId.remove(eventId)
        if (segmentKey != null) {
            segmentsByKey.getValue(segmentKey).remove(eventId)
            dirtySegmentKeys += segmentKey
        } else if (legacyEventIds.remove(eventId)) {
            legacyCleanupPending = true
        }
        recordPlaintextBytes -= requireNotNull(
            recordEncodedBytesByEventId.remove(eventId),
        ).toLong()
        if (record.status == MatrixMlp3InboxStatus.PENDING) pendingRecordCount -= 1
        if (recordBlobs == null) {
            projectedCleanupPending = true
        }
    }

    @Synchronized
    fun quarantine(eventId: String, error: Throwable) {
        val current = records[eventId] ?: return
        val updated = compactQuarantinedRecord(current.copy(
            status = MatrixMlp3InboxStatus.QUARANTINED,
            errorCode = error.javaClass.simpleName.take(160),
        ))
        val currentEncodedBytes = requireNotNull(recordEncodedBytesByEventId[eventId])
        val updatedEncodedBytes = encodedRecordSize(updated)
        records[eventId] = updated
        recordEncodedBytesByEventId[eventId] = updatedEncodedBytes
        recordPlaintextBytes += (updatedEncodedBytes - currentEncodedBytes).toLong()
        if (current.status == MatrixMlp3InboxStatus.PENDING) pendingRecordCount -= 1
        val affectedSegments = linkedSetOf<String>()
        var legacyChanged = false
        segmentKeyByEventId[eventId]?.let { segmentKey ->
            val segment = segmentsByKey.getValue(segmentKey)
            require(segment.containsKey(eventId))
            segment[eventId] = updated
            affectedSegments += segmentKey
        } ?: run {
            legacyChanged = eventId in legacyEventIds
        }
        val quarantined = records.values
            .filter { it.status == MatrixMlp3InboxStatus.QUARANTINED }
            .map { it.event.eventId }
        if (quarantined.size > MAX_QUARANTINED_EVENTS) {
            val remove = quarantined.take(quarantined.size - MAX_QUARANTINED_EVENTS)
            remove.forEach { removedEventId ->
                val removed = requireNotNull(records.remove(removedEventId))
                recordPlaintextBytes -= requireNotNull(
                    recordEncodedBytesByEventId.remove(removed.event.eventId),
                ).toLong()
                val removedSegment = segmentKeyByEventId.remove(removed.event.eventId)
                if (removedSegment != null) {
                    segmentsByKey.getValue(removedSegment).remove(removed.event.eventId)
                    affectedSegments += removedSegment
                } else if (legacyEventIds.remove(removed.event.eventId)) {
                    legacyChanged = true
                }
            }
        }
        if (recordBlobs == null || legacyChanged) {
            saveLegacy()
            legacyCleanupPending = false
        }
        affectedSegments.forEach { segmentKey ->
            persistSegment(segmentKey, segmentsByKey.getValue(segmentKey).values.toList())
            dirtySegmentKeys.remove(segmentKey)
        }
        projectedCleanupPending = false
    }

    /** Persists successful removals at a lifecycle boundary, not once per event. */
    @Synchronized
    fun flushProjected() {
        if (recordBlobs == null) {
            if (!projectedCleanupPending) return
            saveLegacy()
            projectedCleanupPending = false
            return
        }
        if (legacyCleanupPending) {
            saveLegacy()
            legacyCleanupPending = false
        }
        dirtySegmentKeys.toList().forEach { segmentKey ->
            persistSegment(segmentKey, segmentsByKey.getValue(segmentKey).values.toList())
            dirtySegmentKeys.remove(segmentKey)
        }
        projectedCleanupPending = false
    }

    @Synchronized
    fun validateStoredState() {
        loadLegacy()
        loadSegments()
    }

    @Synchronized
    fun clear() {
        records.clear()
        legacyEventIds.clear()
        segmentsByKey.clear()
        segmentKeyByEventId.clear()
        dirtySegmentKeys.clear()
        recordEncodedBytesByEventId.clear()
        legacyCleanupPending = false
        recordPlaintextBytes = 0
        pendingRecordCount = 0
        projectedCleanupPending = false
        blob.delete()
        recordBlobs?.clear()
    }

    private fun loadLegacy(): List<MatrixMlp3InboxRecord> {
        val encrypted = blob.read() ?: return emptyList()
        val plaintext = try {
            val envelope = SecretEnvelope.decode(encrypted)
            try {
                cipher.decrypt(envelope, legacyAssociatedData)
            } finally {
                envelope.iv.fill(0)
                envelope.ciphertext.fill(0)
            }
        } finally {
            encrypted.fill(0)
        }
        return try {
            require(plaintext.size <= MAX_STORE_BYTES)
            val root = Json.parseToJsonElement(plaintext.toString(Charsets.UTF_8)).jsonObject
            require(root.keys == setOf("schemaVersion", "records"))
            require(root.getValue("schemaVersion").jsonPrimitive.longOrNull == 1L)
            val values = root.getValue("records") as? JsonArray
                ?: throw IllegalArgumentException("The MLP/3 raw inbox is invalid.")
            require(values.size <= MAX_PENDING_EVENTS + MAX_QUARANTINED_EVENTS)
            values.map(::decodeRecord).also { decoded ->
                require(decoded.map { it.event.eventId }.distinct().size == decoded.size)
            }
        } finally {
            plaintext.fill(0)
        }
    }

    private fun loadSegments(): List<LoadedSegment> = recordBlobs
        ?.readAll()
        .orEmpty()
        .map { (key, encrypted) ->
            val plaintext = try {
                val envelope = SecretEnvelope.decode(encrypted)
                try {
                    cipher.decrypt(envelope, recordAssociatedData(key))
                } finally {
                    envelope.iv.fill(0)
                    envelope.ciphertext.fill(0)
                }
            } finally {
                encrypted.fill(0)
            }
            try {
                require(plaintext.size <= MAX_STORE_BYTES)
                val root = Json.parseToJsonElement(plaintext.toString(Charsets.UTF_8)).jsonObject
                when (root.getValue("schemaVersion").jsonPrimitive.longOrNull) {
                    1L -> {
                        require(root.keys == setOf("schemaVersion", "record"))
                        val record = decodeRecord(root.getValue("record"))
                        require(recordKey(record.event.eventId) == key) {
                            "The MLP/3 inbox record key does not match its event."
                        }
                        LoadedSegment(key, listOf(record))
                    }
                    2L -> {
                        require(root.keys == setOf("schemaVersion", "records"))
                        val values = root.getValue("records") as? JsonArray
                            ?: throw IllegalArgumentException("The MLP/3 inbox segment is invalid.")
                        require(values.isNotEmpty() && values.size <= MAX_PENDING_EVENTS + MAX_QUARANTINED_EVENTS)
                        val segmentRecords = values.map(::decodeRecord)
                        require(segmentRecords.map { it.event.eventId }.distinct().size == segmentRecords.size)
                        // A segment key is its stable encrypted-file identity. It
                        // starts as a hash of the first event, but that event can
                        // be projected before later records in the same segment.
                        // Retaining the original key keeps the remaining records
                        // crash-safe without rewriting or renaming the file.
                        LoadedSegment(key, segmentRecords)
                    }
                    else -> throw IllegalArgumentException("The MLP/3 inbox segment schema is invalid.")
                }
            } finally {
                plaintext.fill(0)
            }
        }

    private fun decodeRecord(value: kotlinx.serialization.json.JsonElement): MatrixMlp3InboxRecord {
        val record = value as? JsonObject
            ?: throw IllegalArgumentException("The MLP/3 raw inbox record is invalid.")
        require(record.keys == setOf(
            "roomId", "eventId", "sender", "timestamp", "rawJson", "status", "errorCode",
        ))
        val rawJson = record.requiredString("rawJson", MAX_EVENT_BYTES)
        return MatrixMlp3InboxRecord(
            event = MatrixDecryptedEvent(
                roomId = record.requiredString("roomId", 512),
                eventId = record.requiredString("eventId", 512),
                sender = record.requiredString("sender", 512),
                timestamp = record.requiredLong("timestamp"),
                rawJson = rawJson,
            ),
            status = MatrixMlp3InboxStatus.entries.single {
                it.wireName == record.requiredString("status", 32)
            },
            errorCode = record.optionalString("errorCode", 160),
        )
    }

    private fun encodeRecordValue(record: MatrixMlp3InboxRecord): JsonObject = buildJsonObject {
        put("roomId", record.event.roomId)
        put("eventId", record.event.eventId)
        put("sender", record.event.sender)
        put("timestamp", record.event.timestamp)
        put("rawJson", record.event.rawJson)
        put("status", record.status.wireName)
        if (record.errorCode == null) put("errorCode", kotlinx.serialization.json.JsonNull)
        else put("errorCode", record.errorCode)
    }

    private fun encodeRecord(record: MatrixMlp3InboxRecord): ByteArray =
        CanonicalJson.bytes(encodeRecordValue(record))
            .also { require(it.size <= MAX_RECORD_BYTES) }

    private fun encodedRecordSize(record: MatrixMlp3InboxRecord): Int {
        val encoded = encodeRecord(record)
        return try {
            encoded.size
        } finally {
            encoded.fill(0)
        }
    }

    private fun encodeSegment(records: List<MatrixMlp3InboxRecord>): ByteArray {
        require(records.isNotEmpty())
        return CanonicalJson.bytes(buildJsonObject {
            put("schemaVersion", 2)
            put("records", buildJsonArray {
                records.forEach { record -> add(encodeRecordValue(record)) }
            })
        }).also { require(it.size <= MAX_STORE_BYTES) }
    }

    private fun persistSegment(key: String, records: List<MatrixMlp3InboxRecord>) {
        val target = requireNotNull(recordBlobs)
        if (records.isEmpty()) {
            target.delete(key)
            segmentsByKey.remove(key)
            return
        }
        val plaintext = encodeSegment(records)
        val encrypted = try {
            val envelope = cipher.encrypt(plaintext, recordAssociatedData(key))
            try {
                SecretEnvelope.encode(envelope)
            } finally {
                envelope.iv.fill(0)
                envelope.ciphertext.fill(0)
            }
        } finally {
            plaintext.fill(0)
        }
        try {
            target.write(key, encrypted)
        } finally {
            encrypted.fill(0)
        }
    }

    private fun persistIndividualRecord(key: String, record: MatrixMlp3InboxRecord) {
        val target = requireNotNull(recordBlobs)
        val plaintext = CanonicalJson.bytes(buildJsonObject {
            put("schemaVersion", 1)
            put("record", encodeRecordValue(record))
        }).also { require(it.size <= MAX_RECORD_BYTES) }
        val encrypted = try {
            val envelope = cipher.encrypt(plaintext, recordAssociatedData(key))
            try {
                SecretEnvelope.encode(envelope)
            } finally {
                envelope.iv.fill(0)
                envelope.ciphertext.fill(0)
            }
        } finally {
            plaintext.fill(0)
        }
        try {
            target.write(key, encrypted)
        } finally {
            encrypted.fill(0)
        }
    }

    private fun recordKey(eventId: String): String = Base64Url.encode(
        MessageDigest.getInstance("SHA-256").digest(eventId.toByteArray(Charsets.UTF_8)),
    )

    private fun recordAssociatedData(key: String): ByteArray =
        recordAssociatedDataPrefix + key.toByteArray(Charsets.UTF_8)

    private fun saveLegacy() {
        val legacyRecords = if (recordBlobs == null) {
            records.values
        } else {
            records.values.filter { it.event.eventId in legacyEventIds }
        }
        if (legacyRecords.isEmpty()) {
            blob.delete()
            return
        }
        val plaintext = CanonicalJson.bytes(buildJsonObject {
            put("schemaVersion", 1)
            put("records", buildJsonArray {
                legacyRecords.forEach { record -> add(encodeRecordValue(record)) }
            })
        })
        require(plaintext.size <= MAX_STORE_BYTES)
        val encrypted = try {
            val envelope = cipher.encrypt(plaintext, legacyAssociatedData)
            try {
                SecretEnvelope.encode(envelope)
            } finally {
                envelope.iv.fill(0)
                envelope.ciphertext.fill(0)
            }
        } finally {
            plaintext.fill(0)
        }
        try {
            blob.write(encrypted)
        } finally {
            encrypted.fill(0)
        }
    }

    private companion object {
        const val QUARANTINED_EVENT_PLACEHOLDER = "{}"
        const val MAX_EVENT_BYTES = 512 * 1024
        const val MAX_RECORD_BYTES = MAX_EVENT_BYTES + 4 * 1024
        const val MAX_PENDING_EVENTS = 10_000
        const val MAX_QUARANTINED_EVENTS = 100
        const val MAX_STORE_BYTES = 32 * 1024 * 1024
        val NON_AUTHORITATIVE_MATRIX_EVENT_FIELDS = setOf(
            "age",
            "event_id",
            "origin_server_ts",
            "prev_content",
            "replaces_state",
            "room_id",
            "sender",
            "unsigned",
            "user_id",
        )
    }

    private fun compactQuarantinedRecord(record: MatrixMlp3InboxRecord): MatrixMlp3InboxRecord =
        if (
            record.status == MatrixMlp3InboxStatus.QUARANTINED &&
            record.event.rawJson != QUARANTINED_EVENT_PLACEHOLDER
        ) {
            record.copy(event = record.event.copy(rawJson = QUARANTINED_EVENT_PLACEHOLDER))
        } else {
            record
        }

    private fun reconcileInboxRecords(
        first: MatrixMlp3InboxRecord,
        second: MatrixMlp3InboxRecord,
    ): MatrixMlp3InboxRecord {
        require(first.event.eventId == second.event.eventId)
        require(
            first.event.roomId == second.event.roomId &&
                first.event.sender == second.event.sender &&
                first.event.timestamp == second.event.timestamp,
        ) { "The MLP/3 inbox contains conflicting durable records." }
        val firstCompacted = first.status == MatrixMlp3InboxStatus.QUARANTINED &&
            first.event.rawJson == QUARANTINED_EVENT_PLACEHOLDER
        val secondCompacted = second.status == MatrixMlp3InboxStatus.QUARANTINED &&
            second.event.rawJson == QUARANTINED_EVENT_PLACEHOLDER
        if (
            first.event.rawJson != second.event.rawJson &&
            !firstCompacted &&
            !secondCompacted &&
            !equivalentMatrixEventPayload(first.event, second.event)
        ) {
            throw IllegalArgumentException("The MLP/3 inbox contains conflicting durable records.")
        }
        if (
            first.status == MatrixMlp3InboxStatus.PENDING &&
            second.status == MatrixMlp3InboxStatus.PENDING
        ) {
            require(first.errorCode == null && second.errorCode == null) {
                "The MLP/3 inbox contains conflicting durable records."
            }
            return second
        }
        val errorCode = sequenceOf(first, second)
            .filter { it.status == MatrixMlp3InboxStatus.QUARANTINED }
            .mapNotNull(MatrixMlp3InboxRecord::errorCode)
            .minOrNull()
        return MatrixMlp3InboxRecord(
            event = first.event.copy(rawJson = QUARANTINED_EVENT_PLACEHOLDER),
            status = MatrixMlp3InboxStatus.QUARANTINED,
            errorCode = errorCode,
        )
    }

    private fun equivalentMatrixEventPayload(
        first: MatrixDecryptedEvent,
        second: MatrixDecryptedEvent,
    ): Boolean =
        runCatching {
            fun authoritative(event: MatrixDecryptedEvent): JsonObject {
                val root = Json.parseToJsonElement(event.rawJson).jsonObject
                fun requireIdentity(field: String, expected: String) {
                    root[field]?.let { value -> require(value.jsonPrimitive.content == expected) }
                }
                requireIdentity("event_id", event.eventId)
                requireIdentity("room_id", event.roomId)
                requireIdentity("sender", event.sender)
                requireIdentity("user_id", event.sender)
                root["origin_server_ts"]?.let { value ->
                    require(value.jsonPrimitive.longOrNull == event.timestamp)
                }
                // Matrix SDK timeline JSON can lift legacy unsigned transport
                // metadata to the event root, while /messages leaves it under
                // unsigned or omits it. None of these fields is projected as
                // current application content. Redundant identity fields are
                // accepted only after matching the durable event above.
                return JsonObject(
                    root.filterKeys { field -> field !in NON_AUTHORITATIVE_MATRIX_EVENT_FIELDS },
                )
            }
            authoritative(first) == authoritative(second)
        }.getOrDefault(false)
}

/**
 * Durable local-notification outbox for authenticated task terminal events.
 *
 * Matrix may replay a timeline event after reconnect or process death. Pending
 * records retry a notification callback that failed before Android accepted
 * it, while delivered event IDs prevent the same logical terminal from
 * alerting again.
 */
internal class AtomicEncryptedMatrixMlp3TaskNotificationStore internal constructor(
    private val blob: MatrixMlp3BlobStore,
    private val cipher: SecretCipher,
    scope: String,
) {
    constructor(file: File, cipher: SecretCipher, scope: String) :
        this(AtomicFileMatrixMlp3BlobStore(file), cipher, scope)

    private data class State(
        val pending: List<MatrixMlp3TaskNotification>,
        val deliveredEventIds: List<String>,
    )

    private val associatedData = "malink.matrix-v3-task-notifications.v1\u0000$scope".toByteArray()
    private var state = load()

    @Synchronized
    fun enqueue(value: MatrixMlp3TaskNotification): Boolean {
        validate(value)
        if (
            state.pending.any { it.eventId == value.eventId } ||
            value.eventId in state.deliveredEventIds
        ) return false
        require(state.pending.size < MAX_PENDING) {
            "The MLP/3 task notification outbox is full."
        }
        replaceState(state.copy(pending = state.pending + value))
        return true
    }

    @Synchronized
    fun pending(): List<MatrixMlp3TaskNotification> = state.pending

    @Synchronized
    fun delivered(eventId: String) {
        val pending = state.pending.filterNot { it.eventId == eventId }
        if (pending.size == state.pending.size) return
        val delivered = (state.deliveredEventIds + eventId).takeLast(MAX_DELIVERED)
        replaceState(State(pending, delivered))
    }

    @Synchronized
    fun validateStoredState() {
        load()
    }

    @Synchronized
    fun migrateStoredState() {
        save()
    }

    @Synchronized
    fun clear() {
        state = State(emptyList(), emptyList())
        blob.delete()
    }

    private fun load(): State {
        val encrypted = blob.read() ?: return State(emptyList(), emptyList())
        val plaintext = try {
            val envelope = SecretEnvelope.decode(encrypted)
            try {
                cipher.decrypt(envelope, associatedData)
            } finally {
                envelope.iv.fill(0)
                envelope.ciphertext.fill(0)
            }
        } finally {
            encrypted.fill(0)
        }
        return try {
            require(plaintext.size <= MAX_STORE_BYTES)
            val root = Json.parseToJsonElement(plaintext.toString(Charsets.UTF_8)).jsonObject
            require(root.keys == setOf("schemaVersion", "pending", "deliveredEventIds"))
            val schemaVersion = root.requiredLong("schemaVersion")
            require(schemaVersion == 1L || schemaVersion == 2L)
            val pending = (root["pending"] as? JsonArray)?.map { item ->
                val value = item as? JsonObject
                    ?: throw IllegalArgumentException("The task notification record is invalid.")
                val expectedKeys = mutableSetOf(
                    "eventId", "commandId", "outcome", "sessionId",
                )
                if (schemaVersion >= 2L) expectedKeys += "body"
                require(value.keys == expectedKeys)
                MatrixMlp3TaskNotification(
                    eventId = value.requiredString("eventId", 256),
                    commandId = value.requiredString("commandId", 256),
                    outcome = value.requiredString("outcome", 32),
                    sessionId = value.optionalString("sessionId", 256),
                    body = if (schemaVersion >= 2L) {
                        value.optionalString("body", MAX_NOTIFICATION_BODY_BYTES)
                    } else {
                        null
                    },
                ).also(::validate)
            } ?: throw IllegalArgumentException("The task notification outbox is invalid.")
            val delivered = (root["deliveredEventIds"] as? JsonArray)?.map { item ->
                item.jsonPrimitive.content.also {
                    require(it.isNotBlank() && it.length <= 256) {
                        "The delivered task notification ID is invalid."
                    }
                }
            } ?: throw IllegalArgumentException("The task notification ledger is invalid.")
            require(pending.size <= MAX_PENDING)
            require(delivered.size <= MAX_DELIVERED)
            require(pending.map { it.eventId }.distinct().size == pending.size)
            require(delivered.distinct().size == delivered.size)
            require(pending.none { it.eventId in delivered })
            State(pending, delivered)
        } finally {
            plaintext.fill(0)
        }
    }

    private fun save() {
        if (state.pending.isEmpty() && state.deliveredEventIds.isEmpty()) {
            blob.delete()
            return
        }
        val plaintext = CanonicalJson.bytes(buildJsonObject {
            put("schemaVersion", 2)
            put("pending", buildJsonArray {
                state.pending.forEach { value ->
                    add(buildJsonObject {
                        put("eventId", value.eventId)
                        put("commandId", value.commandId)
                        put("outcome", value.outcome)
                        if (value.sessionId == null) put("sessionId", kotlinx.serialization.json.JsonNull)
                        else put("sessionId", value.sessionId)
                        if (value.body == null) put("body", kotlinx.serialization.json.JsonNull)
                        else put("body", value.body)
                    })
                }
            })
            put("deliveredEventIds", buildJsonArray {
                state.deliveredEventIds.forEach { add(JsonPrimitive(it)) }
            })
        })
        require(plaintext.size <= MAX_STORE_BYTES)
        val encrypted = try {
            val envelope = cipher.encrypt(plaintext, associatedData)
            try {
                SecretEnvelope.encode(envelope)
            } finally {
                envelope.iv.fill(0)
                envelope.ciphertext.fill(0)
            }
        } finally {
            plaintext.fill(0)
        }
        try {
            blob.write(encrypted)
        } finally {
            encrypted.fill(0)
        }
    }

    private fun replaceState(next: State) {
        val previous = state
        state = next
        try {
            save()
        } catch (error: Exception) {
            state = previous
            throw error
        }
    }

    private fun validate(value: MatrixMlp3TaskNotification) {
        require(value.eventId.isNotBlank() && value.eventId.length <= 256)
        require(value.commandId.isNotBlank() && value.commandId.length <= 256)
        require(value.outcome in setOf("succeeded", "failed", "cancelled"))
        require(value.sessionId == null || value.sessionId.isNotBlank() && value.sessionId.length <= 256)
        require(
            value.body == null ||
                value.body.isNotBlank() &&
                value.body.length <= MAX_NOTIFICATION_BODY_CHARS &&
                value.body.toByteArray().size <= MAX_NOTIFICATION_BODY_BYTES
        )
    }

    private companion object {
        const val MAX_PENDING = 10_000
        const val MAX_DELIVERED = 10_000
        const val MAX_STORE_BYTES = 4 * 1024 * 1024
        const val MAX_NOTIFICATION_BODY_CHARS = 2_048
        const val MAX_NOTIFICATION_BODY_BYTES = MAX_NOTIFICATION_BODY_CHARS * 4
    }
}

/** Durable key grant; unlike a timeline key bundle, this state is re-readable. */
internal class AtomicEncryptedMatrixMlp3ProjectKeyStore internal constructor(
    private val blob: MatrixMlp3BlobStore,
    private val cipher: SecretCipher,
    scope: String,
) {
    private data class ProjectRoomKey(val projectId: String, val roomId: String)

    constructor(file: File, cipher: SecretCipher, scope: String) :
        this(AtomicFileMatrixMlp3BlobStore(file), cipher, scope)

    private val associatedData = "malink.matrix-v3-project-keys.v1\u0000$scope".toByteArray()
    private var grants: MutableMap<ProjectRoomKey, MatrixMlp3ProjectKeyGrant> =
        load().toMutableMap()

    @Synchronized
    fun value(): MatrixMlp3ProjectKeyGrant? = grants.values.singleOrNull()?.deepCopy()

    @Synchronized
    fun valueForRoom(
        roomId: String,
        projectId: String? = null,
    ): MatrixMlp3ProjectKeyGrant? = grants.values.singleOrNull {
        it.roomId == roomId && (projectId == null || it.projectId == projectId)
    }?.deepCopy()

    @Synchronized
    fun valueForProject(
        projectId: String,
        excludedRoomIds: Set<String> = emptySet(),
    ): MatrixMlp3ProjectKeyGrant? {
        val matching = grants.values.filter {
            it.projectId == projectId && it.roomId !in excludedRoomIds
        }
        require(matching.size <= 1) { "The MLP/3 project has more than one primary room key." }
        return matching.singleOrNull()?.deepCopy()
    }

    @Synchronized
    fun values(): List<MatrixMlp3ProjectKeyGrant> = grants.values.map { it.deepCopy() }

    @Synchronized
    fun projectIds(): Set<String> = grants.values.mapTo(linkedSetOf()) { it.projectId }

    @Synchronized
    fun singleProjectId(): String? = grants.values.map { it.projectId }.distinct().singleOrNull()

    @Synchronized
    fun isNotEmpty(): Boolean = grants.isNotEmpty()

    @Synchronized
    fun save(value: MatrixMlp3ProjectKeyGrant) {
        val key = value.storageKey()
        grants.remove(key)?.wipe()
        grants[key] = value.deepCopy()
        persist()
    }

    @Synchronized
    fun retain(projectIds: Set<String>) {
        val removed = grants.filterValues { it.projectId !in projectIds }.keys
        if (removed.isEmpty()) return
        removed.forEach { key -> grants.remove(key)?.wipe() }
        persist()
    }

    @Synchronized
    fun migrateStoredState() {
        persist()
    }

    @Synchronized
    fun validateStoredState() {
        load().values.forEach(MatrixMlp3ProjectKeyGrant::wipe)
    }

    @Synchronized
    fun clear() {
        grants.values.forEach(MatrixMlp3ProjectKeyGrant::wipe)
        grants.clear()
        blob.delete()
    }

    private fun load(): Map<ProjectRoomKey, MatrixMlp3ProjectKeyGrant> {
        val encrypted = blob.read() ?: return emptyMap()
        val plaintext = try {
            val envelope = SecretEnvelope.decode(encrypted)
            try {
                cipher.decrypt(envelope, associatedData)
            } finally {
                envelope.iv.fill(0)
                envelope.ciphertext.fill(0)
            }
        } finally {
            encrypted.fill(0)
        }
        return try {
            require(plaintext.size <= MAX_BYTES)
            val root = Json.parseToJsonElement(plaintext.toString(Charsets.UTF_8)).jsonObject
            if (root["schemaVersion"]?.jsonPrimitive?.longOrNull == 1L) {
                val grant = decodeGrant(root)
                mapOf(grant.storageKey() to grant)
            } else {
                require(root.keys == setOf("schemaVersion", "grants"))
                require(root.requiredLong("schemaVersion") in 2L..4L)
                val decoded = (root["grants"] as? JsonArray).orEmpty().map { item ->
                    decodeGrant(item.jsonObject)
                }
                require(decoded.size <= 512)
                require(decoded.map { it.storageKey() }.distinct().size == decoded.size)
                decoded.associateBy { it.storageKey() }
            }
        } finally {
            plaintext.fill(0)
        }
    }

    private fun persist() {
        if (grants.isEmpty()) return blob.delete()
        val plaintext = CanonicalJson.bytes(buildJsonObject {
            put("schemaVersion", 4)
            put("grants", buildJsonArray {
                grants.values.sortedWith(compareBy(
                    MatrixMlp3ProjectKeyGrant::roomId,
                    MatrixMlp3ProjectKeyGrant::projectId,
                ))
                    .forEach { add(encodeGrant(it)) }
            })
        })
        require(plaintext.size <= MAX_BYTES)
        val encrypted = try {
            val envelope = cipher.encrypt(plaintext, associatedData)
            try {
                SecretEnvelope.encode(envelope)
            } finally {
                envelope.iv.fill(0)
                envelope.ciphertext.fill(0)
            }
        } finally {
            plaintext.fill(0)
        }
        try {
            blob.write(encrypted)
        } finally {
            encrypted.fill(0)
        }
    }

    private fun encodeGrant(value: MatrixMlp3ProjectKeyGrant): JsonObject = buildJsonObject {
        put("schemaVersion", 1)
        put("workspaceId", value.workspaceId)
        put("projectId", value.projectId)
        put("roomId", value.roomId)
        put("deviceId", value.deviceId)
        put("certificateId", value.certificateId)
        put("activeKeyId", value.activeKeyId)
        put("keys", buildJsonArray {
            value.keys.forEach { key ->
                add(buildJsonObject {
                    put("keyId", key.keyId)
                    put("key", Base64Url.encode(key.key))
                    put("createdAt", key.createdAt)
                })
            }
        })
    }

    private fun decodeGrant(value: JsonObject): MatrixMlp3ProjectKeyGrant {
        require(value.keys == setOf(
            "schemaVersion", "workspaceId", "projectId", "roomId", "deviceId",
            "certificateId", "activeKeyId", "keys",
        ))
        require(value.requiredLong("schemaVersion") == 1L)
        val keys = (value["keys"] as? JsonArray)?.map { item ->
            val key = item as? JsonObject
                ?: throw IllegalArgumentException("The stored MLP/3 project key is invalid.")
            require(key.keys == setOf("keyId", "key", "createdAt"))
            MatrixMlp3ProjectKey(
                keyId = key.requiredString("keyId", 256),
                key = Base64Url.decode(key.requiredString("key", 43)).also { require(it.size == 32) },
                createdAt = key.requiredLong("createdAt"),
            )
        } ?: throw IllegalArgumentException("The stored MLP/3 key list is invalid.")
        require(keys.size in 1..64 && keys.map { it.keyId }.distinct().size == keys.size)
        val activeKeyId = value.requiredString("activeKeyId", 256)
        require(keys.any { it.keyId == activeKeyId })
        return MatrixMlp3ProjectKeyGrant(
            workspaceId = value.requiredString("workspaceId", 256),
            projectId = value.requiredString("projectId", 256),
            roomId = value.requiredString("roomId", 512),
            deviceId = value.requiredString("deviceId", 256),
            certificateId = value.requiredString("certificateId", 256),
            activeKeyId = activeKeyId,
            keys = keys,
        )
    }

    private fun MatrixMlp3ProjectKeyGrant.storageKey() = ProjectRoomKey(projectId, roomId)

    private companion object {
        const val MAX_BYTES = 1024 * 1024
    }
}

private fun MatrixMlp3ProjectKeyGrant.deepCopy() = copy(
    keys = keys.map { it.copy(key = it.key.copyOf()) },
)

internal class AtomicEncryptedMatrixMlp3ProjectionStore internal constructor(
    private val blob: MatrixMlp3BlobStore,
    private val cipher: SecretCipher,
    scope: String,
) {
    constructor(file: File, cipher: SecretCipher, scope: String) :
        this(AtomicFileMatrixMlp3BlobStore(file), cipher, scope)

    private val associatedData = "malink.matrix-v3-projection.v1\u0000$scope".toByteArray()

    @Synchronized
    fun load(): JsonObject? {
        val encrypted = blob.read() ?: return null
        val plaintext = try {
            val envelope = SecretEnvelope.decode(encrypted)
            try {
                cipher.decrypt(envelope, associatedData)
            } finally {
                envelope.iv.fill(0)
                envelope.ciphertext.fill(0)
            }
        } finally {
            encrypted.fill(0)
        }
        return try {
            if (plaintext.size > MAX_BYTES) {
                throw MatrixMlp3ProjectionTooLargeException(plaintext.size, MAX_BYTES)
            }
            Json.parseToJsonElement(plaintext.toString(Charsets.UTF_8)).jsonObject
        } finally {
            plaintext.fill(0)
        }
    }

    @Synchronized
    fun save(value: JsonObject): Int {
        // This local AEAD cache is parsed as JSON, never signed or compared
        // byte-for-byte. Canonical wire encoding here sorted and copied the
        // entire workspace for each event, blocking live command receipts.
        val plaintext = value.toString().toByteArray(Charsets.UTF_8)
        if (plaintext.size > MAX_BYTES) {
            val actualBytes = plaintext.size
            plaintext.fill(0)
            throw MatrixMlp3ProjectionTooLargeException(actualBytes, MAX_BYTES)
        }
        val plaintextBytes = plaintext.size
        val encrypted = try {
            val envelope = cipher.encrypt(plaintext, associatedData)
            try {
                SecretEnvelope.encode(envelope)
            } finally {
                envelope.iv.fill(0)
                envelope.ciphertext.fill(0)
            }
        } finally {
            plaintext.fill(0)
        }
        try {
            blob.write(encrypted)
        } finally {
            encrypted.fill(0)
        }
        return plaintextBytes
    }

    @Synchronized
    fun validateStoredState() {
        load()
    }

    @Synchronized
    fun clear() = blob.delete()

    companion object {
        internal const val MAX_BYTES = 8 * 1024 * 1024
    }
}

internal class MatrixMlp3ProjectionTooLargeException(
    val actualBytes: Int,
    val maximumBytes: Int,
) : IllegalStateException(
    "The rebuildable MLP/3 projection is $actualBytes bytes; the encrypted cache limit is " +
        "$maximumBytes bytes.",
)

/**
 * Projection persistence is best-effort because Matrix plus the raw inbox are
 * the replay authorities. A cache write failure must never quarantine a
 * verified event or make transcript decoding fail.
 */
internal fun persistMatrixMlp3ProjectionCache(
    projection: MatrixMlp3NativeProjection,
    store: AtomicEncryptedMatrixMlp3ProjectionStore,
    diagnostics: DiagnosticRecorder,
    reason: String,
): Boolean {
    var durable: MatrixMlp3DurableProjection? = null
    return try {
        durable = projection.durableProjection()
        store.save(durable.value)
        if (durable.compacted) {
            diagnostics.record(
                "matrix.v3_projection.cache_compacted",
                mapOf(
                    "reason" to reason,
                    "bytes" to durable.encodedBytes.toString(),
                    "sessions" to durable.totalSessions.toString(),
                    "retained_sessions" to durable.retainedSessions.toString(),
                    "seen_events" to durable.totalSeenEvents.toString(),
                    "retained_seen_events" to durable.retainedSeenEvents.toString(),
                    "seen_commands" to durable.totalSeenCommands.toString(),
                    "retained_seen_commands" to durable.retainedSeenCommands.toString(),
                    "assistant_versions" to durable.totalAssistantVersions.toString(),
                    "retained_assistant_versions" to
                        durable.retainedAssistantVersions.toString(),
                    "completion_observations" to
                        durable.totalCompletionObservations.toString(),
                    "retained_completion_observations" to
                        durable.retainedCompletionObservations.toString(),
                ),
            )
        }
        true
    } catch (error: Exception) {
        diagnostics.record(
            "matrix.v3_projection.cache_write_failed",
            buildMap {
                put("reason", reason)
                put("error", error.javaClass.simpleName.take(160))
                durable?.let { put("bytes", it.encodedBytes.toString()) }
                if (error is MatrixMlp3ProjectionTooLargeException) {
                    put("actual_bytes", error.actualBytes.toString())
                    put("maximum_bytes", error.maximumBytes.toString())
                }
            },
        )
        false
    }
}

/** Exact first-attempt Matrix content, including the nondeterministic ES256 signature. */
internal class AtomicEncryptedMatrixMlp3CommandContentStore internal constructor(
    private val blob: MatrixMlp3BlobStore,
    private val cipher: SecretCipher,
    scope: String,
) {
    constructor(file: File, cipher: SecretCipher, scope: String) :
        this(AtomicFileMatrixMlp3BlobStore(file), cipher, scope)

    private val associatedData = "malink.matrix-v3-command-content.v1\u0000$scope".toByteArray()
    private var values = load().toMutableMap()

    @Synchronized
    fun get(commandId: String): JsonObject? = values[commandId]

    @Synchronized
    fun putIfAbsent(commandId: String, content: JsonObject): JsonObject {
        values[commandId]?.let { return it }
        require(commandId.isNotBlank() && commandId.length <= 256)
        require(content.toString().toByteArray().size <= MAX_CONTENT_BYTES)
        require(values.size < MAX_COMMANDS) { "The MLP/3 prepared-command store is full." }
        values[commandId] = content
        save()
        return content
    }

    @Synchronized
    fun remove(commandId: String) {
        if (values.remove(commandId) != null) save()
    }

    @Synchronized
    fun validateStoredState() {
        load()
    }

    @Synchronized
    fun clear() {
        values.clear()
        blob.delete()
    }

    private fun load(): Map<String, JsonObject> {
        val encrypted = blob.read() ?: return emptyMap()
        val plaintext = try {
            val envelope = SecretEnvelope.decode(encrypted)
            try {
                cipher.decrypt(envelope, associatedData)
            } finally {
                envelope.iv.fill(0)
                envelope.ciphertext.fill(0)
            }
        } finally {
            encrypted.fill(0)
        }
        return try {
            require(plaintext.size <= MAX_STORE_BYTES)
            val root = Json.parseToJsonElement(plaintext.toString(Charsets.UTF_8)).jsonObject
            require(root.keys == setOf("schemaVersion", "commands"))
            require(root.requiredLong("schemaVersion") == 1L)
            val commands = root["commands"] as? JsonObject
                ?: throw IllegalArgumentException("The MLP/3 prepared-command store is invalid.")
            require(commands.size <= MAX_COMMANDS)
            commands.mapValues { (commandId, value) ->
                require(commandId.isNotBlank() && commandId.length <= 256)
                (value as? JsonObject)?.also {
                    require(it.toString().toByteArray().size <= MAX_CONTENT_BYTES)
                } ?: throw IllegalArgumentException("A MLP/3 prepared command is invalid.")
            }
        } finally {
            plaintext.fill(0)
        }
    }

    private fun save() {
        val plaintext = CanonicalJson.bytes(buildJsonObject {
            put("schemaVersion", 1)
            put("commands", JsonObject(values.toSortedMap()))
        })
        require(plaintext.size <= MAX_STORE_BYTES)
        val encrypted = try {
            val envelope = cipher.encrypt(plaintext, associatedData)
            try {
                SecretEnvelope.encode(envelope)
            } finally {
                envelope.iv.fill(0)
                envelope.ciphertext.fill(0)
            }
        } finally {
            plaintext.fill(0)
        }
        try {
            blob.write(encrypted)
        } finally {
            encrypted.fill(0)
        }
    }

    private companion object {
        const val MAX_COMMANDS = 1_000
        const val MAX_CONTENT_BYTES = 512 * 1024
        const val MAX_STORE_BYTES = 64 * 1024 * 1024
    }
}

private fun JsonObject.requiredString(key: String, maxBytes: Int): String {
    val primitive = get(key) as? JsonPrimitive
        ?: throw IllegalArgumentException("$key is invalid.")
    require(primitive.isString)
    return primitive.content.also {
        require(it.isNotEmpty() && it.toByteArray().size <= maxBytes)
    }
}

private fun JsonObject.optionalString(key: String, maxBytes: Int): String? {
    val value = get(key) ?: return null
    if (value is kotlinx.serialization.json.JsonNull) return null
    return requiredString(key, maxBytes)
}

private fun JsonObject.requiredLong(key: String): Long {
    val primitive = get(key) as? JsonPrimitive
        ?: throw IllegalArgumentException("$key is invalid.")
    require(!primitive.isString)
    return primitive.longOrNull?.also { require(it >= 0) }
        ?: throw IllegalArgumentException("$key is invalid.")
}

private fun AtomicFile.writeExactly(bytes: ByteArray) {
    val output = startWrite()
    try {
        output.write(bytes)
        output.fd.sync()
        finishWrite(output)
    } catch (error: Exception) {
        failWrite(output)
        throw error
    }
}
