package id.my.anciety.malink.matrix

import id.my.anciety.malink.security.malink.MLP3_MATRIX_KEY_GRANT_EVENT_TYPE
import id.my.anciety.malink.security.malink.MLP3_MATRIX_PROJECT_POINTER_EVENT_TYPE
import id.my.anciety.malink.security.malink.MLP3_MATRIX_WORKSPACE_POINTER_EVENT_TYPE
import id.my.anciety.malink.security.malink.MLP3_MATRIX_WORKSPACE_DIRECTORY_EVENT_TYPE
import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.URI
import java.net.URL
import java.net.URLEncoder
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put

internal const val MALINK_MATRIX_APPLICATION_CONTROL_EVENT_TYPE =
    "io.malink.secure_control.v1"
internal const val MALINK_MATRIX_GATEWAY_STATE_EVENT_TYPE =
    "io.malink.gateway.current.v2"
internal const val MALINK_MATRIX_SESSION_STATE_EVENT_TYPE =
    "io.malink.session.current.v2"
internal const val MALINK_MATRIX_SESSION_DIRECTORY_EVENT_TYPE =
    "io.malink.session.directory.v2"
internal fun isMalinkApplicationControlEvent(rawJson: String): Boolean = runCatching {
    val root = Json.parseToJsonElement(rawJson).jsonObject
    val eventType = root["type"]?.jsonPrimitive?.contentOrNull
    val content = root["content"] as? JsonObject ?: return@runCatching false
    when (eventType) {
        MLP3_MATRIX_KEY_GRANT_EVENT_TYPE ->
            root["state_key"]?.jsonPrimitive?.contentOrNull?.isNotBlank() == true &&
                content["version"]?.jsonPrimitive?.intOrNull == 3 &&
                content["kind"]?.jsonPrimitive?.contentOrNull == "project.key_grant" &&
                content["sealedGrant"] is JsonObject
        MLP3_MATRIX_PROJECT_POINTER_EVENT_TYPE,
        MLP3_MATRIX_WORKSPACE_POINTER_EVENT_TYPE ->
            root["state_key"]?.jsonPrimitive?.contentOrNull?.isNotBlank() == true &&
                content["document"] is JsonObject && content["signature"] is JsonObject
        MLP3_MATRIX_WORKSPACE_DIRECTORY_EVENT_TYPE ->
            root["state_key"]?.jsonPrimitive?.contentOrNull?.isNotBlank() == true &&
                content["directory"] is JsonObject && content["signature"] is JsonObject
        "m.room.message" -> {
            val extension = content["io.malink"] as? JsonObject ?: return@runCatching false
            extension["version"]?.jsonPrimitive?.intOrNull == 3 &&
                extension["envelope"] is JsonObject
        }
        MALINK_MATRIX_APPLICATION_CONTROL_EVENT_TYPE -> {
            val extension = content["io.malink"] as? JsonObject ?: return@runCatching false
            extension["version"]?.jsonPrimitive?.intOrNull == 1 &&
                extension["kind"]?.jsonPrimitive?.contentOrNull == "secure_envelope" &&
                extension["secure_envelope"] is JsonObject
        }
        else -> false
    }
}.getOrDefault(false)

internal fun isMalinkPairingResponseEvent(rawJson: String): Boolean = runCatching {
    val root = Json.parseToJsonElement(rawJson).jsonObject
    if (root["type"]?.jsonPrimitive?.contentOrNull != "m.room.message") {
        return@runCatching false
    }
    val extension = root["content"]
        ?.jsonObject
        ?.get("io.malink") as? JsonObject ?: return@runCatching false
    extension["version"]?.jsonPrimitive?.intOrNull == 1 &&
        when (extension["kind"]?.jsonPrimitive?.contentOrNull) {
            "pairing_response" -> extension["pairing_response"] is JsonObject
            "pairing_rejection" -> extension["pairing_rejection"] is JsonObject
            else -> false
        }
}.getOrDefault(false)

internal fun malinkApplicationEventKind(rawJson: String): String = runCatching {
    val root = Json.parseToJsonElement(rawJson).jsonObject
    when (root["type"]?.jsonPrimitive?.contentOrNull) {
        MLP3_MATRIX_KEY_GRANT_EVENT_TYPE ->
            return@runCatching "v3_project_key_grant"
        MLP3_MATRIX_PROJECT_POINTER_EVENT_TYPE ->
            return@runCatching "v3_project_pointer"
        MLP3_MATRIX_WORKSPACE_POINTER_EVENT_TYPE ->
            return@runCatching "v3_workspace_pointer"
        MLP3_MATRIX_WORKSPACE_DIRECTORY_EVENT_TYPE ->
            return@runCatching "workspace_gateway_directory"
    }
    val extension = root["content"]
        ?.jsonObject
        ?.get("io.malink")
        ?.jsonObject
    if (extension?.get("version")?.jsonPrimitive?.intOrNull == 3 &&
        extension["envelope"] is JsonObject
    ) {
        return@runCatching "v3_project_envelope"
    }
    extension
        ?.get("kind")
        ?.jsonPrimitive
        ?.contentOrNull
        ?.takeIf { it.matches(Regex("^[a-z0-9_]{1,64}$")) }
        ?: "unknown"
}.getOrDefault("unknown")

fun interface MatrixApplicationControlTransport {
    suspend fun putJson(
        endpoint: URI,
        accessToken: String,
        body: ByteArray,
    ): MatrixHttpResponse
}

