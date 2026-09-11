package id.my.anciety.malink.security.malink

import java.security.KeyFactory
import java.security.spec.X509EncodedKeySpec
import java.security.spec.MGF1ParameterSpec
import javax.crypto.Cipher
import javax.crypto.spec.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class ExtensionCryptoTest {
    private fun fixture(): JsonObject = Json.parseToJsonElement(
        javaClass.getResourceAsStream("/extension-crypto-v1.json")!!.bufferedReader().use { it.readText() },
    ) as JsonObject

    @Test fun `decrypts TypeScript fixture and isolates extensions and primary envelopes`() {
        val fixture = fixture()
        val ring = fixture["ring"] as JsonObject
        val crypto = ExtensionCrypto(ring, "fixture-extension")
        val plaintext = fixture["plaintext"]!!.jsonPrimitive.content
        assertEquals(plaintext, crypto.decrypt(fixture["ciphertext"] as JsonObject))
        assertEquals(plaintext, crypto.decrypt(crypto.encrypt(plaintext)))
        assertEquals("", crypto.decrypt(crypto.encrypt("")))
        val ciphertext = fixture["ciphertext"] as JsonObject
        for (changed in listOf(
            JsonObject(ciphertext + ("extensionId" to JsonPrimitive("other"))),
            JsonObject(ciphertext + ("cryptoDomainId" to JsonPrimitive("other"))),
            JsonObject(ciphertext + ("kind" to JsonPrimitive("malink.project-envelope"))),
            JsonObject(ciphertext + ("keyEpoch" to JsonPrimitive(2))),
            JsonObject(ciphertext + ("nonce" to JsonPrimitive("AAAAAAAAAAAAAAAA"))),
        )) assertThrows(Exception::class.java) { crypto.decrypt(changed) }
        assertThrows(Exception::class.java) { crypto.encrypt("密".repeat(50_000)) }
    }

    @Test fun `grant is bound to native private key and expires without exporting keys`() {
        var now = 1L
        val sessions = ExtensionCryptoSessions { now }
        val request = sessions.begin("fixture-extension")
        val id = request["requestId"]!!.jsonPrimitive.content
        val ring = fixture()["ring"] as JsonObject
        val grant = seal(ring, request)
        assertEquals("fixture-extension", sessions.accept(id, grant)["extensionId"]!!.jsonPrimitive.content)
        assertThrows(Exception::class.java) { sessions.accept(id, grant) }
        val ciphertext = sessions.execute(id, buildJsonObject { put("type", "crypto.encrypt"); put("plaintext", "native") }) as JsonObject
        assertEquals("native", ExtensionCrypto(ring, "fixture-extension").decrypt(ciphertext))
        val other = sessions.begin("fixture-extension")
        val otherId = other["requestId"]!!.jsonPrimitive.content
        assertThrows(Exception::class.java) { sessions.accept(otherId, grant) }
        assertThrows(Exception::class.java) { sessions.accept(otherId, JsonObject(grant + ("requestId" to JsonPrimitive(otherId)))) }
        now += 5 * 60_000
        assertThrows(Exception::class.java) { sessions.execute(id, buildJsonObject { put("type", "crypto.connect") }) }
    }

    private fun seal(ring: JsonObject, request: JsonObject): JsonObject {
        val publicKey = KeyFactory.getInstance("RSA").generatePublic(X509EncodedKeySpec(Base64Url.decode(request["recipientPublicKey"]!!.jsonPrimitive.content)))
        val key = ByteArray(32) { it.toByte() }
        val wrapped = Cipher.getInstance("RSA/ECB/OAEPPadding").run {
            init(Cipher.ENCRYPT_MODE, publicKey, OAEPParameterSpec("SHA-256", "MGF1", MGF1ParameterSpec.SHA256, PSource.PSpecified.DEFAULT)); doFinal(key)
        }
        val header = buildJsonObject {
            put("kind", "malink.extension-key-grant"); put("version", 1)
            put("extensionId", request["extensionId"]!!); put("requestId", request["requestId"]!!)
            put("wrappedKey", Base64Url.encode(wrapped)); put("nonce", Base64Url.encode(ByteArray(12)))
        }
        val encrypted = Cipher.getInstance("AES/GCM/NoPadding").run {
            init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, ByteArray(12)))
            updateAAD(CanonicalJson.bytes(header)); doFinal(CanonicalJson.bytes(ring))
        }
        return JsonObject(header + ("ciphertext" to JsonPrimitive(Base64Url.encode(encrypted))))
    }
}
