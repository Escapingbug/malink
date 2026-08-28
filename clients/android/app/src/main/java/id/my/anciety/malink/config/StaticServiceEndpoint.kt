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

class StaticServiceStore(context: Context) {
    private val preferences = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)

    val official: StaticServiceEndpoint
        get() = StaticServiceEndpoint.parse(
            BuildConfig.APP_ORIGIN,
            BuildConfig.ALLOW_INSECURE_E2E_LOOPBACK,
        )

    val selected: StaticServiceEndpoint
        get() {
            if (!preferences.getBoolean(KEY_USE_CUSTOM, false)) return official
            return custom ?: official
        }

    val usesCustom: Boolean
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

    fun select(endpoint: StaticServiceEndpoint) {
        preferences.edit()
            .putString(KEY_CUSTOM_BASE_URL, endpoint.baseUrl)
            .putBoolean(KEY_USE_CUSTOM, true)
            .apply()
    }

    fun useOfficial() {
        preferences.edit().putBoolean(KEY_USE_CUSTOM, false).apply()
    }

    private companion object {
        const val PREFERENCES = "malink-static-service-v1"
        const val KEY_CUSTOM_BASE_URL = "custom-base-url"
        const val KEY_USE_CUSTOM = "use-custom"
    }
}
