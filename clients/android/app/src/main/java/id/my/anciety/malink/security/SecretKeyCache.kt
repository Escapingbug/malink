package id.my.anciety.malink.security

import javax.crypto.SecretKey

/** Process-lifetime cache that avoids reopening AndroidKeyStore per blob. */
internal class SecretKeyCache(
    private val load: () -> SecretKey,
) {
    @Volatile private var cached: SecretKey? = null

    fun get(): SecretKey = cached ?: synchronized(this) {
        cached ?: load().also { cached = it }
    }

    @Synchronized
    fun invalidate() {
        cached = null
    }
}
