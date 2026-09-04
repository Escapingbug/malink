package id.my.anciety.malink.client

import id.my.anciety.malink.client.events.ClientMessage
import id.my.anciety.malink.client.events.ClientMessageFormat
import id.my.anciety.malink.client.events.ClientMessageKind
import id.my.anciety.malink.client.events.PublicClientJson
import id.my.anciety.malink.client.events.ToolCategory
import id.my.anciety.malink.client.events.ToolGroupPresentation
import id.my.anciety.malink.client.events.ToolPhase
import id.my.anciety.malink.client.events.ToolPresentationItem
import id.my.anciety.malink.security.malink.CanonicalJson
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put

internal data class MatrixMlp3NativeTerminal(
    val commandId: String,
    val outcome: String,
    val sessionId: String?,
    val result: JsonElement? = null,
    val errorCode: String? = null,
    val errorMessage: String? = null,
    val retryable: Boolean = false,
)

internal data class MatrixMlp3NativeProjectionResult(
    val messages: List<ClientMessage> = emptyList(),
    val progressedCommandId: String? = null,
    val terminal: MatrixMlp3NativeTerminal? = null,
    val taskNotification: MatrixMlp3TaskNotification? = null,
    val changed: Boolean = false,
)

internal data class MatrixMlp3WorkspaceProjectionProgress(
    val expectedProjectIds: Set<String>?,
    val keyedProjectIds: Set<String>,
    val projectedProjectIds: Set<String>,
    val capabilityProjectIds: Set<String>,
) {
    val loadedProjectIds: Set<String> = when (expectedProjectIds) {
        null -> keyedProjectIds intersect projectedProjectIds intersect capabilityProjectIds
        else -> expectedProjectIds intersect keyedProjectIds intersect
            projectedProjectIds intersect capabilityProjectIds
    }
    val missingProjectIds: Set<String> = expectedProjectIds
        ?.minus(loadedProjectIds)
        .orEmpty()
    val complete: Boolean = when (expectedProjectIds) {
        null -> loadedProjectIds.isNotEmpty()
        else -> expectedProjectIds.isNotEmpty() && missingProjectIds.isEmpty()
    }
    val hasUsableProject: Boolean = (keyedProjectIds intersect projectedProjectIds).isNotEmpty()
}

internal fun matrixMlp3WorkspaceProjectionProgress(
    expectedProjectIds: Set<String>?,
    keyedProjectIds: Set<String>,
    projectedProjectIds: Set<String>,
    capabilityProjectIds: Set<String>,
): MatrixMlp3WorkspaceProjectionProgress = MatrixMlp3WorkspaceProjectionProgress(
    expectedProjectIds = expectedProjectIds?.toSet(),
    keyedProjectIds = keyedProjectIds.toSet(),
    projectedProjectIds = projectedProjectIds.toSet(),
    capabilityProjectIds = capabilityProjectIds.toSet(),
)

internal data class MatrixMlp3SessionTailRecoveryTarget(
    val sessionId: String,
    val projectId: String,
    val threadRootEventId: String,
    val activeTurnId: String,
    val stateVersion: Long,
)

internal data class MatrixMlp3SessionReadReceiptTarget(
    val sessionId: String,
    val projectId: String,
    val roomId: String,
    val threadRootEventId: String,
    val eventId: String,
    val updatedAt: Long,
)

internal data class MatrixMlp3DurableProjection(
    val value: JsonObject,
    val encodedBytes: Int,
    val totalSessions: Int,
    val retainedSessions: Int,
    val totalSeenEvents: Int,
    val retainedSeenEvents: Int,
    val totalSeenCommands: Int,
    val retainedSeenCommands: Int,
    val totalAssistantVersions: Int,
    val retainedAssistantVersions: Int,
) {
    val compacted: Boolean
        get() = retainedSessions < totalSessions ||
            retainedSeenEvents < totalSeenEvents ||
            retainedSeenCommands < totalSeenCommands ||
            retainedAssistantVersions < totalAssistantVersions
}

