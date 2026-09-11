package id.my.anciety.malink.security.malink

import java.security.KeyPairGenerator
import java.security.PrivateKey
import java.security.SecureRandom
import java.security.spec.MGF1ParameterSpec
import java.util.UUID
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.OAEPParameterSpec
import javax.crypto.spec.PSource
import javax.crypto.spec.SecretKeySpec
import kotlinx.serialization.json.*

/** Native-owned ephemeral handles. Neither private keys nor domain keys cross the WebView bridge. */
class ExtensionCryptoSessions(private val now: () -> Long = System::currentTimeMillis) {
    private data class Session(val extensionId: String, val request: JsonObject, val privateKey: PrivateKey,
        val expiresAt: Long, var crypto: ExtensionCrypto? = null)
    private val sessions = mutableMapOf<String, Session>()

    @Synchronized fun begin(extensionId: String): JsonObject {
        require(extensionId.isNotEmpty() && extensionId.length <= 256)
        sessions.entries.removeAll { it.value.expiresAt <= now() }
        require(sessions.size < 16) { "Too many extension crypto sessions" }
        val pair = KeyPairGenerator.getInstance("RSA").apply { initialize(2048) }.generateKeyPair()
        val id = UUID.randomUUID().toString()
        val request = buildJsonObject {
            put("operation", "extension.crypto.grant"); put("extensionId", extensionId)
            put("requestId", id); put("recipientPublicKey", Base64Url.encode(pair.public.encoded))
        }
        sessions[id] = Session(extensionId, request, pair.private, now() + 5 * 60_000)
        return request
    }

    /** The caller supplies a terminal fetched from its verified durable command store, never WebView JSON. */
    @Synchronized fun accept(requestId: String, grant: JsonObject): JsonObject {
        val session = current(requestId)
        require(session.crypto == null) { "Extension grant already consumed" }
        grant.exact(setOf("kind", "version", "extensionId", "requestId", "wrappedKey", "nonce", "ciphertext"))
        require(grant.text("kind") == "malink.extension-key-grant" && grant.number("version") == 1L)
        require(grant.text("extensionId") == session.extensionId && grant.text("requestId") == requestId)
        val wrapped = Base64Url.decode(grant.text("wrappedKey"))
        require(wrapped.size == 256)
        val key = Cipher.getInstance("RSA/ECB/OAEPPadding").run {
            init(Cipher.DECRYPT_MODE, session.privateKey, OAEPParameterSpec("SHA-256", "MGF1", MGF1ParameterSpec.SHA256, PSource.PSpecified.DEFAULT))
            doFinal(wrapped)
        }
        val ciphertext = grant.text("ciphertext")
        require(ciphertext.length in 22..(32 * 1024))
        val plaintext = extensionAes(Cipher.DECRYPT_MODE, key, JsonObject(grant - "ciphertext"), Base64Url.decode(ciphertext))
        require(plaintext.size <= 24 * 1024)
        val ring = Json.parseToJsonElement(plaintext.decodeToString(throwOnInvalidSequence = true)) as JsonObject
        val crypto = ExtensionCrypto(ring, session.extensionId)
        session.crypto = crypto
        return crypto.identity
    }

    @Synchronized fun execute(requestId: String, request: JsonObject): JsonElement {
        val crypto = current(requestId).crypto ?: error("Extension crypto is not connected")
        return when (request.text("type")) {
            "crypto.connect" -> { request.exact(setOf("type")); crypto.identity }
            "crypto.encrypt" -> { request.exact(setOf("type", "plaintext")); crypto.encrypt(request.text("plaintext")) }
            "crypto.decrypt" -> { request.exact(setOf("type", "ciphertext")); JsonPrimitive(crypto.decrypt(request["ciphertext"] as JsonObject)) }
            else -> error("Invalid extension crypto request")
        }
    }
    @Synchronized fun close(requestId: String) { sessions.remove(requestId) }
    @Synchronized fun clear() { sessions.clear() }
    private fun current(id: String): Session = sessions[id]?.also {
        if (it.expiresAt <= now()) { sessions.remove(id); error("Extension crypto session expired") }
    } ?: error("Extension crypto session unavailable")
}