fun interface MatrixApplicationControlSyncTransport {
    suspend fun getJson(
        endpoint: URI,
        accessToken: String,
    ): MatrixHttpResponse
}

class RestrictedHttpsMatrixApplicationControlTransport(
    private val connectTimeoutMs: Int = 15_000,
    private val readTimeoutMs: Int = 30_000,
) : MatrixApplicationControlTransport {
    override suspend fun putJson(
        endpoint: URI,
        accessToken: String,
        body: ByteArray,
    ): MatrixHttpResponse = withContext(Dispatchers.IO) {
        MatrixIdentifiers.requireAllowedEndpoint(endpoint, "Matrix control endpoint")
        require(accessToken.isNotEmpty() && accessToken.length <= 32_768)
        val connection = URL(endpoint.toASCIIString()).openConnection() as HttpURLConnection
        try {
            connection.instanceFollowRedirects = false
            connection.requestMethod = "PUT"
            connection.connectTimeout = connectTimeoutMs
            connection.readTimeout = readTimeoutMs
            connection.doOutput = true
            connection.setRequestProperty("Accept", "application/json")
            connection.setRequestProperty("Content-Type", "application/json")
            connection.setRequestProperty("Authorization", "Bearer $accessToken")
            connection.setFixedLengthStreamingMode(body.size)
            connection.outputStream.use { it.write(body) }
            val status = connection.responseCode
            val input = if (status in 200..299) connection.inputStream else connection.errorStream
            MatrixHttpResponse(status, input?.use { stream ->
                val output = ByteArrayOutputStream()
                val buffer = ByteArray(8 * 1024)
                var total = 0
                while (true) {
                    val read = stream.read(buffer)
                    if (read < 0) break
                    total += read
                    require(total <= MAX_RESPONSE_BYTES) {
                        "Matrix control response is too large."
                    }
                    output.write(buffer, 0, read)
                }
                output.toByteArray()
            } ?: ByteArray(0))
        } finally {
            connection.disconnect()
        }
    }

    private companion object {
        const val MAX_RESPONSE_BYTES = 128 * 1024
    }
}

class RestrictedHttpsMatrixApplicationControlSyncTransport(
    private val connectTimeoutMs: Int = 15_000,
    private val readTimeoutMs: Int = 70_000,
) : MatrixApplicationControlSyncTransport {
    override suspend fun getJson(
        endpoint: URI,
        accessToken: String,
    ): MatrixHttpResponse = withContext(Dispatchers.IO) {
        MatrixIdentifiers.requireAllowedEndpoint(endpoint, "Matrix control sync endpoint")
        require(accessToken.isNotEmpty() && accessToken.length <= 32_768)
        val connection = URL(endpoint.toASCIIString()).openConnection() as HttpURLConnection
        try {
            connection.instanceFollowRedirects = false
            connection.requestMethod = "GET"
            connection.connectTimeout = connectTimeoutMs
            connection.readTimeout = readTimeoutMs
            connection.setRequestProperty("Accept", "application/json")
            connection.setRequestProperty("Authorization", "Bearer $accessToken")
            val status = connection.responseCode
            val input = if (status in 200..299) connection.inputStream else connection.errorStream
            MatrixHttpResponse(status, input?.use { stream ->
                val output = ByteArrayOutputStream()
                val buffer = ByteArray(8 * 1024)
                var total = 0
                while (true) {
                    val read = stream.read(buffer)
                    if (read < 0) break
                    total += read
                    if (total > MAX_RESPONSE_BYTES) {
                        throw MatrixApplicationControlResponseTooLargeException(
                            MAX_RESPONSE_BYTES,
                        )
                    }
                    output.write(buffer, 0, read)
                }
                output.toByteArray()
            } ?: ByteArray(0))
        } finally {
            connection.disconnect()
        }
    }

    private companion object {
        const val MAX_RESPONSE_BYTES = 2 * 1024 * 1024
    }
}

data class MatrixApplicationControlSyncBatch(
    val nextBatch: String,
    val prevBatch: String?,
    val events: List<MatrixDecryptedEvent>,
    val candidateEventCount: Int,
    val limited: Boolean,
    val roomGaps: List<MatrixSyncGap> = emptyList(),
)

data class MatrixApplicationTimelinePage(
    val events: List<MatrixDecryptedEvent>,
    val nextFrom: String?,
    val candidateEventCount: Int,
)

data class MatrixApplicationRoomStateBatch(
    val events: List<MatrixDecryptedEvent>,
    val candidateEventCount: Int,
)

data class MatrixSessionDirectoryLocator(
    val generation: Long,
    val stateVersion: Long,
    val slot: Int,
    val pageCount: Int,
    val stateKeyPrefix: String,
    val digest: String,
)

data class MatrixThreadHistoryBatch(
    val events: List<MatrixDecryptedEvent>,
    val nextBatch: String?,
)

data class MatrixThreadDirectoryBatch(
    val latestEvents: List<MatrixDecryptedEvent>,
    val nextBatch: String?,
    val candidateThreadCount: Int,
)

class MatrixApplicationControlSyncException(
    val status: Int,
    val retryAfterMs: Long?,
) : IllegalStateException("Matrix control sync failed ($status).") {
    val fatal: Boolean get() = status == 401 || status == 403
}