/** Order-independent Android materialized view of MLP/3 timeline data. */
internal class MatrixMlp3NativeProjection(
    private val gatewayId: () -> String,
    private val activeDeviceCount: () -> Int,
    initialState: JsonObject? = null,
) {
    private data class AssistantMessageKey(
        val sessionId: String,
        val messageId: String,
        val partIndex: Int,
    )

    private data class TaskNotificationPreview(
        val sessionId: String,
        val commandId: String,
        val messageId: String,
        val messageVersion: Long,
        val occurredAt: Long,
        val body: String,
    )

    private data class Project(
        val id: String,
        val snapshotVersion: Long,
        val name: String,
        val cwd: String,
        val provider: String,
        val model: String?,
        val reasoningEffort: String?,
        val permissionMode: String,
        val installedExtensions: JsonArray,
        val defaultExtensions: JsonArray,
        val extensionDefaultsRevision: Long,
    )

    private data class WorkspaceCapabilities(
        val snapshotVersion: Long,
        val value: JsonObject,
        val clientReleases: JsonArray,
    )

    private data class Session(
        val id: String,
        val projectId: String,
        val threadRootEventId: String,
        val readReceiptEventId: String? = null,
        val title: String,
        val scope: String,
        val cwd: String,
        val lifecycle: String,
        val activity: String,
        val updatedAt: Long,
        val stateVersion: Long,
        val provider: String?,
        val model: String?,
        val reasoningEffort: String?,
        val permissionMode: String?,
        val extensions: JsonArray,
        val extensionRevision: Long,
        val availableCommands: JsonArray,
        val providerHistory: JsonObject?,
        val activeTurnId: String? = null,
    )

    private data class ProviderHistoryPageState(
        val snapshotId: String,
        val frontier: Long,
        val hasMore: Boolean,
    )

    private data class ProviderHistoryMessagePart(
        val sessionId: String,
        val snapshotId: String,
        val sourceMessageId: String,
        val sourceOrdinal: Long,
        val role: String,
        val body: String,
        val pageIndex: Long,
        val partIndex: Int,
        val partCount: Int,
        val occurredAt: Long,
    )

    private data class ProviderHistoryPageCommit(
        val sessionId: String,
        val snapshotId: String,
        val pageIndex: Long,
        val previousFrontier: Long,
        val frontier: Long,
        val messageCount: Long,
        val hasMore: Boolean,
        val digest: String,
    )

    private data class InboxFile(
        val id: String,
        val receivedAt: Long,
        val caption: String?,
        val sourceLabel: String?,
        val attachment: JsonObject,
    )

    private data class GatewayUpdateObservation(
        val observedAt: Long,
        val status: JsonObject,
    )

    private val projects = linkedMapOf<String, Project>()
    private val projectCapabilities = linkedMapOf<String, WorkspaceCapabilities>()
    private var workspaceGatewayDirectory: JsonObject? = null
    private val workspacePendingGatewayEnrollmentsByProject = linkedMapOf<String, JsonArray>()
    private var gatewayUpdateStatus: JsonObject? = null
    private val gatewayUpdateObservationsByProject =
        linkedMapOf<String, GatewayUpdateObservation>()
    private val sessions = linkedMapOf<String, Session>()
    private val inboxFiles = linkedMapOf<String, InboxFile>()
    private val seenEvents = mutableSetOf<String>()
    private val seenCommands = mutableSetOf<String>()
    private val assistantMessageVersions = linkedMapOf<AssistantMessageKey, Long>()
    private val taskNotificationPreviews = linkedMapOf<String, TaskNotificationPreview>()
    private val providerHistoryPageStates = linkedMapOf<String, ProviderHistoryPageState>()
    private val providerHistoryMessageParts = linkedMapOf<String, ProviderHistoryMessagePart>()
    private val providerHistoryPageCommits = linkedMapOf<String, ProviderHistoryPageCommit>()

    init {
        initialState?.let(::restore)
    }

    @Synchronized
    fun applyOwnCommand(
        command: JsonObject,
        physicalEventId: String,
        timestamp: Long,
    ): MatrixMlp3NativeProjectionResult {
        val commandId = command.requiredString("commandId", 256)
        val deviceId = command.requiredString("deviceId", 256)
        val certificateId = command.requiredString("certificateId", 256)
        if (!seenCommands.add("$deviceId\u0000$certificateId\u0000$commandId")) {
            return MatrixMlp3NativeProjectionResult()
        }
        val operation = command.requiredString("operation", 128)
        val payload = command.requiredObject("payload")
        return when (operation) {
            "session.create" -> {
                val sessionId = command.requiredString("sessionId", 256)
                val projectId = command.requiredString("projectId", 256)
                val initial = payload["initialPrompt"] as? JsonObject
                sessions[sessionId] = Session(
                    id = sessionId,
                    projectId = projectId,
                    threadRootEventId = physicalEventId,
                    readReceiptEventId = physicalEventId,
                    title = payload.optionalString("title", 512)
                        ?: titleFromPrompt(initial?.optionalString("text", Int.MAX_VALUE).orEmpty()),
                    scope = payload.optionalString("scope", 32)?.also {
                        require(it == "project" || it == "scratch")
                    } ?: "project",
                    cwd = projects[projectId]?.cwd.orEmpty(),
                    lifecycle = "active",
                    activity = if (initial == null) "idle" else "queued",
                    updatedAt = timestamp,
                    stateVersion = 1,
                    provider = payload.optionalString("provider", 256),
                    model = payload.optionalString("model", 256),
                    reasoningEffort = payload.optionalString("reasoningEffort", 64),
                    permissionMode = payload.optionalString("permissionMode", 128),
                    extensions = payload["extensions"] as? JsonArray ?: JsonArray(emptyList()),
                    extensionRevision = 1,
                    availableCommands = JsonArray(emptyList()),
                    providerHistory = null,
                )
                MatrixMlp3NativeProjectionResult(
                    messages = initial?.let {
                        listOf(userMessage(
                            commandId,
                            sessionId,
                            physicalEventId,
                            timestamp,
                            it.optionalString("text", Int.MAX_VALUE).orEmpty(),
                            deviceId,
                            it,
                        ))
                    }.orEmpty(),
                    changed = true,
                )
            }
            "prompt.submit" -> MatrixMlp3NativeProjectionResult(
                messages = listOf(userMessage(
                    commandId,
                    command.requiredString("sessionId", 256),
                    physicalEventId,
                    timestamp,
                    payload.optionalString("text", Int.MAX_VALUE).orEmpty(),
                    deviceId,
                    payload,
                )),
                changed = true,
            )
            else -> MatrixMlp3NativeProjectionResult()
        }
    }

    @Synchronized
    fun applyGatewayEvent(
        event: JsonObject,
        physicalEventId: String,
        threadRootHint: String?,
    ): MatrixMlp3NativeProjectionResult {
        val eventId = event.requiredString("eventId", 256)
        val occurredAt = event.requiredLong("occurredAt")
        val sessionId = event.optionalString("sessionId", 256)
        val projectId = event.optionalString("projectId", 256)
        val causation = event.optionalString("causationCommandId", 256)
        val payload = event.requiredObject("payload")
        val type = payload.requiredString("type", 128)

        if (type == "workspace.snapshot") {
            val capabilityProjectId = requireNotNull(projectId) {
                "The Matrix workspace snapshot does not identify its project."
            }
            val version = payload.requiredPositiveLong("snapshotVersion")
            val current = projectCapabilities[capabilityProjectId]
            val incomingReleases = payload["clientReleases"] as? JsonArray
                ?: JsonArray(emptyList())
            val clientReleases = mergeNativeClientReleases(
                current?.clientReleases ?: JsonArray(emptyList()),
                incomingReleases,
            )
            val pendingGatewayEnrollments = payload["pendingGatewayEnrollments"] as? JsonArray
                ?: JsonArray(emptyList())
            validatePendingGatewayEnrollments(pendingGatewayEnrollments)
            val incomingGatewayUpdate = (payload["gatewayUpdate"] as? JsonObject)
                ?.also(::validateGatewayUpdateStatus)
                ?: gatewayUpdateStatus
            val currentPendingGatewayEnrollments =
                workspacePendingGatewayEnrollmentsByProject[capabilityProjectId]
                    ?: JsonArray(emptyList())
            if (current != null && version <= current.snapshotVersion) {
                if (
                    clientReleases == current.clientReleases &&
                    pendingGatewayEnrollments == currentPendingGatewayEnrollments &&
                    incomingGatewayUpdate == gatewayUpdateStatus
                ) {
                    return MatrixMlp3NativeProjectionResult()
                }
                seenEvents.add(eventId)
                workspacePendingGatewayEnrollmentsByProject[capabilityProjectId] =
                    pendingGatewayEnrollments
                gatewayUpdateStatus = incomingGatewayUpdate
                projectCapabilities[capabilityProjectId] = current.copy(
                    clientReleases = clientReleases,
                )
                return MatrixMlp3NativeProjectionResult(changed = true)
            }
            val protocolMin = payload.requiredPositiveLong("protocolMin")
            val protocolMax = payload.requiredPositiveLong("protocolMax")
            require(protocolMin <= 3L && protocolMax >= 3L) {
                "The Matrix workspace snapshot does not support MLP/3."
            }
            payload.requiredString("gatewayKeyId", 256)
            val capabilities = payload.requiredObject("capabilities")
            validateCapabilities(capabilities)
            seenEvents.add(eventId)
            workspacePendingGatewayEnrollmentsByProject[capabilityProjectId] =
                pendingGatewayEnrollments
            gatewayUpdateStatus = incomingGatewayUpdate
            projectCapabilities[capabilityProjectId] = WorkspaceCapabilities(
                version,
                capabilities,
                clientReleases,
            )
            return MatrixMlp3NativeProjectionResult(changed = true)
        }

        if (type == "gateway.update.status") {
            if (!seenEvents.add(eventId)) return MatrixMlp3NativeProjectionResult()
            val status = payload.requiredObject("status")
            validateGatewayUpdateStatus(status)
            val currentUpdatedAt = gatewayUpdateStatus?.requiredLong("updatedAt") ?: -1
            val incomingUpdatedAt = status.requiredLong("updatedAt")
            if (incomingUpdatedAt >= currentUpdatedAt) gatewayUpdateStatus = status
            val currentObservation = projectId?.let(gatewayUpdateObservationsByProject::get)
            val observationChanged = projectId != null &&
                (currentObservation == null || occurredAt > currentObservation.observedAt)
            if (projectId != null && observationChanged) {
                gatewayUpdateObservationsByProject[projectId] =
                    GatewayUpdateObservation(occurredAt, status)
            }
            return MatrixMlp3NativeProjectionResult(
                terminal = terminal(type, event, payload, causation, sessionId),
                changed = incomingUpdatedAt >= currentUpdatedAt || observationChanged,
            )
        }

        if (type == "gateway.restart.status") {
            if (!seenEvents.add(eventId)) return MatrixMlp3NativeProjectionResult()
            val status = payload.requiredObject("status")
            validateGatewayRestartStatus(status)
            return MatrixMlp3NativeProjectionResult(
                terminal = terminal(type, event, payload, causation, sessionId),
                changed = true,
            )
        }

        if (!seenEvents.add(eventId)) return MatrixMlp3NativeProjectionResult()

        if (type == "project.deleted" && projectId != null) {
            projects.remove(projectId)
            projectCapabilities.remove(projectId)
            workspacePendingGatewayEnrollmentsByProject.remove(projectId)
            gatewayUpdateObservationsByProject.remove(projectId)
            val deletedSessionIds = sessions.values
                .filter { it.projectId == projectId }
                .map { it.id }
                .toSet()
            sessions.keys.removeAll(deletedSessionIds)
            assistantMessageVersions.keys.removeAll { it.sessionId in deletedSessionIds }
            taskNotificationPreviews.entries.removeAll { it.value.sessionId in deletedSessionIds }
            return MatrixMlp3NativeProjectionResult(
                terminal = terminal(type, event, payload, causation, sessionId),
                changed = true,
            )
        }

        if (type == "project.snapshot" && projectId != null) {
            val version = payload.requiredPositiveLong("snapshotVersion")
            val current = projects[projectId]
            if (current == null || version >= current.snapshotVersion) {
                projects[projectId] = Project(
                    id = projectId,
                    snapshotVersion = version,
                    name = payload.requiredString("name", 256),
                    cwd = payload.requiredString("cwd", 8_192),
                    provider = payload.requiredString("provider", 256),
                    model = payload.optionalString("model", 256),
                    reasoningEffort = payload.optionalString("reasoningEffort", 64),
                    permissionMode = payload.requiredString("permissionMode", 128),
                    installedExtensions = payload["installedExtensions"] as? JsonArray
                        ?: JsonArray(emptyList()),
                    defaultExtensions = payload["defaultExtensions"] as? JsonArray
                        ?: JsonArray(emptyList()),
                    extensionDefaultsRevision = payload.optionalLong("extensionDefaultsRevision")
                        ?.takeIf { it > 0 }
                        ?: 1,
                )
                return MatrixMlp3NativeProjectionResult(changed = true)
            }
            return MatrixMlp3NativeProjectionResult()
        }

        if (type == "inbox.file.received" && projectId != null) {
            val fileId = payload.requiredString("fileId", 256)
            val attachment = payload.requiredObject("attachment")
            PublicClientJson.decodeAttachment(attachment)
            val source = payload.requiredObject("source")
            require(source.requiredString("kind", 32) == "local-cli")
            inboxFiles[fileId] = InboxFile(
                id = fileId,
                receivedAt = occurredAt,
                caption = payload.optionalString("caption", 8_192),
                sourceLabel = source.optionalString("label", 256),
                attachment = attachment,
            )
            return MatrixMlp3NativeProjectionResult(changed = true)
        }

        if (type == "provider.history.message" && sessionId != null) {
            val snapshotId = payload.requiredString("snapshotId", 256)
            val sourceOrdinal = payload.requiredLong("sourceOrdinal").also { require(it >= 0) }
            val pageIndex = payload.requiredLong("pageIndex").also { require(it >= 0) }
            val hasPartIndex = "partIndex" in payload
            val hasPartCount = "partCount" in payload
            require(hasPartIndex == hasPartCount)
            val partIndex = payload.optionalInt("partIndex") ?: 0
            val partCount = payload.optionalInt("partCount") ?: 1
            require(partIndex >= 0 && partCount > 0 && partIndex < partCount)
            require(sessions[sessionId]?.providerHistory
                ?.requiredString("snapshotId", 256) == snapshotId)
            val role = payload.requiredOneOf("role", setOf("user", "assistant"))
            val part = ProviderHistoryMessagePart(
                sessionId = sessionId,
                snapshotId = snapshotId,
                sourceMessageId = payload.requiredString("sourceMessageId", 256),
                sourceOrdinal = sourceOrdinal,
                role = role,
                body = requireNotNull(payload.optionalString("body", 16 * 1024)) {
                    "The Provider History message body is missing."
                },
                pageIndex = pageIndex,
                partIndex = partIndex,
                partCount = partCount,
                occurredAt = occurredAt,
            )
            val key = providerHistoryPartKey(part)
            val current = providerHistoryMessageParts[key]
            require(current == null || current == part) {
                "The Provider History message part conflicts with an earlier event."
            }
            providerHistoryMessageParts[key] = part
            return MatrixMlp3NativeProjectionResult(
                messages = materializeCommittedProviderHistoryPage(sessionId, snapshotId, pageIndex),
                changed = true,
            )
        }

        if (type == "provider.history.page.committed" && sessionId != null) {
            val snapshotId = payload.requiredString("snapshotId", 256)
            val previousFrontier = payload.requiredLong("previousFrontier")
                .also { require(it >= 0) }
            val frontier = payload.requiredLong("frontier").also { require(it >= previousFrontier) }
            val pageIndex = payload.requiredLong("pageIndex").also { require(it >= 0) }
            val messageCount = payload.requiredLong("messageCount").also { require(it >= 0) }
            val digest = payload.requiredString("digest", 43)
            require(sessions[sessionId]?.providerHistory
                ?.requiredString("snapshotId", 256) == snapshotId)
            val commit = ProviderHistoryPageCommit(
                sessionId = sessionId,
                snapshotId = snapshotId,
                pageIndex = pageIndex,
                previousFrontier = previousFrontier,
                frontier = frontier,
                messageCount = messageCount,
                hasMore = payload.requiredBoolean("hasMore"),
                digest = digest,
            )
            val commitKey = providerHistoryPageKey(sessionId, snapshotId, pageIndex)
            val existingCommit = providerHistoryPageCommits[commitKey]
            require(existingCommit == null || existingCommit == commit) {
                "The Provider History page commit conflicts with an earlier event."
            }
            providerHistoryPageCommits[commitKey] = commit
            val current = providerHistoryPageStates[sessionId]
            if (current == null || frontier >= current.frontier) {
                providerHistoryPageStates[sessionId] = ProviderHistoryPageState(
                    snapshotId = snapshotId,
                    frontier = frontier,
                    hasMore = commit.hasMore,
                )
            }
            return MatrixMlp3NativeProjectionResult(
                messages = materializeCommittedProviderHistoryPage(
                    sessionId,
                    snapshotId,
                    pageIndex,
                ),
                changed = true,
            )
        }

        if (sessionId != null && payload["projection"] is JsonObject) {
            applySessionProjection(
                sessionId,
                projectId,
                payload.requiredObject("projection"),
                physicalEventId,
                threadRootHint,
            )
        }
        if (
            type == "session.lifecycle" &&
            sessionId != null &&
            payload.requiredString("state", 32) == "deleted"
        ) {
            sessions.remove(sessionId)
            assistantMessageVersions.keys.removeAll { it.sessionId == sessionId }
            taskNotificationPreviews.entries.removeAll { it.value.sessionId == sessionId }
            providerHistoryPageStates.remove(sessionId)
            providerHistoryMessageParts.entries.removeAll { it.value.sessionId == sessionId }
            providerHistoryPageCommits.entries.removeAll { it.value.sessionId == sessionId }
        }

        observeActiveTurn(type, sessionId, causation, payload)

        var messages = emptyList<ClientMessage>()
        when (type) {
            "session.ready" -> if (sessionId != null && projectId != null) {
                val projection = payload.requiredObject("projection")
                val current = sessions[sessionId]
                if (
                    current != null &&
                    (current.stateVersion > projection.requiredPositiveLong("stateVersion") ||
                        (current.stateVersion == projection.requiredPositiveLong("stateVersion") &&
                            current.updatedAt > projection.requiredLong("updatedAt")))
                ) {
                    return MatrixMlp3NativeProjectionResult()
                }
                sessions[sessionId] = decodeSession(
                    sessionId = sessionId,
                    projectId = projectId,
                    threadRootEventId = current?.threadRootEventId.orEmpty()
                        .ifEmpty { threadRootHint.orEmpty() },
                    projection = projection,
                    provider = payload.requiredString("provider", 256),
                    model = payload.optionalString("model", 256),
                    reasoningEffort = payload.optionalString("reasoningEffort", 64),
                    permissionMode = payload.requiredString("permissionMode", 128),
                )
                val initial = payload["initialPrompt"] as? JsonObject
                val rootCommandId = payload.optionalString("rootCommandId", 256)
                if (initial != null && rootCommandId != null) {
                    messages = listOf(userMessage(
                        rootCommandId,
                        sessionId,
                        sessions[sessionId]?.threadRootEventId.orEmpty().ifEmpty { physicalEventId },
                        occurredAt,
                        initial.optionalString("text", Int.MAX_VALUE).orEmpty(),
                        payload.optionalString("originDeviceId", 256),
                        initial,
                    ))
                }
            }
            "turn.queued" -> if (sessionId != null) {
                messages = listOf(userMessage(
                    payload.requiredString("turnId", 256),
                    sessionId,
                    physicalEventId,
                    occurredAt,
                    payload.optionalString("text", Int.MAX_VALUE).orEmpty(),
                    payload.requiredString("originDeviceId", 256),
                    payload,
                ))
            }
            "assistant.message" -> if (sessionId != null) {
                val messageId = payload.requiredString("messageId", 256)
                val part = payload.optionalInt("partIndex") ?: 0
                val version = payload.requiredPositiveLong("messageVersion")
                val versionKey = AssistantMessageKey(sessionId, messageId, part)
                val currentVersion = assistantMessageVersions[versionKey]
                if (currentVersion != null && version <= currentVersion) {
                    messages = emptyList()
                } else {
                    assistantMessageVersions[versionKey] = version
                    if (assistantMessageVersions.size > MAX_SEEN_IDS) {
                        assistantMessageVersions.remove(assistantMessageVersions.keys.first())
                    }
                    val toolGroup = decodeMlp3ToolGroup(payload)
                    rememberTaskNotificationPreview(
                        payload = payload,
                        sessionId = sessionId,
                        commandId = causation,
                        messageId = messageId,
                        messageVersion = version,
                        occurredAt = occurredAt,
                        eligible = toolGroup == null,
                    )
                    val attachments = (payload["attachments"] as? JsonArray)?.mapNotNull { item ->
                        runCatching { PublicClientJson.decodeAttachment(item) }.getOrNull()
                    }
                    messages = listOf(ClientMessage(
                        eventId = "assistant:$messageId:$part",
                        sender = gatewayId(),
                        timestamp = occurredAt,
                        encrypted = true,
                        kind = if (toolGroup == null) ClientMessageKind.AGENT else ClientMessageKind.TOOL,
                        format = if (payload.optionalString("format", 32) == "plain") {
                            ClientMessageFormat.PLAIN
                        } else {
                            ClientMessageFormat.MARKDOWN
                        },
                        text = payload.optionalString("body", Int.MAX_VALUE).orEmpty(),
                        sessionId = sessionId,
                        commandId = causation,
                        attachments = attachments?.takeIf { it.isNotEmpty() },
                        toolGroup = toolGroup,
                        semantic = payload,
                    ))
                }
            }
            "tool.activity" -> if (sessionId != null) {
                val toolGroup = toolActivityGroup(payload, occurredAt)
                messages = listOf(ClientMessage(
                    eventId = "tool:${toolGroup.groupId}",
                    sender = gatewayId(),
                    timestamp = occurredAt,
                    encrypted = true,
                    kind = ClientMessageKind.TOOL,
                    format = ClientMessageFormat.PLAIN,
                    text = toolGroup.tools.single().name,
                    sessionId = sessionId,
                    commandId = causation,
                    toolGroup = toolGroup,
                    semantic = payload,
                ))
            }
            "decision.requested" -> if (sessionId != null) {
                val requestId = payload.requiredString("requestId", 256)
                messages = listOf(ClientMessage(
                    eventId = "decision:$requestId",
                    sender = gatewayId(),
                    timestamp = occurredAt,
                    encrypted = true,
                    kind = ClientMessageKind.PERMISSION,
                    format = ClientMessageFormat.MARKDOWN,
                    text = payload.requiredString("title", 1_024),
                    sessionId = sessionId,
                    requestId = requestId,
                    commandId = causation,
                    semantic = payload,
                ))
            }
            "extension.interaction.requested" -> if (sessionId != null) {
                val requestId = payload.requiredString("requestId", 256)
                val view = payload.requiredObject("view")
                messages = listOf(ClientMessage(
                    eventId = "decision:$requestId",
                    sender = gatewayId(),
                    timestamp = occurredAt,
                    encrypted = true,
                    kind = ClientMessageKind.PERMISSION,
                    format = ClientMessageFormat.PLAIN,
                    text = view.requiredString("title", 256),
                    sessionId = sessionId,
                    requestId = requestId,
                    commandId = causation,
                    semantic = payload,
                ))
            }
            "turn.failed" -> if (sessionId != null) {
                val turnId = payload.requiredString("turnId", 256)
                messages = listOf(ClientMessage(
                    eventId = "turn-failed:$turnId",
                    sender = gatewayId(),
                    timestamp = occurredAt,
                    encrypted = true,
                    kind = ClientMessageKind.ERROR,
                    format = ClientMessageFormat.PLAIN,
                    text = payload.requiredString("message", 8_192),
                    sessionId = sessionId,
                    commandId = causation ?: turnId,
                    semantic = payload,
                ))
            }
        }

        return MatrixMlp3NativeProjectionResult(
            messages = messages,
            progressedCommandId = when {
                type in setOf("turn.queued", "turn.started") -> causation
                type == "command.reconciled" &&
                    payload.requiredString("state", 32) == "running" -> causation
                else -> null
            },
            terminal = terminal(type, event, payload, causation, sessionId),
            taskNotification = taskNotification(type, eventId, payload, causation, sessionId),
            changed = sessionId != null || messages.isNotEmpty(),
        )
    }

    @Synchronized
    fun snapshot(): JsonObject? {
        val activeProject = projects.values.firstOrNull() ?: return null
        val visible = sessions.values
            .filter { it.lifecycle == "active" }
            .sortedWith(compareByDescending<Session> { it.updatedAt }.thenBy { it.id })
        val latestVersion = maxOf(1L, visible.maxOfOrNull { it.stateVersion } ?: 1L)
        val latestTimestamp = maxOf(
            visible.maxOfOrNull { it.updatedAt } ?: 0L,
            inboxFiles.values.maxOfOrNull { it.receivedAt } ?: 0L,
            gatewayUpdateStatus?.requiredLong("updatedAt") ?: 0L,
            gatewayUpdateObservationsByProject.values.maxOfOrNull { it.observedAt } ?: 0L,
        )
        return buildJsonObject {
            put("version", 1)
            put("kind", "gateway_state")
            put("revision", 0)
            put("revision_epoch", "matrix-native-v3")
            put("revision_epoch_generation", 1)
            put("state_version", latestVersion)
            put("active_device_count", activeDeviceCount().coerceAtLeast(1))
            put("updated_at", latestTimestamp)
            put("command_sequences", JsonArray(emptyList()))
            put("current_session_id", JsonNull)
            put("sessions", buildJsonArray {
                visible.forEach { session ->
                    add(publicSession(session, projects[session.projectId] ?: activeProject))
                }
            })
            put("inbox_files", buildJsonArray {
                inboxFiles.values.sortedByDescending { it.receivedAt }.forEach { file ->
                    add(buildJsonObject {
                        put("id", file.id)
                        put("received_at", file.receivedAt)
                        file.caption?.let { put("caption", it) }
                        file.sourceLabel?.let { put("source_label", it) }
                        put("attachment", file.attachment)
                    })
                }
            })
            put("workspace", publicProject(activeProject))
            put("projects", buildJsonArray {
                projects.values.sortedBy(Project::id).forEach { add(publicProject(it)) }
            })
            put(
                "capabilities",
                projectCapabilities[activeProject.id]?.value
                    ?: defaultCapabilities(activeProject.installedExtensions),
            )
            put(
                "native_client_releases",
                mergedNativeClientReleases(),
            )
            workspaceGatewayDirectory?.let { put("gateway_directory", it) }
            put("pending_gateway_enrollments", mergedPendingGatewayEnrollments())
            gatewayUpdateStatus?.let { put("gateway_update", it) }
            put("gateway_node_statuses", gatewayNodeStatuses())
        }
    }

    private fun publicProject(project: Project): JsonObject = buildJsonObject {
        put("project_id", project.id)
        put("project_name", project.name)
        put("cwd", project.cwd)
        put("provider", project.provider)
        project.model?.let { put("model", it) }
        project.reasoningEffort?.let { put("reasoning_effort", it) }
        put("permission_mode", project.permissionMode)
        put("default_extensions", project.defaultExtensions)
        put("extension_defaults_revision", project.extensionDefaultsRevision)
        put(
            "capabilities",
            projectCapabilities[project.id]?.value
                ?: defaultCapabilities(project.installedExtensions),
        )
    }

    private fun mergedNativeClientReleases(): JsonArray = projectCapabilities.values.fold(
        JsonArray(emptyList()),
    ) { releases, capabilities ->
        mergeNativeClientReleases(releases, capabilities.clientReleases)
    }

    private fun gatewayNodeStatuses(): JsonObject {
        val gateways = workspaceGatewayDirectory
            ?.requiredObject("directory")
            ?.get("gateways") as? JsonArray
            ?: return JsonObject(emptyMap())
        return buildJsonObject {
            gateways.forEach { element ->
                val gateway = element as? JsonObject
                    ?: throw IllegalArgumentException(
                        "Workspace Gateway Directory entry is invalid.",
                    )
                val gatewayNodeId = gateway.requiredString("gatewayNodeId", 256)
                val routes = gateway["projects"] as? JsonArray ?: JsonArray(emptyList())
                val latest = routes.mapNotNull { route ->
                    val projectId = (route as? JsonObject)
                        ?.requiredString("projectId", 256)
                        ?: throw IllegalArgumentException(
                            "Workspace Gateway Directory project route is invalid.",
                        )
                    gatewayUpdateObservationsByProject[projectId]
                }.maxByOrNull(GatewayUpdateObservation::observedAt) ?: return@forEach
                put(gatewayNodeId, buildJsonObject {
                    put("version", 1)
                    put("gatewayNodeId", gatewayNodeId)
                    put("observedAt", latest.observedAt)
                    put("update", latest.status)
                })
            }
        }
    }

    @Synchronized
    fun threadRootEventId(sessionId: String): String? = sessions[sessionId]
        ?.takeIf { it.lifecycle != "deleted" }
        ?.threadRootEventId
        ?.takeIf { it.isNotBlank() }

    @Synchronized
    fun projectId(sessionId: String): String? = sessions[sessionId]
        ?.takeIf { it.lifecycle != "deleted" }
        ?.projectId
        ?.takeIf { it.isNotBlank() }

    @Synchronized
    fun sessionReadReceiptTargets(
        singleRoomFallback: String? = null,
    ): List<MatrixMlp3SessionReadReceiptTarget> {
        val projectRooms = linkedMapOf<String, String>()
        workspaceGatewayDirectory?.requiredObject("directory")?.let { directory ->
            val gateways = directory["gateways"] as? JsonArray ?: JsonArray(emptyList())
            gateways.forEach { gatewayElement ->
                val projects = (gatewayElement as? JsonObject)?.get("projects") as? JsonArray
                    ?: return@forEach
                projects.forEach { projectElement ->
                    val project = projectElement as? JsonObject ?: return@forEach
                    projectRooms[project.requiredString("projectId", 256)] =
                        project.requiredString("roomId", 512)
                }
            }
        }
        if (projectRooms.isEmpty() && singleRoomFallback != null) {
            sessions.values.map(Session::projectId).distinct().singleOrNull()?.let { projectId ->
                projectRooms[projectId] = singleRoomFallback
            }
        }
        return sessions.values.mapNotNull { session ->
            val roomId = projectRooms[session.projectId]
            val eventId = session.readReceiptEventId
            if (
                session.lifecycle == "deleted" ||
                roomId == null ||
                eventId == null ||
                session.threadRootEventId.isBlank()
            ) return@mapNotNull null
            MatrixMlp3SessionReadReceiptTarget(
                sessionId = session.id,
                projectId = session.projectId,
                roomId = roomId,
                threadRootEventId = session.threadRootEventId,
                eventId = eventId,
                updatedAt = session.updatedAt,
            )
        }
    }

    @Synchronized
    fun sessionReadReceiptTarget(
        sessionId: String,
        projectId: String? = null,
        singleRoomFallback: String? = null,
    ): MatrixMlp3SessionReadReceiptTarget? = sessionReadReceiptTargets(singleRoomFallback).singleOrNull {
        it.sessionId == sessionId && (projectId == null || it.projectId == projectId)
    }

    @Synchronized
    fun providerHistoryRoomIds(): Set<String> = sessions.values.mapNotNull { session ->
        session.providerHistory?.requiredString("roomId", 512)
    }.toSet()

    @Synchronized
    fun providerHistoryRoomBindings(): List<Triple<String, String, String>> = sessions.values
        .mapNotNull { session ->
            session.providerHistory?.let { binding ->
                Triple(
                    session.id,
                    session.projectId,
                    binding.requiredString("roomId", 512),
                )
            }
        }

    @Synchronized
    fun providerHistory(sessionId: String): JsonObject? = sessions[sessionId]
        ?.providerHistory

    @Synchronized
    fun providerHistoryHasMore(sessionId: String): Boolean = sessions[sessionId]
        ?.providerHistory
        ?.let { binding ->
            providerHistoryPageStates[sessionId]
                ?.takeIf { it.snapshotId == binding.requiredString("snapshotId", 256) }
                ?.hasMore
                ?: true
        }
        ?: false

    private fun providerHistoryPartKey(part: ProviderHistoryMessagePart): String =
        "${part.sessionId}\u0000${part.snapshotId}\u0000${part.sourceOrdinal}\u0000${part.partIndex}"

    private fun providerHistoryPageKey(
        sessionId: String,
        snapshotId: String,
        pageIndex: Long,
    ): String = "$sessionId\u0000$snapshotId\u0000$pageIndex"

    private fun materializeCommittedProviderHistoryPage(
        sessionId: String,
        snapshotId: String,
        pageIndex: Long,
    ): List<ClientMessage> {
        val commitKey = providerHistoryPageKey(sessionId, snapshotId, pageIndex)
        val commit = providerHistoryPageCommits[commitKey] ?: return emptyList()
        val parts = providerHistoryMessageParts.values.filter {
            it.sessionId == sessionId &&
                it.snapshotId == snapshotId &&
                it.pageIndex == pageIndex
        }
        val grouped = parts.groupBy(ProviderHistoryMessagePart::sourceOrdinal)
        require(grouped.size.toLong() <= commit.messageCount) {
            "The Provider History page contains too many source messages."
        }
        if (grouped.size.toLong() < commit.messageCount) return emptyList()
        val orderedGroups = grouped.entries.sortedBy { it.key }
        for ((_, sourceParts) in orderedGroups) {
            val expectedPartCount = sourceParts.first().partCount
            require(sourceParts.size <= expectedPartCount) {
                "The Provider History source message contains too many parts."
            }
            if (sourceParts.size < expectedPartCount) return emptyList()
        }
        val messages = orderedGroups.map { (sourceOrdinal, sourceParts) ->
            val ordered = sourceParts.sortedBy(ProviderHistoryMessagePart::partIndex)
            val first = ordered.first()
            require(ordered.map(ProviderHistoryMessagePart::partIndex) == ordered.indices.toList()) {
                "The Provider History source message has a missing part."
            }
            require(ordered.all {
                it.sourceMessageId == first.sourceMessageId &&
                    it.role == first.role &&
                    it.partCount == first.partCount
            }) { "The Provider History source message parts disagree." }
            val body = ordered.joinToString(separator = "", transform = ProviderHistoryMessagePart::body)
            val semantic = buildJsonObject {
                put("type", "provider.history.message")
                put("snapshotId", snapshotId)
                put("sourceMessageId", first.sourceMessageId)
                put("sourceOrdinal", sourceOrdinal)
                put("role", first.role)
                put("body", body)
                put("pageIndex", pageIndex)
                put("providerHistoryOrder", sourceOrdinal * 2 + 1)
            }
            ClientMessage(
                eventId = "provider-history:$sessionId:$snapshotId:$sourceOrdinal",
                sender = if (first.role == "user") "provider-history-user" else gatewayId(),
                timestamp = ordered.minOf(ProviderHistoryMessagePart::occurredAt),
                encrypted = true,
                kind = if (first.role == "user") {
                    ClientMessageKind.USER
                } else {
                    ClientMessageKind.AGENT
                },
                format = ClientMessageFormat.MARKDOWN,
                text = body,
                sessionId = sessionId,
                historical = true,
                semantic = semantic,
            )
        }
        providerHistoryMessageParts.entries.removeAll { (_, part) ->
            part.sessionId == sessionId &&
                part.snapshotId == snapshotId &&
                part.pageIndex == pageIndex
        }
        providerHistoryPageCommits.remove(commitKey)
        return messages
    }

    @Synchronized
    fun sessionLifecycle(sessionId: String): String? = sessions[sessionId]?.lifecycle

    @Synchronized
    fun activeSessionTailRecoveryTargets(
        limit: Int,
    ): List<MatrixMlp3SessionTailRecoveryTarget> {
        require(limit in 1..MAX_SESSION_TAIL_RECOVERY_TARGETS)
        return sessions.values
            .asSequence()
            .filter {
                it.lifecycle == "active" &&
                    it.activity in ACTIVE_SESSION_ACTIVITIES &&
                    it.threadRootEventId.isNotEmpty() &&
                    it.activeTurnId != null
            }
            .sortedWith(compareByDescending<Session> { it.updatedAt }.thenBy { it.id })
            .take(limit)
            .map { session ->
                MatrixMlp3SessionTailRecoveryTarget(
                    sessionId = session.id,
                    projectId = session.projectId,
                    threadRootEventId = session.threadRootEventId,
                    activeTurnId = requireNotNull(session.activeTurnId),
                    stateVersion = session.stateVersion,
                )
            }
            .toList()
    }

    /**
     * Repairs a stale active session from one independently verified Matrix
     * thread terminal. This deliberately projects only the monotonic session
     * state and terminal command result: transcript pagination owns message
     * materialization and must not be triggered for every session at startup.
     */
    @Synchronized
    fun reconcileSessionTerminal(
        event: JsonObject,
        threadRootHint: String,
        expectedSessionId: String,
        expectedTurnId: String,
        physicalEventId: String? = null,
    ): MatrixMlp3NativeProjectionResult {
        val sessionId = event.requiredString("sessionId", 256)
        require(sessionId == expectedSessionId)
        val payload = event.requiredObject("payload")
        val type = payload.requiredString("type", 128)
        require(type == "turn.completed" || type == "turn.failed")
        require(payload.requiredString("turnId", 256) == expectedTurnId)
        val incomingVersion = payload.requiredObject("projection")
            .requiredPositiveLong("stateVersion")
        val current = sessions[sessionId] ?: return MatrixMlp3NativeProjectionResult()
        if (incomingVersion < current.stateVersion) return MatrixMlp3NativeProjectionResult()

        applySessionProjection(
            sessionId = sessionId,
            projectId = event.optionalString("projectId", 256),
            projection = payload.requiredObject("projection"),
            physicalEventId = physicalEventId,
            threadRootHint = threadRootHint,
        )
        observeActiveTurn(
            type = type,
            sessionId = sessionId,
            causationCommandId = event.optionalString("causationCommandId", 256),
            payload = payload,
        )
        val changed = sessions[sessionId] != current
        return MatrixMlp3NativeProjectionResult(
            terminal = terminal(
                type = type,
                event = event,
                payload = payload,
                commandId = event.optionalString("causationCommandId", 256),
                sessionId = sessionId,
            ),
            changed = changed,
        )
    }

    @Synchronized
    fun workspaceGatewayDirectoryRevision(): Long = workspaceGatewayDirectory
        ?.requiredObject("directory")
        ?.requiredLong("revision")
        ?: 0

    @Synchronized
    fun workspaceGatewayDirectory(): JsonObject? = workspaceGatewayDirectory

    @Synchronized
    fun projectedProjectIds(): Set<String> = projects.keys.toSet()

    @Synchronized
    fun projectedWorkspaceCapabilityProjectIds(): Set<String> = projectCapabilities.keys.toSet()

    /** Null means no authoritative multi-Gateway directory has been projected yet. */
    @Synchronized
    fun workspaceHasProject(projectId: String): Boolean? {
        val directory = workspaceGatewayDirectory?.requiredObject("directory") ?: return null
        val gateways = directory["gateways"] as? JsonArray
            ?: throw IllegalArgumentException("Workspace Gateway Directory gateways are invalid.")
        return gateways.any { gateway ->
            val projects = (gateway as? JsonObject)?.get("projects") as? JsonArray
                ?: throw IllegalArgumentException("Workspace Gateway Directory entry is invalid.")
            projects.any { project ->
                (project as? JsonObject)?.requiredString("projectId", 256) == projectId
            }
        }
    }

    @Synchronized
    fun pendingGatewayEnrollments(): JsonArray = mergedPendingGatewayEnrollments()

    private fun mergedPendingGatewayEnrollments(): JsonArray {
        val byEnrollmentId = linkedMapOf<String, JsonObject>()
        workspacePendingGatewayEnrollmentsByProject.values.forEach { pending ->
            pending.forEach { element ->
                val enrollment = element as JsonObject
                byEnrollmentId.putIfAbsent(
                    enrollment.requiredString("enrollmentId", 512),
                    enrollment,
                )
            }
        }
        return JsonArray(byEnrollmentId.values.sortedBy { it.requiredLong("requestedAt") })
    }

    @Synchronized
    fun applyWorkspaceGatewayDirectory(signed: JsonObject): Boolean {
        val revision = signed.requiredObject("directory").requiredLong("revision")
        require(revision >= 0)
        val currentRevision = workspaceGatewayDirectoryRevision()
        if (revision < currentRevision) return false
        if (revision == currentRevision && workspaceGatewayDirectory != null) {
            require(workspaceGatewayDirectory == signed) {
                "Workspace Gateway Directory revision is immutable."
            }
            return false
        }
        workspaceGatewayDirectory = signed
        return true
    }

    @Synchronized
    fun retainProjects(projectIds: Set<String>) {
        projects.keys.retainAll(projectIds)
        projectCapabilities.keys.retainAll(projectIds)
        workspacePendingGatewayEnrollmentsByProject.keys.retainAll(projectIds + "__legacy__")
        gatewayUpdateObservationsByProject.keys.retainAll(projectIds)
        sessions.entries.removeAll { it.value.projectId !in projectIds }
        val retainedSessionIds = sessions.keys
        taskNotificationPreviews.entries.removeAll { it.value.sessionId !in retainedSessionIds }
    }

    @Synchronized
    fun clear() {
        projects.clear()
        projectCapabilities.clear()
        workspaceGatewayDirectory = null
        workspacePendingGatewayEnrollmentsByProject.clear()
        gatewayUpdateStatus = null
        gatewayUpdateObservationsByProject.clear()
        sessions.clear()
        inboxFiles.clear()
        seenEvents.clear()
        seenCommands.clear()
        assistantMessageVersions.clear()
        taskNotificationPreviews.clear()
    }

    @Synchronized
    fun durableState(): JsonObject = durableProjection().value

    /**
     * The projection is a rebuildable Matrix materialized view, not an
     * authority. Keep its encrypted checkpoint bounded and normalize repeated
     * per-session arrays so a large thread directory cannot poison event
     * processing merely by crossing the cache file's safety limit.
     */
    @Synchronized
    fun durableProjection(
        targetBytes: Int = DEFAULT_DURABLE_TARGET_BYTES,
    ): MatrixMlp3DurableProjection {
        require(targetBytes in MIN_DURABLE_TARGET_BYTES..MAX_DURABLE_TARGET_BYTES) {
            "The MLP/3 durable projection target is invalid."
        }
        var last: MatrixMlp3DurableProjection? = null
        for (policy in DURABLE_RETENTION_POLICIES) {
            val candidate = encodeDurableProjection(policy)
            last = candidate
            if (candidate.encodedBytes <= targetBytes) return candidate
        }
        return requireNotNull(last)
    }

    private fun encodeDurableProjection(
        policy: DurableRetentionPolicy,
    ): MatrixMlp3DurableProjection {
        val retainedSessions = sessions.values
            .sortedWith(
                compareByDescending<Session> { it.lifecycle == "active" }
                    .thenByDescending { it.activity in ACTIVE_SESSION_ACTIVITIES }
                    .thenByDescending(Session::updatedAt)
                    .thenBy(Session::id),
            )
            .take(policy.sessionLimit)
        val extensionCatalog = linkedMapOf<JsonArray, Int>()
        val availableCommandCatalog = linkedMapOf<JsonArray, Int>()
        retainedSessions.forEach { session ->
            extensionCatalog.getOrPut(session.extensions) { extensionCatalog.size }
            availableCommandCatalog.getOrPut(session.availableCommands) {
                availableCommandCatalog.size
            }
        }
        val retainedSeenEvents = seenEvents.toList().takeLast(policy.seenEventLimit)
        val retainedSeenCommands = seenCommands.toList().takeLast(policy.seenCommandLimit)
        val retainedAssistantVersions = assistantMessageVersions.entries
            .toList()
            .takeLast(policy.assistantVersionLimit)
        val retainedSessionIds = retainedSessions.mapTo(mutableSetOf(), Session::id)
        val retainedTaskNotificationPreviews = taskNotificationPreviews.values
            .filter { it.sessionId in retainedSessionIds }
            .takeLast(MAX_TASK_NOTIFICATION_PREVIEWS)
        val value = buildJsonObject {
            put("schemaVersion", 18)
            put("projectCapabilities", buildJsonArray {
                projectCapabilities.entries.sortedBy { it.key }.forEach { (projectId, capabilities) ->
                    add(buildJsonObject {
                        put("projectId", projectId)
                        put("snapshotVersion", capabilities.snapshotVersion)
                        put("value", capabilities.value)
                        put("clientReleases", capabilities.clientReleases)
                    })
                }
            })
            put("workspaceGatewayDirectory", workspaceGatewayDirectory ?: JsonNull)
            put("workspacePendingGatewayEnrollmentsByProject", buildJsonObject {
                workspacePendingGatewayEnrollmentsByProject.entries.sortedBy { it.key }
                    .forEach { (projectId, enrollments) -> put(projectId, enrollments) }
            })
            put("gatewayUpdateStatus", gatewayUpdateStatus ?: JsonNull)
            put("gatewayUpdateObservationsByProject", buildJsonObject {
                gatewayUpdateObservationsByProject.entries.sortedBy { it.key }
                    .forEach { (projectId, observation) ->
                    put(projectId, buildJsonObject {
                        put("observedAt", observation.observedAt)
                        put("status", observation.status)
                    })
                }
            })
            put("projects", buildJsonArray {
                projects.values.sortedBy(Project::id).forEach { activeProject ->
                    add(buildJsonObject {
                        put("id", activeProject.id)
                        put("snapshotVersion", activeProject.snapshotVersion)
                        put("name", activeProject.name)
                        put("cwd", activeProject.cwd)
                        put("provider", activeProject.provider)
                        activeProject.model?.let { put("model", it) }
                        activeProject.reasoningEffort?.let { put("reasoningEffort", it) }
                        put("permissionMode", activeProject.permissionMode)
                        put("installedExtensions", activeProject.installedExtensions)
                        put("defaultExtensions", activeProject.defaultExtensions)
                        put("extensionDefaultsRevision", activeProject.extensionDefaultsRevision)
                    })
                }
            })
            put("sessions", buildJsonArray {
                retainedSessions.forEach { session ->
                    add(buildJsonObject {
                        put("id", session.id)
                        put("projectId", session.projectId)
                        put("threadRootEventId", session.threadRootEventId)
                        session.readReceiptEventId?.let { put("readReceiptEventId", it) }
                        put("title", session.title)
                        put("scope", session.scope)
                        put("cwd", session.cwd)
                        put("lifecycle", session.lifecycle)
                        put("activity", session.activity)
                        put("updatedAt", session.updatedAt)
                        put("stateVersion", session.stateVersion)
                        session.provider?.let { put("provider", it) }
                        session.model?.let { put("model", it) }
                        session.reasoningEffort?.let { put("reasoningEffort", it) }
                        session.permissionMode?.let { put("permissionMode", it) }
                        put("extensionsRef", extensionCatalog.getValue(session.extensions))
                        put("extensionRevision", session.extensionRevision)
                        put(
                            "availableCommandsRef",
                            availableCommandCatalog.getValue(session.availableCommands),
                        )
                        session.providerHistory?.let { put("providerHistory", it) }
                        session.activeTurnId?.let { put("activeTurnId", it) }
                    })
                }
            })
            put("sessionArrayCatalogs", buildJsonObject {
                put("extensions", JsonArray(extensionCatalog.keys.toList()))
                put("availableCommands", JsonArray(availableCommandCatalog.keys.toList()))
            })
            put("inboxFiles", buildJsonArray {
                inboxFiles.values.forEach { file ->
                    add(buildJsonObject {
                        put("id", file.id)
                        put("receivedAt", file.receivedAt)
                        file.caption?.let { put("caption", it) }
                        file.sourceLabel?.let { put("sourceLabel", it) }
                        put("attachment", file.attachment)
                    })
                }
            })
            put("seenEvents", JsonArray(retainedSeenEvents.map(::JsonPrimitive)))
            put("seenCommands", JsonArray(retainedSeenCommands.map(::JsonPrimitive)))
            put("assistantMessageVersions", buildJsonArray {
                retainedAssistantVersions.forEach { (key, version) ->
                    add(buildJsonObject {
                        put("sessionId", key.sessionId)
                        put("messageId", key.messageId)
                        put("partIndex", key.partIndex)
                        put("version", version)
                    })
                }
            })
            put("taskNotificationPreviews", buildJsonArray {
                retainedTaskNotificationPreviews.forEach { preview ->
                    add(buildJsonObject {
                        put("sessionId", preview.sessionId)
                        put("commandId", preview.commandId)
                        put("messageId", preview.messageId)
                        put("messageVersion", preview.messageVersion)
                        put("occurredAt", preview.occurredAt)
                        put("body", preview.body)
                    })
                }
            })
            put("providerHistoryPageStates", buildJsonObject {
                providerHistoryPageStates.entries.sortedBy { it.key }
                    .forEach { (sessionId, state) ->
                        put(sessionId, buildJsonObject {
                            put("snapshotId", state.snapshotId)
                            put("frontier", state.frontier)
                            put("hasMore", state.hasMore)
                        })
                    }
            })
            put("providerHistoryMessageParts", buildJsonArray {
                providerHistoryMessageParts.values
                    .filter { it.sessionId in retainedSessionIds }
                    .sortedWith(compareBy(
                        ProviderHistoryMessagePart::sessionId,
                        ProviderHistoryMessagePart::snapshotId,
                        ProviderHistoryMessagePart::pageIndex,
                        ProviderHistoryMessagePart::sourceOrdinal,
                        ProviderHistoryMessagePart::partIndex,
                    ))
                    .forEach { part ->
                        add(buildJsonObject {
                            put("sessionId", part.sessionId)
                            put("snapshotId", part.snapshotId)
                            put("sourceMessageId", part.sourceMessageId)
                            put("sourceOrdinal", part.sourceOrdinal)
                            put("role", part.role)
                            put("body", part.body)
                            put("pageIndex", part.pageIndex)
                            put("partIndex", part.partIndex)
                            put("partCount", part.partCount)
                            put("occurredAt", part.occurredAt)
                        })
                    }
            })
            put("providerHistoryPageCommits", buildJsonArray {
                providerHistoryPageCommits.values
                    .filter { it.sessionId in retainedSessionIds }
                    .sortedWith(compareBy(
                        ProviderHistoryPageCommit::sessionId,
                        ProviderHistoryPageCommit::snapshotId,
                        ProviderHistoryPageCommit::pageIndex,
                    ))
                    .forEach { commit ->
                        add(buildJsonObject {
                            put("sessionId", commit.sessionId)
                            put("snapshotId", commit.snapshotId)
                            put("pageIndex", commit.pageIndex)
                            put("previousFrontier", commit.previousFrontier)
                            put("frontier", commit.frontier)
                            put("messageCount", commit.messageCount)
                            put("hasMore", commit.hasMore)
                            put("digest", commit.digest)
                        })
                    }
            })
        }
        val encoded = CanonicalJson.bytes(value)
        val encodedBytes = try {
            encoded.size
        } finally {
            encoded.fill(0)
        }
        return MatrixMlp3DurableProjection(
            value = value,
            encodedBytes = encodedBytes,
            totalSessions = sessions.size,
            retainedSessions = retainedSessions.size,
            totalSeenEvents = seenEvents.size,
            retainedSeenEvents = retainedSeenEvents.size,
            totalSeenCommands = seenCommands.size,
            retainedSeenCommands = retainedSeenCommands.size,
            totalAssistantVersions = assistantMessageVersions.size,
            retainedAssistantVersions = retainedAssistantVersions.size,
        )
    }

    private fun restore(value: JsonObject) {
        val schemaVersion = value.requiredLong("schemaVersion")
        require(schemaVersion in 1L..18L)
        val legacyWorkspaceCapabilities = if (schemaVersion == 1L || schemaVersion >= 9L) {
            null
        } else {
            (value["workspaceCapabilities"] as? JsonObject)?.let {
                val capabilities = it.requiredObject("value")
                validateCapabilities(capabilities)
                val clientReleases = if (schemaVersion >= 6L) {
                    it["clientReleases"] as? JsonArray
                        ?: throw IllegalArgumentException("The native release projection is invalid.")
                } else {
                    JsonArray(emptyList())
                }
                val mergedClientReleases = mergeNativeClientReleases(
                    JsonArray(emptyList()),
                    clientReleases,
                )
                WorkspaceCapabilities(
                    snapshotVersion = it.requiredPositiveLong("snapshotVersion"),
                    value = capabilities,
                    clientReleases = mergedClientReleases,
                )
            }
        }
        if (schemaVersion >= 9L) {
            val restoredCapabilities = value["projectCapabilities"] as? JsonArray
                ?: throw IllegalArgumentException("The MLP/3 project capabilities are invalid.")
            require(restoredCapabilities.size <= 256)
            restoredCapabilities.forEach { element ->
                val entry = element as? JsonObject
                    ?: throw IllegalArgumentException("The MLP/3 project capabilities are invalid.")
                val projectId = entry.requiredString("projectId", 256)
                val capabilities = entry.requiredObject("value")
                validateCapabilities(capabilities)
                val clientReleases = entry["clientReleases"] as? JsonArray
                    ?: throw IllegalArgumentException("The native release projection is invalid.")
                val restored = WorkspaceCapabilities(
                    snapshotVersion = entry.requiredPositiveLong("snapshotVersion"),
                    value = capabilities,
                    clientReleases = mergeNativeClientReleases(
                        JsonArray(emptyList()),
                        clientReleases,
                    ),
                )
                require(projectCapabilities.put(projectId, restored) == null) {
                    "The MLP/3 project capabilities are duplicated."
                }
            }
        }
        workspaceGatewayDirectory = if (schemaVersion >= 8L) {
            value["workspaceGatewayDirectory"] as? JsonObject
        } else {
            null
        }
        if (schemaVersion >= 11L) {
            val pendingByProject = value["workspacePendingGatewayEnrollmentsByProject"] as? JsonObject
                ?: throw IllegalArgumentException("The Gateway enrollment projection is invalid.")
            require(pendingByProject.size <= 256)
            pendingByProject.entries.forEach { (projectId, value) ->
                require(projectId.isNotBlank() && projectId.length <= 256)
                val pending = value as? JsonArray
                    ?: throw IllegalArgumentException("The Gateway enrollment projection is invalid.")
                validatePendingGatewayEnrollments(pending)
                workspacePendingGatewayEnrollmentsByProject[projectId] = pending
            }
        } else if (schemaVersion >= 10L) {
            val pending = value["workspacePendingGatewayEnrollments"] as? JsonArray
                ?: throw IllegalArgumentException("The Gateway enrollment projection is invalid.")
            validatePendingGatewayEnrollments(pending)
            if (pending.isNotEmpty()) {
                workspacePendingGatewayEnrollmentsByProject["__legacy__"] = pending
            }
        }
        gatewayUpdateStatus = if (schemaVersion >= 12L) {
            (value["gatewayUpdateStatus"] as? JsonObject)?.also(::validateGatewayUpdateStatus)
        } else {
            null
        }
        if (schemaVersion >= 14L) {
            val observations = value.requiredObject("gatewayUpdateObservationsByProject")
            require(observations.size <= 256)
            observations.entries.forEach { (projectId, element) ->
                require(projectId.isNotBlank() && projectId.length <= 256)
                val observation = element as? JsonObject
                    ?: throw IllegalArgumentException("The Gateway update observation is invalid.")
                observation.requireKeys(
                    setOf("observedAt", "status"),
                    emptySet(),
                    "Gateway update observation",
                )
                val status = observation.requiredObject("status")
                validateGatewayUpdateStatus(status)
                gatewayUpdateObservationsByProject[projectId] = GatewayUpdateObservation(
                    observation.requiredLong("observedAt").also { require(it >= 0) },
                    status,
                )
            }
        }
        val restoredProjects = if (schemaVersion >= 7L) {
            value["projects"] as? JsonArray
                ?: throw IllegalArgumentException("The MLP/3 project projection is invalid.")
        } else {
            JsonArray(listOfNotNull(value["project"] as? JsonObject))
        }
        require(restoredProjects.size <= 256)
        restoredProjects.forEach { element ->
            val it = element as? JsonObject
                ?: throw IllegalArgumentException("The MLP/3 project projection is invalid.")
            val restored = Project(
                id = it.requiredString("id", 256),
                snapshotVersion = it.requiredPositiveLong("snapshotVersion"),
                name = it.requiredString("name", 256),
                cwd = it.requiredString("cwd", 8_192),
                provider = it.requiredString("provider", 256),
                model = it.optionalString("model", 256),
                reasoningEffort = it.optionalString("reasoningEffort", 64),
                permissionMode = it.requiredString("permissionMode", 128),
                installedExtensions = it["installedExtensions"] as? JsonArray
                    ?: JsonArray(emptyList()),
                defaultExtensions = it["defaultExtensions"] as? JsonArray
                    ?: JsonArray(emptyList()),
                extensionDefaultsRevision = it.optionalLong("extensionDefaultsRevision")
                    ?.takeIf { version -> version > 0 }
                    ?: 1,
            )
            require(projects.put(restored.id, restored) == null) {
                "The MLP/3 project projection is duplicated."
            }
        }
        if (legacyWorkspaceCapabilities != null) {
            projects.keys.firstOrNull()?.let { projectId ->
                projectCapabilities[projectId] = legacyWorkspaceCapabilities
            }
        }
        require(projectCapabilities.keys.all(projects::containsKey)) {
            "The MLP/3 project capabilities name an unknown project."
        }
        require(gatewayUpdateObservationsByProject.keys.all(projects::containsKey)) {
            "The Gateway update observations name an unknown project."
        }
        val restoredSessions = value["sessions"] as? JsonArray
            ?: throw IllegalArgumentException("The MLP/3 session projection is invalid.")
        require(restoredSessions.size <= 20_000)
        val sessionArrayCatalogs = if (schemaVersion >= 13L) {
            value.requiredObject("sessionArrayCatalogs")
        } else {
            null
        }
        val extensionCatalog = sessionArrayCatalogs
            ?.requiredArray("extensions", MAX_DURABLE_SESSIONS)
        val availableCommandCatalog = sessionArrayCatalogs
            ?.requiredArray("availableCommands", MAX_DURABLE_SESSIONS)
        extensionCatalog?.forEach {
            require(it is JsonArray) { "The MLP/3 session extension catalog is invalid." }
        }
        availableCommandCatalog?.forEach {
            require(it is JsonArray) { "The MLP/3 session command catalog is invalid." }
        }
        restoredSessions.forEach { item ->
            val session = item as? JsonObject
                ?: throw IllegalArgumentException("The MLP/3 session projection is invalid.")
            val id = session.requiredString("id", 256)
            sessions[id] = Session(
                id = id,
                projectId = session.requiredString("projectId", 256),
                threadRootEventId = session.optionalString("threadRootEventId", 512).orEmpty(),
                readReceiptEventId = if (schemaVersion >= 18L) {
                    session.optionalString("readReceiptEventId", 512)
                } else {
                    null
                },
                title = session.requiredString("title", 512),
                scope = session.optionalString("scope", 32)?.also {
                    require(it == "project" || it == "scratch")
                } ?: "project",
                cwd = session.optionalString("cwd", 8_192)
                    ?: projects[session.requiredString("projectId", 256)]?.cwd.orEmpty(),
                lifecycle = session.requiredOneOf("lifecycle", setOf("active", "archived", "deleted")),
                activity = session.requiredOneOf(
                    "activity",
                    setOf("idle", "queued", "working", "attention", "failed"),
                ),
                updatedAt = session.requiredLong("updatedAt"),
                stateVersion = session.requiredPositiveLong("stateVersion"),
                provider = session.optionalString("provider", 256),
                model = session.optionalString("model", 256),
                reasoningEffort = session.optionalString("reasoningEffort", 64),
                permissionMode = session.optionalString("permissionMode", 128),
                extensions = if (schemaVersion >= 13L) {
                    extensionCatalog.requiredCatalogArray(
                        session.requiredLong("extensionsRef"),
                        "session extension",
                    )
                } else {
                    session["extensions"] as? JsonArray ?: JsonArray(emptyList())
                },
                extensionRevision = session.optionalLong("extensionRevision")
                    ?.takeIf { it > 0 }
                    ?: 1,
                availableCommands = if (schemaVersion >= 13L) {
                    availableCommandCatalog.requiredCatalogArray(
                        session.requiredLong("availableCommandsRef"),
                        "session command",
                    )
                } else {
                    session["availableCommands"] as? JsonArray ?: JsonArray(emptyList())
                },
                providerHistory = if (schemaVersion >= 15L) {
                    decodeProviderHistory(session["providerHistory"])
                } else {
                    null
                },
                activeTurnId = if (schemaVersion >= 4L) {
                    session.optionalString("activeTurnId", 256)
                } else {
                    null
                },
            )
        }
        if (schemaVersion >= 15L) {
            val restoredProviderHistory = value.requiredObject("providerHistoryPageStates")
            require(restoredProviderHistory.size <= 20_000)
            restoredProviderHistory.entries.forEach { (sessionId, element) ->
                require(sessionId in sessions)
                val state = element as? JsonObject
                    ?: throw IllegalArgumentException("The Provider History page state is invalid.")
                state.requireKeys(
                    setOf("snapshotId", "frontier", "hasMore"),
                    emptySet(),
                    "Provider History page state",
                )
                val snapshotId = state.requiredString("snapshotId", 256)
                require(sessions[sessionId]?.providerHistory
                    ?.requiredString("snapshotId", 256) == snapshotId)
                providerHistoryPageStates[sessionId] = ProviderHistoryPageState(
                    snapshotId = snapshotId,
                    frontier = state.requiredLong("frontier").also { require(it >= 0) },
                    hasMore = state.requiredBoolean("hasMore"),
                )
            }
        }
        if (schemaVersion >= 16L) {
            value.requiredArray("providerHistoryMessageParts", 10_000).forEach { element ->
                val item = element as? JsonObject
                    ?: throw IllegalArgumentException("A Provider History message part is invalid.")
                item.requireKeys(
                    setOf(
                        "sessionId",
                        "snapshotId",
                        "sourceMessageId",
                        "sourceOrdinal",
                        "role",
                        "body",
                        "pageIndex",
                        "partIndex",
                        "partCount",
                        "occurredAt",
                    ),
                    emptySet(),
                    "Provider History message part",
                )
                val part = ProviderHistoryMessagePart(
                    sessionId = item.requiredString("sessionId", 256),
                    snapshotId = item.requiredString("snapshotId", 256),
                    sourceMessageId = item.requiredString("sourceMessageId", 256),
                    sourceOrdinal = item.requiredLong("sourceOrdinal").also { require(it >= 0) },
                    role = item.requiredOneOf("role", setOf("user", "assistant")),
                    body = requireNotNull(item.optionalString("body", 16 * 1024)) {
                        "The Provider History message body is missing."
                    },
                    pageIndex = item.requiredLong("pageIndex").also { require(it >= 0) },
                    partIndex = item.requiredLong("partIndex")
                        .also { require(it in 0..Int.MAX_VALUE.toLong()) }
                        .toInt(),
                    partCount = item.requiredLong("partCount")
                        .also { require(it in 1..Int.MAX_VALUE.toLong()) }
                        .toInt(),
                    occurredAt = item.requiredLong("occurredAt").also { require(it >= 0) },
                )
                require(part.partIndex < part.partCount)
                require(sessions[part.sessionId]?.providerHistory
                    ?.requiredString("snapshotId", 256) == part.snapshotId)
                require(providerHistoryMessageParts.put(providerHistoryPartKey(part), part) == null) {
                    "A Provider History message part is duplicated."
                }
            }
            value.requiredArray("providerHistoryPageCommits", 10_000).forEach { element ->
                val item = element as? JsonObject
                    ?: throw IllegalArgumentException("A Provider History page commit is invalid.")
                item.requireKeys(
                    setOf(
                        "sessionId",
                        "snapshotId",
                        "pageIndex",
                        "previousFrontier",
                        "frontier",
                        "messageCount",
                        "hasMore",
                        "digest",
                    ),
                    emptySet(),
                    "Provider History page commit",
                )
                val previousFrontier = item.requiredLong("previousFrontier")
                    .also { require(it >= 0) }
                val commit = ProviderHistoryPageCommit(
                    sessionId = item.requiredString("sessionId", 256),
                    snapshotId = item.requiredString("snapshotId", 256),
                    pageIndex = item.requiredLong("pageIndex").also { require(it >= 0) },
                    previousFrontier = previousFrontier,
                    frontier = item.requiredLong("frontier")
                        .also { require(it >= previousFrontier) },
                    messageCount = item.requiredLong("messageCount").also { require(it >= 0) },
                    hasMore = item.requiredBoolean("hasMore"),
                    digest = item.requiredString("digest", 43),
                )
                require(sessions[commit.sessionId]?.providerHistory
                    ?.requiredString("snapshotId", 256) == commit.snapshotId)
                require(providerHistoryPageCommits.put(
                    providerHistoryPageKey(commit.sessionId, commit.snapshotId, commit.pageIndex),
                    commit,
                ) == null) { "A Provider History page commit is duplicated." }
            }
        }
        if (schemaVersion >= 3L) {
            val restoredInbox = value["inboxFiles"] as? JsonArray
                ?: throw IllegalArgumentException("The MLP/3 inbox projection is invalid.")
            require(restoredInbox.size <= 100_000)
            restoredInbox.forEach { item ->
                val file = item as? JsonObject
                    ?: throw IllegalArgumentException("The MLP/3 inbox projection is invalid.")
                val id = file.requiredString("id", 256)
                val attachment = file.requiredObject("attachment")
                PublicClientJson.decodeAttachment(attachment)
                inboxFiles[id] = InboxFile(
                    id = id,
                    receivedAt = file.requiredLong("receivedAt"),
                    caption = file.optionalString("caption", 8_192),
                    sourceLabel = file.optionalString("sourceLabel", 256),
                    attachment = attachment,
                )
            }
        }
        (value["seenEvents"] as? JsonArray).orEmpty().takeLast(MAX_SEEN_IDS).forEach {
            seenEvents += it.jsonPrimitive.content
        }
        (value["seenCommands"] as? JsonArray).orEmpty().takeLast(MAX_SEEN_IDS).forEach {
            seenCommands += it.jsonPrimitive.content
        }
        if (schemaVersion >= 5L) {
            (value["assistantMessageVersions"] as? JsonArray)
                .orEmpty()
                .takeLast(MAX_SEEN_IDS)
                .forEach { item ->
                    val entry = item as? JsonObject
                        ?: throw IllegalArgumentException("The MLP/3 assistant version projection is invalid.")
                    val key = AssistantMessageKey(
                        sessionId = entry.requiredString("sessionId", 256),
                        messageId = entry.requiredString("messageId", 256),
                        partIndex = entry.requiredLong("partIndex").also { require(it in 0..Int.MAX_VALUE) }.toInt(),
                    )
                    assistantMessageVersions[key] = entry.requiredPositiveLong("version")
                }
        }
        if (schemaVersion >= 17L) {
            value.requiredArray(
                "taskNotificationPreviews",
                MAX_TASK_NOTIFICATION_PREVIEWS,
            ).forEach { element ->
                val item = element as? JsonObject
                    ?: throw IllegalArgumentException("A task notification preview is invalid.")
                item.requireKeys(
                    setOf(
                        "sessionId",
                        "commandId",
                        "messageId",
                        "messageVersion",
                        "occurredAt",
                        "body",
                    ),
                    emptySet(),
                    "Task notification preview",
                )
                val preview = TaskNotificationPreview(
                    sessionId = item.requiredString("sessionId", 256),
                    commandId = item.requiredString("commandId", 256),
                    messageId = item.requiredString("messageId", 256),
                    messageVersion = item.requiredPositiveLong("messageVersion"),
                    occurredAt = item.requiredLong("occurredAt").also { require(it >= 0) },
                    body = item.requiredString("body", MAX_NOTIFICATION_BODY_CHARS),
                )
                require(preview.sessionId in sessions)
                require(taskNotificationPreviews.put(
                    taskNotificationPreviewKey(preview.sessionId, preview.commandId),
                    preview,
                ) == null) { "A task notification preview is duplicated." }
            }
        }
    }

    private companion object {
        const val MAX_SEEN_IDS = 10_000
        const val MAX_DURABLE_SESSIONS = 4_000
        const val MAX_SESSION_TAIL_RECOVERY_TARGETS = 128
        const val MAX_TASK_NOTIFICATION_PREVIEWS = 128
        const val MAX_NOTIFICATION_BODY_CHARS = 2_048
        const val DEFAULT_DURABLE_TARGET_BYTES = 6 * 1024 * 1024
        const val MIN_DURABLE_TARGET_BYTES = 256 * 1024
        const val MAX_DURABLE_TARGET_BYTES = 8 * 1024 * 1024
        val ACTIVE_SESSION_ACTIVITIES = setOf("queued", "working", "attention")
        val DURABLE_RETENTION_POLICIES = listOf(
            DurableRetentionPolicy(MAX_DURABLE_SESSIONS, MAX_SEEN_IDS, MAX_SEEN_IDS, MAX_SEEN_IDS),
            DurableRetentionPolicy(2_000, 4_096, 4_096, 4_096),
            DurableRetentionPolicy(1_000, 2_048, 2_048, 2_048),
            DurableRetentionPolicy(256, 512, 512, 512),
            DurableRetentionPolicy(64, 128, 128, 128),
        )
    }

    private data class DurableRetentionPolicy(
        val sessionLimit: Int,
        val seenEventLimit: Int,
        val seenCommandLimit: Int,
        val assistantVersionLimit: Int,
    )

    private fun mergeNativeClientReleases(current: JsonArray, incoming: JsonArray): JsonArray {
        require(incoming.size <= 8)
        val releases = linkedMapOf<String, JsonObject>()
        current.forEach { item ->
            val release = item as? JsonObject
                ?: throw IllegalArgumentException("The native release projection is invalid.")
            releases[nativeClientReleaseKey(release)] = release
        }
        var changed = false
        incoming.forEach { item ->
            val release = item as? JsonObject
                ?: throw IllegalArgumentException("The native release projection is invalid.")
            require(release.toString().toByteArray().size <= 16 * 1024)
            require(release["artifact"] is JsonObject)
            val key = nativeClientReleaseKey(release)
            val version = release.requiredPositiveLong("versionCode")
            val existing = releases[key]
            val existingVersion = existing?.requiredPositiveLong("versionCode")
            when {
                existing == null || version > existingVersion!! -> {
                    releases[key] = release
                    changed = true
                }
                version == existingVersion && release != existing ->
                    throw IllegalArgumentException(
                        "Native client release $key/$version is immutable.",
                    )
            }
        }
        if (!changed) return current
        return JsonArray(releases.toSortedMap().values.toList())
    }

    private fun nativeClientReleaseKey(release: JsonObject): String {
        val platform = release.requiredString("platform", 32)
        require(platform == "android")
        val channel = release.requiredString("channel", 32)
        val architecture = release.requiredString("architecture", 32)
        return "$platform\u0000$channel\u0000$architecture"
    }

    private fun applySessionProjection(
        sessionId: String,
        projectId: String?,
        projection: JsonObject,
        physicalEventId: String?,
        threadRootHint: String?,
    ) {
        val nextVersion = projection.requiredPositiveLong("stateVersion")
        val current = sessions[sessionId]
        val nextUpdatedAt = projection.requiredLong("updatedAt")
        if (
            current != null &&
            (current.stateVersion > nextVersion ||
                (current.stateVersion == nextVersion && current.updatedAt > nextUpdatedAt))
        ) return
        sessions[sessionId] = decodeSession(
            sessionId,
            projectId ?: current?.projectId.orEmpty(),
            current?.threadRootEventId.orEmpty().ifEmpty { threadRootHint.orEmpty() },
            projection,
            current?.provider,
            current?.model,
            current?.reasoningEffort,
            current?.permissionMode,
        ).copy(readReceiptEventId = physicalEventId ?: current?.readReceiptEventId)
    }

    private fun decodeSession(
        sessionId: String,
        projectId: String,
        threadRootEventId: String,
        projection: JsonObject,
        provider: String?,
        model: String?,
        reasoningEffort: String?,
        permissionMode: String?,
    ): Session = Session(
        id = sessionId,
        projectId = projectId,
        threadRootEventId = threadRootEventId,
        readReceiptEventId = sessions[sessionId]?.readReceiptEventId,
        title = projection.requiredString("title", 512),
        scope = projection.optionalString("scope", 32)?.also {
            require(it == "project" || it == "scratch")
        } ?: sessions[sessionId]?.scope ?: "project",
        cwd = projection.optionalString("cwd", 8_192)
            ?: sessions[sessionId]?.cwd
            ?: projects[projectId]?.cwd.orEmpty(),
        lifecycle = projection.requiredOneOf("lifecycle", setOf("active", "archived", "deleted")),
        activity = projection.requiredOneOf(
            "activity",
            setOf("idle", "queued", "working", "attention", "failed"),
        ),
        updatedAt = projection.requiredLong("updatedAt"),
        stateVersion = projection.requiredPositiveLong("stateVersion"),
        provider = provider,
        model = model,
        reasoningEffort = reasoningEffort,
        permissionMode = permissionMode,
        extensions = projection["extensions"] as? JsonArray
            ?: sessions[sessionId]?.extensions
            ?: JsonArray(emptyList()),
        extensionRevision = projection.optionalLong("extensionRevision")
            ?.takeIf { it > 0 }
            ?: sessions[sessionId]?.extensionRevision
            ?: 1,
        availableCommands = projection["availableCommands"] as? JsonArray
            ?: sessions[sessionId]?.availableCommands
            ?: JsonArray(emptyList()),
        providerHistory = decodeProviderHistory(projection["providerHistory"]),
        activeTurnId = sessions[sessionId]?.activeTurnId,
    )

    private fun decodeProviderHistory(value: JsonElement?): JsonObject? {
        if (value == null || value is JsonNull) return null
        val binding = value as? JsonObject
            ?: throw IllegalArgumentException("The Provider History room binding is invalid.")
        binding.requireKeys(
            setOf("roomId", "snapshotId", "ordering"),
            emptySet(),
            "Provider History room binding",
        )
        binding.requiredString("roomId", 512)
        binding.requiredString("snapshotId", 256)
        require(binding.requiredString("ordering", 64) == "reverse_append_v1")
        return binding
    }

    private fun observeActiveTurn(
        type: String,
        sessionId: String?,
        causationCommandId: String?,
        payload: JsonObject,
    ) {
        sessionId ?: return
        val current = sessions[sessionId] ?: return
        if (type == "turn.completed" || type == "turn.failed") {
            val turnId = payload.requiredString("turnId", 256)
            if (current.activeTurnId == turnId) {
                sessions[sessionId] = current.copy(activeTurnId = null)
            }
            return
        }

        val eventProjection = payload["projection"] as? JsonObject ?: return
        if (eventProjection.requiredPositiveLong("stateVersion") != current.stateVersion) return
        if (current.activity !in setOf("queued", "working", "attention")) return
        val turnId = when (type) {
            "turn.queued", "turn.started" -> payload.requiredString("turnId", 256)
            "assistant.message", "tool.activity", "decision.requested",
            "extension.interaction.requested" -> causationCommandId
            else -> null
        }
        if (turnId != null && (current.activeTurnId == null || current.activeTurnId == turnId)) {
            sessions[sessionId] = current.copy(activeTurnId = turnId)
        }
    }

    private fun terminal(
        type: String,
        event: JsonObject,
        payload: JsonObject,
        commandId: String?,
        sessionId: String?,
    ): MatrixMlp3NativeTerminal? {
        commandId ?: return null
        return when (type) {
            "assistant.message" -> {
                val ui = payload["ui"] as? JsonObject
                if (ui?.optionalString("kind", 128) != "artifact_materialization") {
                    null
                } else {
                    require(ui.requiredLong("version") == 1L)
                    val status = ui.requiredString("status", 32)
                    require(status == "materialized" || status == "changed")
                    val referenceId = ui.requiredString("referenceId", 256)
                    val hasReference = (payload["artifactReferences"] as? JsonArray)
                        ?.any { item ->
                            (item as? JsonObject)?.get("id")?.jsonPrimitive?.contentOrNull == referenceId
                        } == true
                    require(hasReference)
                    val hasAttachment = (payload["attachments"] as? JsonArray)
                        ?.any { item ->
                            (item as? JsonObject)?.get("id")?.jsonPrimitive?.contentOrNull == referenceId
                        } == true
                    require((status == "materialized") == hasAttachment)
                    MatrixMlp3NativeTerminal(
                        commandId,
                        "succeeded",
                        sessionId,
                        result = buildJsonObject {
                            put("status", status)
                            put("referenceId", referenceId)
                        },
                    )
                }
            }
            "session.ready", "session.updated", "session.lifecycle", "decision.resolved",
            "extension.interaction.resolved", "project.snapshot", "project.deleted",
            "notification.subscription.changed" ->
                MatrixMlp3NativeTerminal(commandId, "succeeded", sessionId)
            "provider.sessions.listed", "provider.session.inspected", "provider.history.materialized" ->
                MatrixMlp3NativeTerminal(commandId, "succeeded", sessionId, result = payload)
            "project.created" ->
                MatrixMlp3NativeTerminal(commandId, "succeeded", sessionId, result = payload)
            "turn.completed" -> MatrixMlp3NativeTerminal(
                commandId,
                if (payload.requiredString("outcome", 32) == "cancelled") "cancelled" else "succeeded",
                sessionId,
            )
            "turn.failed" -> MatrixMlp3NativeTerminal(
                commandId,
                "failed",
                sessionId,
                errorCode = payload.requiredString("code", 128),
                errorMessage = payload.requiredString("message", 8_192),
            )
            "command.rejected" -> MatrixMlp3NativeTerminal(
                commandId,
                "failed",
                sessionId,
                errorCode = payload.requiredString("code", 128),
                errorMessage = payload.requiredString("message", 8_192),
                retryable = payload.requiredBoolean("retryable"),
            )
            "command.reconciled" -> {
                require(payload.requiredString("commandId", 256) == commandId)
                payload.requiredLong("acceptedAt")
                payload.optionalLong("dispatchedAt")
                val state = payload.requiredOneOf(
                    "state",
                    setOf("accepted", "running", "terminal"),
                )
                if (state != "terminal") {
                    null
                } else {
                    payload.optionalLong("terminalAt")
                    val outcome = payload.requiredOneOf(
                        "outcome",
                        setOf("succeeded", "failed", "cancelled", "rejected", "interrupted"),
                    )
                    val error = payload["error"] as? JsonObject
                    if (outcome in setOf("failed", "rejected", "interrupted")) {
                        requireNotNull(error) {
                            "A failed reconciled command requires an error."
                        }
                    } else {
                        require(error == null) {
                            "A successful reconciled command cannot include an error."
                        }
                    }
                    MatrixMlp3NativeTerminal(
                        commandId = commandId,
                        outcome = when (outcome) {
                            "succeeded", "cancelled" -> outcome
                            else -> "failed"
                        },
                        sessionId = sessionId,
                        result = payload["result"],
                        errorCode = error?.requiredString("code", 128),
                        errorMessage = error?.requiredString("message", 8_192),
                        retryable = error?.requiredBoolean("retryable") ?: false,
                    )
                }
            }
            "device.invitation.created" -> MatrixMlp3NativeTerminal(
                commandId,
                "succeeded",
                sessionId,
                result = buildJsonObject {
                    put("pairingLink", payload.requiredString("pairingLink", 128 * 1024))
                    put("expiresAt", payload.requiredLong("expiresAt"))
                },
            )
            "gateway.enrollment.invitation.created" -> MatrixMlp3NativeTerminal(
                commandId,
                "succeeded",
                sessionId,
                result = buildJsonObject {
                    put("enrollmentLink", payload.requiredString("enrollmentLink", 128 * 1024))
                    put("expiresAt", payload.requiredLong("expiresAt"))
                },
            )
            "gateway.enrollment.approved" -> MatrixMlp3NativeTerminal(
                commandId,
                "succeeded",
                sessionId,
                result = buildJsonObject {
                    put("gatewayNodeId", payload.requiredString("gatewayNodeId", 512))
                    put("gatewayName", payload.requiredString("gatewayName", 128))
                },
            )
            "gateway.enrollment.cancelled" -> MatrixMlp3NativeTerminal(
                commandId,
                "succeeded",
                sessionId,
                result = buildJsonObject {
                    put("gatewayNodeId", payload.requiredString("gatewayNodeId", 512))
                    put("gatewayName", payload.requiredString("gatewayName", 128))
                },
            )
            "gateway.profile.updated" -> MatrixMlp3NativeTerminal(
                commandId,
                "succeeded",
                sessionId,
                result = buildJsonObject {
                    put("gatewayNodeId", payload.requiredString("gatewayNodeId", 512))
                    put("gatewayName", payload.requiredString("gatewayName", 128))
                    put("computerName", payload.requiredString("computerName", 128))
                },
            )
            "gateway.retired" -> MatrixMlp3NativeTerminal(
                commandId,
                "succeeded",
                sessionId,
                result = buildJsonObject {
                    put("gatewayNodeId", payload.requiredString("gatewayNodeId", 512))
                    val removedProjectCount = payload.requiredLong("removedProjectCount")
                    require(removedProjectCount in 0..256) {
                        "Gateway retirement project count is invalid."
                    }
                    put("removedProjectCount", removedProjectCount)
                    val directoryRevision = payload.requiredLong("directoryRevision")
                    require(directoryRevision >= 0) { "Gateway directory revision is invalid." }
                    put("directoryRevision", directoryRevision)
                },
            )
            "gateway.update.status" -> payload.requiredObject("status")
                .takeUnless { it.requiredString("phase", 64) == "waiting_for_idle" }
                ?.let { status ->
                    MatrixMlp3NativeTerminal(
                        commandId,
                        "succeeded",
                        sessionId,
                        result = status,
                    )
                }
            "gateway.restart.status" -> payload.requiredObject("status")
                .takeUnless { it.requiredString("phase", 64) == "waiting_for_idle" }
                ?.let { status ->
                    MatrixMlp3NativeTerminal(
                        commandId,
                        "succeeded",
                        sessionId,
                        result = status,
                    )
                }
            else -> null
        }
    }

    private fun taskNotification(
        type: String,
        eventId: String,
        payload: JsonObject,
        commandId: String?,
        sessionId: String?,
    ): MatrixMlp3TaskNotification? {
        commandId ?: return null
        val previewKey = sessionId?.let { taskNotificationPreviewKey(it, commandId) }
        val finalPreview = if (type == "turn.completed" || type == "turn.failed") {
            previewKey?.let(taskNotificationPreviews::remove)
        } else {
            null
        }
        return when (type) {
            "turn.completed" -> {
                val outcome = if (payload.requiredString("outcome", 32) == "cancelled") {
                    "cancelled"
                } else {
                    "succeeded"
                }
                MatrixMlp3TaskNotification(
                    eventId = eventId,
                    commandId = commandId,
                    outcome = outcome,
                    sessionId = sessionId,
                    body = finalPreview?.body?.takeUnless { outcome == "cancelled" },
                )
            }
            "turn.failed" -> MatrixMlp3TaskNotification(
                eventId = eventId,
                commandId = commandId,
                outcome = "failed",
                sessionId = sessionId,
                body = compactTaskNotificationBody(payload.requiredString("message", 8_192)),
            )
            else -> null
        }
    }

    private fun rememberTaskNotificationPreview(
        payload: JsonObject,
        sessionId: String,
        commandId: String?,
        messageId: String,
        messageVersion: Long,
        occurredAt: Long,
        eligible: Boolean,
    ) {
        commandId ?: return
        if (!eligible || payload["ui"] != null) return
        if (payload["final"]?.jsonPrimitive?.booleanOrNull != true) return
        if ((payload.optionalInt("partIndex") ?: 0) != 0) return
        val body = compactTaskNotificationBody(
            payload.optionalString("body", Int.MAX_VALUE).orEmpty(),
        ) ?: return
        val preview = TaskNotificationPreview(
            sessionId = sessionId,
            commandId = commandId,
            messageId = messageId,
            messageVersion = messageVersion,
            occurredAt = occurredAt,
            body = body,
        )
        val key = taskNotificationPreviewKey(sessionId, commandId)
        val current = taskNotificationPreviews[key]
        val newer = current == null || compareValuesBy(
            preview,
            current,
            TaskNotificationPreview::occurredAt,
            TaskNotificationPreview::messageId,
            TaskNotificationPreview::messageVersion,
        ) > 0
        if (!newer) return
        taskNotificationPreviews.remove(key)
        taskNotificationPreviews[key] = preview
        while (taskNotificationPreviews.size > MAX_TASK_NOTIFICATION_PREVIEWS) {
            taskNotificationPreviews.remove(taskNotificationPreviews.keys.first())
        }
    }

    private fun taskNotificationPreviewKey(sessionId: String, commandId: String): String =
        "$sessionId\u0000$commandId"

    private fun compactTaskNotificationBody(value: String): String? {
        val normalized = value.replace("\r\n", "\n").replace('\r', '\n').trim()
        if (normalized.isEmpty()) return null
        return if (normalized.length > MAX_NOTIFICATION_BODY_CHARS) {
            var endExclusive = MAX_NOTIFICATION_BODY_CHARS - 1
            if (
                Character.isHighSurrogate(normalized[endExclusive - 1]) &&
                Character.isLowSurrogate(normalized[endExclusive])
            ) {
                endExclusive -= 1
            }
            "${normalized.take(endExclusive).trimEnd()}…"
        } else {
            normalized
        }
    }

    private fun validateGatewayUpdateStatus(value: JsonObject) {
        value.requireKeys(
            setOf("version", "phase", "updatedAt"),
            setOf(
                "updateId",
                "releaseId",
                "targetBuildId",
                "currentBuildId",
                "previousReleaseId",
                "activationMode",
                "detail",
                "maintenanceSessionId",
                "activeTurns",
            ),
            "Gateway update status",
        )
        require(value.requiredLong("version") == 1L)
        require(value.requiredString("phase", 64) in setOf(
            "idle",
            "staging",
            "agent_required",
            "agent_running",
            "agent_validating",
            "staged",
            "waiting_for_idle",
            "scheduled",
            "activating",
            "probation",
            "committed",
            "rolled_back",
            "failed",
            "repair_required",
        ))
        value.optionalString("activationMode", 32)?.let { mode ->
            require(mode == "rollback-safe" || mode == "forward-only")
        }
        value.optionalString("updateId", 256)
        value.optionalString("releaseId", 128)
        value.optionalString("targetBuildId", 256)
        value.optionalString("currentBuildId", 256)
        value.optionalString("previousReleaseId", 128)
        value.optionalString("detail", 4_096)
        value.optionalString("maintenanceSessionId", 256)
        require(value.requiredLong("updatedAt") >= 0)
        value.optionalLong("activeTurns")?.let { require(it >= 0) }
    }

    private fun validateGatewayRestartStatus(value: JsonObject) {
        value.requireKeys(
            setOf("version", "phase", "updatedAt"),
            setOf(
                "restartId",
                "mode",
                "requestedAt",
                "scheduledAt",
                "startedAt",
                "completedAt",
                "activeTurns",
                "detail",
            ),
            "Gateway restart status",
        )
        require(value.requiredLong("version") == 1L)
        require(value.requiredString("phase", 64) in setOf(
            "idle",
            "waiting_for_idle",
            "scheduled",
            "restarting",
            "ready",
            "failed",
        ))
        value.optionalString("restartId", 256)
        value.optionalString("mode", 32)?.let { mode ->
            require(mode == "when_idle" || mode == "force")
        }
        value.optionalLong("requestedAt")?.let { require(it >= 0) }
        value.optionalLong("scheduledAt")?.let { require(it >= 0) }
        value.optionalLong("startedAt")?.let { require(it >= 0) }
        value.optionalLong("completedAt")?.let { require(it >= 0) }
        value.optionalLong("activeTurns")?.let { require(it >= 0) }
        value.optionalString("detail", 4_096)
    }

    private fun userMessage(
        commandId: String,
        sessionId: String,
        physicalEventId: String,
        timestamp: Long,
        text: String,
        originDeviceId: String?,
        semantic: JsonObject,
    ) = ClientMessage(
        eventId = "user:$commandId",
        sender = originDeviceId ?: gatewayId(),
        timestamp = timestamp,
        encrypted = true,
        kind = ClientMessageKind.USER,
        format = ClientMessageFormat.MARKDOWN,
        text = text,
        sessionId = sessionId,
        commandId = commandId,
        originDeviceId = originDeviceId,
        semantic = JsonObject(semantic + ("physicalEventId" to JsonPrimitive(physicalEventId))),
    )

    private fun publicSession(session: Session, project: Project): JsonObject = buildJsonObject {
        put("id", session.id)
        put("title", session.title)
        put("updated_at", session.updatedAt)
        put("state_version", session.stateVersion)
        put("status", when (session.activity) {
            "queued", "working", "attention" -> "running"
            "failed" -> "failed"
            else -> "idle"
        })
        if (session.lifecycle == "archived") put("archived", true)
        put("activity_phase", when (session.activity) {
            "queued" -> "starting"
            "working", "attention" -> "working"
            "failed" -> "failed"
            else -> "idle"
        })
        put("project_id", session.projectId.ifEmpty { project.id })
        put("project_name", if (session.scope == "scratch") "Temporary" else project.name)
        put("scope", session.scope)
        put("cwd", session.cwd.ifEmpty { project.cwd })
        put("provider", session.provider ?: project.provider)
        (session.model ?: project.model)?.let { put("model", it) }
        (session.reasoningEffort ?: project.reasoningEffort)?.let { put("reasoning_effort", it) }
        session.activeTurnId?.let { put("active_turn_id", it) }
        put("extensions", session.extensions)
        put("available_commands", session.availableCommands)
        session.providerHistory?.let { binding ->
            val page = providerHistoryPageStates[session.id]
                ?.takeIf { it.snapshotId == binding.requiredString("snapshotId", 256) }
            put("provider_history", buildJsonObject {
                put("room_id", binding.requiredString("roomId", 512))
                put("snapshot_id", binding.requiredString("snapshotId", 256))
                put("ordering", binding.requiredString("ordering", 64))
                put("frontier", page?.frontier ?: 0)
                put("has_more", page?.hasMore ?: true)
            })
        }
    }

    private fun validateCapabilities(value: JsonObject) {
        fun validateModels(models: JsonArray, label: String) {
            models.forEach { item ->
                val model = item as? JsonObject
                    ?: throw IllegalArgumentException("A MLP/3 model capability must be an object.")
                model.requireKeys(
                    setOf("id", "name"),
                    setOf("default_reasoning_level", "supported_reasoning_levels"),
                    "MLP/3 model capability",
                )
                model.requiredString("id", 256)
                model.requiredString("name", 256)
                model.optionalString("default_reasoning_level", 64)
                model.optionalArray("supported_reasoning_levels", 64).orEmpty().forEach { levelValue ->
                    val level = levelValue as? JsonObject
                        ?: throw IllegalArgumentException("A MLP/3 reasoning capability must be an object.")
                    level.requireKeys(
                        setOf("effort"),
                        setOf("description"),
                        "MLP/3 reasoning capability",
                    )
                    level.requiredString("effort", 64)
                    level.optionalString("description", 4_096)
                }
            }
            requireUniqueIds(models, label)
        }

        value.requireKeys(
            setOf(
                "models",
                "permission_modes",
                "can_create_session",
                "can_select_session",
                "can_archive_session",
                "can_delete_session",
                "session_extensions",
            ),
            setOf("web_push", "providers"),
            "MLP/3 capabilities",
        )
        val models = value.requiredArray("models", 256)
        validateModels(models, "MLP/3 model capabilities")

        val providers = value.optionalArray("providers", 64) ?: JsonArray(emptyList())
        providers.forEach { item ->
            val provider = item as? JsonObject
                ?: throw IllegalArgumentException("A MLP/3 provider capability must be an object.")
            provider.requireKeys(
                setOf("id", "name", "models", "can_list_sessions", "can_inspect_sessions"),
                setOf("can_materialize_history"),
                "MLP/3 provider capability",
            )
            provider.requiredString("id", 256)
            provider.requiredString("name", 256)
            validateModels(
                provider.requiredArray("models", 256),
                "MLP/3 provider model capabilities",
            )
            provider.requiredBoolean("can_list_sessions")
            provider.requiredBoolean("can_inspect_sessions")
            if (provider["can_materialize_history"] != null) {
                provider.requiredBoolean("can_materialize_history")
            }
        }
        requireUniqueIds(providers, "MLP/3 provider capabilities")

        val permissionModes = value.requiredArray("permission_modes", 128)
        permissionModes.forEach { item ->
            val mode = item as? JsonObject
                ?: throw IllegalArgumentException("A MLP/3 permission capability must be an object.")
            mode.requireKeys(setOf("id", "name"), emptySet(), "MLP/3 permission capability")
            mode.requiredString("id", 256)
            mode.requiredString("name", 256)
        }
        requireUniqueIds(permissionModes, "MLP/3 permission capabilities")
        value.requiredBoolean("can_create_session")
        value.requiredBoolean("can_select_session")
        value.requiredBoolean("can_archive_session")
        value.requiredBoolean("can_delete_session")

        value["web_push"]?.let { candidate ->
            val webPush = candidate as? JsonObject
                ?: throw IllegalArgumentException("MLP/3 Web Push capability must be an object.")
            webPush.requireKeys(
                setOf("vapid_public_key"),
                emptySet(),
                "MLP/3 Web Push capability",
            )
            require(webPush.requiredString("vapid_public_key", 87)
                .matches(Regex("^[A-Za-z0-9_-]{87}$")))
        }

        val extensions = value.requiredArray("session_extensions", 128)
        extensions.forEach { item ->
            val extension = item as? JsonObject
                ?: throw IllegalArgumentException("A MLP/3 extension capability must be an object.")
            extension.requireKeys(
                setOf("id", "name", "description", "version", "settings"),
                emptySet(),
                "MLP/3 extension capability",
            )
            extension.requiredString("id", 256)
            extension.requiredString("name", 256)
            extension.requiredString("description", 4_096)
            extension.requiredString("version", 128)
            val settings = extension.requiredArray("settings", 32)
            settings.forEach { settingValue ->
                val setting = settingValue as? JsonObject
                    ?: throw IllegalArgumentException("A MLP/3 extension setting must be an object.")
                when (setting.requiredOneOf("type", setOf("text", "boolean"))) {
                    "text" -> setting.requireKeys(
                        setOf("id", "type", "label"),
                        setOf("description", "required", "placeholder", "default_value"),
                        "MLP/3 text extension setting",
                    )
                    "boolean" -> setting.requireKeys(
                        setOf("id", "type", "label"),
                        setOf("description", "default_value"),
                        "MLP/3 boolean extension setting",
                    )
                }
                setting.requiredString("id", 128)
                setting.requiredString("label", 256)
                setting.optionalString("description", 2_048)
                setting.optionalString("placeholder", 512)
                if (setting["required"] != null) setting.requiredBoolean("required")
                val defaultValue = setting["default_value"]
                if (defaultValue != null) {
                    val primitive = defaultValue as? JsonPrimitive
                        ?: throw IllegalArgumentException("A MLP/3 extension default must be scalar.")
                    if (setting.requiredString("type", 16) == "text") {
                        require(primitive.isString && primitive.content.length <= 4_096)
                    } else {
                        require(!primitive.isString && primitive.content in setOf("true", "false"))
                    }
                }
            }
            requireUniqueIds(settings, "MLP/3 extension settings")
        }
        requireUniqueIds(extensions, "MLP/3 extension capabilities")
    }

    private fun defaultCapabilities(
        installedExtensions: JsonArray = JsonArray(emptyList()),
    ): JsonObject = buildJsonObject {
        put("models", JsonArray(emptyList()))
        put("providers", JsonArray(emptyList()))
        put("permission_modes", buildJsonArray {
            add(buildJsonObject { put("id", "default"); put("name", "Default") })
        })
        put("can_create_session", true)
        put("can_select_session", false)
        put("can_archive_session", true)
        put("can_delete_session", false)
        put("session_extensions", installedExtensions)
    }

    private fun titleFromPrompt(text: String): String {
        val title = text.replace(Regex("\\s+"), " ").trim()
        if (title.isEmpty()) return "New session"
        return if (title.length <= 64) title else title.take(61) + "..."
    }
}

