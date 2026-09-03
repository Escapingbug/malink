package id.my.anciety.malink.client.command

import id.my.anciety.malink.security.malink.PairingOperation
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.longOrNull

enum class CommandOperation(val wireName: String) {
    PROMPT("prompt"),
    CANCEL("cancel"),
    DECISION("decision"),
    ARTIFACT_MATERIALIZE("artifact.materialize"),
    SESSION_SETTINGS("session.settings"),
    SESSION_CREATE("session.create"),
    PROJECT_CREATE("project.create"),
    PROJECT_SETTINGS("project.settings"),
    PROJECT_DELETE("project.delete"),
    PROVIDER_SESSIONS_LIST("provider.sessions.list"),
    PROVIDER_SESSION_INSPECT("provider.session.inspect"),
    PROVIDER_HISTORY_MATERIALIZE("provider.history.materialize"),
    SESSION_ARCHIVE("session.archive"),
    SESSION_RESTORE("session.restore"),
    SESSION_DELETE("session.delete"),
    DEVICE_INVITE("device.invite"),
    GATEWAY_ENROLLMENT_INVITE("gateway.enrollment.invite"),
    GATEWAY_ENROLLMENT_APPROVE("gateway.enrollment.approve"),
    GATEWAY_PROFILE_UPDATE("gateway.profile.update"),
    GATEWAY_RETIRE("gateway.retire"),
    GATEWAY_UPDATE_STAGE("gateway.update.stage"),
    GATEWAY_UPDATE_APPLY("gateway.update.apply"),
    GATEWAY_UPDATE_STATUS("gateway.update.status"),
    ;

    companion object {
        fun fromWireName(value: String): CommandOperation = entries.firstOrNull { it.wireName == value }
            ?: throw IllegalArgumentException("Command operation is invalid.")
    }
}

sealed interface ValidatedCommandPayload {
    val operation: CommandOperation
    val sessionId: String?
}

data class EncryptedMediaPayload(
    val url: String,
    val key: String,
    val iv: String,
    val sha256: String,
    val size: Long,
) {
    override fun toString(): String =
        "EncryptedMediaPayload(url=<redacted>, key=<redacted>, iv=<redacted>, " +
            "sha256=<redacted>, size=$size)"
}

data class CommandAttachmentPayload(
    val id: String,
    val name: String,
    val mimeType: String,
    val size: Long,
    val sha256: String,
    val media: EncryptedMediaPayload,
) {
    override fun toString(): String =
        "CommandAttachmentPayload(id=$id, name=<redacted>, mimeType=$mimeType, size=$size, " +
            "sha256=<redacted>, media=$media)"
}

data class PromptCommandPayload(
    override val sessionId: String,
    val text: String,
    val attachments: List<CommandAttachmentPayload>,
) : ValidatedCommandPayload {
    override val operation = CommandOperation.PROMPT

    override fun toString(): String =
        "PromptCommandPayload(sessionId=$sessionId, text=<redacted>, attachments=$attachments)"
}

data class CancelCommandPayload(
    override val sessionId: String,
    val targetCommandId: String?,
) : ValidatedCommandPayload {
    override val operation = CommandOperation.CANCEL
}

data class DecisionCommandPayload(
    override val sessionId: String,
    val requestId: String,
    val decision: String,
    val totp: String?,
) : ValidatedCommandPayload {
    override val operation = CommandOperation.DECISION

    override fun toString(): String =
        "DecisionCommandPayload(sessionId=$sessionId, requestId=$requestId, decision=$decision, totp=<redacted>)"
}

data class ArtifactMaterializeCommandPayload(
    override val sessionId: String,
    val referenceId: String,
    val expectedStatRevision: String,
) : ValidatedCommandPayload {
    override val operation = CommandOperation.ARTIFACT_MATERIALIZE
}

enum class CommandPermissionMode(val wireName: String) {
    DEFAULT("default"),
    ACCEPT_EDITS("accept_edits"),
    PLAN("plan"),
    BYPASS_PERMISSIONS("bypass_permissions"),
    ;

    companion object {
        fun fromWireName(value: String): CommandPermissionMode = entries.firstOrNull { it.wireName == value }
            ?: throw IllegalArgumentException("Command permission mode is invalid.")
    }
}

