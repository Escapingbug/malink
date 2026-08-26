package id.my.anciety.malink.client.command

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put

internal data class DecodedCommandOutbox(
    val snapshot: CommandOutboxSnapshot,
    val migration: CommandOutboxMigration? = null,
)

internal object CommandOutboxCodec {
    private const val LEGACY_SCHEMA_VERSION = 1
    private const val AUTHENTICATION_SCHEMA_VERSION = 3
    private const val RETIRED_COMMAND_IDS_SCHEMA_VERSION = 3
    private const val EPOCH_SCOPE_SCHEMA_VERSION = 4
    private const val PROJECT_ROUTE_SCHEMA_VERSION = 5
    private const val EVENT_STREAM_SCHEMA_VERSION = 6
    private const val SCHEMA_VERSION = EVENT_STREAM_SCHEMA_VERSION
    private const val MAX_PLAINTEXT_BYTES = 3 * 1024 * 1024
    private const val MAX_COMMANDS = 128
    private const val MAX_TOMBSTONES = 4_096
    private val json = Json { explicitNulls = true }

    fun encode(value: CommandOutboxSnapshot): ByteArray {
        validateSnapshot(value)
        val encoded = buildJsonObject {
            put("schemaVersion", SCHEMA_VERSION)
            put("commands", buildJsonArray { value.commands.forEach { add(encodeCommand(it)) } })
            put("released", buildJsonArray { value.released.forEach { add(encodeTombstone(it)) } })
        }.toString().toByteArray(Charsets.UTF_8)
        require(encoded.size <= MAX_PLAINTEXT_BYTES) { "Command outbox is too large." }
        return encoded
    }

    fun decode(bytes: ByteArray): CommandOutboxSnapshot = decodeForStorage(bytes).snapshot

    internal fun decodeForStorage(bytes: ByteArray): DecodedCommandOutbox {
        require(bytes.size <= MAX_PLAINTEXT_BYTES) { "Command outbox is too large." }
        val root = json.parseToJsonElement(bytes.toString(Charsets.UTF_8)).jsonObject
        val schemaVersionValue = root.requiredLong("schemaVersion")
        require(schemaVersionValue in LEGACY_SCHEMA_VERSION.toLong()..SCHEMA_VERSION.toLong()) {
            "Command outbox schema is unsupported."
        }
        val schemaVersion = schemaVersionValue.toInt()
        root.requireExactKeys(
            if (schemaVersion == EVENT_STREAM_SCHEMA_VERSION) {
                setOf("schemaVersion", "commands", "released")
            } else {
                setOf("schemaVersion", "lastAcknowledgedSequence", "lastRevision", "commands", "released") +
                    if (schemaVersion >= EPOCH_SCOPE_SCHEMA_VERSION) {
                        setOf("revisionEpoch", "revisionEpochGeneration")
                    } else {
                        emptySet()
                    }
            },
        )
        val commands = root.requiredArray("commands").also {
            require(it.size <= MAX_COMMANDS) { "Command outbox contains too many commands." }
        }.map { decodeCommand(it.jsonObject, schemaVersion) }
        val released = root.requiredArray("released").also {
            require(it.size <= MAX_TOMBSTONES) { "Command outbox contains too many tombstones." }
        }.map { decodeTombstone(it.jsonObject, schemaVersion) }

        val quarantined = if (schemaVersion < AUTHENTICATION_SCHEMA_VERSION) {
            commands.filter { it.state != CommandState.QUEUED && it.createdAt == null }
        } else {
            emptyList()
        }
        require(released.size + quarantined.size <= MAX_TOMBSTONES) {
            "Command outbox cannot safely quarantine legacy commands."
        }
        val quarantinedIds = quarantined.mapTo(mutableSetOf(), PersistedCommand::commandId)
        val snapshot = CommandOutboxSnapshot(
            commands = commands.filterNot { it.commandId in quarantinedIds },
            released = released + quarantined.map { command ->
                ReleasedCommandTombstone(
                    operationId = command.operationId,
                    commandId = command.commandId,
                    retiredCommandIds = command.retiredCommandIds,
                    idempotencyKey = command.idempotencyKey,
                    requestFingerprint = command.requestFingerprint,
                    releasedAt = command.updatedAt,
                )
            },
        )
        validateSnapshot(snapshot)
        return DecodedCommandOutbox(
            snapshot = snapshot,
            migration = if (schemaVersion == SCHEMA_VERSION) null else CommandOutboxMigration(
                fromSchemaVersion = schemaVersion,
                quarantinedCommandCount = quarantined.size,
            ),
        )
    }

