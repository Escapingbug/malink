package id.my.anciety.malink.web

internal enum class NativeDisconnectPresentation {
    STOPPED,
    ACCOUNT_SETUP,
}

internal fun nativeDisconnectPresentation(mode: String): NativeDisconnectPresentation =
    when (mode) {
        "stop" -> NativeDisconnectPresentation.STOPPED
        "revoke" -> NativeDisconnectPresentation.ACCOUNT_SETUP
        else -> throw IllegalArgumentException("Unsupported disconnect mode.")
    }