data class SessionSettingsCommandPayload(
    override val sessionId: String,
    val model: String?,
    val reasoningEffort: String?,
    val permissionMode: CommandPermissionMode?,
    val cwd: String?,
    val projectName: String?,
) : ValidatedCommandPayload {
    override val operation = CommandOperation.SESSION_SETTINGS

    override fun toString(): String =
        "SessionSettingsCommandPayload(sessionId=$sessionId, model=$model, " +
            "reasoningEffort=$reasoningEffort, permissionMode=$permissionMode, cwd=<redacted>, " +
            "projectName=<redacted>)"
}

data class SessionCreateCommandPayload(
    val scope: String,
    val cwd: String?,
    val projectName: String?,
    val provider: String?,
    val providerSessionId: String?,
    val title: String?,
    val model: String?,
    val reasoningEffort: String?,
    val permissionMode: CommandPermissionMode?,
    val extensions: List<SessionExtensionBindingPayload>,
    val initialPrompt: String?,
) : ValidatedCommandPayload {
    override val operation = CommandOperation.SESSION_CREATE
    override val sessionId: String? = null

    override fun toString(): String =
        "SessionCreateCommandPayload(cwd=<redacted>, projectName=<redacted>, provider=$provider, " +
            "scope=$scope, model=$model, reasoningEffort=$reasoningEffort, permissionMode=$permissionMode, " +
            "extensions=${extensions.map { it.id }})"
}

data class ProjectSettingsCommandPayload(
    val name: String?,
    val model: String?,
    val reasoningEffort: String?,
    val defaultExtensions: List<SessionExtensionBindingPayload>?,
) : ValidatedCommandPayload {
    override val operation = CommandOperation.PROJECT_SETTINGS
    override val sessionId: String? = null
}

data object ProjectDeleteCommandPayload : ValidatedCommandPayload {
    override val operation = CommandOperation.PROJECT_DELETE
    override val sessionId: String? = null
}

data class ProjectCreateCommandPayload(
    val name: String,
    val cwd: String,
    val provider: String?,
    val createDirectory: Boolean?,
) : ValidatedCommandPayload {
    override val operation = CommandOperation.PROJECT_CREATE
    override val sessionId: String? = null

    override fun toString(): String =
        "ProjectCreateCommandPayload(name=<redacted>, cwd=<redacted>, provider=$provider, " +
            "createDirectory=$createDirectory)"
}

data class ProviderSessionsListCommandPayload(
    val provider: String,
    val cursor: String?,
) : ValidatedCommandPayload {
    override val operation = CommandOperation.PROVIDER_SESSIONS_LIST
    override val sessionId: String? = null
}

data class ProviderSessionInspectCommandPayload(
    val provider: String,
    val providerSessionId: String,
) : ValidatedCommandPayload {
    override val operation = CommandOperation.PROVIDER_SESSION_INSPECT
    override val sessionId: String? = null
}

data class ProviderHistoryMaterializeCommandPayload(
    override val sessionId: String,
    val expectedFrontier: Long,
    val limit: Long?,
) : ValidatedCommandPayload {
    override val operation = CommandOperation.PROVIDER_HISTORY_MATERIALIZE
}

data class SessionExtensionBindingPayload(
    val id: String,
    val config: JsonObject?,
) {
    override fun toString(): String =
        "SessionExtensionBindingPayload(id=$id, config=<redacted>)"
}

data class SessionLifecycleCommandPayload(
    override val operation: CommandOperation,
    override val sessionId: String,
) : ValidatedCommandPayload {
    init {
        require(
            operation == CommandOperation.SESSION_ARCHIVE ||
                operation == CommandOperation.SESSION_RESTORE ||
                operation == CommandOperation.SESSION_DELETE,
        ) { "Session lifecycle operation is invalid." }
    }
}

data class DeviceInviteCommandPayload(
    val lifetimeMs: Long?,
) : ValidatedCommandPayload {
    override val operation = CommandOperation.DEVICE_INVITE
    override val sessionId: String? = null
}

data class GatewayEnrollmentInviteCommandPayload(
    val lifetimeMs: Long?,
) : ValidatedCommandPayload {
    override val operation = CommandOperation.GATEWAY_ENROLLMENT_INVITE
    override val sessionId: String? = null
}