class MatrixApplicationControlResponseTooLargeException(
    val maximumBytes: Int,
) : IllegalStateException(
    "Matrix control sync response exceeded the $maximumBytes-byte safety limit.",
)

/** Pages exactly one omitted `/sync` range using Matrix's gap-closing contract. */
class MatrixApplicationTimelineClient(
    private val transport: MatrixApplicationControlSyncTransport =
        RestrictedHttpsMatrixApplicationControlSyncTransport(),
) {
    suspend fun page(
        session: StoredMatrixSession,
        from: String,
        to: String,
        roomId: String? = null,
        limit: Int = 32,
    ): MatrixApplicationTimelinePage {
        require(from.isNotBlank() && from.length <= 4_096)
        require(to.isNotBlank() && to.length <= 4_096)
        require(from != to)
        require(limit in 1..32)
        val homeserver = MatrixIdentifiers.normalizeHomeserver(session.homeserverUrl)
        val bindings = session.roomBindings.map(MatrixIdentifiers::validateRoomBinding)
        val binding = roomId?.let { targetRoomId ->
            bindings.singleOrNull { it.roomId == targetRoomId }
                ?: throw IllegalArgumentException("Unknown Matrix project room: $targetRoomId")
        } ?: MatrixIdentifiers.validateRoomBinding(session.roomBinding)
        val filter = buildJsonObject {
            put("types", buildJsonArray {
                add(JsonPrimitive("m.room.message"))
                add(JsonPrimitive(MALINK_MATRIX_APPLICATION_CONTROL_EVENT_TYPE))
                add(JsonPrimitive(MLP3_MATRIX_KEY_GRANT_EVENT_TYPE))
                add(JsonPrimitive(MLP3_MATRIX_PROJECT_POINTER_EVENT_TYPE))
                add(JsonPrimitive(MLP3_MATRIX_WORKSPACE_POINTER_EVENT_TYPE))
                add(JsonPrimitive(MLP3_MATRIX_WORKSPACE_DIRECTORY_EVENT_TYPE))
            })
        }.toString()
        val endpoint = URI(
            "$homeserver/_matrix/client/v3/rooms/${encode(binding.roomId)}/messages?" +
                listOf(
                    "dir=f",
                    "from=${encode(from)}",
                    "to=${encode(to)}",
                    "limit=$limit",
                    "filter=${encode(filter)}",
                ).joinToString("&"),
        )
        val response = transport.getJson(endpoint, session.accessToken)
        return try {
            if (response.status !in 200..299) {
                throw MatrixApplicationControlSyncException(
                    response.status,
                    parseMatrixRetryAfterMs(response.body),
                )
            }
            val root = runCatching {
                Json.parseToJsonElement(response.body.toString(Charsets.UTF_8)) as? JsonObject
            }.getOrNull() ?: throw MatrixApplicationControlPayloadException(
                "Matrix gap page response is not an object.",
            )
            val candidates = root["chunk"].let { it as? JsonArray }.orEmpty()
            val events = candidates.mapNotNull { element ->
                val event = element as? JsonObject ?: return@mapNotNull null
                val eventType = event["type"]?.jsonPrimitive?.contentOrNull
                if (
                    (eventType != MLP3_MATRIX_WORKSPACE_DIRECTORY_EVENT_TYPE &&
                        event["sender"]?.jsonPrimitive?.contentOrNull !=
                        binding.gatewayUserId) ||
                    !isMalinkApplicationControlEvent(event.toString())
                ) return@mapNotNull null
                matrixApplicationEvent(binding.roomId, event)
            }
            val end = root["end"]
                .let { it as? JsonPrimitive }
                ?.contentOrNull
                ?.takeIf { it.isNotBlank() && it.length <= 4_096 }
            MatrixApplicationTimelinePage(
                events = events,
                nextFrom = end?.takeUnless { it == from || it == to || candidates.isEmpty() },
                candidateEventCount = candidates.size,
            )
        } finally {
            response.body.fill(0)
        }
    }

    /**
     * Walks backward from a durable /sync token without moving that token.
     * Command recovery uses this cursor-independent view when an already
     * published terminal event fell outside the latest bounded /sync window.
     */
    suspend fun backwardPage(
        session: StoredMatrixSession,
        from: String,
        roomId: String,
        limit: Int = 32,
    ): MatrixApplicationTimelinePage {
        require(from.isNotBlank() && from.length <= 4_096)
        require(limit in 1..32)
        val homeserver = MatrixIdentifiers.normalizeHomeserver(session.homeserverUrl)
        val binding = session.roomBindings
            .map(MatrixIdentifiers::validateRoomBinding)
            .singleOrNull { it.roomId == roomId }
            ?: throw IllegalArgumentException("Unknown Matrix project room: $roomId")
        val filter = buildJsonObject {
            put("types", buildJsonArray {
                add(JsonPrimitive("m.room.message"))
                add(JsonPrimitive(MALINK_MATRIX_APPLICATION_CONTROL_EVENT_TYPE))
            })
        }.toString()
        val endpoint = URI(
            "$homeserver/_matrix/client/v3/rooms/${encode(binding.roomId)}/messages?" +
                listOf(
                    "dir=b",
                    "from=${encode(from)}",
                    "limit=$limit",
                    "filter=${encode(filter)}",
                ).joinToString("&"),
        )
        val response = transport.getJson(endpoint, session.accessToken)
        return try {
            if (response.status !in 200..299) {
                throw MatrixApplicationControlSyncException(
                    response.status,
                    parseMatrixRetryAfterMs(response.body),
                )
            }
            val root = runCatching {
                Json.parseToJsonElement(response.body.toString(Charsets.UTF_8)) as? JsonObject
            }.getOrNull() ?: throw MatrixApplicationControlPayloadException(
                "Matrix command-recovery page response is not an object.",
            )
            val candidates = root["chunk"].let { it as? JsonArray }.orEmpty()
            val events = candidates.mapNotNull { element ->
                val event = element as? JsonObject ?: return@mapNotNull null
                if (
                    event["sender"]?.jsonPrimitive?.contentOrNull != binding.gatewayUserId ||
                    !isMalinkApplicationControlEvent(event.toString())
                ) return@mapNotNull null
                matrixApplicationEvent(binding.roomId, event)
            }
            val end = root["end"]
                .let { it as? JsonPrimitive }
                ?.contentOrNull
                ?.takeIf { it.isNotBlank() && it.length <= 4_096 }
            MatrixApplicationTimelinePage(
                events = events,
                nextFrom = end?.takeUnless { it == from || candidates.isEmpty() },
                candidateEventCount = candidates.size,
            )
        } finally {
            response.body.fill(0)
        }
    }

    private fun encode(value: String): String =
        URLEncoder.encode(value, Charsets.UTF_8.name()).replace("+", "%20")
}

