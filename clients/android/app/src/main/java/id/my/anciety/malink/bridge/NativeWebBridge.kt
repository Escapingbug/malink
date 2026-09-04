package id.my.anciety.malink.bridge

import android.webkit.WebView
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import id.my.anciety.malink.diagnostics.DiagnosticRecorder
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

class NativeWebBridge(
    private val webView: WebView,
    runtime: BridgeRuntime,
    private val trustedWebOrigin: TrustedWebOrigin,
    diagnostics: DiagnosticRecorder = DiagnosticRecorder.None,
) {
    @Volatile private var notificationSink: ((String) -> Unit)? = null
    private val dispatcher = BridgeDispatcher(
        runtime = runtime,
        eventSink = { notification ->
            webView.post { notificationSink?.invoke(notification) }
        },
        unexpectedFailureSink = { method, error ->
            diagnostics.record(
                "bridge.request.unexpected_failure",
                mapOf(
                    "action" to method,
                    "error" to error.javaClass.simpleName
                        .replace(Regex("[^A-Za-z0-9._:+/-]"), "_")
                        .take(160)
                        .ifBlank { "Exception" },
                ),
            )
        },
    )
    private val dispatchScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var installed = false

    fun install(): Boolean {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) return false
        WebViewCompat.addWebMessageListener(
            webView,
            BRIDGE_OBJECT_NAME,
            setOf(trustedWebOrigin.appOrigin),
        ) { _, message, sourceOrigin, isMainFrame, replyProxy ->
            val messageData = message.data
            val immediateFailure = when {
                !isMainFrame || !trustedWebOrigin.isTrustedOrigin(sourceOrigin.toString()) ->
                    BridgeProtocol.failure(
                        null,
                        BridgeError.UNAUTHORIZED_ORIGIN,
                        "Native bridge is only available to the Malink main frame.",
                    )
                message.type != WebMessageCompat.TYPE_STRING || messageData == null ->
                    BridgeProtocol.failure(
                        null,
                        BridgeError.INVALID_REQUEST,
                        "Native bridge accepts JSON text messages only.",
                    )
                else -> null
            }
            if (immediateFailure != null) {
                replyProxy.postMessage(immediateFailure)
            } else {
                notificationSink = { notification -> replyProxy.postMessage(notification) }
                dispatchScope.launch {
                    val response = dispatcher.dispatch(messageData!!)
                    webView.post { replyProxy.postMessage(response) }
                }
            }
        }
        installed = true
        return true
    }

    fun close() {
        if (!installed) return
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            WebViewCompat.removeWebMessageListener(webView, BRIDGE_OBJECT_NAME)
        }
        installed = false
        notificationSink = null
        dispatchScope.cancel()
    }

    private companion object {
        const val BRIDGE_OBJECT_NAME = "malinkNative"
    }
}