data class GatewayEnrollmentApproveCommandPayload(
    val enrollmentId: String,
) : ValidatedCommandPayload {
    override val operation = CommandOperation.GATEWAY_ENROLLMENT_APPROVE
    override val sessionId: String? = null
}

data class GatewayProfileUpdateCommandPayload(
    val gatewayNodeId: String,
    val gatewayName: String,
) : ValidatedCommandPayload {
    override val operation = CommandOperation.GATEWAY_PROFILE_UPDATE
    override val sessionId: String? = null
}

data class GatewayRetireCommandPayload(
    val gatewayNodeId: String,
    val expectedDirectoryRevision: Long,
    val expectedGatewayKeyId: String,
) : ValidatedCommandPayload {
    override val operation = CommandOperation.GATEWAY_RETIRE
    override val sessionId: String? = null
}

data class GatewayUpdateCommandPayload(
    override val operation: CommandOperation,
    val releaseId: String?,
    val mode: String?,
    val allowForwardOnly: Boolean?,
) : ValidatedCommandPayload {
    override val sessionId: String? = null

    init {
        require(
            operation == CommandOperation.GATEWAY_UPDATE_STAGE ||
                operation == CommandOperation.GATEWAY_UPDATE_APPLY ||
                operation == CommandOperation.GATEWAY_UPDATE_STATUS,
        ) { "Gateway update operation is invalid." }
    }
}

object CommandPayloadValidator {
    const val MAX_ATTACHMENT_BYTES = 50L * 1024 * 1024
    const val MAX_ATTACHMENTS = 10
    const val MAX_PROMPT_ATTACHMENT_BYTES = 100L * 1024 * 1024

    fun validate(value: JsonObject): ValidatedCommandPayload {
        val operation = CommandOperation.fromWireName(value.requiredString("operation", 128))
        return when (operation) {
            CommandOperation.PROMPT -> validatePrompt(value)
            CommandOperation.CANCEL -> validateCancel(value)
            CommandOperation.DECISION -> validateDecision(value)
            CommandOperation.ARTIFACT_MATERIALIZE -> validateArtifactMaterialize(value)
            CommandOperation.SESSION_SETTINGS -> validateSessionSettings(value)
            CommandOperation.SESSION_CREATE -> validateSessionCreate(value)
            CommandOperation.PROJECT_CREATE -> validateProjectCreate(value)
            CommandOperation.PROJECT_SETTINGS -> validateProjectSettings(value)
            CommandOperation.PROJECT_DELETE -> validateProjectDelete(value)
            CommandOperation.PROVIDER_SESSIONS_LIST -> validateProviderSessionsList(value)
            CommandOperation.PROVIDER_SESSION_INSPECT -> validateProviderSessionInspect(value)
            CommandOperation.PROVIDER_HISTORY_MATERIALIZE -> validateProviderHistoryMaterialize(value)
            CommandOperation.SESSION_ARCHIVE,
            CommandOperation.SESSION_RESTORE,
            CommandOperation.SESSION_DELETE,
            -> validateSessionLifecycle(value, operation)
            CommandOperation.DEVICE_INVITE -> validateDeviceInvite(value)
            CommandOperation.GATEWAY_ENROLLMENT_INVITE -> validateGatewayEnrollmentInvite(value)
            CommandOperation.GATEWAY_ENROLLMENT_APPROVE -> validateGatewayEnrollmentApprove(value)
            CommandOperation.GATEWAY_PROFILE_UPDATE -> validateGatewayProfileUpdate(value)
            CommandOperation.GATEWAY_RETIRE -> validateGatewayRetire(value)
            CommandOperation.GATEWAY_UPDATE_STAGE,
            CommandOperation.GATEWAY_UPDATE_APPLY,
            CommandOperation.GATEWAY_UPDATE_STATUS,
            -> validateGatewayUpdate(value, operation)
        }
    }