/**
 * Pages Matrix's native thread directory. The latest signed Gateway event in
 * each thread is enough to rebuild the complete session list; transcripts are
 * fetched lazily through the relations API when the user opens a session.
 */
class MatrixThreadDirectoryClient(
    private val transport: MatrixApplicationControlSyncTransport =
        RestrictedHttpsMatrixApplicationControlSyncTransport(),
) {
    suspend fun page(
        session: StoredMatrixSession,
        from: String?,
        roomId: String? = null,
        limit: Int = 100,
    ): MatrixThreadDirectoryBatch {
        require(from == null || (from.isNotBlank() && from.length <= 4_096))
        require(limit in 1..100)
        val homeserver = MatrixIdentifiers.normalizeHomeserver(session.homeserverUrl)
        val bindings = session.roomBindings.map(MatrixIdentifiers::validateRoomBinding)
        val binding = roomId?.let { targetRoomId ->
            bindings.singleOrNull { it.roomId == targetRoomId }
                ?: throw IllegalArgumentException("Unknown Matrix project room: $targetRoomId")
        } ?: MatrixIdentifiers.validateRoomBinding(session.roomBinding)
        val query = buildList {
            add("dir=b")
            add("include=all")
            add("limit=$limit")
            if (from != null) add("from=${encode(from)}")
        }.joinToString("&")
        val response = transport.getJson(
            URI(
                "$homeserver/_matrix/client/v1/rooms/${encode(binding.roomId)}/threads?$query",
            ),
            session.accessToken,
        )
        return try {
            if (response.status !in 200..299) {
                throw MatrixApplicationControlSyncException(
                    response.status,
                    parseMatrixRetryAfterMs(response.body),
                )
            }
            val root = runCatching {
                Json.parseToJsonElement(response.body.toString(Charsets.UTF_8)) as? JsonObject
            }.getOrNull() ?: throw MatrixApplicationControlPayloadException(
                "Matrix thread directory response is not an object.",
            )
            val candidates = root["chunk"].let { it as? JsonArray }.orEmpty()
            val latestEvents = candidates.mapNotNull { element ->
                val threadRoot = element as? JsonObject ?: return@mapNotNull null
                val unsigned = threadRoot["unsigned"] as? JsonObject ?: return@mapNotNull null
                val relations = unsigned["m.relations"] as? JsonObject
                    ?: return@mapNotNull null
                val thread = relations["m.thread"] as? JsonObject ?: return@mapNotNull null
                val latest = thread["latest_event"] as? JsonObject ?: return@mapNotNull null
                if (
                    latest["sender"]?.jsonPrimitive?.contentOrNull !=
                    binding.gatewayUserId ||
                    !isMalinkApplicationControlEvent(latest.toString())
                ) return@mapNotNull null
                matrixApplicationEvent(binding.roomId, latest)
            }
            val next = root["next_batch"]
                .let { it as? JsonPrimitive }
                ?.contentOrNull
                ?.takeIf { it.isNotBlank() && it.length <= 4_096 }
            MatrixThreadDirectoryBatch(latestEvents, next, candidates.size)
        } finally {
            response.body.fill(0)
        }
    }

    private fun encode(value: String): String =
        URLEncoder.encode(value, Charsets.UTF_8.name()).replace("+", "%20")
}

class MatrixApplicationControlPayloadException(message: String) :
    IllegalStateException(message)

internal fun applicationControlCursorResetReason(
    error: Throwable,
    since: String?,
): String? {
    if (since == null) return null
    // An invalid server token can only be replaced after the receiver has
    // crossed the authoritative state barrier. Session inventory is rebuilt
    // from bounded state-history pages, transcripts from thread relations,
    // and pending commands from their durable idempotent outbox. An oversized
    // response proves none of those things and must retain its cursor.
    return if (error is MatrixApplicationControlSyncException && error.status == 400) {
        "server_rejected_after_authoritative_rebuild"
    } else {
        null
    }
}

