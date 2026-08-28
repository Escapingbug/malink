package id.my.anciety.malink.config

import android.content.Context
import id.my.anciety.malink.BuildConfig
import java.net.URI

class StaticServiceEndpoint private constructor(
    val baseUrl: String,
    val origin: String,
    private val baseUri: URI,
) {
    fun resolve(relativePath: String): URI {
        require(relativePath.isNotBlank() && !relativePath.startsWith('/')) {
            "Static service paths must be relative."
        }
        val relative = parseUri(relativePath)
            ?: throw IllegalArgumentException("Static service path is invalid.")
        require(
            !relative.isAbsolute &&
                relative.rawAuthority == null &&
                relative.rawQuery == null &&
                relative.rawFragment == null &&
                relative.normalize() == relative &&
                !relative.rawPath.contains("//")
        ) {
            "Static service path is not normalized."
        }
        val resolved = baseUri.resolve(relative)
        require(sameOrigin(resolved) && resolved.rawPath.startsWith(baseUri.rawPath)) {
            "Static service path escaped its configured base URL."
        }
        return resolved
    }

    fun isTrustedOrigin(candidate: String?): Boolean {
        val uri = parseUri(candidate) ?: return false
        val path = uri.rawPath
        return sameOrigin(uri) &&
            (path.isNullOrEmpty() || path == "/") &&
            uri.rawQuery == null &&
            uri.rawFragment == null &&
            uri.rawUserInfo == null
    }

    fun isTrustedUrl(candidate: String?): Boolean {
        val uri = parseUri(candidate) ?: return false
        return sameOrigin(uri) &&
            uri.rawUserInfo == null &&
            uri.rawPath.startsWith(baseUri.rawPath)
    }

    private fun sameOrigin(uri: URI): Boolean =
        uri.scheme.equals(baseUri.scheme, ignoreCase = true) &&
            uri.host.equals(baseUri.host, ignoreCase = true) &&
            effectivePort(uri) == effectivePort(baseUri)

    companion object {
        fun parse(input: String, allowLoopbackHttp: Boolean = false): StaticServiceEndpoint {
            val parsed = parseUri(input.trim())
                ?: throw IllegalArgumentException("Enter a valid static service URL.")
            val loopback = allowLoopbackHttp &&
                parsed.scheme.equals("http", ignoreCase = true) &&
                parsed.host == "127.0.0.1" &&
                parsed.port in 1..65_535
            if (!parsed.scheme.equals("https", ignoreCase = true) && !loopback) {
                throw IllegalArgumentException("Static services must use HTTPS.")
            }
            if (
                parsed.host.isNullOrBlank() ||
                parsed.rawUserInfo != null ||
                parsed.rawQuery != null ||
                parsed.rawFragment != null
            ) {
                throw IllegalArgumentException("The static service URL contains unsupported components.")
            }
            val normalized = parsed.normalize()
            if (normalized.rawPath != parsed.rawPath || parsed.rawPath.contains("//")) {
                throw IllegalArgumentException("The static service URL path is not normalized.")
            }
            val path = (parsed.path.takeUnless(String::isBlank) ?: "/")
                .let { if (it.endsWith('/')) it else "$it/" }
            val baseUri = URI(
                parsed.scheme.lowercase(),
                null,
                parsed.host.lowercase(),
                parsed.port,
                path,
                null,
                null,
            )
            val origin = URI(
                baseUri.scheme,
                null,
                baseUri.host,
                baseUri.port,
                null,
                null,
                null,
            ).toASCIIString()
            return StaticServiceEndpoint(
                baseUrl = baseUri.toASCIIString(),
                origin = origin,
                baseUri = baseUri,
            )
        }

        private fun parseUri(input: String?): URI? {
            if (input.isNullOrBlank()) return null
            return runCatching { URI(input) }.getOrNull()
        }

        private fun effectivePort(uri: URI): Int = when {
            uri.port != -1 -> uri.port
            uri.scheme.equals("https", ignoreCase = true) -> 443
            uri.scheme.equals("http", ignoreCase = true) -> 80
            else -> -1
        }
    }
}

data class PendingStaticServiceSelection(
    val endpoint: StaticServiceEndpoint,
    val usesCustom: Boolean,
    val startedAt: Long,
    val expiresAt: Long,
)

