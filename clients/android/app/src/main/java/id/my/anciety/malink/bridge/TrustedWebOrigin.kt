package id.my.anciety.malink.bridge

import id.my.anciety.malink.config.StaticServiceEndpoint

class TrustedWebOrigin(private val endpoint: StaticServiceEndpoint) {
    val appOrigin: String = endpoint.origin
    val appUrl: String = endpoint.baseUrl

    fun isTrustedOrigin(candidate: String?): Boolean = endpoint.isTrustedOrigin(candidate)

    fun isTrustedUrl(candidate: String?): Boolean = endpoint.isTrustedUrl(candidate)
}