/** Reads current replace-in-place Malink state independently of a /sync cursor. */
class MatrixApplicationRoomStateClient(
    private val transport: MatrixApplicationControlSyncTransport =
        RestrictedHttpsMatrixApplicationControlSyncTransport(),
) {
    suspend fun currentGateway(session: StoredMatrixSession): MatrixDecryptedEvent {
        val homeserver = MatrixIdentifiers.normalizeHomeserver(session.homeserverUrl)
        val roomId = MatrixIdentifiers.validateRoomBinding(session.roomBinding).roomId
        return currentStateEvent(
            session,
            homeserver,
            roomId,
            MALINK_MATRIX_GATEWAY_STATE_EVENT_TYPE,
            session.roomBinding.gatewayId,
        )
    }

    suspend fun currentDirectory(
        session: StoredMatrixSession,
        locator: MatrixSessionDirectoryLocator,
    ): MatrixApplicationRoomStateBatch {
        require(locator.pageCount in 0..MAX_DIRECTORY_PAGES)
        val homeserver = MatrixIdentifiers.normalizeHomeserver(session.homeserverUrl)
        val roomId = MatrixIdentifiers.validateRoomBinding(session.roomBinding).roomId
        val events = (0 until locator.pageCount).map { pageIndex ->
            currentStateEvent(
                session,
                homeserver,
                roomId,
                MALINK_MATRIX_SESSION_DIRECTORY_EVENT_TYPE,
                "${locator.stateKeyPrefix}.${locator.slot}.$pageIndex",
            )
        }
        return MatrixApplicationRoomStateBatch(events, events.size)
    }

    private suspend fun currentStateEvent(
        session: StoredMatrixSession,
        homeserver: String,
        roomId: String,
        eventType: String,
        stateKey: String,
    ): MatrixDecryptedEvent {
        val response = transport.getJson(
            URI(
                "$homeserver/_matrix/client/v3/rooms/${encode(roomId)}/state/" +
                    "${encode(eventType)}/${encode(stateKey)}",
            ),
            session.accessToken,
        )
        return try {
            if (response.status !in 200..299) {
                throw MatrixApplicationControlSyncException(
                    response.status,
                    parseMatrixRetryAfterMs(response.body),
                )
            }
            val content = runCatching {
                Json.parseToJsonElement(
                    response.body.toString(Charsets.UTF_8),
                ) as? JsonObject
            }.getOrNull() ?: throw MatrixApplicationControlPayloadException(
                "Current Malink Gateway state is not an object.",
            )
            val event = buildJsonObject {
                put("type", eventType)
                put("state_key", stateKey)
                put("event_id", "\$malink-current-${eventType.hashCode()}-${stateKey.hashCode()}")
                put("sender", session.roomBinding.gatewayUserId)
                put("origin_server_ts", 0)
                put("content", content)
            }
            if (!isMalinkApplicationControlEvent(event.toString())) {
                throw MatrixApplicationControlPayloadException(
                    "Current Malink Room State has an invalid envelope shape.",
                )
            }
            matrixApplicationEvent(roomId, event)
                ?: throw MatrixApplicationControlPayloadException(
                    "Current Malink Room State is incomplete.",
                )
        } finally {
            response.body.fill(0)
        }
    }

    private fun encode(value: String): String =
        URLEncoder.encode(value, Charsets.UTF_8.name()).replace("+", "%20")

    private companion object {
        const val MAX_DIRECTORY_PAGES = 100_000
    }
}

/** Directly fetches a pointer-referenced MLP/3 room event without scanning history. */
class MatrixApplicationEventClient(
    private val transport: MatrixApplicationControlSyncTransport =
        RestrictedHttpsMatrixApplicationControlSyncTransport(),
) {
    suspend fun event(
        session: StoredMatrixSession,
        eventId: String,
        roomId: String? = null,
    ): MatrixDecryptedEvent {
        require(eventId.isNotBlank() && eventId.length <= 512 && eventId.startsWith("$")) {
            "Matrix event ID is invalid."
        }
        val homeserver = MatrixIdentifiers.normalizeHomeserver(session.homeserverUrl)
        val bindings = session.roomBindings.map(MatrixIdentifiers::validateRoomBinding)
        val binding = roomId?.let { targetRoomId ->
            bindings.singleOrNull { it.roomId == targetRoomId }
                ?: throw IllegalArgumentException("Unknown Matrix project room: $targetRoomId")
        } ?: MatrixIdentifiers.validateRoomBinding(session.roomBinding)
        val response = transport.getJson(
            URI(
                "$homeserver/_matrix/client/v3/rooms/${encode(binding.roomId)}/event/" +
                    encode(eventId),
            ),
            session.accessToken,
        )
        return try {
            if (response.status !in 200..299) {
                throw MatrixApplicationControlSyncException(
                    response.status,
                    parseMatrixRetryAfterMs(response.body),
                )
            }
            val root = runCatching {
                Json.parseToJsonElement(response.body.toString(Charsets.UTF_8)) as? JsonObject
            }.getOrNull() ?: throw MatrixApplicationControlPayloadException(
                "The pointer-referenced Matrix event is not an object.",
            )
            if (
                root["event_id"]?.jsonPrimitive?.contentOrNull != eventId ||
                root["sender"]?.jsonPrimitive?.contentOrNull != binding.gatewayUserId ||
                !isMalinkApplicationControlEvent(root.toString())
            ) {
                throw MatrixApplicationControlPayloadException(
                    "The pointer-referenced Matrix event is not a trusted MLP/3 event.",
                )
            }
            matrixApplicationEvent(binding.roomId, root)
                ?: throw MatrixApplicationControlPayloadException(
                    "The pointer-referenced Matrix event is incomplete.",
                )
        } finally {
            response.body.fill(0)
        }
    }

    private fun encode(value: String): String =
        URLEncoder.encode(value, Charsets.UTF_8.name()).replace("+", "%20")
}