    private fun validatePrompt(value: JsonObject): PromptCommandPayload {
        value.requireExactKeys(
            required = setOf("operation", "sessionId", "text"),
            optional = setOf("attachments"),
        )
        val attachments = value.optionalArray("attachments")?.also {
            require(it.size <= MAX_ATTACHMENTS) { "Prompt contains too many attachments." }
        }?.map(::validateAttachment) ?: emptyList()
        val totalBytes = attachments.fold(0L) { total, attachment ->
            Math.addExact(total, attachment.size)
        }
        require(totalBytes <= MAX_PROMPT_ATTACHMENT_BYTES) {
            "Prompt attachments exceed $MAX_PROMPT_ATTACHMENT_BYTES bytes."
        }
        val text = value.requiredString("text", Int.MAX_VALUE, allowEmpty = true)
        require(text.isNotEmpty() || attachments.isNotEmpty()) {
            "A prompt requires text or at least one attachment."
        }
        return PromptCommandPayload(
            sessionId = value.requiredOpaqueId("sessionId"),
            text = text,
            attachments = attachments,
        )
    }

    private fun validateCancel(value: JsonObject): CancelCommandPayload {
        value.requireExactKeys(
            required = setOf("operation", "sessionId"),
            optional = setOf("targetCommandId"),
        )
        return CancelCommandPayload(
            sessionId = value.requiredOpaqueId("sessionId"),
            targetCommandId = value.optionalOpaqueId("targetCommandId"),
        )
    }

    private fun validateDecision(value: JsonObject): DecisionCommandPayload {
        value.requireExactKeys(
            required = setOf("operation", "sessionId", "requestId", "decision"),
            optional = setOf("totp"),
        )
        val decision = value.requiredString("decision", 32)
        require(ACTION_ID.matches(decision)) { "Command decision is invalid." }
        val totp = value.optionalBoundedString("totp", 6)
        require(totp == null || TOTP.matches(totp)) { "Command TOTP is invalid." }
        return DecisionCommandPayload(
            sessionId = value.requiredOpaqueId("sessionId"),
            requestId = value.requiredOpaqueId("requestId"),
            decision = decision,
            totp = totp,
        )
    }

    private fun validateArtifactMaterialize(value: JsonObject): ArtifactMaterializeCommandPayload {
        value.requireExactKeys(
            required = setOf("operation", "sessionId", "referenceId", "expectedStatRevision"),
        )
        return ArtifactMaterializeCommandPayload(
            sessionId = value.requiredOpaqueId("sessionId"),
            referenceId = value.requiredOpaqueId("referenceId"),
            expectedStatRevision = value.requiredOpaqueId("expectedStatRevision"),
        )
    }

    private fun validateSessionSettings(value: JsonObject): SessionSettingsCommandPayload {
        val settings = setOf("model", "reasoningEffort", "permissionMode", "cwd", "projectName")
        value.requireExactKeys(required = setOf("operation", "sessionId"), optional = settings)
        require(value.keys.any(settings::contains)) { "At least one session setting is required." }
        return SessionSettingsCommandPayload(
            sessionId = value.requiredOpaqueId("sessionId"),
            model = value.optionalBoundedString("model", 256),
            reasoningEffort = value.optionalBoundedString("reasoningEffort", 64),
            permissionMode = value.optionalString("permissionMode")?.let(CommandPermissionMode::fromWireName),
            cwd = value.optionalBoundedString("cwd", 4_096),
            projectName = value.optionalBoundedString("projectName", 256),
        )
    }

    private fun validateSessionCreate(value: JsonObject): SessionCreateCommandPayload {
        value.requireExactKeys(
            required = setOf("operation"),
            optional = setOf(
                "cwd",
                "scope",
                "projectName",
                "provider",
                "providerSessionId",
                "title",
                "model",
                "reasoningEffort",
                "permissionMode",
                "extensions",
                "initialPrompt",
            ),
        )
        val extensions = value.optionalArray("extensions")?.also {
            require(it.size <= 8) { "Session contains too many extensions." }
        }?.map(::validateSessionExtension) ?: emptyList()
        require(extensions.map { it.id }.toSet().size == extensions.size) {
            "Session extension IDs must be unique."
        }
        return SessionCreateCommandPayload(
            scope = value.optionalString("scope")?.also {
                require(it == "project" || it == "scratch") { "Session scope is invalid." }
            } ?: "project",
            cwd = value.optionalBoundedString("cwd", 4_096),
            projectName = value.optionalBoundedString("projectName", 256),
            provider = value.optionalBoundedString("provider", 256),
            providerSessionId = value.optionalOpaqueId("providerSessionId"),
            title = value.optionalBoundedString("title", 512),
            model = value.optionalBoundedString("model", 256),
            reasoningEffort = value.optionalBoundedString("reasoningEffort", 64),
            permissionMode = value.optionalString("permissionMode")?.let(CommandPermissionMode::fromWireName),
            extensions = extensions,
            initialPrompt = value.optionalBoundedString("initialPrompt", 64 * 1024),
        )
    }

