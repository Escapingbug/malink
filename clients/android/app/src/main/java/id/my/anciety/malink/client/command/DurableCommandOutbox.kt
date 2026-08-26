package id.my.anciety.malink.client.command

import id.my.anciety.malink.security.SecretCipher
import java.io.File
import java.security.MessageDigest
import java.util.UUID
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

fun interface CommandClock {
    fun now(): Long
}

fun interface CommandIdFactory {
    fun newId(): String
}

/**
 * Durable MLP/3 command lifecycle.
 *
 * Commands are independent timeline objects identified by [CommandView.commandId].
 * Matrix publication and Gateway business events are deliberately separate:
 * `published` means the homeserver returned the physical event id, `running`
 * means a signed Gateway progress event was projected, and only a signed
 * terminal event completes the command. There is no acknowledgement sequence,
 * workspace revision, or global command lane.
 */
class DurableCommandOutbox internal constructor(
    private val store: CommandOutboxStore,
    private val clock: CommandClock = CommandClock(System::currentTimeMillis),
    private val idFactory: CommandIdFactory = CommandIdFactory { UUID.randomUUID().toString() },
) {
    private var snapshot: CommandOutboxSnapshot

    init {
        val loaded = store.load() ?: CommandOutboxSnapshot()
        val recovered = loaded.copy(
            commands = loaded.commands.map { command ->
                if (command.state == CommandState.TRANSMITTING) {
                    command.copy(
                        state = CommandState.RECOVERY_REQUIRED,
                        updatedAt = monotonicNow(command.updatedAt),
                    )
                } else {
                    command
                }
            },
        )
        if (recovered != loaded) store.save(recovered)
        snapshot = recovered
    }

    @Synchronized
    fun enqueue(
        idempotencyKey: String,
        payload: JsonObject,
        sessionId: String? = null,
        projectId: String? = null,
    ): CommandReceipt {
        requireUuid(idempotencyKey)
        sessionId?.let { requireOpaqueId(it, "sessionId") }
        projectId?.let { requireOpaqueId(it, "projectId") }
        val validatedPayload = CommandPayloadValidator.validate(payload)
        require(sessionId == null || sessionId == validatedPayload.sessionId) {
            "The command session id does not match its payload."
        }
        val effectiveSessionId = validatedPayload.sessionId
        val fingerprint = requestFingerprint(payload, effectiveSessionId, projectId)
        snapshot.commands.firstOrNull { it.idempotencyKey == idempotencyKey }?.let { existing ->
            if (existing.requestFingerprint != fingerprint) {
                throw CommandIdempotencyConflictException(
                    "The idempotency key is already associated with a different command.",
                )
            }
            return existing.toView().toReceipt()
        }
        snapshot.released.firstOrNull { it.idempotencyKey == idempotencyKey }?.let { released ->
            if (released.requestFingerprint != fingerprint) {
                throw CommandIdempotencyConflictException(
                    "The released idempotency key belongs to a different command.",
                )
            }
            throw ReleasedCommandException(
                "Command ${released.commandId} was already completed and released; it will not be executed again.",
            )
        }
        require(snapshot.commands.size < MAX_ACTIVE_COMMANDS) {
            "Release completed commands before adding another command."
        }
        val now = nonnegativeNow()
        val operationId = newUniqueId("operationId")
        val command = PersistedCommand(
            operationId = operationId,
            commandId = newUniqueId("commandId", setOf(operationId)),
            retiredCommandIds = emptyList(),
            idempotencyKey = idempotencyKey,
            requestFingerprint = fingerprint,
            state = CommandState.QUEUED,
            submittedAt = now,
            updatedAt = now,
            sessionId = effectiveSessionId,
            projectId = projectId,
            createdAt = null,
            matrixEventId = null,
            cancelRequested = false,
            completion = null,
            payload = payload,
        )
        commit(snapshot.copy(commands = snapshot.commands + command))
        return command.toView().toReceipt()
    }

    @Synchronized
    fun claimForTransmission(commandId: String): CommandTransmission? {
        val command = findCurrent(commandId) ?: return null
        if (command.state != CommandState.QUEUED) return null
        val now = monotonicNow(command.updatedAt)
        val next = command.copy(
            state = CommandState.TRANSMITTING,
            updatedAt = now,
            createdAt = command.createdAt ?: now,
        )
        replaceAndCommit(command, next)
        return next.toTransmission(recovery = false)
    }

    @Synchronized
    fun claimRecovery(commandId: String): CommandTransmission? {
        val command = findCurrent(commandId) ?: return null
        if (command.state != CommandState.RECOVERY_REQUIRED) return null
        val next = command.copy(
            state = CommandState.TRANSMITTING,
            updatedAt = monotonicNow(command.updatedAt),
            createdAt = requireNotNull(command.createdAt) {
                "Recoverable command creation time is missing."
            },
        )
        replaceAndCommit(command, next)
        return next.toTransmission(recovery = true)
    }

    /** Marks a Matrix PUT with an uncertain outcome as safe for idempotent retry. */
    @Synchronized
    fun markTransmissionUncertain(commandId: String): CommandView? {
        val command = findCurrent(commandId) ?: return null
        if (command.state != CommandState.TRANSMITTING) return command.toView()
        val next = command.copy(
            state = CommandState.RECOVERY_REQUIRED,
            updatedAt = monotonicNow(command.updatedAt),
        )
        replaceAndCommit(command, next)
        return next.toView()
    }

    /** Records only Matrix transport durability; it is not a Gateway acknowledgement. */
    @Synchronized
    fun recordPublished(commandId: String, matrixEventId: String): Boolean {
        requireOpaqueId(matrixEventId, "matrixEventId")
        val command = findCurrent(commandId) ?: return false
        if (command.state.isTerminal) return false
        if (command.matrixEventId != null && command.matrixEventId != matrixEventId) {
            throw IllegalStateException("A command was published under a different Matrix event id.")
        }
        val next = command.copy(
            state = if (command.state == CommandState.RUNNING) CommandState.RUNNING else CommandState.PUBLISHED,
            updatedAt = monotonicNow(command.updatedAt),
            matrixEventId = matrixEventId,
        )
        if (next == command) return false
        replaceAndCommit(command, next)
        return true
    }

    /** Records a signed Gateway progress event causally linked to this command. */
    @Synchronized
    fun recordProgress(commandId: String, sessionId: String? = null): Boolean {
        sessionId?.let { requireOpaqueId(it, "sessionId") }
        val command = findCurrent(commandId) ?: return false
        if (command.state.isTerminal) return false
        val next = command.copy(
            state = CommandState.RUNNING,
            updatedAt = monotonicNow(command.updatedAt),
            sessionId = sessionId ?: command.sessionId,
        )
        if (next == command) return false
        replaceAndCommit(command, next)
        return true
    }

    @Synchronized
    fun recordCompletion(completion: CommandCompletion): Boolean {
        val command = findCurrent(completion.commandId) ?: return false
        command.completion?.let { existing ->
            if (existing == completion) return false
            throw IllegalStateException("A different terminal result is already stored for this command.")
        }
        val terminalState = when (completion.outcome) {
            CommandOutcome.SUCCEEDED -> CommandState.SUCCEEDED
            CommandOutcome.FAILED -> CommandState.FAILED
            CommandOutcome.CANCELLED -> CommandState.CANCELLED
        }
        val next = command.copy(
            state = terminalState,
            updatedAt = monotonicNow(command.updatedAt),
            sessionId = completion.sessionId ?: command.sessionId,
            completion = completion,
        )
        replaceAndCommit(command, next)
        return true
    }

    @Synchronized
    fun markCancelRequested(commandId: String): CommandView? {
        val command = findCurrent(commandId) ?: return null
        if (command.state.isTerminal || command.cancelRequested) return command.toView()
        val next = command.copy(
            cancelRequested = true,
            updatedAt = monotonicNow(command.updatedAt),
        )
        replaceAndCommit(command, next)
        return next.toView()
    }

    @Synchronized
    fun get(commandId: String): CommandView? = findCurrent(commandId)?.toView()

    @Synchronized
    fun resolveCurrent(commandId: String): CommandView? = snapshot.commands
        .firstOrNull { command ->
            command.commandId == commandId || commandId in command.retiredCommandIds
        }
        ?.toView()

    @Synchronized
    fun operation(commandId: String): CommandOperation? =
        findCurrent(commandId)?.payload?.let(CommandPayloadValidator::validate)?.operation

    @Synchronized
    fun list(): List<CommandView> = snapshot.commands.map(PersistedCommand::toView)

    @Synchronized
    fun release(commandId: String): Boolean {
        val command = findCurrent(commandId) ?: return false
        require(command.state.isTerminal) { "Only completed commands can be released." }
        require(snapshot.released.size < MAX_RELEASED_TOMBSTONES) {
            "The released-command safety ledger is full; revoke this native account before clearing it."
        }
        val tombstone = ReleasedCommandTombstone(
            operationId = command.operationId,
            commandId = command.commandId,
            retiredCommandIds = command.retiredCommandIds,
            idempotencyKey = command.idempotencyKey,
            requestFingerprint = command.requestFingerprint,
            releasedAt = nonnegativeNow(),
        )
        commit(snapshot.copy(commands = snapshot.commands - command, released = snapshot.released + tombstone))
        return true
    }

    @Synchronized
    fun clear() {
        store.clear()
        snapshot = CommandOutboxSnapshot()
    }

    private fun findCurrent(commandId: String): PersistedCommand? =
        snapshot.commands.firstOrNull { it.commandId == commandId }

    private fun replaceAndCommit(before: PersistedCommand, after: PersistedCommand) {
        commit(snapshot.copy(commands = replace(snapshot.commands, before, after)))
    }

    private fun commit(next: CommandOutboxSnapshot) {
        store.save(next)
        snapshot = next
    }

    private fun nonnegativeNow(): Long = clock.now().also {
        requireNonnegativeJsonInteger(it, "Command clock timestamp")
    }

    private fun monotonicNow(previous: Long): Long = maxOf(nonnegativeNow(), previous)

    private fun newUniqueId(
        field: String,
        additionallyForbidden: Set<String> = emptySet(),
    ): String = idFactory.newId().also { candidate ->
        requireOpaqueId(candidate, field)
        require(
            candidate !in additionallyForbidden && snapshot.commands.none {
                it.operationId == candidate || it.commandId == candidate || candidate in it.retiredCommandIds
            } && snapshot.released.none {
                it.operationId == candidate || it.commandId == candidate || candidate in it.retiredCommandIds
            },
        ) { "$field collides with an existing durable identifier." }
    }

    companion object {
        private const val MAX_ACTIVE_COMMANDS = 128
        private const val MAX_RELEASED_TOMBSTONES = 4_096

        internal fun encrypted(
            file: File,
            cipher: SecretCipher,
            accountScope: String,
            onMigration: (CommandOutboxMigration) -> Unit = {},
        ): DurableCommandOutbox = DurableCommandOutbox(
            EncryptedAtomicCommandOutboxStore(file, cipher, accountScope, onMigration),
        )
    }
}