    private fun encodeCommand(value: PersistedCommand): JsonObject = buildJsonObject {
        put("operationId", value.operationId)
        put("commandId", value.commandId)
        put("retiredCommandIds", buildJsonArray {
            value.retiredCommandIds.forEach { add(JsonPrimitive(it)) }
        })
        put("idempotencyKey", value.idempotencyKey)
        put("requestFingerprint", value.requestFingerprint)
        put("state", value.state.wireName)
        put("submittedAt", value.submittedAt)
        put("updatedAt", value.updatedAt)
        putNullableString("sessionId", value.sessionId)
        putNullableString("projectId", value.projectId)
        putNullableLong("createdAt", value.createdAt)
        putNullableString("matrixEventId", value.matrixEventId)
        put("cancelRequested", value.cancelRequested)
        put("completion", value.completion?.let(::encodeCompletion) ?: JsonNull)
        put("payload", value.payload)
    }

    private fun decodeCommand(value: JsonObject, schemaVersion: Int): PersistedCommand {
        if (schemaVersion == EVENT_STREAM_SCHEMA_VERSION) {
            value.requireExactKeys(
                setOf(
                    "operationId", "commandId", "retiredCommandIds", "idempotencyKey",
                    "requestFingerprint", "state", "submittedAt", "updatedAt", "sessionId",
                    "projectId", "createdAt", "matrixEventId", "cancelRequested", "completion",
                    "payload",
                ),
            )
            return PersistedCommand(
                operationId = value.requiredString("operationId"),
                commandId = value.requiredString("commandId"),
                retiredCommandIds = value.requiredArray("retiredCommandIds").map {
                    it.jsonPrimitive.requiredStringValue()
                },
                idempotencyKey = value.requiredString("idempotencyKey"),
                requestFingerprint = value.requiredString("requestFingerprint"),
                state = CommandState.fromWireName(value.requiredString("state")),
                submittedAt = value.requiredLong("submittedAt"),
                updatedAt = value.requiredLong("updatedAt"),
                sessionId = value.optionalString("sessionId"),
                projectId = value.optionalString("projectId"),
                createdAt = value.optionalLong("createdAt"),
                matrixEventId = value.optionalString("matrixEventId"),
                cancelRequested = value.requiredBoolean("cancelRequested"),
                completion = value.optionalObject("completion")?.let { decodeCompletion(it, schemaVersion) },
                payload = value.getValue("payload").jsonObject,
            )
        }

        val keys = setOf(
            "operationId", "commandId", "retiredCommandIds", "idempotencyKey",
            "requestFingerprint", "state", "submittedAt", "updatedAt", "sessionId",
            "sequence", "baseRevision", "revision", "cancelRequested", "completion",
            "expectedRevision", "payload",
        ) + if (schemaVersion >= 2) {
            setOf("authenticationIssuedAt", "authenticationNonce")
        } else {
            emptySet()
        } + if (schemaVersion >= EPOCH_SCOPE_SCHEMA_VERSION) {
            setOf("revisionEpoch", "revisionEpochGeneration")
        } else {
            emptySet()
        } + if (schemaVersion >= PROJECT_ROUTE_SCHEMA_VERSION) setOf("projectId") else emptySet()
        value.requireExactKeys(keys)
        return PersistedCommand(
            operationId = value.requiredString("operationId"),
            commandId = value.requiredString("commandId"),
            retiredCommandIds = value.requiredArray("retiredCommandIds").map {
                it.jsonPrimitive.requiredStringValue()
            },
            idempotencyKey = value.requiredString("idempotencyKey"),
            requestFingerprint = value.requiredString("requestFingerprint"),
            state = CommandState.fromWireName(value.requiredString("state")),
            submittedAt = value.requiredLong("submittedAt"),
            updatedAt = value.requiredLong("updatedAt"),
            sessionId = value.optionalString("sessionId"),
            projectId = if (schemaVersion >= PROJECT_ROUTE_SCHEMA_VERSION) {
                value.optionalString("projectId")
            } else {
                null
            },
            createdAt = if (schemaVersion >= 2) value.optionalLong("authenticationIssuedAt") else null,
            matrixEventId = null,
            cancelRequested = value.requiredBoolean("cancelRequested"),
            completion = value.optionalObject("completion")?.let { decodeCompletion(it, schemaVersion) },
            payload = value.getValue("payload").jsonObject,
        )
    }

    private fun encodeCompletion(value: CommandCompletion): JsonObject = buildJsonObject {
        put("commandId", value.commandId)
        put("outcome", value.outcome.wireName)
        putNullableString("sessionId", value.sessionId)
        put("result", value.result ?: JsonNull)
        put("error", value.error?.let(::encodeError) ?: JsonNull)
    }