    private fun validateProjectSettings(value: JsonObject): ProjectSettingsCommandPayload {
        val settings = setOf("name", "model", "reasoningEffort", "defaultExtensions")
        value.requireExactKeys(
            required = setOf("operation"),
            optional = settings,
        )
        require(value.keys.any(settings::contains)) {
            "At least one project setting is required."
        }
        val defaultExtensions = value.optionalArray("defaultExtensions")?.also {
            require(it.size <= 8) { "Project contains too many default extensions." }
        }?.map(::validateSessionExtension)?.also { extensions ->
            require(extensions.map { it.id }.toSet().size == extensions.size) {
                "Project default extension IDs must be unique."
            }
        }
        return ProjectSettingsCommandPayload(
            name = value.optionalBoundedString("name", 256)?.trim()?.also {
                require(it.isNotEmpty()) { "Project name is invalid." }
            },
            model = value.optionalNullableBoundedString("model", 256),
            reasoningEffort = value.optionalNullableBoundedString("reasoningEffort", 64),
            defaultExtensions = defaultExtensions,
        )
    }

    private fun validateProjectDelete(value: JsonObject): ProjectDeleteCommandPayload {
        value.requireExactKeys(setOf("operation"))
        return ProjectDeleteCommandPayload
    }

    private fun validateProjectCreate(value: JsonObject): ProjectCreateCommandPayload {
        value.requireExactKeys(
            required = setOf("operation", "name", "cwd"),
            optional = setOf("provider", "createDirectory"),
        )
        return ProjectCreateCommandPayload(
            name = value.requiredString("name", 256),
            cwd = value.requiredString("cwd", 4_096),
            provider = value.optionalBoundedString("provider", 256),
            createDirectory = value.optionalBoolean("createDirectory"),
        )
    }

    private fun validateProviderSessionsList(value: JsonObject): ProviderSessionsListCommandPayload {
        value.requireExactKeys(
            required = setOf("operation", "provider"),
            optional = setOf("cursor"),
        )
        return ProviderSessionsListCommandPayload(
            provider = value.requiredString("provider", 256),
            cursor = value.optionalBoundedString("cursor", 4_096),
        )
    }

    private fun validateProviderSessionInspect(value: JsonObject): ProviderSessionInspectCommandPayload {
        value.requireExactKeys(setOf("operation", "provider", "providerSessionId"))
        return ProviderSessionInspectCommandPayload(
            provider = value.requiredString("provider", 256),
            providerSessionId = value.requiredOpaqueId("providerSessionId"),
        )
    }

    private fun validateProviderHistoryMaterialize(
        value: JsonObject,
    ): ProviderHistoryMaterializeCommandPayload {
        value.requireExactKeys(
            required = setOf("operation", "sessionId", "expectedFrontier"),
            optional = setOf("limit"),
        )
        val expectedFrontier = value.requiredLong("expectedFrontier")
        val limit = value.optionalLong("limit")
        require(expectedFrontier >= 0) { "Provider History frontier is invalid." }
        require(limit == null || limit in 1..100) { "Provider History page limit is invalid." }
        return ProviderHistoryMaterializeCommandPayload(
            sessionId = value.requiredOpaqueId("sessionId"),
            expectedFrontier = expectedFrontier,
            limit = limit,
        )
    }

    private fun validateSessionExtension(element: JsonElement): SessionExtensionBindingPayload {
        val value = element.asObject("Session extension binding")
        value.requireExactKeys(required = setOf("id"), optional = setOf("config"))
        val config = if ("config" in value) {
            value.getValue("config") as? JsonObject
                ?: throw IllegalArgumentException("Session extension config must be an object.")
        } else {
            null
        }
        if (config != null) {
            require(config.size <= 32) { "Session extension config has too many settings." }
            require(config.keys.all { it.isNotEmpty() && it.length <= 128 }) {
                "Session extension config setting ID is invalid."
            }
            require(config.toString().length <= 32 * 1024) {
                "Session extension config is too large."
            }
        }
        return SessionExtensionBindingPayload(
            id = value.requiredOpaqueId("id"),
            config = config,
        )
    }