/**
 * Validates the semantic projection shape before NativeClientRuntime consumes
 * the rebuildable cache. The encrypted blob store can only validate that the
 * payload is JSON; format-level incompatibilities must be handled while the
 * state upgrade coordinator can still discard and rebuild this cache.
 */
internal fun validateMatrixMlp3ProjectionState(value: JsonObject) {
    MatrixMlp3NativeProjection(
        gatewayId = { "validation-gateway" },
        activeDeviceCount = { 1 },
        initialState = value,
    )
}

private fun decodeMlp3ToolGroup(payload: JsonObject): ToolGroupPresentation? {
    val ui = payload["ui"] ?: return null
    return runCatching { PublicClientJson.decodeToolGroup(ui) }.getOrNull()
}

private fun toolActivityGroup(payload: JsonObject, occurredAt: Long): ToolGroupPresentation {
    val toolCallId = payload.requiredString("toolCallId", 256)
    val name = payload.requiredString("name", 256)
    val phase = ToolPhase.fromWire(payload.requiredString("phase", 64))
    return ToolGroupPresentation(
        groupId = toolCallId,
        tools = listOf(ToolPresentationItem(
            id = toolCallId,
            name = name,
            title = name,
            category = ToolCategory.UNKNOWN,
            phase = phase,
            isError = phase == ToolPhase.FAILED,
            startedAt = occurredAt,
            updatedAt = occurredAt,
        )),
    )
}