    private fun decodeCompletion(value: JsonObject, schemaVersion: Int): CommandCompletion {
        value.requireExactKeys(
            setOf("commandId", "outcome", "sessionId", "result", "error") +
                if (schemaVersion < EVENT_STREAM_SCHEMA_VERSION) setOf("sequence", "revision") else emptySet(),
        )
        return CommandCompletion(
            commandId = value.requiredString("commandId"),
            outcome = CommandOutcome.fromWireName(value.requiredString("outcome")),
            sessionId = value.optionalString("sessionId"),
            result = value.getValue("result").takeUnless { it is JsonNull },
            error = value.optionalObject("error")?.let(::decodeError),
        )
    }

    private fun encodeError(value: PublicCommandError): JsonObject = buildJsonObject {
        put("code", value.code)
        put("message", value.message)
        put("retryable", value.retryable)
    }

    private fun decodeError(value: JsonObject): PublicCommandError {
        value.requireExactKeys(setOf("code", "message", "retryable"))
        return PublicCommandError(
            code = value.requiredString("code"),
            message = value.requiredString("message", allowEmpty = true),
            retryable = value.requiredBoolean("retryable"),
        )
    }

    private fun encodeTombstone(value: ReleasedCommandTombstone): JsonObject = buildJsonObject {
        put("operationId", value.operationId)
        put("commandId", value.commandId)
        put("retiredCommandIds", buildJsonArray {
            value.retiredCommandIds.forEach { add(JsonPrimitive(it)) }
        })
        put("idempotencyKey", value.idempotencyKey)
        put("requestFingerprint", value.requestFingerprint)
        put("releasedAt", value.releasedAt)
    }

    private fun decodeTombstone(value: JsonObject, schemaVersion: Int): ReleasedCommandTombstone {
        value.requireExactKeys(
            setOf("operationId", "commandId", "idempotencyKey", "requestFingerprint", "releasedAt") +
                if (schemaVersion >= RETIRED_COMMAND_IDS_SCHEMA_VERSION) {
                    setOf("retiredCommandIds")
                } else {
                    emptySet()
                },
        )
        return ReleasedCommandTombstone(
            operationId = value.requiredString("operationId"),
            commandId = value.requiredString("commandId"),
            retiredCommandIds = if (schemaVersion >= RETIRED_COMMAND_IDS_SCHEMA_VERSION) {
                value.requiredArray("retiredCommandIds").map { it.jsonPrimitive.requiredStringValue() }
            } else {
                emptyList()
            },
            idempotencyKey = value.requiredString("idempotencyKey"),
            requestFingerprint = value.requiredString("requestFingerprint"),
            releasedAt = value.requiredLong("releasedAt"),
        )
    }

    private fun validateSnapshot(value: CommandOutboxSnapshot) {
        require(value.commands.size <= MAX_COMMANDS && value.released.size <= MAX_TOMBSTONES) {
            "Command outbox capacity is exceeded."
        }
        require(value.commands.map { it.commandId }.distinct().size == value.commands.size) {
            "Command outbox contains duplicate command ids."
        }
        require(value.commands.map { it.idempotencyKey }.distinct().size == value.commands.size) {
            "Command outbox contains duplicate idempotency keys."
        }
        val durableIds = buildList {
            value.commands.forEach {
                add(it.operationId)
                add(it.commandId)
                addAll(it.retiredCommandIds)
            }
            value.released.forEach {
                add(it.operationId)
                add(it.commandId)
                addAll(it.retiredCommandIds)
            }
        }
        require(durableIds.distinct().size == durableIds.size) {
            "Command outbox contains duplicate durable identifiers."
        }
        require(value.released.map { it.idempotencyKey }.distinct().size == value.released.size) {
            "Command outbox contains duplicate released idempotency keys."
        }
        require(value.commands.none { command ->
            value.released.any { it.idempotencyKey == command.idempotencyKey }
        }) { "Active and released commands overlap." }
        value.commands.forEach(::validateCommand)
        value.released.forEach {
            requireOpaqueId(it.operationId, "operationId")
            requireOpaqueId(it.commandId, "commandId")
            it.retiredCommandIds.forEach { retiredId -> requireOpaqueId(retiredId, "retiredCommandId") }
            require(
                it.commandId !in it.retiredCommandIds &&
                    it.retiredCommandIds.distinct().size == it.retiredCommandIds.size,
            ) { "Released command retired ids are invalid." }
            requireUuid(it.idempotencyKey)
            requireFingerprint(it.requestFingerprint)
            requireNonnegativeJsonInteger(it.releasedAt, "Released command timestamp")
        }
    }

