package id.my.anciety.malink.client

import id.my.anciety.malink.client.events.ClientMessage
import id.my.anciety.malink.client.events.ClientMessageFormat
import id.my.anciety.malink.client.events.ClientMessageKind
import id.my.anciety.malink.client.events.PublicClientJson
import id.my.anciety.malink.client.events.ToolCategory
import id.my.anciety.malink.client.events.ToolGroupPresentation
import id.my.anciety.malink.client.events.ToolPhase
import id.my.anciety.malink.client.events.ToolPresentationItem
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
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
    val acknowledgedCommandId: String? = null,
    val terminal: MatrixMlp3NativeTerminal? = null,
    val changed: Boolean = false,
)

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
        val activeTurnId: String? = null,
    )

    private data class InboxFile(
        val id: String,
        val receivedAt: Long,
        val caption: String?,
        val sourceLabel: String?,
        val attachment: JsonObject,
    )

    private val projects = linkedMapOf<String, Project>()
    private val projectCapabilities = linkedMapOf<String, WorkspaceCapabilities>()
    private var workspaceGatewayDirectory: JsonObject? = null
    private val workspacePendingGatewayEnrollmentsByProject = linkedMapOf<String, JsonArray>()
    private var gatewayUpdateStatus: JsonObject? = null
    private val sessions = linkedMapOf<String, Session>()
    private val inboxFiles = linkedMapOf<String, InboxFile>()
    private val seenEvents = mutableSetOf<String>()
    private val seenCommands = mutableSetOf<String>()
    private val assistantMessageVersions = linkedMapOf<AssistantMessageKey, Long>()

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
            return MatrixMlp3NativeProjectionResult(
                terminal = terminal(type, event, payload, causation, sessionId),
                changed = incomingUpdatedAt >= currentUpdatedAt,
            )
        }

        if (!seenEvents.add(eventId)) return MatrixMlp3NativeProjectionResult()

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

        if (sessionId != null && payload["projection"] is JsonObject) {
            applySessionProjection(
                sessionId,
                projectId,
                payload.requiredObject("projection"),
                threadRootHint,
            )
        }

        observeActiveTurn(type, sessionId, causation, payload)

        var messages = emptyList<ClientMessage>()
        when (type) {
            "session.ready" -> if (sessionId != null && projectId != null) {
                val projection = payload.requiredObject("projection")
                val current = sessions[sessionId]
                if (current != null && current.stateVersion > projection.requiredPositiveLong("stateVersion")) {
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
            acknowledgedCommandId = if (type in setOf("turn.queued", "turn.started")) causation else null,
            terminal = terminal(type, event, payload, causation, sessionId),
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
    fun workspaceGatewayDirectoryRevision(): Long = workspaceGatewayDirectory
        ?.requiredObject("directory")
        ?.requiredLong("revision")
        ?: 0

    @Synchronized
    fun workspaceGatewayDirectory(): JsonObject? = workspaceGatewayDirectory

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
        if (revision < currentRevision) {
            throw IllegalArgumentException("Workspace Gateway Directory rolled back.")
        }
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
        sessions.entries.removeAll { it.value.projectId !in projectIds }
    }

    @Synchronized
    fun clear() {
        projects.clear()
        projectCapabilities.clear()
        workspaceGatewayDirectory = null
        workspacePendingGatewayEnrollmentsByProject.clear()
        gatewayUpdateStatus = null
        sessions.clear()
        inboxFiles.clear()
        seenEvents.clear()
        seenCommands.clear()
        assistantMessageVersions.clear()
    }

    @Synchronized
    fun durableState(): JsonObject = buildJsonObject {
        put("schemaVersion", 12)
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
            sessions.values.forEach { session ->
                add(buildJsonObject {
                    put("id", session.id)
                    put("projectId", session.projectId)
                    put("threadRootEventId", session.threadRootEventId)
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
                    put("extensions", session.extensions)
                    put("extensionRevision", session.extensionRevision)
                    put("availableCommands", session.availableCommands)
                    session.activeTurnId?.let { put("activeTurnId", it) }
                })
            }
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
        put("seenEvents", JsonArray(seenEvents.toList().takeLast(MAX_SEEN_IDS).map(::JsonPrimitive)))
        put("seenCommands", JsonArray(seenCommands.toList().takeLast(MAX_SEEN_IDS).map(::JsonPrimitive)))
        put("assistantMessageVersions", buildJsonArray {
            assistantMessageVersions.entries.toList().takeLast(MAX_SEEN_IDS).forEach { (key, version) ->
                add(buildJsonObject {
                    put("sessionId", key.sessionId)
                    put("messageId", key.messageId)
                    put("partIndex", key.partIndex)
                    put("version", version)
                })
            }
        })
    }

    private fun restore(value: JsonObject) {
        val schemaVersion = value.requiredLong("schemaVersion")
        require(schemaVersion in 1L..12L)
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
        val restoredSessions = value["sessions"] as? JsonArray
            ?: throw IllegalArgumentException("The MLP/3 session projection is invalid.")
        require(restoredSessions.size <= 20_000)
        restoredSessions.forEach { item ->
            val session = item as? JsonObject
                ?: throw IllegalArgumentException("The MLP/3 session projection is invalid.")
            val id = session.requiredString("id", 256)
            sessions[id] = Session(
                id = id,
                projectId = session.requiredString("projectId", 256),
                threadRootEventId = session.optionalString("threadRootEventId", 512).orEmpty(),
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
                extensions = session["extensions"] as? JsonArray ?: JsonArray(emptyList()),
                extensionRevision = session.optionalLong("extensionRevision")
                    ?.takeIf { it > 0 }
                    ?: 1,
                availableCommands = session["availableCommands"] as? JsonArray
                    ?: JsonArray(emptyList()),
                activeTurnId = if (schemaVersion >= 4L) {
                    session.optionalString("activeTurnId", 256)
                } else {
                    null
                },
            )
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
    }

    private companion object {
        const val MAX_SEEN_IDS = 10_000
    }

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
        threadRootHint: String?,
    ) {
        val nextVersion = projection.requiredPositiveLong("stateVersion")
        val current = sessions[sessionId]
        if (current != null && current.stateVersion > nextVersion) return
        sessions[sessionId] = decodeSession(
            sessionId,
            projectId ?: current?.projectId.orEmpty(),
            current?.threadRootEventId.orEmpty().ifEmpty { threadRootHint.orEmpty() },
            projection,
            current?.provider,
            current?.model,
            current?.reasoningEffort,
            current?.permissionMode,
        )
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
        activeTurnId = sessions[sessionId]?.activeTurnId,
    )

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
            "session.ready", "session.updated", "session.lifecycle", "decision.resolved",
            "extension.interaction.resolved", "project.snapshot",
            "notification.subscription.changed" ->
                MatrixMlp3NativeTerminal(commandId, "succeeded", sessionId)
            "provider.sessions.listed", "provider.session.inspected" ->
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
            "gateway.update.status" -> MatrixMlp3NativeTerminal(
                commandId,
                "succeeded",
                sessionId,
                result = payload.requiredObject("status"),
            )
            else -> null
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
                "detail",
                "activeTurns",
            ),
            "Gateway update status",
        )
        require(value.requiredLong("version") == 1L)
        require(value.requiredString("phase", 64) in setOf(
            "idle",
            "staging",
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
        value.optionalString("updateId", 256)
        value.optionalString("releaseId", 128)
        value.optionalString("targetBuildId", 256)
        value.optionalString("currentBuildId", 256)
        value.optionalString("previousReleaseId", 128)
        value.optionalString("detail", 4_096)
        require(value.requiredLong("updatedAt") >= 0)
        value.optionalLong("activeTurns")?.let { require(it >= 0) }
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
                emptySet(),
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