/** Pages one session thread without scanning or materializing the room timeline. */
class MatrixThreadHistoryClient(
    private val transport: MatrixApplicationControlSyncTransport =
        RestrictedHttpsMatrixApplicationControlSyncTransport(),
) {
    suspend fun page(
        session: StoredMatrixSession,
        threadRootEventId: String,
        from: String?,
        limit: Int,
        roomId: String? = null,
    ): MatrixThreadHistoryBatch {
        require(threadRootEventId.isNotBlank() && threadRootEventId.length <= 512)
        require(from == null || (from.isNotBlank() && from.length <= 4_096))
        require(limit in 1..100)
        val boundedLimit = minOf(limit, MAX_RELATION_PAGE_EVENTS)
        val homeserver = MatrixIdentifiers.normalizeHomeserver(session.homeserverUrl)
        val bindings = session.roomBindings.map(MatrixIdentifiers::validateRoomBinding)
        val binding = roomId?.let { targetRoomId ->
            bindings.singleOrNull { it.roomId == targetRoomId }
                ?: throw IllegalArgumentException("Unknown Matrix project room: $targetRoomId")
        } ?: MatrixIdentifiers.validateRoomBinding(session.roomBinding)
        val query = buildList {
            add("dir=b")
            add("limit=$boundedLimit")
            add("recurse=true")
            if (from != null) add("from=${encode(from)}")
        }.joinToString("&")
        val response = transport.getJson(
            URI(
                "$homeserver/_matrix/client/v1/rooms/${encode(binding.roomId)}/relations/" +
                    "${encode(threadRootEventId)}/${encode("m.thread")}?$query",
            ),
            session.accessToken,
        )
        return try {
            if (response.status !in 200..299) {
                throw MatrixApplicationControlSyncException(
                    response.status,
                    parseMatrixRetryAfterMs(response.body),
                )
            }
            val root = runCatching {
                Json.parseToJsonElement(
                    response.body.toString(Charsets.UTF_8),
                ) as? JsonObject
            }.getOrNull() ?: throw MatrixApplicationControlPayloadException(
                "Matrix thread history response is not an object.",
            )
            val events = root["chunk"]
                .let { it as? JsonArray }
                .orEmpty()
                .mapNotNull { it as? JsonObject }
                .filter { event ->
                    event["sender"]?.jsonPrimitive?.contentOrNull ==
                        binding.gatewayUserId &&
                        isMalinkApplicationControlEvent(event.toString())
                }
                .mapNotNull { event -> matrixApplicationEvent(binding.roomId, event) }
            val nextBatch = root["next_batch"]
                .let { it as? JsonPrimitive }
                ?.contentOrNull
                ?.takeIf { it.isNotBlank() && it.length <= 4_096 }
            MatrixThreadHistoryBatch(events, nextBatch)
        } finally {
            response.body.fill(0)
        }
    }

    private fun encode(value: String): String =
        URLEncoder.encode(value, Charsets.UTF_8.name()).replace("+", "%20")

    private companion object {
        const val MAX_RELATION_PAGE_EVENTS = 32
    }
}

/**
 * Receives Malink application-encrypted control and standard room-message
 * timeline events without relying on the Matrix UI timeline. `/sync` keeps
 * live state and history responsive even when a UI timeline is rebuilding.
 */
