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
    do {
        var advanced = false
        for (record in store.pending()) {
            if (project(record) == MatrixMlp3InboxProjectionStep.ADVANCED) {
                advanced = true
            }
        }
    } while (advanced && store.pending().isNotEmpty())
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

/**
 * Raw Matrix events are committed before parsing or projection. Successfully
 * projected events leave this queue because ClientEventHub is already the
 * durable materialized view; poison events remain quarantined and cannot hold
 * back the following sync event.
 */
internal class AtomicEncryptedMatrixMlp3InboxStore internal constructor(
    private val blob: MatrixMlp3BlobStore,
    private val cipher: SecretCipher,
    scope: String,
) {
    constructor(file: File, cipher: SecretCipher, scope: String) :
        this(AtomicFileMatrixMlp3BlobStore(file), cipher, scope)

    // Cryptographic domain strings are wire/storage compatibility values, not
    // the human protocol name, and cannot be renamed without losing old data.
    private val associatedData = "malink.matrix-v3-inbox.v1\u0000$scope".toByteArray()
    private var records = load().toMutableList()
    private var projectedCleanupPending = false

    @Synchronized
    fun put(event: MatrixDecryptedEvent): Boolean {
        if (records.any { it.event.eventId == event.eventId }) return false
        require(event.rawJson.toByteArray().size <= MAX_EVENT_BYTES) {
            "The MLP/3 raw event is too large."
        }
        require(records.count { it.status == MatrixMlp3InboxStatus.PENDING } < MAX_PENDING_EVENTS) {
            "The MLP/3 raw inbox is full."
        }
        records += MatrixMlp3InboxRecord(event, MatrixMlp3InboxStatus.PENDING)
        save()
        projectedCleanupPending = false
        return true
    }

    @Synchronized
    fun pending(): List<MatrixMlp3InboxRecord> = records
        .filter { it.status == MatrixMlp3InboxStatus.PENDING }

    @Synchronized
    fun projected(eventId: String) {
        val changed = records.removeAll { it.event.eventId == eventId }
        if (changed) projectedCleanupPending = true
    }

    @Synchronized
    fun quarantine(eventId: String, error: Throwable) {
        val index = records.indexOfFirst { it.event.eventId == eventId }
        if (index < 0) return
        val current = records[index]
        records[index] = current.copy(
            status = MatrixMlp3InboxStatus.QUARANTINED,
            errorCode = error.javaClass.simpleName.take(160),
        )
        val quarantined = records.indices
            .filter { records[it].status == MatrixMlp3InboxStatus.QUARANTINED }
        if (quarantined.size > MAX_QUARANTINED_EVENTS) {
            val remove = quarantined.take(quarantined.size - MAX_QUARANTINED_EVENTS).toSet()
            records = records.filterIndexed { recordIndex, _ -> recordIndex !in remove }.toMutableList()
        }
        save()
        projectedCleanupPending = false
    }

    /** Persists successful removals at a lifecycle boundary, not once per event. */
    @Synchronized
    fun flushProjected() {
        if (!projectedCleanupPending) return
        save()
        projectedCleanupPending = false
    }

    @Synchronized
    fun validateStoredState() {
        load()
    }

    @Synchronized
    fun clear() {
        records.clear()
        projectedCleanupPending = false
        blob.delete()
    }

    private fun load(): List<MatrixMlp3InboxRecord> {
        val encrypted = blob.read() ?: return emptyList()
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
            require(root.keys == setOf("schemaVersion", "records"))
            require(root.getValue("schemaVersion").jsonPrimitive.longOrNull == 1L)
            val values = root.getValue("records") as? JsonArray
                ?: throw IllegalArgumentException("The MLP/3 raw inbox is invalid.")
            require(values.size <= MAX_PENDING_EVENTS + MAX_QUARANTINED_EVENTS)
            values.map { value ->
                val record = value as? JsonObject
                    ?: throw IllegalArgumentException("The MLP/3 raw inbox record is invalid.")
                require(record.keys == setOf(
                    "roomId", "eventId", "sender", "timestamp", "rawJson", "status", "errorCode",
                ))
                val rawJson = record.requiredString("rawJson", MAX_EVENT_BYTES)
                MatrixMlp3InboxRecord(
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
            }.also { decoded ->
                require(decoded.map { it.event.eventId }.distinct().size == decoded.size)
            }
        } finally {
            plaintext.fill(0)
        }
    }

    private fun save() {
        if (records.isEmpty()) {
            blob.delete()
            return
        }
        val plaintext = CanonicalJson.bytes(buildJsonObject {
            put("schemaVersion", 1)
            put("records", buildJsonArray {
                records.forEach { record ->
                    add(buildJsonObject {
                        put("roomId", record.event.roomId)
                        put("eventId", record.event.eventId)
                        put("sender", record.event.sender)
                        put("timestamp", record.event.timestamp)
                        put("rawJson", record.event.rawJson)
                        put("status", record.status.wireName)
                        if (record.errorCode == null) put("errorCode", kotlinx.serialization.json.JsonNull)
                        else put("errorCode", record.errorCode)
                    })
                }
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

    private companion object {
        const val MAX_EVENT_BYTES = 512 * 1024
        const val MAX_PENDING_EVENTS = 10_000
        const val MAX_QUARANTINED_EVENTS = 100
        const val MAX_STORE_BYTES = 32 * 1024 * 1024
    }
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
        val plaintext = CanonicalJson.bytes(value)
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

/**
 * Tiny rebuildable checkpoint for frequently advancing Gateway observations.
 * Keeping it separate prevents every heartbeat from encrypting and syncing the
 * full multi-session projection.
 */
internal class AtomicEncryptedMatrixMlp3LivenessStore internal constructor(
    private val blob: MatrixMlp3BlobStore,
    private val cipher: SecretCipher,
    scope: String,
) {
    constructor(file: File, cipher: SecretCipher, scope: String) :
        this(AtomicFileMatrixMlp3BlobStore(file), cipher, scope)

    private val associatedData = "malink.matrix-v3-liveness.v1\u0000$scope".toByteArray()

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
            require(plaintext.size <= MAX_BYTES) { "The MLP/3 liveness cache is too large." }
            Json.parseToJsonElement(plaintext.toString(Charsets.UTF_8)).jsonObject
        } finally {
            plaintext.fill(0)
        }
    }

    @Synchronized
    fun save(value: JsonObject): Int {
        val plaintext = CanonicalJson.bytes(value)
        require(plaintext.size <= MAX_BYTES) { "The MLP/3 liveness cache is too large." }
        val size = plaintext.size
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
        return size
    }

    @Synchronized
    fun validateStoredState() {
        load()?.let { value ->
            MatrixMlp3NativeProjection({ "validation" }, { 1 })
                .applyLivenessState(value)
        }
    }

    @Synchronized
    fun clear() = blob.delete()

    private companion object {
        const val MAX_BYTES = 256 * 1024
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
