package id.my.anciety.malink.client

/** Called under the runtime mutex. Never owns projection persistence or notifications. */
internal class DeploymentPresentationPolicy {
    private var pending = false

    fun update(defer: Boolean, publish: () -> Unit) {
        pending = true
        if (!defer) flush(publish)
    }

    fun flush(publish: () -> Unit) {
        if (!pending) return
        publish()
        pending = false
    }

    fun clear() { pending = false }
}

internal fun deferDeploymentPresentation(
    type: String?,
    caused: Boolean,
    foreground: Boolean,
    cacheReady: Boolean,
    coalescing: Boolean,
): Boolean = type == "gateway.deployment.status" && !caused && !foreground && cacheReady && coalescing