    private fun validateCommand(value: PersistedCommand) {
        requireOpaqueId(value.operationId, "operationId")
        requireOpaqueId(value.commandId, "commandId")
        value.retiredCommandIds.forEach { requireOpaqueId(it, "retiredCommandId") }
        require(
            value.commandId !in value.retiredCommandIds &&
                value.retiredCommandIds.distinct().size == value.retiredCommandIds.size,
        ) { "Retired command ids are invalid." }
        requireUuid(value.idempotencyKey)
        requireFingerprint(value.requestFingerprint)
        requireNonnegativeJsonInteger(value.submittedAt, "Command submitted timestamp")
        requireNonnegativeJsonInteger(value.updatedAt, "Command updated timestamp")
        require(value.updatedAt >= value.submittedAt) { "Command timestamps are invalid." }
        value.sessionId?.let { requireOpaqueId(it, "sessionId") }
        value.projectId?.let { requireOpaqueId(it, "projectId") }
        value.createdAt?.let { requireNonnegativeJsonInteger(it, "Command creation timestamp") }
        value.matrixEventId?.let { requireOpaqueId(it, "matrixEventId") }
        require(value.state == CommandState.QUEUED || value.createdAt != null) {
            "A submitted command must retain its signed creation timestamp."
        }
        require(value.payload.toString().toByteArray(Charsets.UTF_8).size <= MAX_PAYLOAD_BYTES) {
            "Command payload is too large."
        }
        require(value.payload["operation"]?.jsonPrimitive?.contentOrNull?.isNotBlank() == true) {
            "Command payload operation is invalid."
        }
        require(value.state.isTerminal == (value.completion != null)) {
            "Terminal commands must contain exactly one completion."
        }
        require(value.completion == null || value.completion.commandId == value.commandId) {
            "Command completion does not belong to its command."
        }
    }

    private fun requireFingerprint(value: String) {
        require(value.length == 64 && value.all { it in '0'..'9' || it in 'a'..'f' }) {
            "Command request fingerprint is invalid."
        }
    }
}

private fun JsonObject.requiredArray(name: String): JsonArray =
    this[name]?.takeUnless { it is JsonNull }?.jsonArray
        ?: throw IllegalArgumentException("$name is required.")

private fun JsonObject.optionalObject(name: String): JsonObject? =
    this[name]?.takeUnless { it is JsonNull }?.jsonObject

private fun JsonObject.requiredString(name: String, allowEmpty: Boolean = false): String {
    val primitive = this[name]?.jsonPrimitive
    val value = primitive?.takeIf { it.isString }?.contentOrNull
        ?: throw IllegalArgumentException("$name is required.")
    require(value.length <= 4_096 && (allowEmpty || value.isNotBlank())) { "$name is required." }
    return value
}

private fun JsonPrimitive.requiredStringValue(): String = takeIf { it.isString }
    ?.contentOrNull
    ?.takeIf { it.isNotBlank() && it.length <= 4_096 }
    ?: throw IllegalArgumentException("Array string value is invalid.")

private fun JsonObject.optionalString(name: String): String? {
    val element = this[name] ?: throw IllegalArgumentException("$name is required.")
    if (element is JsonNull) return null
    val primitive = element.jsonPrimitive
    return primitive.takeIf { it.isString }?.contentOrNull
        ?.takeIf { it.length <= 4_096 }
        ?: throw IllegalArgumentException("$name is invalid.")
}

private fun JsonObject.requiredLong(name: String): Long {
    val primitive = this[name]?.jsonPrimitive
        ?: throw IllegalArgumentException("$name is required.")
    require(!primitive.isString) { "$name is invalid." }
    return primitive.longOrNull ?: throw IllegalArgumentException("$name is required.")
}

private fun JsonObject.optionalLong(name: String): Long? {
    val element = this[name] ?: throw IllegalArgumentException("$name is required.")
    if (element is JsonNull) return null
    val primitive = element.jsonPrimitive
    require(!primitive.isString) { "$name is invalid." }
    return primitive.longOrNull ?: throw IllegalArgumentException("$name is invalid.")
}

private fun JsonObject.requiredBoolean(name: String): Boolean =
    this[name]?.jsonPrimitive?.booleanOrNull
        ?: throw IllegalArgumentException("$name is required.")

private fun JsonObject.requireExactKeys(expected: Set<String>) {
    require(keys == expected) { "Command outbox object fields are invalid." }
}

private fun kotlinx.serialization.json.JsonObjectBuilder.putNullableString(name: String, value: String?) {
    put(name, value?.let(::JsonPrimitive) ?: JsonNull)
}

private fun kotlinx.serialization.json.JsonObjectBuilder.putNullableLong(name: String, value: Long?) {
    put(name, value?.let(::JsonPrimitive) ?: JsonNull)
}