    private fun validateSessionLifecycle(
        value: JsonObject,
        operation: CommandOperation,
    ): SessionLifecycleCommandPayload {
        value.requireExactKeys(setOf("operation", "sessionId"))
        return SessionLifecycleCommandPayload(operation, value.requiredOpaqueId("sessionId"))
    }

    private fun validateDeviceInvite(value: JsonObject): DeviceInviteCommandPayload {
        value.requireExactKeys(required = setOf("operation"), optional = setOf("lifetimeMs"))
        val lifetime = value.optionalLong("lifetimeMs")
        require(lifetime == null || lifetime in 30_000..600_000) {
            "Device invitation lifetime is invalid."
        }
        return DeviceInviteCommandPayload(lifetime)
    }

    private fun validateGatewayEnrollmentInvite(value: JsonObject): GatewayEnrollmentInviteCommandPayload {
        value.requireExactKeys(required = setOf("operation"), optional = setOf("lifetimeMs"))
        val lifetime = value.optionalLong("lifetimeMs")
        require(lifetime == null || lifetime in 30_000..600_000) {
            "Gateway enrollment lifetime is invalid."
        }
        return GatewayEnrollmentInviteCommandPayload(lifetime)
    }

    private fun validateGatewayEnrollmentApprove(value: JsonObject): GatewayEnrollmentApproveCommandPayload {
        value.requireExactKeys(setOf("operation", "enrollmentId"))
        return GatewayEnrollmentApproveCommandPayload(value.requiredOpaqueId("enrollmentId"))
    }

    private fun validateGatewayProfileUpdate(value: JsonObject): GatewayProfileUpdateCommandPayload {
        value.requireExactKeys(setOf("operation", "gatewayNodeId", "gatewayName"))
        return GatewayProfileUpdateCommandPayload(
            gatewayNodeId = value.requiredOpaqueId("gatewayNodeId"),
            gatewayName = value.requiredString("gatewayName", 128).trim().also {
                require(it.isNotEmpty()) { "Gateway name is invalid." }
            },
        )
    }

    private fun validateGatewayRetire(value: JsonObject): GatewayRetireCommandPayload {
        value.requireExactKeys(
            setOf(
                "operation",
                "gatewayNodeId",
                "expectedDirectoryRevision",
                "expectedGatewayKeyId",
            ),
        )
        val expectedDirectoryRevision = value.requiredLong("expectedDirectoryRevision")
        require(expectedDirectoryRevision >= 0) { "Workspace directory revision is invalid." }
        val expectedGatewayKeyId = value.requiredString("expectedGatewayKeyId", 43)
        require(expectedGatewayKeyId.length == 43 && BASE64_URL.matches(expectedGatewayKeyId)) {
            "Gateway key ID is invalid."
        }
        return GatewayRetireCommandPayload(
            gatewayNodeId = value.requiredOpaqueId("gatewayNodeId"),
            expectedDirectoryRevision = expectedDirectoryRevision,
            expectedGatewayKeyId = expectedGatewayKeyId,
        )
    }

    private fun validateGatewayUpdate(
        value: JsonObject,
        operation: CommandOperation,
    ): GatewayUpdateCommandPayload {
        if (operation == CommandOperation.GATEWAY_UPDATE_STATUS) {
            value.requireExactKeys(setOf("operation"))
            return GatewayUpdateCommandPayload(operation, null, null, null)
        }
        value.requireExactKeys(
            required = setOf("operation", "releaseId"),
            optional = if (operation == CommandOperation.GATEWAY_UPDATE_APPLY) {
                setOf("mode", "allowForwardOnly")
            } else {
                emptySet()
            },
        )
        val releaseId = value.requiredString("releaseId", 128)
        require(RELEASE_ID.matches(releaseId)) { "Gateway release ID is invalid." }
        val mode = value.optionalBoundedString("mode", 32)
        require(mode == null || mode == "when_idle" || mode == "force") {
            "Gateway update mode is invalid."
        }
        val allowForwardOnly = value.optionalBoolean("allowForwardOnly")
        require(allowForwardOnly == null || allowForwardOnly) {
            "Gateway forward-only confirmation must be true when present."
        }
        return GatewayUpdateCommandPayload(operation, releaseId, mode, allowForwardOnly)
    }