class ExtensionCrypto(ring: JsonObject, extensionId: String) {
    val identity: JsonObject
    private val keys: Map<Long, ByteArray>
    init {
        ring.exact(setOf("version", "extensionId", "cryptoDomainId", "activeEpoch", "keys"))
        require(ring.number("version") == 1L && ring.text("extensionId") == extensionId)
        require(extensionId.isNotEmpty() && extensionId.length <= 256)
        val domain = ring.text("cryptoDomainId")
        require(domain.isNotEmpty() && domain.length <= 256)
        val list = ring["keys"] as JsonArray
        require(list.size in 1..128)
        keys = list.associate { value ->
            val entry = value as JsonObject
            entry.exact(setOf("epoch", "key"))
            val epoch = entry.number("epoch")
            require(epoch in 1..9_007_199_254_740_991L)
            epoch to Base64Url.decode(entry.text("key")).also { require(it.size == 32) }
        }
        val active = ring.number("activeEpoch")
        require(keys.size == list.size && keys.keys.max() == active)
        identity = buildJsonObject { put("extensionId", extensionId); put("cryptoDomainId", domain); put("keyEpoch", active) }
    }
    fun encrypt(plaintext: String): JsonObject {
        val data = plaintext.toByteArray(Charsets.UTF_8)
        require(data.size <= 128 * 1024)
        val header = buildJsonObject {
            put("kind", "malink.extension-data"); put("version", 1)
            identity.forEach { (key, value) -> put(key, value) }
            put("nonce", Base64Url.encode(ByteArray(12).also { SecureRandom().nextBytes(it) }))
        }
        val encrypted = extensionAes(Cipher.ENCRYPT_MODE, keys.getValue(identity.number("keyEpoch")), header, data)
        return JsonObject(header + ("ciphertext" to JsonPrimitive(Base64Url.encode(encrypted))))
    }
    fun decrypt(value: JsonObject): String {
        value.exact(setOf("kind", "version", "extensionId", "cryptoDomainId", "keyEpoch", "nonce", "ciphertext"))
        require(value.text("kind") == "malink.extension-data" && value.number("version") == 1L)
        require(value["extensionId"] == identity["extensionId"] && value["cryptoDomainId"] == identity["cryptoDomainId"])
        val encoded = value.text("ciphertext")
        require(encoded.length <= 174_784)
        val ciphertext = Base64Url.decode(encoded)
        require(ciphertext.size in 16..(128 * 1024 + 16))
        return extensionAes(Cipher.DECRYPT_MODE, keys.getValue(value.number("keyEpoch")), JsonObject(value - "ciphertext"), ciphertext)
            .decodeToString(throwOnInvalidSequence = true)
    }
}
private fun extensionAes(mode: Int, key: ByteArray, header: JsonObject, data: ByteArray): ByteArray {
    require(key.size == 32)
    val nonce = Base64Url.decode(header.text("nonce"))
    require(nonce.size == 12)
    return Cipher.getInstance("AES/GCM/NoPadding").run {
        init(mode, SecretKeySpec(key, "AES"), GCMParameterSpec(128, nonce))
        updateAAD(CanonicalJson.bytes(header)); doFinal(data)
    }
}
private fun JsonObject.text(key: String): String = (get(key) as? JsonPrimitive)?.takeIf { it.isString }?.content ?: error("Invalid extension field")
private fun JsonObject.number(key: String): Long = (get(key) as? JsonPrimitive)?.takeIf { !it.isString }?.longOrNull ?: error("Invalid extension number")
private fun JsonObject.exact(keys: Set<String>) { require(this.keys == keys) { "Invalid extension fields" } }