class StaticServiceStore(context: Context) {
    private val preferences = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)

    val official: StaticServiceEndpoint
        get() = StaticServiceEndpoint.parse(
            BuildConfig.APP_ORIGIN,
            BuildConfig.ALLOW_INSECURE_E2E_LOOPBACK,
        )

    val selected: StaticServiceEndpoint
        get() = pending()?.endpoint ?: committed

    val committed: StaticServiceEndpoint
        get() = if (committedUsesCustom) custom ?: official else official

    val usesCustom: Boolean
        get() = pending()?.usesCustom ?: committedUsesCustom

    private val committedUsesCustom: Boolean
        get() = preferences.getBoolean(KEY_USE_CUSTOM, false) && custom != null

    val custom: StaticServiceEndpoint?
        get() {
            val stored = preferences.getString(KEY_CUSTOM_BASE_URL, null) ?: return null
            return runCatching {
                StaticServiceEndpoint.parse(stored, BuildConfig.ALLOW_INSECURE_E2E_LOOPBACK)
            }.getOrElse {
                preferences.edit()
                    .remove(KEY_CUSTOM_BASE_URL)
                    .remove(KEY_USE_CUSTOM)
                    .apply()
                null
            }
        }

    fun beginSelection(
        endpoint: StaticServiceEndpoint,
        usesCustom: Boolean,
        now: Long = System.currentTimeMillis(),
        timeoutMs: Long = SWITCH_CONFIRMATION_TIMEOUT_MS,
    ): PendingStaticServiceSelection {
        require(timeoutMs in 1L..MAX_SWITCH_CONFIRMATION_TIMEOUT_MS) {
            "Static service switch timeout is invalid."
        }
        val pending = PendingStaticServiceSelection(
            endpoint = endpoint,
            usesCustom = usesCustom,
            startedAt = now,
            expiresAt = Math.addExact(now, timeoutMs),
        )
        check(preferences.edit()
            .putString(KEY_PENDING_BASE_URL, endpoint.baseUrl)
            .putBoolean(KEY_PENDING_USE_CUSTOM, usesCustom)
            .putLong(KEY_PENDING_STARTED_AT, pending.startedAt)
            .putLong(KEY_PENDING_EXPIRES_AT, pending.expiresAt)
            .commit()) { "Could not persist the pending static service switch." }
        return pending
    }

    fun pending(now: Long = System.currentTimeMillis()): PendingStaticServiceSelection? {
        val baseUrl = preferences.getString(KEY_PENDING_BASE_URL, null) ?: return null
        val startedAt = preferences.getLong(KEY_PENDING_STARTED_AT, -1L)
        val expiresAt = preferences.getLong(KEY_PENDING_EXPIRES_AT, -1L)
        val endpoint = runCatching {
            StaticServiceEndpoint.parse(baseUrl, BuildConfig.ALLOW_INSECURE_E2E_LOOPBACK)
        }.getOrNull()
        if (endpoint == null || startedAt < 0L || expiresAt <= startedAt || now >= expiresAt) {
            rollbackPending()
            return null
        }
        return PendingStaticServiceSelection(
            endpoint = endpoint,
            usesCustom = preferences.getBoolean(KEY_PENDING_USE_CUSTOM, false),
            startedAt = startedAt,
            expiresAt = expiresAt,
        )
    }

    fun commitPending(expectedStartedAt: Long? = null): Boolean {
        val pending = pending() ?: return false
        if (expectedStartedAt != null && pending.startedAt != expectedStartedAt) return false
        val editor = preferences.edit()
        if (pending.usesCustom) {
            editor
                .putString(KEY_CUSTOM_BASE_URL, pending.endpoint.baseUrl)
                .putBoolean(KEY_USE_CUSTOM, true)
        } else {
            editor.putBoolean(KEY_USE_CUSTOM, false)
        }
        clearPending(editor)
        return editor.commit()
    }

    fun rollbackPending(expectedStartedAt: Long? = null): Boolean {
        if (expectedStartedAt != null) {
            val currentStartedAt = preferences.getLong(KEY_PENDING_STARTED_AT, -1L)
            if (currentStartedAt != expectedStartedAt) return false
        }
        return clearPending(preferences.edit()).commit()
    }

    private fun clearPending(editor: android.content.SharedPreferences.Editor) = editor
        .remove(KEY_PENDING_BASE_URL)
        .remove(KEY_PENDING_USE_CUSTOM)
        .remove(KEY_PENDING_STARTED_AT)
        .remove(KEY_PENDING_EXPIRES_AT)

    companion object {
        const val SWITCH_CONFIRMATION_TIMEOUT_MS = 30_000L
        private const val MAX_SWITCH_CONFIRMATION_TIMEOUT_MS = 5 * 60_000L
        const val PREFERENCES = "malink-static-service-v1"
        const val KEY_CUSTOM_BASE_URL = "custom-base-url"
        const val KEY_USE_CUSTOM = "use-custom"
        const val KEY_PENDING_BASE_URL = "pending-base-url"
        const val KEY_PENDING_USE_CUSTOM = "pending-use-custom"
        const val KEY_PENDING_STARTED_AT = "pending-started-at"
        const val KEY_PENDING_EXPIRES_AT = "pending-expires-at"
    }
}