    private fun validateAttachment(element: JsonElement): CommandAttachmentPayload {
        val value = element.asObject("Command attachment")
        value.requireExactKeys(setOf("id", "name", "mimeType", "size", "sha256", "media"))
        val size = value.requiredLong("size")
        require(size in 0..MAX_ATTACHMENT_BYTES) { "Command attachment size is invalid." }
        return CommandAttachmentPayload(
            id = value.requiredOpaqueId("id"),
            name = value.requiredString("name", 1_024),
            mimeType = value.requiredString("mimeType", 256),
            size = size,
            sha256 = value.requiredBase64Url("sha256", 43),
            media = validateMedia(value.getValue("media")),
        )
    }

    private fun validateMedia(element: JsonElement): EncryptedMediaPayload {
        val value = element.asObject("Encrypted media")
        value.requireExactKeys(setOf("url", "key", "iv", "sha256", "size"))
        val size = value.requiredLong("size")
        require(size in 1..(MAX_ATTACHMENT_BYTES + 16)) { "Encrypted media size is invalid." }
        val url = value.requiredString("url", Int.MAX_VALUE)
        require(isMxcUrl(url)) { "Encrypted media URL is invalid." }
        return EncryptedMediaPayload(
            url = url,
            key = value.requiredBase64Url("key", 43),
            iv = value.requiredBase64Url("iv", 16),
            sha256 = value.requiredBase64Url("sha256", 43),
            size = size,
        )
    }