private fun JsonObject.requiredObject(key: String): JsonObject = get(key) as? JsonObject
    ?: throw IllegalArgumentException("$key must be an object.")

private fun JsonObject.requiredString(key: String, maximum: Int): String {
    val primitive = get(key) as? JsonPrimitive
        ?: throw IllegalArgumentException("$key must be a string.")
    require(primitive.isString)
    return primitive.content.also { require(it.isNotEmpty() && it.length <= maximum) }
}

private fun JsonObject.optionalString(key: String, maximum: Int): String? {
    val primitive = get(key) as? JsonPrimitive ?: return null
    require(primitive.isString)
    return primitive.content.also { require(it.length <= maximum) }
}

private fun JsonObject.requiredLong(key: String): Long {
    val primitive = get(key) as? JsonPrimitive
        ?: throw IllegalArgumentException("$key must be an integer.")
    require(!primitive.isString)
    return primitive.longOrNull?.also { require(it >= 0) }
        ?: throw IllegalArgumentException("$key must be an integer.")
}

private fun JsonObject.requiredPositiveLong(key: String): Long = requiredLong(key).also {
    require(it > 0)
}

private fun JsonObject.optionalInt(key: String): Int? = get(key)?.jsonPrimitive?.intOrNull

private fun JsonObject.optionalLong(key: String): Long? {
    val primitive = get(key) as? JsonPrimitive ?: return null
    require(!primitive.isString)
    return primitive.longOrNull
}