class MatrixApplicationControlSyncClient(
    private val transport: MatrixApplicationControlSyncTransport =
        RestrictedHttpsMatrixApplicationControlSyncTransport(),
) {
    suspend fun sync(
        session: StoredMatrixSession,
        since: String?,
        longPoll: Boolean = true,
    ): MatrixApplicationControlSyncBatch {
        require(since == null || (since.isNotBlank() && since.length <= 4_096)) {
            "Matrix control sync token is invalid."
        }
        val homeserver = MatrixIdentifiers.normalizeHomeserver(session.homeserverUrl)
        val bindings = session.roomBindings.map(MatrixIdentifiers::validateRoomBinding)
        val filter = buildJsonObject {
            put("presence", buildJsonObject { put("types", JsonArray(emptyList())) })
            put("account_data", buildJsonObject { put("types", JsonArray(emptyList())) })
            put("room", buildJsonObject {
                put("rooms", buildJsonArray {
                    bindings.forEach { add(JsonPrimitive(it.roomId)) }
                })
                put("state", buildJsonObject {
                    // MLP/3 has only bounded discovery/key state. Session
                    // inventory is a timeline/thread projection and therefore
                    // never needs a paged custom Room State directory.
                    put("types", buildJsonArray {
                        add(JsonPrimitive(MLP3_MATRIX_KEY_GRANT_EVENT_TYPE))
                        add(JsonPrimitive(MLP3_MATRIX_PROJECT_POINTER_EVENT_TYPE))
                        add(JsonPrimitive(MLP3_MATRIX_WORKSPACE_POINTER_EVENT_TYPE))
                        add(JsonPrimitive(MLP3_MATRIX_WORKSPACE_DIRECTORY_EVENT_TYPE))
                    })
                })
                put("ephemeral", buildJsonObject { put("types", JsonArray(emptyList())) })
                put("account_data", buildJsonObject { put("types", JsonArray(emptyList())) })
                put("timeline", buildJsonObject {
                    put("types", buildJsonArray {
                        add(JsonPrimitive("m.room.message"))
                        add(JsonPrimitive(MALINK_MATRIX_APPLICATION_CONTROL_EVENT_TYPE))
                        // State changes can also appear in the incremental
                        // timeline; accept only MLP/3's bounded discovery state.
                        add(JsonPrimitive(MLP3_MATRIX_KEY_GRANT_EVENT_TYPE))
                        add(JsonPrimitive(MLP3_MATRIX_PROJECT_POINTER_EVENT_TYPE))
                        add(JsonPrimitive(MLP3_MATRIX_WORKSPACE_POINTER_EVENT_TYPE))
                        add(JsonPrimitive(MLP3_MATRIX_WORKSPACE_DIRECTORY_EVENT_TYPE))
                    })
                    put(
                        "limit",
                        if (since == null) {
                            INITIAL_TIMELINE_LIMIT
                        } else {
                            LIVE_TIMELINE_LIMIT
                        },
                    )
                })
            })
        }.toString()
        val query = buildList {
            add("timeout=${if (since == null || !longPoll) 0 else LONG_POLL_TIMEOUT_MS}")
            add("filter=${encode(filter)}")
            if (since != null) add("since=${encode(since)}")
        }.joinToString("&")
        val response = transport.getJson(
            URI("$homeserver/_matrix/client/v3/sync?$query"),
            session.accessToken,
        )
        return try {
            if (response.status !in 200..299) {
                throw MatrixApplicationControlSyncException(
                    response.status,
                    parseRetryAfterMs(response.body),
                )
            }
            val root = runCatching {
                Json.parseToJsonElement(
                    response.body.toString(Charsets.UTF_8),
                ) as? JsonObject
            }.getOrNull() ?: throw MatrixApplicationControlPayloadException(
                "Matrix control sync response is not an object.",
            )
            val nextBatch = root["next_batch"]
                .let { it as? JsonPrimitive }
                ?.contentOrNull
                ?.takeIf { it.isNotBlank() && it.length <= 4_096 }
                ?: throw MatrixApplicationControlPayloadException(
                    "Matrix control sync response is incomplete.",
                )
            val joined = (root["rooms"] as? JsonObject)?.get("join") as? JsonObject
            val roomGaps = mutableListOf<MatrixSyncGap>()
            val candidateEvents = mutableListOf<Pair<MatrixRoomBinding, JsonElement>>()
            for (binding in bindings) {
                val joinedRoom = joined?.get(binding.roomId) as? JsonObject
                val timeline = joinedRoom?.get("timeline") as? JsonObject
                val limited = (timeline?.get("limited") as? JsonPrimitive)?.booleanOrNull ?: false
                val prev = (timeline?.get("prev_batch") as? JsonPrimitive)?.contentOrNull
                    ?.takeIf { it.isNotBlank() && it.length <= 4_096 }
                if (limited && since != null) {
                    if (prev == null) throw MatrixApplicationControlPayloadException(
                        "Limited Matrix control sync has no gap boundary.",
                    )
                    roomGaps += MatrixSyncGap(since, prev, roomId = binding.roomId)
                }
                val stateEvents = ((joinedRoom?.get("state") as? JsonObject)?.get("events") as? JsonArray)
                    .orEmpty().sortedBy { event -> when (
                        ((event as? JsonObject)?.get("type") as? JsonPrimitive)?.contentOrNull
                    ) {
                        MALINK_MATRIX_GATEWAY_STATE_EVENT_TYPE -> 0
                        MALINK_MATRIX_SESSION_STATE_EVENT_TYPE -> 1
                        else -> 2
                    } }
                val timelineEvents = (timeline?.get("events") as? JsonArray).orEmpty()
                candidateEvents += (stateEvents + timelineEvents).map { binding to it }
            }
            val events = candidateEvents.mapNotNull { (binding, element) ->
                val event = element as? JsonObject ?: return@mapNotNull null
                val eventType = (event["type"] as? JsonPrimitive)?.contentOrNull
                val sender = (event["sender"] as? JsonPrimitive)?.contentOrNull
                if ((eventType != MLP3_MATRIX_WORKSPACE_DIRECTORY_EVENT_TYPE &&
                        sender != binding.gatewayUserId) ||
                    !isMalinkApplicationControlEvent(event.toString())) return@mapNotNull null
                matrixApplicationEvent(binding.roomId, event)
            }
            MatrixApplicationControlSyncBatch(
                nextBatch = nextBatch,
                prevBatch = roomGaps.firstOrNull()?.to,
                events = events,
                candidateEventCount = candidateEvents.size,
                limited = roomGaps.isNotEmpty(),
                roomGaps = roomGaps,
            )
        } finally {
            response.body.fill(0)
        }
    }

    private fun parseRetryAfterMs(body: ByteArray): Long? = runCatching {
        Json.parseToJsonElement(body.toString(Charsets.UTF_8))
            .jsonObject["retry_after_ms"]
            ?.jsonPrimitive
            ?.longOrNull
            ?.coerceIn(100, MAX_RETRY_AFTER_MS)
    }.getOrNull()

    private fun encode(value: String): String =
        URLEncoder.encode(value, Charsets.UTF_8.name()).replace("+", "%20")

    private companion object {
        const val INITIAL_TIMELINE_LIMIT = 32
        // Gateway timeline content is capped at 40 KiB. Keep one /sync page
        // comfortably below the 2 MiB response budget after Matrix metadata
        // and JSON framing. Larger backlogs are recovered through the
        // authoritative Room State baseline and per-thread history paging.
        const val LIVE_TIMELINE_LIMIT = 32
        // A live event releases /sync immediately. The longer empty timeout
        // only reduces idle radio wakeups when no Agent activity is happening.
        const val LONG_POLL_TIMEOUT_MS = 55_000
        const val MAX_RETRY_AFTER_MS = 60_000L
    }
}