    private val BASE64_URL = Regex("^[A-Za-z0-9_-]+$")
    private val ACTION_ID = Regex("^[a-z][a-z0-9._-]*$")
    private val RELEASE_ID = Regex("^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
    private val TOTP = Regex("^[0-9]{6}$")

    private fun isMxcUrl(value: String): Boolean {
        if (!value.startsWith("mxc://")) return false
        val body = value.removePrefix("mxc://")
        val separator = body.indexOf('/')
        if (separator <= 0 || separator == body.lastIndex || body.indexOf('/', separator + 1) >= 0) {
            return false
        }
        return body.none { it.isWhitespace() || Character.isSpaceChar(it) || it == '\uFEFF' }
    }

    private fun JsonObject.requireExactKeys(
        required: Set<String>,
        optional: Set<String> = emptySet(),
    ) {
        require(keys.containsAll(required) && keys.all { it in required || it in optional }) {
            "Command payload has missing or unexpected fields."
        }
    }

    private fun JsonObject.requiredOpaqueId(key: String): String = requiredString(key, 256)

    private fun JsonObject.optionalOpaqueId(key: String): String? =
        optionalBoundedString(key, 256)

    private fun JsonObject.requiredString(
        key: String,
        maxLength: Int,
        allowEmpty: Boolean = false,
    ): String {
        val primitive = get(key) as? JsonPrimitive
            ?: throw IllegalArgumentException("Command field $key is invalid.")
        require(primitive.isString) { "Command field $key must be a string." }
        val result = primitive.content
        require((allowEmpty || result.isNotEmpty()) && result.length <= maxLength) {
            "Command field $key has an invalid length."
        }
        return result
    }

    private fun JsonObject.optionalString(key: String): String? {
        if (key !in this) return null
        return requiredString(key, Int.MAX_VALUE, allowEmpty = true)
    }

    private fun JsonObject.optionalBoundedString(key: String, maxLength: Int): String? {
        if (key !in this) return null
        return requiredString(key, maxLength)
    }

    private fun JsonObject.optionalNullableBoundedString(key: String, maxLength: Int): String? {
        if (key !in this || get(key) === JsonNull) return null
        return requiredString(key, maxLength)
    }

    private fun JsonObject.requiredLong(key: String): Long {
        val primitive = get(key) as? JsonPrimitive
            ?: throw IllegalArgumentException("Command field $key is invalid.")
        require(!primitive.isString) { "Command field $key must be a number." }
        return primitive.longOrNull
            ?: throw IllegalArgumentException("Command field $key must be an integer.")
    }

    private fun JsonObject.optionalLong(key: String): Long? =
        if (key in this) requiredLong(key) else null

    private fun JsonObject.optionalBoolean(key: String): Boolean? {
        if (key !in this) return null
        val primitive = get(key) as? JsonPrimitive
            ?: throw IllegalArgumentException("Command field $key is invalid.")
        require(!primitive.isString) { "Command field $key must be a boolean." }
        return primitive.booleanOrNull
            ?: throw IllegalArgumentException("Command field $key must be a boolean.")
    }

    private fun JsonObject.optionalArray(key: String): List<JsonElement>? {
        if (key !in this) return null
        return runCatching { getValue(key) as kotlinx.serialization.json.JsonArray }.getOrElse {
            throw IllegalArgumentException("Command field $key must be an array.")
        }
    }

    private fun JsonObject.requiredBase64Url(key: String, length: Int): String =
        requiredString(key, length).also {
            require(it.length == length && BASE64_URL.matches(it)) { "Command field $key is invalid." }
        }

    private fun JsonElement.asObject(label: String): JsonObject = this as? JsonObject
        ?: throw IllegalArgumentException("$label must be an object.")
}

enum class CommandAuthorizationSource {
    CERTIFICATE_GRANT,
    DENIED,
}

data class CommandAuthorizationDecision(
    val authorized: Boolean,
    val source: CommandAuthorizationSource,
)

object CommandAuthorizationPolicy {
    /**
     * Evaluates command authority after certificate signature, binding,
     * status, and expiry have already been verified by the pairing layer.
     */
    fun evaluate(
        operation: CommandOperation,
        certificateGrants: Collection<PairingOperation>,
    ): CommandAuthorizationDecision {
        val requiredGrant = requiredCertificateOperation(operation)
        // DEVICE_INVITE marks a full Workspace member. Such a member can
        // already delegate full membership, so it inherits ordinary command
        // operations introduced after its certificate was issued. Keep this
        // local preflight aligned with MatrixMlp3CommandAuthorizer; otherwise
        // an older Android pairing can reject a command that the Gateway
        // explicitly authorizes.
        val granted = requiredGrant in certificateGrants ||
            PairingOperation.DEVICE_INVITE in certificateGrants
        return if (granted) {
            CommandAuthorizationDecision(true, CommandAuthorizationSource.CERTIFICATE_GRANT)
        } else {
            CommandAuthorizationDecision(false, CommandAuthorizationSource.DENIED)
        }
    }

    fun requireAuthorized(
        payload: ValidatedCommandPayload,
        certificateGrants: Collection<PairingOperation>,
    ) = requireAuthorized(payload.operation, certificateGrants)

    fun requireAuthorized(
        operation: CommandOperation,
        certificateGrants: Collection<PairingOperation>,
    ) {
        val decision = evaluate(operation, certificateGrants)
        require(decision.authorized) {
            "The pairing certificate does not authorize ${operation.wireName}."
        }
    }
}

/**
 * Gateway enrollment belongs to the same delegated administration authority
 * as inviting another client. Keep this mapping shared by the local command
 * authorization check and the capability preflight so an existing
 * DEVICE_INVITE certificate can create and approve Gateway setup links.
 */
internal fun requiredCertificateOperation(operation: CommandOperation): PairingOperation =
    when (operation) {
        CommandOperation.PROJECT_DELETE -> PairingOperation.PROJECT_SETTINGS
        CommandOperation.GATEWAY_ENROLLMENT_INVITE,
        CommandOperation.GATEWAY_ENROLLMENT_APPROVE,
        CommandOperation.GATEWAY_PROFILE_UPDATE,
        CommandOperation.GATEWAY_RETIRE,
        -> PairingOperation.DEVICE_INVITE
        CommandOperation.GATEWAY_UPDATE_STAGE,
        CommandOperation.GATEWAY_UPDATE_APPLY,
        CommandOperation.GATEWAY_UPDATE_STATUS,
        -> PairingOperation.GATEWAY_UPDATE
        else -> PairingOperation.parse(operation.wireName)
    }
