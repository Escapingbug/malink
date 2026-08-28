package id.my.anciety.malink.web

import id.my.anciety.malink.config.StaticServiceEndpoint

internal fun staticServiceSettingsChoices(
    selected: StaticServiceEndpoint,
    official: StaticServiceEndpoint,
    usesCustom: Boolean,
): Array<String> = arrayOf(
    buildString {
        append("Official PWA")
        if (!usesCustom) append(" (current)")
        append('\n')
        append(official.baseUrl)
    },
    buildString {
        append("Custom PWA address…")
        if (usesCustom) append(" (current)")
        append('\n')
        append(
            if (usesCustom) {
                selected.baseUrl
            } else {
                "Use a mirror or self-hosted HTTPS address"
            },
        )
    },
)
