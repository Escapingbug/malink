package id.my.anciety.malink.e2e

import android.app.Activity
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.AtomicFile
import id.my.anciety.malink.BuildConfig
import id.my.anciety.malink.client.NativeRuntimeFiles
import id.my.anciety.malink.client.NativeStateManifestCodec
import id.my.anciety.malink.client.NativeUpgradePhase
import id.my.anciety.malink.client.command.DurableCommandOutbox
import id.my.anciety.malink.security.AndroidKeystoreSecretCipher
import id.my.anciety.malink.security.SecretEnvelope
import id.my.anciety.malink.security.malink.AndroidKeystoreP256Identity
import java.security.MessageDigest
import java.util.UUID
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import kotlinx.serialization.json.put

/**
 * Seeds encrypted outbox states that cannot be created deterministically from UI automation.
 *
 * This receiver only exists in the separately signed `.e2e` package. Keeping
 * the fixture on-device exercises the production Android Keystore key,
 * associated data, AtomicFile, process restart, and cover-install boundaries.
 */
class LegacyOutboxSeederReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        check(BuildConfig.ALLOW_INSECURE_E2E_LOOPBACK) {
            "The legacy outbox fixture is available only in E2E builds."
        }
        val runId = requireNotNull(intent.getStringExtra(EXTRA_RUN_ID)) {
            "The legacy outbox fixture requires a run id."
        }.also {
            require(it.length in 1..256 && !it.any(Char::isISOControl))
        }
        val deviceId = AndroidKeystoreP256Identity().publicIdentity.keyId
        val runtimeFiles = NativeRuntimeFiles(context, deviceId)
        val commandsFile = runtimeFiles.commands
        val atomicFile = AtomicFile(commandsFile)
        check(atomicFile.baseFile.exists()) { "The current encrypted outbox is missing." }
        val cipher = AndroidKeystoreSecretCipher()
        val mode = intent.getStringExtra(EXTRA_MODE)
        if (mode == MODE_CURRENT_QUEUED || mode == MODE_CURRENT_ACCEPTED) {
            val cwd = requireNotNull(intent.getStringExtra(EXTRA_CWD)) {
                "The queued outbox fixture requires a cwd."
            }
            val projectName = requireNotNull(intent.getStringExtra(EXTRA_PROJECT_NAME)) {
                "The queued outbox fixture requires a project name."
            }
            val outbox = DurableCommandOutbox.encrypted(commandsFile, cipher, deviceId)
            val receipt = outbox.enqueue(
                UUID.nameUUIDFromBytes("queued:$runId".toByteArray()).toString(),
                buildJsonObject {
                    put("operation", "session.create")
                    put("cwd", cwd)
                    put("projectName", projectName)
                },
            )
            if (mode == MODE_CURRENT_ACCEPTED) {
                checkNotNull(outbox.claimForTransmission(receipt.commandId))
                check(outbox.recordPublished(receipt.commandId, "\$e2e-published-$runId")) {
                    "The published fixture could not persist its Matrix event id."
                }
            }
            resultCode = Activity.RESULT_OK
            resultData = receipt.commandId
            return
        }
        val associatedData = "malink.command.outbox.v1\u0000$deviceId".toByteArray(Charsets.UTF_8)
        val encrypted = atomicFile.readFully()
        val envelope = try {
            SecretEnvelope.decode(encrypted)
        } finally {
            encrypted.fill(0)
        }
        val plaintext = try {
            cipher.decrypt(envelope, associatedData)
        } finally {
            envelope.iv.fill(0)
            envelope.ciphertext.fill(0)
        }
        val current = try {
            Json.parseToJsonElement(plaintext.toString(Charsets.UTF_8)).jsonObject
        } finally {
            plaintext.fill(0)
        }
        check(current.getValue("schemaVersion").jsonPrimitive.long == 6L) {
            "The fixture requires a current schema-6 outbox."
        }
        val currentCommands = current.getValue("commands").jsonArray
        val terminalStates = setOf("succeeded", "failed", "cancelled")
        check(currentCommands.all { element ->
            element.jsonObject.getValue("state").jsonPrimitive.content in terminalStates
        }) {
            "The fixture requires every retained current command to be terminal."
        }

        val commandId = "legacy-upgrade-${sha256(runId).take(24)}"
        val operationId = "legacy-operation-${sha256("operation:$runId").take(24)}"
        val now = System.currentTimeMillis()
        val sequence = currentCommands.size + 1L
        val released = current.getValue("released").jsonArray.map { element ->
            JsonObject(element.jsonObject.filterKeys { key -> key != "retiredCommandIds" })
        }
        val legacyCommands = currentCommands.mapIndexed { index, element ->
            val command = element.jsonObject
            val compatibilitySequence = index + 1L
            buildJsonObject {
                put("operationId", command.getValue("operationId"))
                put("commandId", command.getValue("commandId"))
                put("retiredCommandIds", command.getValue("retiredCommandIds"))
                put("idempotencyKey", command.getValue("idempotencyKey"))
                put("requestFingerprint", command.getValue("requestFingerprint"))
                put("state", command.getValue("state"))
                put("submittedAt", command.getValue("submittedAt"))
                put("updatedAt", command.getValue("updatedAt"))
                put("sessionId", command.getValue("sessionId"))
                put("sequence", compatibilitySequence)
                put("baseRevision", 0)
                put("authenticationIssuedAt", command.getValue("createdAt"))
                put("authenticationNonce", sha256("legacy-nonce:$runId:$compatibilitySequence"))
                put("revision", 0)
                put("cancelRequested", command.getValue("cancelRequested"))
                val completion = command.getValue("completion")
                put("completion", if (completion is JsonNull) JsonNull else buildJsonObject {
                    val value = completion.jsonObject
                    put("commandId", value.getValue("commandId"))
                    put("sequence", compatibilitySequence)
                    put("revision", 0)
                    put("outcome", value.getValue("outcome"))
                    put("sessionId", value.getValue("sessionId"))
                    put("result", value.getValue("result"))
                    put("error", value.getValue("error"))
                })
                put("expectedRevision", JsonNull)
                put("payload", command.getValue("payload"))
            }
        }
        val legacy = buildJsonObject {
            put("schemaVersion", 2)
            put("lastAcknowledgedSequence", sequence - 1L)
            put("lastRevision", 0)
            put("commands", buildJsonArray {
                legacyCommands.forEach(::add)
                add(buildJsonObject {
                    put("operationId", operationId)
                    put("commandId", commandId)
                    put("retiredCommandIds", buildJsonArray {})
                    put("idempotencyKey", UUID.nameUUIDFromBytes(runId.toByteArray()).toString())
                    put("requestFingerprint", sha256("request:$runId"))
                    put("state", "recovery_required")
                    put("submittedAt", now)
                    put("updatedAt", now)
                    put("sessionId", JsonNull)
                    put("sequence", sequence)
                    put("baseRevision", 0)
                    put("authenticationIssuedAt", JsonNull)
                    put("authenticationNonce", JsonNull)
                    put("revision", JsonNull)
                    put("cancelRequested", false)
                    put("completion", JsonNull)
                    put("expectedRevision", JsonNull)
                    put("payload", buildJsonObject { put("operation", "session.create") })
                })
            })
            put("released", buildJsonArray { released.forEach(::add) })
        }.toString().toByteArray(Charsets.UTF_8)
        val replacement = try {
            val payload = cipher.encrypt(legacy, associatedData)
            try {
                SecretEnvelope.encode(payload)
            } finally {
                payload.iv.fill(0)
                payload.ciphertext.fill(0)
            }
        } finally {
            legacy.fill(0)
        }
        val output = atomicFile.startWrite()
        try {
            output.write(replacement)
            output.fd.sync()
            atomicFile.finishWrite(output)
        } catch (error: Exception) {
            atomicFile.failWrite(output)
            throw error
        } finally {
            replacement.fill(0)
        }
        downgradeUpgradeManifest(runtimeFiles.stateManifest)
        resultCode = Activity.RESULT_OK
        resultData = commandId
    }

    private fun sha256(value: String): String = MessageDigest.getInstance("SHA-256")
        .digest(value.toByteArray(Charsets.UTF_8))
        .joinToString("") { byte -> "%02x".format(byte) }

    /** Simulates the exact per-store version recorded by the previous APK. */
    private fun downgradeUpgradeManifest(file: java.io.File) {
        val atomic = AtomicFile(file)
        check(atomic.baseFile.exists()) { "The current native upgrade manifest is missing." }
        val current = NativeStateManifestCodec.decode(atomic.readFully())
        val previous = current.copy(
            phase = NativeUpgradePhase.COMPLETE,
            runtimeBuild = "previous-e2e-fixture",
            completedAt = System.currentTimeMillis(),
            stores = current.stores.map { store ->
                if (store.id == "command-outbox") store.copy(schemaVersion = 2) else store
            },
            activeMigration = null,
            invalidated = emptyList(),
            blocked = emptyList(),
        )
        val bytes = NativeStateManifestCodec.encode(previous)
        val output = atomic.startWrite()
        try {
            output.write(bytes)
            output.fd.sync()
            atomic.finishWrite(output)
        } catch (error: Exception) {
            atomic.failWrite(output)
            throw error
        } finally {
            bytes.fill(0)
        }
    }

    private companion object {
        const val EXTRA_RUN_ID = "run_id"
        const val EXTRA_MODE = "mode"
        const val EXTRA_CWD = "cwd"
        const val EXTRA_PROJECT_NAME = "project_name"
        const val MODE_CURRENT_QUEUED = "current_queued"
        const val MODE_CURRENT_ACCEPTED = "current_accepted"
    }
}
