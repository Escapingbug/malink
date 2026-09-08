package id.my.anciety.malink.web

import id.my.anciety.malink.update.NativeUpdatePhase
import id.my.anciety.malink.update.NativeUpdateStatus

internal enum class NativeRecoveryUpdateAction {
    NONE,
    CHECK,
    INSTALL,
    OPEN_INSTALL_PERMISSION,
    BACK,
}

internal data class NativeRecoveryUpdatePresentation(
    val title: String,
    val detail: String,
    val action: NativeRecoveryUpdateAction,
    val actionLabel: String? = null,
    val showProgress: Boolean = false,
    val progressPercent: Int? = null,
)

internal fun nativeRecoveryUpdatePresentation(
    status: NativeUpdateStatus,
): NativeRecoveryUpdatePresentation = when (status.phase) {
    NativeUpdatePhase.CURRENT -> NativeRecoveryUpdatePresentation(
        title = "No newer APK is available",
        detail = "This APK (${status.currentVersionName}) is already current on the built-in " +
            "Official release channel. Return to UI recovery to reset the hosted interface or " +
            "export diagnostics; reinstalling the same APK would not change the failure.",
        action = NativeRecoveryUpdateAction.BACK,
        actionLabel = "Back to UI recovery",
    )
    NativeUpdatePhase.CHECKING -> NativeRecoveryUpdatePresentation(
        title = "Checking for an APK update…",
        detail = "Malink is contacting its built-in Official GitHub Pages release channel. " +
            "This does not require the PWA, Workspace, Matrix, or a Gateway.",
        action = NativeRecoveryUpdateAction.NONE,
        showProgress = true,
    )
    NativeUpdatePhase.AVAILABLE -> NativeRecoveryUpdatePresentation(
        title = "APK update found",
        detail = "Malink found ${status.latestVersionName ?: "a newer version"} and is preparing " +
            "the immutable release download.",
        action = NativeRecoveryUpdateAction.NONE,
        showProgress = true,
    )
    NativeUpdatePhase.DOWNLOADING -> NativeRecoveryUpdatePresentation(
        title = "Downloading the verified APK…",
        detail = nativeUpdateDownloadDetail(status),
        action = NativeRecoveryUpdateAction.NONE,
        showProgress = true,
        progressPercent = nativeUpdateDownloadPercent(status),
    )
    NativeUpdatePhase.READY -> NativeRecoveryUpdatePresentation(
        title = "APK update is ready",
        detail = "${status.latestVersionName ?: "The newer APK"} has been downloaded and verified " +
            "against this installed application's signing certificate. Android will ask you to " +
            "confirm the installation.",
        action = NativeRecoveryUpdateAction.INSTALL,
        actionLabel = "Install verified update",
    )
    NativeUpdatePhase.PERMISSION_REQUIRED -> NativeRecoveryUpdatePresentation(
        title = "Allow APK installation",
        detail = "Android must allow Malink to request package installation before the verified " +
            "update can open its system confirmation screen. Your app data is not removed.",
        action = NativeRecoveryUpdateAction.OPEN_INSTALL_PERMISSION,
        actionLabel = "Open Android permission",
    )
    NativeUpdatePhase.INSTALLING -> NativeRecoveryUpdatePresentation(
        title = "Confirm the APK update in Android",
        detail = "The verified update was submitted to Android. Complete the system installation " +
            "confirmation; Malink will retain its existing app data.",
        action = NativeRecoveryUpdateAction.NONE,
        showProgress = true,
    )
    NativeUpdatePhase.FAILED -> NativeRecoveryUpdatePresentation(
        title = "APK update could not be prepared",
        detail = nativeUpdateFailureDetail(status.detailCode),
        action = NativeRecoveryUpdateAction.CHECK,
        actionLabel = "Retry Official update check",
    )
}

internal fun nativeRecoveryUpdateShouldPoll(status: NativeUpdateStatus): Boolean = when (status.phase) {
    NativeUpdatePhase.CHECKING,
    NativeUpdatePhase.AVAILABLE,
    NativeUpdatePhase.DOWNLOADING,
    NativeUpdatePhase.INSTALLING,
    -> true
    else -> false
}

private fun nativeUpdateDownloadPercent(status: NativeUpdateStatus): Int? {
    val downloaded = status.downloadedBytes ?: return null
    val total = status.totalBytes?.takeIf { it > 0L } ?: return null
    return ((downloaded.coerceIn(0L, total) * 100L) / total).toInt()
}

private fun nativeUpdateDownloadDetail(status: NativeUpdateStatus): String {
    val downloaded = status.downloadedBytes
    val total = status.totalBytes
    val amount = if (downloaded != null && total != null && total > 0L) {
        "${formatMiB(downloaded)} of ${formatMiB(total)}"
    } else {
        "Download progress is starting"
    }
    return "$amount. Malink will verify the size, SHA-256 digest, package identity, version, " +
        "and signing certificate before installation is offered."
}

private fun formatMiB(bytes: Long): String {
    val tenths = (bytes.coerceAtLeast(0L) * 10L) / (1024L * 1024L)
    return "${tenths / 10L}.${tenths % 10L} MB"
}

private fun nativeUpdateFailureDetail(detailCode: String?): String {
    val explanation = when {
        detailCode == null -> "The Official release check did not finish."
        detailCode.startsWith("manifest_http_") ->
            "The Official release channel did not return a usable update manifest."
        detailCode.startsWith("artifact_http_") ->
            "GitHub did not return the immutable APK download."
        detailCode.contains("timeout") || detailCode.contains("socket") ||
            detailCode.contains("connect") ->
            "The device could not reach the Official release channel in time. Check its internet " +
                "connection and retry."
        detailCode.startsWith("release_") ->
            "The published update metadata was rejected by Malink's compatibility checks."
        detailCode.startsWith("artifact_") || detailCode.startsWith("apk_") ->
            "The downloaded APK did not pass Malink's integrity or signing checks."
        detailCode.startsWith("install_") ->
            "Android could not prepare the verified APK installation."
        else -> "The Official release check failed before a verified APK became ready."
    }
    val diagnostic = detailCode?.takeIf(String::isNotBlank)?.let { " Diagnostic code: $it." }.orEmpty()
    return "$explanation$diagnostic Retry is safe; if it fails again, export diagnostics from " +
        "this page."
}
