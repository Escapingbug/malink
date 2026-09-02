package id.my.anciety.malink.web

import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.util.Base64

internal const val AUTHORIZATION_TRANSFER_MIME_TYPE =
    "application/vnd.malink.authorization+json"
internal const val MAX_AUTHORIZATION_TRANSFER_BYTES = 128 * 1024

internal fun readAuthorizationTransfer(input: InputStream): ByteArray {
    val output = ByteArrayOutputStream()
    val buffer = ByteArray(8 * 1024)
    while (true) {
        val count = input.read(buffer)
        if (count < 0) break
        if (count == 0) continue
        if (output.size() + count > MAX_AUTHORIZATION_TRANSFER_BYTES) {
            throw IllegalArgumentException("The authorization file is too large.")
        }
        output.write(buffer, 0, count)
    }
    return output.toByteArray().takeIf { it.isNotEmpty() }
        ?: throw IllegalArgumentException("The authorization file is empty.")
}

/**
 * Carries the bounded file into the trusted static PWA without interpreting
 * its bearer credential in the native presentation layer. The PWA consumes
 * the fragment immediately and applies the shared strict parser.
 */
internal fun authorizationTransferFragment(contents: ByteArray): String {
    require(contents.isNotEmpty()) { "The authorization file is empty." }
    require(contents.size <= MAX_AUTHORIZATION_TRANSFER_BYTES) {
        "The authorization file is too large."
    }
    return Base64.getUrlEncoder().withoutPadding().encodeToString(contents)
}