private fun JsonObject.requiredBoolean(key: String): Boolean {
    val value = get(key)?.jsonPrimitive?.contentOrNull
    require(value == "true" || value == "false")
    return value == "true"
}

private fun JsonObject.requiredOneOf(key: String, values: Set<String>): String =
    requiredString(key, 128).also { require(it in values) }

private fun JsonObject.requiredArray(key: String, maximum: Int): JsonArray =
    (get(key) as? JsonArray
        ?: throw IllegalArgumentException("$key must be an array."))
        .also { require(it.size <= maximum) }

private fun JsonObject.optionalArray(key: String, maximum: Int): JsonArray? =
    get(key)?.let {
        (it as? JsonArray
            ?: throw IllegalArgumentException("$key must be an array."))
            .also { array -> require(array.size <= maximum) }
    }

private fun JsonArray?.requiredCatalogArray(index: Long, label: String): JsonArray {
    val catalog = this
        ?: throw IllegalArgumentException("The MLP/3 $label catalog is missing.")
    require(index >= 0 && index < catalog.size) {
        "The MLP/3 $label catalog reference is invalid."
    }
    return catalog[index.toInt()] as? JsonArray
        ?: throw IllegalArgumentException("The MLP/3 $label catalog entry is invalid.")
}

private fun JsonObject.requireKeys(
    required: Set<String>,
    optional: Set<String>,
    label: String,
) {
    require(keys.containsAll(required) && keys.all { it in required || it in optional }) {
        "$label contains unexpected or missing fields."
    }
}