private fun replace(
    commands: List<PersistedCommand>,
    before: PersistedCommand,
    after: PersistedCommand,
): List<PersistedCommand> = commands.map { if (it === before || it == before) after else it }

private fun PersistedCommand.toTransmission(recovery: Boolean) = CommandTransmission(
    operationId = operationId,
    commandId = commandId,
    idempotencyKey = idempotencyKey,
    projectId = projectId,
    issuedAt = createdAt ?: error("A transmission has no durable creation timestamp."),
    payload = payload,
    recovery = recovery,
)

private fun PersistedCommand.toView() = CommandView(
    operationId = operationId,
    commandId = commandId,
    idempotencyKey = idempotencyKey,
    state = state,
    submittedAt = submittedAt,
    updatedAt = updatedAt,
    sessionId = sessionId,
    cancelRequested = cancelRequested,
    completion = completion,
)

private fun requestFingerprint(payload: JsonObject, sessionId: String?, projectId: String?): String {
    val canonical = JsonObject(
        buildMap {
            put("payload", canonicalize(payload))
            put("sessionId", sessionId?.let(::JsonPrimitive) ?: JsonNull)
            put("projectId", projectId?.let(::JsonPrimitive) ?: JsonNull)
        },
    ).toString().toByteArray(Charsets.UTF_8)
    return try {
        sha256Hex(canonical)
    } finally {
        canonical.fill(0)
    }
}

private fun sha256Hex(value: ByteArray): String {
    val alphabet = "0123456789abcdef"
    val digest = MessageDigest.getInstance("SHA-256").digest(value)
    return try {
        buildString(digest.size * 2) {
            digest.forEach { byte ->
                val octet = byte.toInt() and 0xff
                append(alphabet[octet ushr 4])
                append(alphabet[octet and 0x0f])
            }
        }
    } finally {
        digest.fill(0)
    }
}

private fun canonicalize(value: JsonElement): JsonElement = when (value) {
    is JsonObject -> JsonObject(value.entries.sortedBy { it.key }.associate { (key, item) ->
        key to canonicalize(item)
    })
    is JsonArray -> JsonArray(value.map(::canonicalize))
    else -> value
}
