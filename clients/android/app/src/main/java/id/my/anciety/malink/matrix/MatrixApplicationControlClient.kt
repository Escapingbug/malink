package id.my.anciety.malink.matrix

import id.my.anciety.malink.security.malink.MLP3_MATRIX_KEY_GRANT_EVENT_TYPE
import id.my.anciety.malink.security.malink.MLP3_MATRIX_PROJECT_POINTER_EVENT_TYPE
import id.my.anciety.malink.security.malink.MLP3_MATRIX_PROVIDER_CATALOG_EVENT_TYPE
import id.my.anciety.malink.security.malink.MLP3_MATRIX_WORKSPACE_POINTER_EVENT_TYPE
import id.my.anciety.malink.security.malink.MLP3_MATRIX_WORKSPACE_DIRECTORY_EVENT_TYPE
import id.my.anciety.malink.security.malink.MLP3_MATRIX_WORKSPACE_DEVICE_REVOCATION_EVENT_TYPE
import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.URI
import java.net.URL
import java.net.URLEncoder
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
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

internal class UnknownMatrixProjectRoomException(roomId: String) :
    IllegalStateException("Unknown Matrix project room: $roomId")

internal class MatrixApplicationControlRequestException(
    val statusCode: Int,
) : IllegalStateException("Matrix control request failed ($statusCode).")

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
        MLP3_MATRIX_PROVIDER_CATALOG_EVENT_TYPE -> {
            val extension = content["io.malink"] as? JsonObject ?: return@runCatching false
            root["state_key"]?.jsonPrimitive?.contentOrNull?.isNotBlank() == true &&
                extension["version"]?.jsonPrimitive?.intOrNull == 3 &&
                extension["envelope"] is JsonObject
        }
        MLP3_MATRIX_WORKSPACE_DIRECTORY_EVENT_TYPE ->
            root["state_key"]?.jsonPrimitive?.contentOrNull?.isNotBlank() == true &&
                content["directory"] is JsonObject && content["signature"] is JsonObject
        MLP3_MATRIX_WORKSPACE_DEVICE_REVOCATION_EVENT_TYPE ->
            root["state_key"]?.jsonPrimitive?.contentOrNull?.isNotBlank() == true &&
                content["revocation"] is JsonObject && content["signature"] is JsonObject
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
        MLP3_MATRIX_PROVIDER_CATALOG_EVENT_TYPE ->
            return@runCatching "v3_provider_catalog"
        MLP3_MATRIX_WORKSPACE_DIRECTORY_EVENT_TYPE ->
            return@runCatching "workspace_gateway_directory"
        MLP3_MATRIX_WORKSPACE_DEVICE_REVOCATION_EVENT_TYPE ->
            return@runCatching "workspace_device_revocation"
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

