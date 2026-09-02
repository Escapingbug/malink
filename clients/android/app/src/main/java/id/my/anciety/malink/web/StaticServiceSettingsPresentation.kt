package id.my.anciety.malink.web

import id.my.anciety.malink.config.StaticServiceEndpoint

internal data class StaticServiceSettingsPresentation(
    val currentSource: String,
    val currentBaseUrl: String,
    val officialAction: String,
    val officialBaseUrl: String,
    val customAction: String,
    val customDetail: String,
)

internal fun staticServiceSettingsPresentation(
    selected: StaticServiceEndpoint,
    official: StaticServiceEndpoint,
    usesCustom: Boolean,
): StaticServiceSettingsPresentation = StaticServiceSettingsPresentation(
    currentSource = if (usesCustom) "Custom PWA" else "Official PWA",
    currentBaseUrl = selected.baseUrl,
    officialAction = "Switch to official PWA",
    officialBaseUrl = official.baseUrl,
    customAction = if (usesCustom) "Edit custom PWA address" else "Set a custom PWA address",
    customDetail = if (usesCustom) {
        selected.baseUrl
    } else {
        "Use a trusted mirror or self-hosted HTTPS address"
    },
)