private fun requireUniqueIds(values: JsonArray, label: String) {
    val ids = values.map { (it as JsonObject).requiredString("id", 256) }
    require(ids.toSet().size == ids.size) { "$label contain duplicate IDs." }
}

private fun validatePendingGatewayEnrollments(values: JsonArray) {
    require(values.size <= 32)
    val ids = values.map { element ->
        val enrollment = element as? JsonObject
            ?: throw IllegalArgumentException("A pending Gateway enrollment is invalid.")
        enrollment.requireKeys(
            required = setOf(
                "enrollmentId",
                "gatewayNodeId",
                "gatewayName",
                "verificationCode",
                "requestedAt",
                "expiresAt",
            ),
            optional = setOf("approverProjectId"),
            label = "Pending Gateway enrollment",
        )
        val requestedAt = enrollment.requiredLong("requestedAt")
        require(enrollment.requiredLong("expiresAt") > requestedAt)
        require(Regex("^\\d{3}-\\d{3}$").matches(
            enrollment.requiredString("verificationCode", 7),
        ))
        enrollment.requiredString("gatewayNodeId", 512)
        enrollment.requiredString("gatewayName", 128)
        val enrollmentId = enrollment.requiredString("enrollmentId", 512)
        enrollment.optionalString("approverProjectId", 512)
        enrollmentId
    }
    require(ids.distinct().size == ids.size)
}