private fun matrixApplicationEvent(roomId: String, event: JsonObject): MatrixDecryptedEvent? {
    val eventId = (event["event_id"] as? JsonPrimitive)?.contentOrNull
        ?.takeIf { it.isNotBlank() && it.length <= 512 }
        ?: return null
    val sender = (event["sender"] as? JsonPrimitive)?.contentOrNull
        ?.takeIf { it.isNotBlank() && it.length <= 512 }
        ?: return null
    val timestamp = (event["origin_server_ts"] as? JsonPrimitive)?.longOrNull
        ?.takeIf { it >= 0 }
        ?: return null
    return MatrixDecryptedEvent(roomId, eventId, sender, timestamp, event.toString())
}

private fun parseMatrixRetryAfterMs(body: ByteArray): Long? = runCatching {
    Json.parseToJsonElement(body.toString(Charsets.UTF_8))
        .jsonObject["retry_after_ms"]
        ?.jsonPrimitive
        ?.longOrNull
        ?.coerceIn(100, 60_000L)
}.getOrNull()

/**
 * Sends an already signed and project-encrypted MLP/3 command as an ordinary
 * Matrix room message. Matrix remains the transport/history protocol; the
 * inner envelope supplies Malink's project confidentiality boundary.
 */
class MatrixApplicationControlClient(
    private val transport: MatrixApplicationControlTransport =
        RestrictedHttpsMatrixApplicationControlTransport(),
) {
    suspend fun send(
        session: StoredMatrixSession,
        contentJson: String,
        transactionId: String,
        roomId: String? = null,
    ): String {
        require(transactionId.isNotBlank() && transactionId.length <= 512) {
            "Matrix control transaction ID is invalid."
        }
        require(transactionId.none(Char::isISOControl)) {
            "Matrix control transaction ID is invalid."
        }
        val content = Json.parseToJsonElement(contentJson).jsonObject
        val eventType = requireApplicationControlEnvelope(content)
        val homeserver = MatrixIdentifiers.normalizeHomeserver(session.homeserverUrl)
        val bindings = session.roomBindings.map(MatrixIdentifiers::validateRoomBinding)
        val binding = roomId?.let { targetRoomId ->
            bindings.singleOrNull { it.roomId == targetRoomId }
                ?: throw IllegalArgumentException("Unknown Matrix project room: $targetRoomId")
        } ?: MatrixIdentifiers.validateRoomBinding(session.roomBinding)
        val endpoint = URI(
            "$homeserver/_matrix/client/v3/rooms/${encode(binding.roomId)}/send/" +
                "${encode(eventType)}/${encode(transactionId)}",
        )
        val requestBytes = content.toString().toByteArray(Charsets.UTF_8)
        val response = try {
            transport.putJson(endpoint, session.accessToken, requestBytes)
        } finally {
            requestBytes.fill(0)
        }
        return try {
            require(response.status in 200..299) {
                "Matrix control request failed (${response.status})."
            }
            val root = Json.parseToJsonElement(
                response.body.toString(Charsets.UTF_8),
            ).jsonObject
            root["event_id"]
                ?.jsonPrimitive
                ?.takeIf { it.isString }
                ?.contentOrNull
                ?.takeIf { it.isNotBlank() && it.length <= 512 }
                ?: throw IllegalStateException("Matrix control response is incomplete.")
        } finally {
            response.body.fill(0)
        }
    }

    private fun requireApplicationControlEnvelope(content: JsonObject): String {
        val extension = content["io.malink"] as? JsonObject
        val isNotice = content["msgtype"]?.jsonPrimitive?.contentOrNull == "m.notice"
        if (
            isNotice &&
            extension?.get("version")?.jsonPrimitive?.intOrNull == 3 &&
            extension["envelope"] is JsonObject
        ) {
            return "m.room.message"
        }
        if (
            isNotice &&
            extension?.get("version")?.jsonPrimitive?.intOrNull == 1 &&
            extension["kind"]?.jsonPrimitive?.contentOrNull == "secure_envelope" &&
            extension["secure_envelope"] is JsonObject
        ) {
            return MALINK_MATRIX_APPLICATION_CONTROL_EVENT_TYPE
        }
        throw IllegalArgumentException(
            "Application control events must contain a MLP/3 project envelope."
        )
    }

    private fun encode(value: String): String =
        URLEncoder.encode(value, Charsets.UTF_8.name()).replace("+", "%20")
}