fun interface MatrixApplicationReadTransport {
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

class RestrictedHttpsMatrixApplicationReadTransport(
    private val connectTimeoutMs: Int = 15_000,
    private val readTimeoutMs: Int = 30_000,
) : MatrixApplicationReadTransport {
    override suspend fun getJson(
        endpoint: URI,
        accessToken: String,
    ): MatrixHttpResponse = withContext(Dispatchers.IO) {
        MatrixIdentifiers.requireAllowedEndpoint(endpoint, "Matrix application read endpoint")
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
                        throw MatrixApplicationResponseTooLargeException(
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

data class MatrixApplicationRoomStateBatch(
    val events: List<MatrixDecryptedEvent>,
    val candidateEventCount: Int,
)

data class MatrixApplicationTimelineBatch(
    val events: List<MatrixDecryptedEvent>,
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

class MatrixApplicationReadException(
    val status: Int,
    val retryAfterMs: Long?,
) : IllegalStateException("Matrix application read failed ($status).") {
    val fatal: Boolean get() = status == 401 || status == 403
}

class MatrixApplicationResponseTooLargeException(
    val maximumBytes: Int,
) : IllegalStateException(
    "Matrix application response exceeded the $maximumBytes-byte safety limit.",
)

/**
 * Pages Matrix's native thread directory. The latest signed Gateway event in
 * each thread is enough to rebuild the complete session list; transcripts are
 * fetched lazily through the relations API when the user opens a session.
 */
class MatrixThreadDirectoryClient(
    private val transport: MatrixApplicationReadTransport =
        RestrictedHttpsMatrixApplicationReadTransport(),
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
                throw MatrixApplicationReadException(
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

/** Reads current replace-in-place Malink state without owning a sync cursor. */
class MatrixApplicationRoomStateClient(
    private val transport: MatrixApplicationReadTransport =
        RestrictedHttpsMatrixApplicationReadTransport(),
) {
    /** Reads the bounded MLP/3 Room State used to rebuild a cold local projection. */
    suspend fun currentMlp3(
        session: StoredMatrixSession,
        roomIds: Set<String>? = null,
    ): MatrixApplicationRoomStateBatch {
        val homeserver = MatrixIdentifiers.normalizeHomeserver(session.homeserverUrl)
        val bindings = session.roomBindings.map(MatrixIdentifiers::validateRoomBinding)
        val selectedBindings = if (roomIds == null) {
            bindings
        } else {
            require(roomIds.all { roomId -> bindings.any { it.roomId == roomId } }) {
                "Unknown Matrix project room requested for projection recovery."
            }
            bindings.filter { it.roomId in roomIds }
        }
        val events = selectedBindings.flatMap { binding ->
            val response = transport.getJson(
                URI("$homeserver/_matrix/client/v3/rooms/${encode(binding.roomId)}/state"),
                session.accessToken,
            )
            try {
                if (response.status !in 200..299) {
                    throw MatrixApplicationReadException(
                        response.status,
                        parseMatrixRetryAfterMs(response.body),
                    )
                }
                val candidates = runCatching {
                    Json.parseToJsonElement(response.body.toString(Charsets.UTF_8)) as? JsonArray
                }.getOrNull() ?: throw MatrixApplicationControlPayloadException(
                    "Current Matrix Room State is not an array.",
                )
                candidates.mapNotNull { element ->
                    val event = element as? JsonObject ?: return@mapNotNull null
                    val eventType = event["type"]?.jsonPrimitive?.contentOrNull
                    if (
                        eventType !in MLP3_CURRENT_STATE_EVENT_TYPES ||
                        (eventType != MLP3_MATRIX_WORKSPACE_DIRECTORY_EVENT_TYPE &&
                            eventType != MLP3_MATRIX_WORKSPACE_DEVICE_REVOCATION_EVENT_TYPE &&
                            event["sender"]?.jsonPrimitive?.contentOrNull != binding.gatewayUserId) ||
                        !isMalinkApplicationControlEvent(event.toString())
                    ) return@mapNotNull null
                    matrixApplicationEvent(binding.roomId, event)
                }
            } finally {
                response.body.fill(0)
            }
        }
        return MatrixApplicationRoomStateBatch(events, events.size)
    }

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

    /**
     * Reads the one state key that can revoke the active application
     * certificate. This is intentionally independent of the much larger
     * project projection baseline so cold start does not wait for every
     * provider catalog page before proving command authorization.
     */
    suspend fun currentWorkspaceDeviceRevocation(
        session: StoredMatrixSession,
        roomId: String,
        stateKey: String,
    ): MatrixDecryptedEvent? {
        require(session.roomBindings.any { it.roomId == roomId }) {
            "Unknown Matrix Workspace control room."
        }
        val homeserver = MatrixIdentifiers.normalizeHomeserver(session.homeserverUrl)
        return try {
            currentStateEvent(
                session,
                homeserver,
                roomId,
                MLP3_MATRIX_WORKSPACE_DEVICE_REVOCATION_EVENT_TYPE,
                stateKey,
            )
        } catch (error: MatrixApplicationReadException) {
            if (error.status == 404) null else throw error
        }
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
                throw MatrixApplicationReadException(
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
        val MLP3_CURRENT_STATE_EVENT_TYPES = setOf(
            MLP3_MATRIX_KEY_GRANT_EVENT_TYPE,
            MLP3_MATRIX_PROJECT_POINTER_EVENT_TYPE,
            MLP3_MATRIX_WORKSPACE_POINTER_EVENT_TYPE,
            MLP3_MATRIX_PROVIDER_CATALOG_EVENT_TYPE,
            MLP3_MATRIX_WORKSPACE_DIRECTORY_EVENT_TYPE,
            MLP3_MATRIX_WORKSPACE_DEVICE_REVOCATION_EVENT_TYPE,
        )
    }
}

/** Directly fetches a pointer-referenced MLP/3 room event without scanning history. */
class MatrixApplicationEventClient(
    private val transport: MatrixApplicationReadTransport =
        RestrictedHttpsMatrixApplicationReadTransport(),
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
                throw MatrixApplicationReadException(
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

/**
 * Reads one bounded recent room page when the SDK's live UI timeline omits a
 * durable Matrix event. This is a recovery path, not a second sync loop: the
 * normal SDK callback remains the fast path and the native raw inbox performs
 * the same verification and event-ID deduplication for recovered events.
 */
class MatrixApplicationTimelineClient(
    private val transport: MatrixApplicationReadTransport =
        RestrictedHttpsMatrixApplicationReadTransport(),
) {
    suspend fun latest(
        session: StoredMatrixSession,
        roomId: String,
        limit: Int,
    ): MatrixApplicationTimelineBatch {
        require(limit in 1..MAX_RECOVERY_PAGE_EVENTS)
        val homeserver = MatrixIdentifiers.normalizeHomeserver(session.homeserverUrl)
        val binding = session.roomBindings
            .map(MatrixIdentifiers::validateRoomBinding)
            .singleOrNull { it.roomId == roomId }
            ?: throw IllegalArgumentException("Unknown Matrix project room: $roomId")
        val response = transport.getJson(
            URI(
                "$homeserver/_matrix/client/v3/rooms/${encode(binding.roomId)}/messages" +
                    "?dir=b&limit=$limit",
            ),
            session.accessToken,
        )
        return try {
            if (response.status !in 200..299) {
                throw MatrixApplicationReadException(
                    response.status,
                    parseMatrixRetryAfterMs(response.body),
                )
            }
            val root = runCatching {
                Json.parseToJsonElement(response.body.toString(Charsets.UTF_8)) as? JsonObject
            }.getOrNull() ?: throw MatrixApplicationControlPayloadException(
                "The Matrix recovery timeline response is not an object.",
            )
            val chunk = root["chunk"] as? JsonArray
                ?: throw MatrixApplicationControlPayloadException(
                    "The Matrix recovery timeline response has no event page.",
                )
            require(chunk.size <= MAX_RECOVERY_PAGE_EVENTS) {
                "The Matrix recovery timeline exceeded its requested limit."
            }
            val events = chunk.mapNotNull { value ->
                val event = value as? JsonObject ?: return@mapNotNull null
                if (event["sender"]?.jsonPrimitive?.contentOrNull != binding.gatewayUserId) {
                    return@mapNotNull null
                }
                if (!isMalinkApplicationControlEvent(event.toString())) return@mapNotNull null
                matrixApplicationEvent(binding.roomId, event)
            }.asReversed()
            MatrixApplicationTimelineBatch(events)
        } finally {
            response.body.fill(0)
        }
    }

    private fun encode(value: String): String =
        URLEncoder.encode(value, Charsets.UTF_8.name()).replace("+", "%20")

    private companion object {
        const val MAX_RECOVERY_PAGE_EVENTS = 64
    }
}

/** Pages one session thread without scanning or materializing the room timeline. */
class MatrixThreadHistoryClient(
    private val transport: MatrixApplicationReadTransport =
        RestrictedHttpsMatrixApplicationReadTransport(),
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
                throw MatrixApplicationReadException(
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

/** Pages a data-only Provider History room in physical append order. */
class MatrixProviderHistoryClient(
    private val transport: MatrixApplicationReadTransport =
        RestrictedHttpsMatrixApplicationReadTransport(),
) {
    suspend fun page(
        session: StoredMatrixSession,
        roomId: String,
        from: String?,
        limit: Int,
    ): MatrixThreadHistoryBatch {
        require(from == null || (from.isNotBlank() && from.length <= 4_096))
        require(limit in 1..500)
        val homeserver = MatrixIdentifiers.normalizeHomeserver(session.homeserverUrl)
        val binding = session.roomBindings
            .map(MatrixIdentifiers::validateRoomBinding)
            .singleOrNull { it.roomId == roomId }
            ?: throw IllegalArgumentException("Unknown Provider History room: $roomId")
        val query = buildList {
            add("dir=f")
            add("limit=${minOf(limit, MAX_PAGE_EVENTS)}")
            if (from != null) add("from=${encode(from)}")
        }.joinToString("&")
        val response = transport.getJson(
            URI(
                "$homeserver/_matrix/client/v3/rooms/${encode(binding.roomId)}/messages?$query",
            ),
            session.accessToken,
        )
        return try {
            if (response.status !in 200..299) {
                throw MatrixApplicationReadException(response.status, parseMatrixRetryAfterMs(response.body))
            }
            val root = runCatching {
                Json.parseToJsonElement(response.body.toString(Charsets.UTF_8)) as? JsonObject
            }.getOrNull() ?: throw MatrixApplicationControlPayloadException(
                "Provider History response is not an object.",
            )
            val events = root["chunk"]
                .let { it as? JsonArray }
                .orEmpty()
                .mapNotNull { it as? JsonObject }
                .filter { event ->
                    event["sender"]?.jsonPrimitive?.contentOrNull == binding.gatewayUserId &&
                        isMalinkApplicationControlEvent(event.toString())
                }
                .mapNotNull { event -> matrixApplicationEvent(binding.roomId, event) }
            val nextBatch = root["end"]
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
        const val MAX_PAGE_EVENTS = 500
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
                ?: throw UnknownMatrixProjectRoomException(targetRoomId)
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
            if (response.status !in 200..299) {
                throw MatrixApplicationControlRequestException(response.status)
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
