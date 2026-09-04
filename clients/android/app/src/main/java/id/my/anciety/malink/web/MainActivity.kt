package id.my.anciety.malink.web

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.app.AlertDialog
import android.content.ClipData
import android.content.ActivityNotFoundException
import android.content.ComponentName
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.content.pm.PackageManager
import android.graphics.BitmapFactory
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.net.http.SslError
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.os.IBinder
import android.provider.MediaStore
import android.provider.OpenableColumns
import android.provider.Settings
import android.text.InputType
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.CookieManager
import android.webkit.PermissionRequest
import android.webkit.RenderProcessGoneDetail
import android.webkit.SslErrorHandler
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebStorage
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import android.util.Base64
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.lifecycle.lifecycleScope
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.core.content.IntentCompat
import androidx.core.graphics.Insets
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import id.my.anciety.malink.BuildConfig
import id.my.anciety.malink.R
import id.my.anciety.malink.bridge.BridgeRuntime
import id.my.anciety.malink.bridge.BridgeError
import id.my.anciety.malink.bridge.BridgeRuntimeFailure
import id.my.anciety.malink.bridge.NativePwaSource
import id.my.anciety.malink.bridge.NativeWebBridge
import id.my.anciety.malink.bridge.TrustedWebOrigin
import id.my.anciety.malink.client.NativeClientRuntime
import id.my.anciety.malink.client.NativePairingRejectedException
import id.my.anciety.malink.client.events.ClientSnapshot
import id.my.anciety.malink.client.events.PublicTrustState
import id.my.anciety.malink.config.StaticServiceEndpoint
import id.my.anciety.malink.config.StaticServiceStore
import id.my.anciety.malink.diagnostics.NativeDiagnosticLog
import id.my.anciety.malink.service.MalinkConnectionService
import id.my.anciety.malink.service.ActivityLaunchDecision
import id.my.anciety.malink.service.PersistentConnectionPower
import id.my.anciety.malink.service.ServicePreferenceStore
import id.my.anciety.malink.service.ServiceStartPolicy
import id.my.anciety.malink.update.NativeUpdateManager
import id.my.anciety.malink.update.NativeUpdatePhase
import id.my.anciety.malink.update.NativeUpdateStatus
import id.my.anciety.malink.matrix.MatrixBootstrap
import id.my.anciety.malink.matrix.PublicMatrixSession
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import java.io.File
import kotlin.coroutines.resume

class MainActivity : ComponentActivity() {
    private var serviceBinder: MalinkConnectionService.LocalBinder? = null
    private var serviceBound = false
    private var bindingRequested = false
    private var serviceConnectionInterrupted = false
    private var serviceBinderReady = CompletableDeferred<MalinkConnectionService.LocalBinder>()
    private lateinit var contentHost: FrameLayout
    private var webView: WebView? = null
    private var webLoadingOverlay: View? = null
    private var nativeBridge: NativeWebBridge? = null
    private var foreground = false
    private var webViewResumed = false
    private var pendingForegroundStart = false
    private var pendingSessionId: String? = null
    private var pendingAuthorizationTransfer: String? = null
    private var authorizationImportGeneration = 0L
    private var nativeBackDispatchPending = false
    private var nativeBackDispatchGeneration = 0L
    private val staticServiceStore by lazy { StaticServiceStore(this) }
    private var pendingStaticServiceTimeout: Job? = null
    private lateinit var trustedWebOrigin: TrustedWebOrigin
    private val diagnostics by lazy { NativeDiagnosticLog.get(this) }
    private val updateManager: NativeUpdateManager? by lazy {
        runCatching { NativeUpdateManager.get(this) }
            .onFailure { error ->
                diagnostics.record(
                    "update.initialization_failed",
                    mapOf("error" to error.javaClass.simpleName.take(160)),
                )
            }
            .getOrNull()
    }
    private var pendingNativeUpdateInstall = false
    private var pendingWebPermissionRequest: PermissionRequest? = null
    private var pendingFileChooser: ValueCallback<Array<Uri>>? = null
    private var pendingCameraCaptureUri: Uri? = null
    private var pendingCameraIntent: Intent? = null

    private val cameraPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted ->
        val request = pendingWebPermissionRequest.also { pendingWebPermissionRequest = null }
        if (request != null) {
            if (
                granted &&
                trustedWebOrigin.isTrustedOrigin(request.origin.toString()) &&
                request.resources.contains(PermissionRequest.RESOURCE_VIDEO_CAPTURE)
            ) {
                request.grant(arrayOf(PermissionRequest.RESOURCE_VIDEO_CAPTURE))
            } else {
                request.deny()
            }
            return@registerForActivityResult
        }

        val cameraIntent = pendingCameraIntent.also { pendingCameraIntent = null }
        if (granted && cameraIntent != null) {
            fileChooserLauncher.launch(cameraIntent)
        } else {
            finishFileChooser(null)
        }
    }

    private val fileChooserLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult(),
    ) { result ->
        val cameraUri = pendingCameraCaptureUri.also { pendingCameraCaptureUri = null }
        val selected = when {
            result.resultCode != Activity.RESULT_OK -> null
            result.data?.data != null -> arrayOf(result.data!!.data!!)
            cameraUri != null -> arrayOf(cameraUri)
            else -> null
        }
        finishFileChooser(selected)
    }

    private val notificationPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted ->
        preferences.edit().putBoolean(KEY_NOTIFICATION_REQUESTED, true).apply()
        if (granted && notificationsAvailable()) {
            if (persistentPowerAvailable()) startForegroundAndBind()
            else showPowerGate()
        } else {
            showNotificationGate()
        }
    }

    private val serviceConnection = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName, service: IBinder) {
            bindingRequested = false
            serviceBound = true
            serviceBinder = service as MalinkConnectionService.LocalBinder
            if (!serviceBinderReady.isCompleted) serviceBinderReady.complete(serviceBinder!!)
            serviceBinder?.setUiForeground(foreground)
            val reloadWebHost = serviceConnectionInterrupted || pendingForegroundStart
            serviceConnectionInterrupted = false
            diagnostics.record(
                "activity.service_connected",
                mapOf(
                    "stage" to when {
                        webView == null -> "create"
                        reloadWebHost -> "reload"
                        else -> "keep"
                    },
                ),
            )
            if (
                pendingForegroundStart &&
                notificationsAvailable() &&
                persistentPowerAvailable()
            ) {
                serviceBinder?.startInBackground()
                pendingForegroundStart = false
            }
            showWebHost(reloadExisting = reloadWebHost)
        }

        override fun onServiceDisconnected(name: ComponentName) {
            serviceBinder = null
            serviceBound = false
            bindingRequested = false
            serviceConnectionInterrupted = true
            serviceBinderReady = CompletableDeferred()
            if (foreground && notificationsAvailable()) {
                showRecoveryPage("The native host stopped unexpectedly.")
            }
        }
    }

    private val preferences by lazy {
        getSharedPreferences("malink-native-host-ui", Context.MODE_PRIVATE)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        trustedWebOrigin = TrustedWebOrigin(staticServiceStore.selected)
        monitorPendingStaticServiceSwitch()
        configureEdgeToEdgeContent()
        diagnostics.record("activity.created")
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                dispatchNativeBack()
            }
        })
        handleIntent(intent)
        if (ServicePreferenceStore(this).accountSetupRequired) {
            clearHostedAccountStateAfterSignOut()
        }
        showWebHost()
        ensureHostBound()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleIntent(intent)
    }

    override fun onStart() {
        super.onStart()
        foreground = true
        serviceBinder?.setUiForeground(true)
        resumePersistentHost()
    }

    override fun onResume() {
        super.onResume()
        webViewResumed = true
        webView?.apply {
            resumeTimers()
            onResume()
        }
        if (pendingNativeUpdateInstall && packageManager.canRequestPackageInstalls()) {
            pendingNativeUpdateInstall = false
            installNativeUpdate()
        }
        resumePersistentHost()
    }

    override fun onPause() {
        webViewResumed = false
        webView?.apply {
            onPause()
            pauseTimers()
        }
        super.onPause()
    }

    override fun onStop() {
        foreground = false
        serviceBinder?.setUiForeground(false)
        super.onStop()
    }

    override fun onDestroy() {
        diagnostics.record("activity.destroyed")
        if (serviceBound || bindingRequested) {
            runCatching { unbindService(serviceConnection) }
            serviceBound = false
            bindingRequested = false
            serviceBinder = null
        }
        if (!serviceBinderReady.isCompleted) serviceBinderReady.cancel()
        nativeBackDispatchGeneration += 1
        nativeBackDispatchPending = false
        nativeBridge?.close()
        nativeBridge = null
        pendingWebPermissionRequest?.deny()
        pendingWebPermissionRequest = null
        pendingFileChooser?.onReceiveValue(null)
        pendingFileChooser = null
        pendingCameraCaptureUri = null
        pendingCameraIntent = null
        authorizationImportGeneration += 1
        pendingAuthorizationTransfer = null
        webView?.apply {
            stopLoading()
            loadUrl("about:blank")
            clearHistory()
            removeAllViews()
            destroy()
        }
        webView = null
        webLoadingOverlay = null
        super.onDestroy()
    }

    private fun dispatchNativeBack() {
        val current = webView
        if (current == null) {
            performNativeBackFallback(null)
            return
        }
        if (nativeBackDispatchPending) return

        nativeBackDispatchPending = true
        val generation = ++nativeBackDispatchGeneration
        current.postDelayed({
            if (!nativeBackDispatchPending || nativeBackDispatchGeneration != generation) return@postDelayed
            nativeBackDispatchPending = false
            if (current !== webView || isFinishing || isDestroyed) return@postDelayed
            performNativeBackFallback(current)
        }, NATIVE_BACK_RESPONSE_TIMEOUT_MS)

        runCatching {
            current.evaluateJavascript(NATIVE_BACK_DISPATCH_SCRIPT) { result ->
                if (!nativeBackDispatchPending || nativeBackDispatchGeneration != generation) {
                    return@evaluateJavascript
                }
                nativeBackDispatchPending = false
                if (current !== webView || isFinishing || isDestroyed) return@evaluateJavascript
                if (!nativeBackWasHandled(result)) performNativeBackFallback(current)
            }
        }.onFailure {
            if (nativeBackDispatchGeneration == generation) {
                nativeBackDispatchPending = false
                if (current === webView && !isFinishing && !isDestroyed) {
                    performNativeBackFallback(current)
                }
            }
        }
    }

    private fun performNativeBackFallback(current: WebView?) {
        when (nativeBackFallbackAction(current?.canGoBack() == true)) {
            NativeBackFallbackAction.WEB_HISTORY -> current?.goBack()
            NativeBackFallbackAction.BACKGROUND_TASK -> {
                if (!moveTaskToBack(true)) finish()
            }
        }
    }

    private fun notificationsAvailable(): Boolean {
        val permissionGranted = Build.VERSION.SDK_INT < 33 ||
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) ==
            PackageManager.PERMISSION_GRANTED
        return permissionGranted && NotificationManagerCompat.from(this).areNotificationsEnabled()
    }

    private fun persistentPowerAvailable(): Boolean =
        PersistentConnectionPower.isExempt(this)

    private fun resumePersistentHost() {
        val persistentConnectionExpected = pendingForegroundStart ||
            ServicePreferenceStore(this).restoreEnabled
        when {
            persistentConnectionExpected && !notificationsAvailable() -> {
                pendingForegroundStart = true
                showNotificationGate()
            }
            persistentConnectionExpected && !persistentPowerAvailable() -> {
                pendingForegroundStart = true
                showPowerGate()
            }
            pendingForegroundStart -> startForegroundAndBind()
            else -> ensureHostBound()
        }
    }

    private fun ensureHostBound() {
        if (serviceBound || bindingRequested) return
        val servicePreferences = ServicePreferenceStore(this)
        val restoreEnabled = servicePreferences.restoreEnabled
        val restorePreferenceExists = servicePreferences.hasRestorePreference
        when (ServiceStartPolicy.activityLaunch(
            restoreEnabled,
            restorePreferenceExists,
            notificationsAvailable(),
            persistentPowerAvailable(),
        )) {
            ActivityLaunchDecision.BIND_ONLY -> bindHostOnly()
            ActivityLaunchDecision.RESTORE_FOREGROUND -> {
                if (restorePreferenceExists) {
                    MalinkConnectionService.restoreIfEnabled(this)
                } else {
                    MalinkConnectionService.startFromUser(this)
                }
                bindHostOnly()
            }
            ActivityLaunchDecision.WAIT_FOR_NOTIFICATION -> {
                pendingForegroundStart = true
                showNotificationGate()
            }
            ActivityLaunchDecision.WAIT_FOR_POWER_EXEMPTION -> {
                pendingForegroundStart = true
                showPowerGate()
            }
        }
    }

    private fun bindHostOnly() {
        if (serviceBound || bindingRequested) return
        bindingRequested = bindService(
            Intent(this, MalinkConnectionService::class.java),
            serviceConnection,
            Context.BIND_AUTO_CREATE,
        )
        diagnostics.record(
            "activity.service_binding_requested",
            mapOf("available" to bindingRequested.toString()),
        )
        if (!bindingRequested) {
            if (!serviceBinderReady.isCompleted) {
                serviceBinderReady.completeExceptionally(
                    IllegalStateException("The native host service could not be bound."),
                )
            }
            showRecoveryPage("The native host service could not be bound.")
        }
    }

    private fun startForegroundAndBind() {
        pendingForegroundStart = true
        if (!notificationsAvailable()) {
            showNotificationGate()
            return
        }
        if (!persistentPowerAvailable()) {
            showPowerGate()
            return
        }
        MalinkConnectionService.startFromUser(this)
        serviceBinder?.let {
            it.startInBackground()
            pendingForegroundStart = false
            showWebHost(reloadExisting = true)
            return
        }
        bindHostOnly()
    }

    private fun showNotificationGate() {
        val requested = preferences.getBoolean(KEY_NOTIFICATION_REQUESTED, false)
        val canRequest = Build.VERSION.SDK_INT >= 33 &&
            (!requested || shouldShowRequestPermissionRationale(Manifest.permission.POST_NOTIFICATIONS))
        showContent(messageView(
            title = "Persistent notification required",
            detail = "Malink needs a visible notification before its persistent native connection can start. Denying this permission leaves the native connection stopped.",
            action = if (canRequest) "Allow notification" else "Open notification settings",
        ) {
            if (canRequest) {
                notificationPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
            } else {
                openNotificationSettings()
            }
        })
    }

    private fun showPowerGate() {
        pendingForegroundStart = true
        showContent(messageView(
            title = "Persistent connection required",
            detail = "Allow Malink to stay connected while the screen is off. Android otherwise pauses Matrix updates and task notifications during device idle.",
            action = "Allow persistent connection",
        ) {
            val requested = runCatching {
                startActivity(PersistentConnectionPower.requestIntent(this))
            }.isSuccess
            if (!requested) {
                runCatching {
                    startActivity(PersistentConnectionPower.settingsIntent(this))
                }.onFailure {
                    openApplicationSettings()
                }
            }
        })
    }

    private fun openApplicationSettings() {
        startActivity(
            Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
                .setData(Uri.parse("package:$packageName")),
        )
    }

    private fun openNotificationSettings() {
        val intent = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                .putExtra(Settings.EXTRA_APP_PACKAGE, packageName)
        } else {
            Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
                .setData(Uri.parse("package:$packageName"))
        }
        runCatching { startActivity(intent) }
            .onFailure {
                startActivity(
                    Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
                        .setData(Uri.parse("package:$packageName")),
                )
            }
    }

    private fun showStaticServiceSettings() {
        val selected = staticServiceStore.selected
        val official = staticServiceStore.official
        val presentation = staticServiceSettingsPresentation(
            selected = selected,
            official = official,
            usesCustom = staticServiceStore.usesCustom,
        )
        val officialButton = staticServiceSettingsAction(
            presentation.officialAction,
            presentation.officialBaseUrl,
        )
        val customButton = staticServiceSettingsAction(
            presentation.customAction,
            presentation.customDetail,
        )
        val panel = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(20), dp(4), dp(20), dp(4))
            addView(TextView(context).apply {
                text = "Choose where the Android app loads the Malink interface and update channel."
                textSize = 13f
                setTextColor(0xFF5F6878.toInt())
            })
            addView(LinearLayout(context).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(dp(14), dp(12), dp(14), dp(12))
                background = GradientDrawable().apply {
                    cornerRadius = dp(12).toFloat()
                    setColor(0xFFF5F3FF.toInt())
                    setStroke(dp(1), 0xFFD9D3F7.toInt())
                }
                addView(TextView(context).apply {
                    text = "CURRENT · ${presentation.currentSource}"
                    textSize = 11f
                    setTextColor(0xFF6856C9.toInt())
                    setTypeface(typeface, Typeface.BOLD)
                })
                addView(TextView(context).apply {
                    text = presentation.currentBaseUrl
                    textSize = 13f
                    setTextColor(0xFF303748.toInt())
                    setTextIsSelectable(true)
                    setPadding(0, dp(5), 0, 0)
                })
            }, staticServiceSettingsLayoutParams(topMargin = 14))
            if (staticServiceStore.usesCustom) {
                addView(officialButton, staticServiceSettingsLayoutParams(topMargin = 12))
            }
            addView(customButton, staticServiceSettingsLayoutParams(topMargin = 12))
            addView(TextView(context).apply {
                text = "A custom PWA can use the native bridge. Only enter an HTTPS address you trust."
                textSize = 11f
                setTextColor(0xFF767F8F.toInt())
            }, staticServiceSettingsLayoutParams(topMargin = 12))
        }
        val dialog = AlertDialog.Builder(this)
            .setTitle("PWA address")
            .setView(panel)
            .setNegativeButton("Close", null)
            .create()
        officialButton.setOnClickListener {
            dialog.dismiss()
            confirmStaticService(official, custom = false)
        }
        customButton.setOnClickListener {
            dialog.dismiss()
            showCustomStaticServiceDialog(staticServiceStore.custom ?: selected)
        }
        dialog.show()
    }

    private fun staticServiceSettingsAction(title: String, detail: String): Button =
        Button(this).apply {
            text = "$title\n$detail"
            isAllCaps = false
            gravity = Gravity.START or Gravity.CENTER_VERTICAL
            minHeight = dp(64)
            textSize = 13f
            setPadding(dp(14), dp(8), dp(14), dp(8))
        }

    private fun staticServiceSettingsLayoutParams(topMargin: Int): LinearLayout.LayoutParams =
        LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            LinearLayout.LayoutParams.WRAP_CONTENT,
        ).apply {
            this.topMargin = dp(topMargin)
        }

    private fun showCustomStaticServiceDialog(current: StaticServiceEndpoint) {
        val input = EditText(this).apply {
            setText(current.baseUrl)
            selectAll()
            hint = "https://static.example/malink/"
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
            setSingleLine(true)
        }
        val dialog = AlertDialog.Builder(this)
            .setTitle("Custom PWA address")
            .setMessage(
                "Enter the base URL that contains the Malink index page, version.json, " +
                    "and optionally native-updates/.",
            )
            .setView(input)
            .setPositiveButton("Continue", null)
            .setNegativeButton("Cancel", null)
            .create()
        dialog.setOnShowListener {
            dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
                val endpoint = runCatching {
                    StaticServiceEndpoint.parse(
                        input.text.toString(),
                        BuildConfig.ALLOW_INSECURE_E2E_LOOPBACK,
                    )
                }.getOrElse { error ->
                    input.error = error.message ?: "Invalid static service URL."
                    return@setOnClickListener
                }
                dialog.dismiss()
                confirmStaticService(endpoint, custom = true)
            }
        }
        dialog.show()
    }

    private fun confirmStaticService(endpoint: StaticServiceEndpoint, custom: Boolean) {
        if (
            endpoint.baseUrl == staticServiceStore.selected.baseUrl &&
            custom == staticServiceStore.usesCustom
        ) return
        val trustWarning = if (custom) {
            "Only continue if you trust this service. Its JavaScript receives the Malink native " +
                "bridge and can issue actions allowed by this device. Private keys and Matrix " +
                "access tokens still remain in Android.\n\n"
        } else {
            ""
        }
        AlertDialog.Builder(this)
            .setTitle("Use this PWA address?")
            .setMessage(
                "$trustWarning${endpoint.baseUrl}\n\n" +
                    "The UI will reload. Browser storage belongs to each service origin, while " +
                    "the native Matrix session remains on this device.",
            )
            .setPositiveButton("Use service") { _, _ ->
                val pending = staticServiceStore.beginSelection(endpoint, custom)
                trustedWebOrigin = TrustedWebOrigin(pending.endpoint)
                monitorPendingStaticServiceSwitch(pending.startedAt)
                diagnostics.record(
                    "activity.static_service_switch_started",
                    mapOf("source" to if (custom) "custom" else "official"),
                )
                replaceWebHostForStaticService()
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

    private fun monitorPendingStaticServiceSwitch(expectedStartedAt: Long? = null) {
        pendingStaticServiceTimeout?.cancel()
        val pending = staticServiceStore.pending() ?: return
        if (expectedStartedAt != null && pending.startedAt != expectedStartedAt) return
        pendingStaticServiceTimeout = lifecycleScope.launch {
            delay((pending.expiresAt - System.currentTimeMillis()).coerceAtLeast(1L))
            if (!staticServiceStore.rollbackPending(pending.startedAt)) return@launch
            trustedWebOrigin = TrustedWebOrigin(staticServiceStore.committed)
            diagnostics.record(
                "activity.static_service_switch_rolled_back",
                mapOf("reason" to "presentation_activation_timeout"),
            )
            Toast.makeText(
                this@MainActivity,
                "The new PWA did not connect to Android. Restored the previous service.",
                Toast.LENGTH_LONG,
            ).show()
            replaceWebHostForStaticService()
        }
    }

    private fun commitPendingStaticServiceSwitch() {
        val pending = staticServiceStore.pending() ?: return
        if (!staticServiceStore.commitPending(pending.startedAt)) return
        pendingStaticServiceTimeout?.cancel()
        pendingStaticServiceTimeout = null
        trustedWebOrigin = TrustedWebOrigin(staticServiceStore.committed)
        updateManager?.onStaticServiceChanged()
        lifecycleScope.launch(Dispatchers.IO) {
            updateManager?.checkStaticRelease(force = true)
        }
        diagnostics.record(
            "activity.static_service_switch_committed",
            mapOf("source" to if (pending.usesCustom) "custom" else "official"),
        )
    }

    private fun replaceWebHostForStaticService() {
        nativeBridge?.close()
        nativeBridge = null
        webView?.apply {
            stopLoading()
            loadUrl("about:blank")
            clearHistory()
            removeAllViews()
            destroy()
        }
        webView = null
        showWebHost()
    }

    private fun isStaticServiceSettingsUrl(uri: Uri): Boolean =
        uri.scheme == "malink" &&
            uri.host == "static-service-settings" &&
            uri.path.isNullOrEmpty() &&
            uri.query == null &&
            uri.fragment == null

    private fun showWebHost(reloadExisting: Boolean = false) {
        val existing = webView
        when (webHostActionAfterServiceConnected(existing != null, reloadExisting)) {
            WebHostBindingAction.KEEP -> {
                checkNotNull(existing)
                showContent(existing)
                diagnostics.record("activity.web_host_kept_during_bind")
                return
            }
            WebHostBindingAction.RELOAD -> {
                checkNotNull(existing)
                showContent(existing)
                showWebLoading(
                    title = "Refreshing Malink…",
                    detail = "Restoring the secure interface and its current operation status.",
                )
                diagnostics.record("activity.web_host_reloading_after_bind")
                val target = pendingWebAppUrl()
                if (target == trustedWebOrigin.appUrl) existing.reload() else existing.loadUrl(target)
                return
            }
            WebHostBindingAction.CREATE -> Unit
        }

        val created = WebView(this)
        webView = created
        configureWebView(created)
        if (!webViewResumed) {
            created.onPause()
            created.pauseTimers()
        }
        val bridge = NativeWebBridge(
            created,
            ActivityBridgeRuntime(),
            trustedWebOrigin,
            diagnostics,
        )
        if (!bridge.install()) {
            created.destroy()
            webView = null
            showRecoveryPage("This Android System WebView does not support the secure Malink bridge. Update Android System WebView and retry.")
            return
        }
        nativeBridge = bridge
        showContent(created)
        showWebLoading(
            title = "Loading Malink…",
            detail = "Connecting the secure interface to the native background service.",
        )
        diagnostics.record("activity.web_host_created")
        created.loadUrl(pendingWebAppUrl())
    }

    private fun configureEdgeToEdgeContent() {
        WindowCompat.setDecorFitsSystemWindows(window, false)
        // Insets below are the single source of truth for keyboard avoidance.
        // Prevent the platform from also panning or resizing the same content.
        window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_NOTHING)

        contentHost = FrameLayout(this).apply {
            setBackgroundColor(0xFFF4F6FA.toInt())
        }
        ViewCompat.setOnApplyWindowInsetsListener(contentHost) { host, windowInsets ->
            val resolved = resolveNativeWebInsets(
                systemBars = windowInsets.getInsets(WindowInsetsCompat.Type.systemBars()).toEdges(),
                displayCutout = windowInsets.getInsets(WindowInsetsCompat.Type.displayCutout()).toEdges(),
                mandatoryGestures = windowInsets
                    .getInsets(WindowInsetsCompat.Type.mandatorySystemGestures())
                    .toEdges(),
                ime = windowInsets.getInsets(WindowInsetsCompat.Type.ime()).toEdges(),
                imeVisible = windowInsets.isVisible(WindowInsetsCompat.Type.ime()),
            )
            if (
                host.paddingLeft != resolved.left ||
                host.paddingTop != resolved.top ||
                host.paddingRight != resolved.right ||
                host.paddingBottom != resolved.bottom
            ) {
                host.setPadding(resolved.left, resolved.top, resolved.right, resolved.bottom)
            }

            // The WebView is already laid out inside the native safe region.
            // Consuming here prevents a WebView implementation from applying
            // the same values again through CSS safe-area environment values.
            WindowInsetsCompat.CONSUMED
        }
        setContentView(contentHost)
        ViewCompat.requestApplyInsets(contentHost)
    }

    private fun Insets.toEdges(): InsetEdges = InsetEdges(left, top, right, bottom)

    private fun showContent(content: View) {
        if (content.parent !== contentHost) {
            (content.parent as? ViewGroup)?.removeView(content)
            contentHost.removeAllViews()
            webLoadingOverlay = null
            contentHost.addView(
                content,
                FrameLayout.LayoutParams(
                    FrameLayout.LayoutParams.MATCH_PARENT,
                    FrameLayout.LayoutParams.MATCH_PARENT,
                ),
            )
        }
        ViewCompat.requestApplyInsets(contentHost)
    }

    private fun showWebLoading(title: String, detail: String) {
        webLoadingOverlay?.let(contentHost::removeView)
        val overlay = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setPadding(dp(32), dp(32), dp(32), dp(32))
            setBackgroundColor(0xFFF4F6FA.toInt())
            addView(ProgressBar(context))
            addView(TextView(context).apply {
                text = title
                textSize = 20f
                setTextColor(0xFF111827.toInt())
                gravity = Gravity.CENTER
                setPadding(0, dp(18), 0, 0)
            })
            addView(TextView(context).apply {
                text = detail
                textSize = 14f
                setTextColor(0xFF4B5563.toInt())
                gravity = Gravity.CENTER
                setPadding(0, dp(10), 0, 0)
            })
        }
        webLoadingOverlay = overlay
        contentHost.addView(
            overlay,
            FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT,
            ),
        )
    }

    private fun hideWebLoading(view: WebView) {
        if (view !== webView) return
        webLoadingOverlay?.let(contentHost::removeView)
        webLoadingOverlay = null
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun configureWebView(view: WebView) {
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        CookieManager.getInstance().setAcceptThirdPartyCookies(view, false)
        view.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            javaScriptCanOpenWindowsAutomatically = false
            setSupportMultipleWindows(false)
            mediaPlaybackRequiresUserGesture = true
            userAgentString = "$userAgentString MalinkNative/${BuildConfig.VERSION_NAME}"
        }
        view.webViewClient = object : WebViewClient() {
            override fun onPageCommitVisible(view: WebView, url: String) {
                hideWebLoading(view)
                diagnostics.record("activity.web_page_visible")
            }

            override fun onPageFinished(view: WebView, url: String) {
                diagnostics.record("activity.web_page_finished")
            }

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                if (!request.isForMainFrame) return false
                val url = request.url.toString()
                if (
                    isStaticServiceSettingsUrl(request.url) &&
                    trustedWebOrigin.isTrustedUrl(view.url)
                ) {
                    showStaticServiceSettings()
                    return true
                }
                if (trustedWebOrigin.isTrustedUrl(url)) return false
                openExternalUrl(request.url)
                return true
            }

            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (request.isForMainFrame) showRecoveryPage("The online Malink UI could not be loaded.")
            }

            override fun onReceivedHttpError(
                view: WebView,
                request: WebResourceRequest,
                errorResponse: WebResourceResponse,
            ) {
                if (request.isForMainFrame && errorResponse.statusCode >= 400) {
                    showRecoveryPage("The online Malink UI returned HTTP ${errorResponse.statusCode}.")
                }
            }

            override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) {
                handler.cancel()
                showRecoveryPage("The Malink server certificate could not be verified.")
            }

            override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                nativeBridge?.close()
                nativeBridge = null
                webView = null
                view.destroy()
                showRecoveryPage("Android System WebView stopped. The native service is still running.")
                return true
            }
        }
        view.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest) {
                runOnUiThread {
                    if (
                        !trustedWebOrigin.isTrustedOrigin(request.origin.toString()) ||
                        !request.resources.contains(PermissionRequest.RESOURCE_VIDEO_CAPTURE)
                    ) {
                        request.deny()
                        return@runOnUiThread
                    }
                    pendingWebPermissionRequest?.deny()
                    if (
                        ContextCompat.checkSelfPermission(
                            this@MainActivity,
                            Manifest.permission.CAMERA,
                        ) == PackageManager.PERMISSION_GRANTED
                    ) {
                        request.grant(arrayOf(PermissionRequest.RESOURCE_VIDEO_CAPTURE))
                    } else {
                        pendingWebPermissionRequest = request
                        cameraPermissionLauncher.launch(Manifest.permission.CAMERA)
                    }
                }
            }

            override fun onPermissionRequestCanceled(request: PermissionRequest) {
                if (pendingWebPermissionRequest === request) {
                    pendingWebPermissionRequest = null
                }
            }

            override fun onShowFileChooser(
                webView: WebView,
                filePathCallback: ValueCallback<Array<Uri>>,
                fileChooserParams: FileChooserParams,
            ): Boolean {
                if (!trustedWebOrigin.isTrustedUrl(webView.url.orEmpty())) return false

                pendingFileChooser?.onReceiveValue(null)
                pendingFileChooser = filePathCallback
                val intent = if (fileChooserParams.isCaptureEnabled) {
                    createQrCameraIntent()
                } else {
                    val mimePolicy = webFileChooserMimePolicy(fileChooserParams.acceptTypes)
                    Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                        addCategory(Intent.CATEGORY_OPENABLE)
                        type = mimePolicy.type
                        if (mimePolicy.acceptedMimeTypes.isNotEmpty()) {
                            putExtra(
                                Intent.EXTRA_MIME_TYPES,
                                mimePolicy.acceptedMimeTypes.toTypedArray(),
                            )
                        }
                    }
                }
                if (intent == null) {
                    finishFileChooser(null)
                    return true
                }
                if (
                    fileChooserParams.isCaptureEnabled &&
                    ContextCompat.checkSelfPermission(
                        this@MainActivity,
                        Manifest.permission.CAMERA,
                    ) != PackageManager.PERMISSION_GRANTED
                ) {
                    pendingCameraIntent = intent
                    cameraPermissionLauncher.launch(Manifest.permission.CAMERA)
                } else {
                    fileChooserLauncher.launch(intent)
                }
                return true
            }
        }
    }

    private fun finishFileChooser(value: Array<Uri>?) {
        pendingCameraIntent = null
        if (value == null) pendingCameraCaptureUri = null
        pendingFileChooser.also { pendingFileChooser = null }?.onReceiveValue(value)
    }

    private fun createQrCameraIntent(): Intent? {
        val captureDirectory = File(cacheDir, "qr-captures").apply { mkdirs() }
        val captureFile = File.createTempFile("qr-", ".jpg", captureDirectory)
        val captureUri = FileProvider.getUriForFile(
            this,
            "$packageName.fileprovider",
            captureFile,
        )
        val intent = Intent(android.provider.MediaStore.ACTION_IMAGE_CAPTURE).apply {
            putExtra(android.provider.MediaStore.EXTRA_OUTPUT, captureUri)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
            clipData = ClipData.newRawUri("Malink QR capture", captureUri)
        }
        if (intent.resolveActivity(packageManager) == null) {
            captureFile.delete()
            return null
        }
        pendingCameraCaptureUri = captureUri
        return intent
    }

    private fun openExternalUrl(uri: Uri) {
        try {
            startActivity(Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE))
        } catch (_: ActivityNotFoundException) {
            showRecoveryPage("No application can open this external link.")
        }
    }

    private fun handleIntent(intent: Intent?) {
        when (intent?.action) {
            Intent.ACTION_VIEW, Intent.ACTION_SEND -> importAuthorizationTransfer(intent)
            ACTION_EXPORT_DIAGNOSTICS -> {
                intent.action = null
                exportDiagnostics()
            }
            ACTION_STATIC_SERVICE_SETTINGS -> {
                intent.action = null
                showStaticServiceSettings()
            }
            ACTION_OPEN_SESSION -> openSessionFromNotification(intent)
            ACTION_INSTALL_NATIVE_UPDATE -> {
                intent.action = null
                installNativeUpdate()
            }
            ACTION_E2E_PUBLISH_NATIVE_RELEASE -> {
                if (!BuildConfig.ALLOW_INSECURE_E2E_LOOPBACK) {
                    diagnostics.record("update.e2e_release_ignored")
                    return
                }
                intent.action = null
                val encoded = intent.getStringExtra(EXTRA_E2E_NATIVE_RELEASE)
                    ?: throw IllegalArgumentException("The E2E native release is missing.")
                val release = Json.parseToJsonElement(
                    Base64.decode(encoded, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
                        .toString(Charsets.UTF_8),
                ).jsonObject
                lifecycleScope.launch(Dispatchers.IO) {
                    updateManager?.acceptPublishedRelease(release)
                }
            }
        }
    }

    private fun importAuthorizationTransfer(intent: Intent) {
        val declaredMediaType = intent.type
        val uri = when (intent.action) {
            Intent.ACTION_VIEW -> intent.data
            Intent.ACTION_SEND -> IntentCompat.getParcelableExtra(
                intent,
                Intent.EXTRA_STREAM,
                Uri::class.java,
            )
            else -> null
        }
        intent.action = null
        intent.data = null
        intent.removeExtra(Intent.EXTRA_STREAM)
        intent.clipData = null
        if (uri?.scheme != "content") {
            diagnostics.record("authorization_file.rejected", mapOf("reason" to "invalid_uri"))
            Toast.makeText(
                this,
                "Malink could not read this authorization file.",
                Toast.LENGTH_LONG,
            ).show()
            return
        }
        val generation = ++authorizationImportGeneration
        lifecycleScope.launch {
            val result = runCatching {
                withContext(Dispatchers.IO) {
                    val mediaType = declaredMediaType ?: contentResolver.getType(uri)
                    val displayName = if (
                        mediaType.equals(AUTHORIZATION_TRANSFER_MIME_TYPE, ignoreCase = true)
                    ) {
                        null
                    } else {
                        authorizationTransferDisplayName(uri)
                    }
                    require(acceptsAuthorizationTransferFile(displayName, mediaType)) {
                        "This is not a Malink authorization file."
                    }
                    val contents = contentResolver.openInputStream(uri)?.use {
                        readAuthorizationTransfer(it)
                    } ?: throw IllegalArgumentException(
                        "The authorization file could not be opened.",
                    )
                    authorizationTransferFragment(contents)
                }
            }
            if (generation != authorizationImportGeneration || isFinishing || isDestroyed) {
                return@launch
            }
            result.onSuccess { payload ->
                pendingAuthorizationTransfer = payload
                diagnostics.record("authorization_file.opened")
                webView?.loadUrl(pendingWebAppUrl())
            }.onFailure { error ->
                diagnostics.record(
                    "authorization_file.rejected",
                    mapOf("reason" to error.javaClass.simpleName.take(160)),
                )
                Toast.makeText(
                    this@MainActivity,
                    error.message ?: "Malink could not read this authorization file.",
                    Toast.LENGTH_LONG,
                ).show()
            }
        }
    }

    private fun authorizationTransferDisplayName(uri: Uri): String? =
        contentResolver.query(
            uri,
            arrayOf(OpenableColumns.DISPLAY_NAME),
            null,
            null,
            null,
        )?.use { cursor ->
            val nameIndex = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
            if (nameIndex >= 0 && cursor.moveToFirst()) cursor.getString(nameIndex) else null
        }

    private fun installNativeUpdate() {
        val manager = updateManager
        if (manager == null) {
            Toast.makeText(
                this,
                "The update service is still starting. Try again in a moment.",
                Toast.LENGTH_LONG,
            ).show()
            return
        }
        if (manager.status().phase == NativeUpdatePhase.INSTALLING) {
            Toast.makeText(
                this,
                "The verified update is already waiting for Android confirmation.",
                Toast.LENGTH_SHORT,
            ).show()
            return
        }
        Toast.makeText(
            this,
            "Preparing the verified Malink update…",
            Toast.LENGTH_SHORT,
        ).show()
        lifecycleScope.launch {
            val result = withContext(Dispatchers.IO) { manager.installReady() }
            when (result.phase) {
                NativeUpdatePhase.PERMISSION_REQUIRED -> openNativeUpdateInstallPermission()
                NativeUpdatePhase.INSTALLING -> Toast.makeText(
                    this@MainActivity,
                    "Update prepared. Android will show the installation confirmation.",
                    Toast.LENGTH_LONG,
                ).show()
                NativeUpdatePhase.FAILED -> Toast.makeText(
                    this@MainActivity,
                    "The verified update is not ready. Reopen Malink update settings to retry.",
                    Toast.LENGTH_LONG,
                ).show()
                else -> Unit
            }
        }
    }

    private fun openNativeUpdateInstallPermission() {
        pendingNativeUpdateInstall = true
        startActivity(
            Intent(
                Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                Uri.parse("package:$packageName"),
            ),
        )
    }

    private fun openSessionFromNotification(intent: Intent) {
        intent.action = null
        val sessionId = intent.getStringExtra(EXTRA_SESSION_ID)
            ?.takeIf { it.isNotBlank() && it.length <= 512 && !it.any(Char::isISOControl) }
            ?: return
        intent.removeExtra(EXTRA_SESSION_ID)
        pendingSessionId = sessionId
        diagnostics.record(
            "notification.task_opened",
            mapOf("stage" to if (serviceBound) "bound" else "deferred"),
        )
        // If Android recreated this Activity or disconnected the service while
        // it was backgrounded, retain the target until onServiceConnected
        // reloads the Web host; navigating now would be overwritten by that
        // reload.
        if (serviceBound) webView?.loadUrl(pendingWebAppUrl())
    }

    private fun pendingWebAppUrl(): String {
        val authorization = pendingAuthorizationTransfer
        if (authorization != null) {
            pendingAuthorizationTransfer = null
            return "${trustedWebOrigin.appUrl}#authorization=${Uri.encode(authorization)}"
        }
        val sessionId = pendingSessionId ?: return trustedWebOrigin.appUrl
        pendingSessionId = null
        return "${trustedWebOrigin.appUrl}#session=${Uri.encode(sessionId)}"
    }

    private fun exportDiagnostics() {
        runCatching {
            shareDiagnostics()
        }.onFailure { error ->
            diagnostics.record(
                "diagnostics.export_failure",
                mapOf(
                    "error" to error.javaClass.simpleName
                        .replace(Regex("[^A-Za-z0-9._:+/-]"), "_")
                        .take(160),
                ),
            )
            showRecoveryPage("The native diagnostic report could not be exported.")
        }
    }

    private fun shareDiagnostics(): String {
        diagnostics.record("diagnostics.export_requested")
        val report = diagnostics.export()
        val uri = FileProvider.getUriForFile(
            this,
            "$packageName.fileprovider",
            report,
        )
        val share = Intent(Intent.ACTION_SEND)
            .setType("text/plain")
            .putExtra(Intent.EXTRA_STREAM, uri)
            .putExtra(Intent.EXTRA_SUBJECT, "Malink native diagnostics ${BuildConfig.VERSION_NAME}")
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        share.clipData = ClipData.newRawUri("Malink diagnostics", uri)
        startActivity(Intent.createChooser(share, getString(R.string.diagnostics_share_title)))
        diagnostics.record("diagnostics.export_shared")
        return report.name
    }

    private fun savePngImageToPictures(filename: String, bytes: ByteArray): String {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
        if (
            bounds.outMimeType != "image/png" ||
            bounds.outWidth !in 1..MAX_SAVED_QR_DIMENSION ||
            bounds.outHeight !in 1..MAX_SAVED_QR_DIMENSION
        ) {
            throw BridgeRuntimeFailure(
                BridgeError.INVALID_PARAMS,
                "The QR image is not a valid bounded PNG.",
            )
        }
        val resolver = contentResolver
        val values = ContentValues().apply {
            put(MediaStore.Images.Media.DISPLAY_NAME, filename)
            put(MediaStore.Images.Media.MIME_TYPE, "image/png")
            put(
                MediaStore.Images.Media.RELATIVE_PATH,
                "${Environment.DIRECTORY_PICTURES}/Malink",
            )
            put(MediaStore.Images.Media.IS_PENDING, 1)
        }
        val uri = resolver.insert(
            MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY),
            values,
        ) ?: throw BridgeRuntimeFailure(
            BridgeError.NATIVE_INTERNAL,
            "Android could not create the QR image in Pictures/Malink.",
            retryable = true,
        )
        return try {
            resolver.openOutputStream(uri, "w")?.use { output ->
                output.write(bytes)
                output.flush()
            } ?: throw BridgeRuntimeFailure(
                BridgeError.NATIVE_INTERNAL,
                "Android could not write the QR image to Pictures/Malink.",
                retryable = true,
            )
            val committed = ContentValues().apply {
                put(MediaStore.Images.Media.IS_PENDING, 0)
            }
            if (resolver.update(uri, committed, null, null) <= 0) {
                throw BridgeRuntimeFailure(
                    BridgeError.NATIVE_INTERNAL,
                    "Android could not finish saving the QR image.",
                    retryable = true,
                )
            }
            diagnostics.record("image.qr_saved", mapOf("filename" to filename))
            filename
        } catch (error: Throwable) {
            runCatching { resolver.delete(uri, null, null) }
            throw error
        }
    }

    private fun saveAuthorizationFileToDownloads(filename: String, bytes: ByteArray): String {
        val resolver = contentResolver
        val values = ContentValues().apply {
            put(MediaStore.Downloads.DISPLAY_NAME, filename)
            put(MediaStore.Downloads.MIME_TYPE, AUTHORIZATION_TRANSFER_MIME_TYPE)
            put(
                MediaStore.Downloads.RELATIVE_PATH,
                "${Environment.DIRECTORY_DOWNLOADS}/Malink",
            )
            put(MediaStore.Downloads.IS_PENDING, 1)
        }
        val uri = resolver.insert(
            MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY),
            values,
        ) ?: throw BridgeRuntimeFailure(
            BridgeError.NATIVE_INTERNAL,
            "Android could not create the authorization file in Downloads/Malink.",
            retryable = true,
        )
        return try {
            resolver.openOutputStream(uri, "w")?.use { output ->
                output.write(bytes)
                output.flush()
            } ?: throw BridgeRuntimeFailure(
                BridgeError.NATIVE_INTERNAL,
                "Android could not write the authorization file to Downloads/Malink.",
                retryable = true,
            )
            val committed = ContentValues().apply {
                put(MediaStore.Downloads.IS_PENDING, 0)
            }
            if (resolver.update(uri, committed, null, null) <= 0) {
                throw BridgeRuntimeFailure(
                    BridgeError.NATIVE_INTERNAL,
                    "Android could not finish saving the authorization file.",
                    retryable = true,
                )
            }
            val savedFilename = authorizationTransferDisplayName(uri) ?: filename
            diagnostics.record(
                "authorization_file.exported",
                mapOf("filename" to savedFilename),
            )
            savedFilename
        } catch (error: Throwable) {
            runCatching { resolver.delete(uri, null, null) }
            throw error
        }
    }

    private fun showRecoveryPage(detail: String) {
        showContent(messageView(
            title = "Malink is temporarily unavailable",
            detail = detail,
            action = "Retry",
            secondaryAction = "Change static service",
            onSecondaryAction = ::showStaticServiceSettings,
        ) {
            if (serviceBinder == null) {
                ensureHostBound()
            } else {
                showWebHost(reloadExisting = true)
            }
        })
    }

    private fun showDisconnectedPage() {
        showContent(messageView(
            title = "Malink is disconnected",
            detail = "The persistent native host has stopped and will not restart after reboot.",
            action = "Reconnect",
        ) {
            startForegroundAndBind()
        })
    }

    private fun messageView(
        title: String,
        detail: String,
        action: String,
        secondaryAction: String? = null,
        onSecondaryAction: (() -> Unit)? = null,
        onAction: () -> Unit,
    ): View = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        gravity = Gravity.CENTER
        setPadding(dp(32), dp(32), dp(32), dp(32))
        setBackgroundColor(0xFFF4F6FA.toInt())
        addView(TextView(context).apply {
            text = title
            textSize = 22f
            setTextColor(0xFF111827.toInt())
            gravity = Gravity.CENTER
        }, LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            LinearLayout.LayoutParams.WRAP_CONTENT,
        ))
        addView(TextView(context).apply {
            text = detail
            textSize = 15f
            setTextColor(0xFF4B5563.toInt())
            gravity = Gravity.CENTER
            setPadding(0, dp(16), 0, dp(24))
        }, LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            LinearLayout.LayoutParams.WRAP_CONTENT,
        ))
        addView(Button(context).apply {
            text = action
            setOnClickListener {
                if (!isEnabled) return@setOnClickListener
                isEnabled = false
                text = "$action…"
                onAction()
            }
        })
        if (secondaryAction != null && onSecondaryAction != null) {
            addView(Button(context).apply {
                text = secondaryAction
                setOnClickListener { onSecondaryAction() }
            })
        }
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

    private suspend fun awaitServiceBinder(): MalinkConnectionService.LocalBinder =
        serviceBinder ?: withTimeout(SERVICE_BIND_TIMEOUT_MS) { serviceBinderReady.await() }

    private fun clearHostedAccountStateAfterSignOut() {
        WebStorage.getInstance().deleteAllData()
        CookieManager.getInstance().apply {
            removeAllCookies(null)
            flush()
        }
        webView?.clearHistory()
        diagnostics.record("activity.account_signout_web_state_cleared")
    }

    private inner class ActivityBridgeRuntime : BridgeRuntime {
        override val runtimeVersion: String = BuildConfig.VERSION_NAME
        override val runtimeBuild: String = BuildConfig.NATIVE_BUILD_ID
        override val pwaSource: NativePwaSource
            get() = NativePwaSource(
                currentBaseUrl = staticServiceStore.selected.baseUrl,
                officialBaseUrl = staticServiceStore.official.baseUrl,
                source = if (staticServiceStore.usesCustom) "custom" else "official",
            )
        override val nativeDeviceId: String
            get() = serviceBinder?.readyClientRuntime()?.deviceId
                ?: ServicePreferenceStore(this@MainActivity).nativeDeviceId

        override suspend fun client(): NativeClientRuntime =
            awaitServiceBinder().clientRuntime()

        override suspend fun snapshot(): ClientSnapshot = client().snapshot()

        override suspend fun start(): ClientSnapshot = withContext(Dispatchers.Main.immediate) {
            if (!notificationsAvailable()) {
                pendingForegroundStart = true
                // Let the JSON-RPC failure reach the WebView before replacing
                // it with the native permission gate.
                webView?.post { showNotificationGate() }
                throw BridgeRuntimeFailure(
                    BridgeError.INVALID_STATE,
                    "A visible persistent notification must be allowed before the native host starts.",
                    userAction = "open_app",
                )
            }
            if (!persistentPowerAvailable()) {
                pendingForegroundStart = true
                webView?.post { showPowerGate() }
                throw BridgeRuntimeFailure(
                    BridgeError.INVALID_STATE,
                    "Allow Malink to stay active while the screen is off before starting the native host.",
                    userAction = "open_app",
                )
            }
            MalinkConnectionService.startFromUser(this@MainActivity)
            awaitServiceBinder().start()
        }

        override suspend fun bootstrap(
            input: MatrixBootstrap,
        ): Pair<PublicMatrixSession, ClientSnapshot> =
            accountSetupBinder().bootstrap(input)

        private suspend fun accountSetupBinder(): MalinkConnectionService.LocalBinder {
            withContext(Dispatchers.Main.immediate) {
                if (!notificationsAvailable()) {
                    pendingForegroundStart = true
                    webView?.post { showNotificationGate() }
                    throw BridgeRuntimeFailure(
                        BridgeError.INVALID_STATE,
                        "A visible persistent notification must be allowed before signing in.",
                        userAction = "open_app",
                    )
                }
                if (!persistentPowerAvailable()) {
                    pendingForegroundStart = true
                    webView?.post { showPowerGate() }
                    throw BridgeRuntimeFailure(
                        BridgeError.INVALID_STATE,
                        "Allow Malink to stay active while the screen is off before signing in.",
                        userAction = "open_app",
                    )
                }
                MalinkConnectionService.startFromUser(this@MainActivity)
                // A sign-out leaves the presentation host bound while disabling
                // persistent restoration. Do not treat that binder as proof that
                // the foreground runtime is active; bootstrap owns activation.
                if (serviceBinder == null) bindHostOnly()
            }
            return awaitServiceBinder()
        }

        private suspend fun accountRemovalBinder(): MalinkConnectionService.LocalBinder {
            serviceBinder?.let { return it }
            withContext(Dispatchers.Main.immediate) {
                // A broken or stopped connection must not disable the account
                // removal escape hatch. Binding creates the service without
                // requiring a new foreground-session permission gate.
                bindHostOnly()
            }
            return awaitServiceBinder()
        }

        override suspend fun publicMatrixSession(): PublicMatrixSession? =
            client().publicMatrixSession()

        override suspend fun onPresentationActivated() =
            withContext(Dispatchers.Main.immediate) {
                commitPendingStaticServiceSwitch()
            }

        override suspend fun completePairing(
            pairingId: String,
            deviceName: String,
        ): Pair<PublicTrustState.Trusted, ClientSnapshot> {
            diagnostics.record("activity.pairing_completion.entered")
            val binder = awaitServiceBinder()
            val (preview, alreadyConfirmed) = binder.clientRuntime().pairingConfirmation(pairingId)
                ?: throw IllegalStateException("The pairing preview is no longer available.")
            if (!alreadyConfirmed) {
                val confirmed = withContext(Dispatchers.Main.immediate) {
                    confirmNativePairing(preview.gatewayName, preview.verificationCode)
                }
                if (!confirmed) {
                    binder.clientRuntime().cancelPairing(pairingId)
                    throw NativePairingRejectedException(
                        "Pairing was cancelled on the Android device.",
                        retryable = false,
                    )
                }
            }
            diagnostics.record("activity.pairing_completion.confirmed")
            return binder.completePairing(pairingId, deviceName)
        }

        override suspend fun disconnect(mode: String): ClientSnapshot {
            val binder = if (mode == "revoke") accountRemovalBinder() else awaitServiceBinder()
            val snapshot = binder.disconnect(mode)
            withContext(Dispatchers.Main.immediate) {
                if (serviceBound || bindingRequested) {
                    runCatching { unbindService(serviceConnection) }
                }
                serviceBinder = null
                serviceBound = false
                bindingRequested = false
                serviceBinderReady = CompletableDeferred()
                pendingForegroundStart = false
                when (nativeDisconnectPresentation(mode)) {
                    NativeDisconnectPresentation.STOPPED ->
                        webView?.post { showDisconnectedPage() }
                    NativeDisconnectPresentation.ACCOUNT_SETUP -> {
                        clearHostedAccountStateAfterSignOut()
                        diagnostics.record("activity.account_signout_ready_for_setup")
                    }
                }
            }
            return snapshot
        }

        override fun nativeUpdateStatus(): NativeUpdateStatus = requireNativeUpdateManager().status()

        override fun checkNativeUpdate(): NativeUpdateStatus =
            requireNativeUpdateManager().requestStaticReleaseCheck()

        override suspend fun installNativeUpdate(): NativeUpdateStatus {
            val result = withContext(Dispatchers.IO) { requireNativeUpdateManager().installReady() }
            if (result.phase == NativeUpdatePhase.PERMISSION_REQUIRED) {
                withContext(Dispatchers.Main.immediate) { openNativeUpdateInstallPermission() }
            }
            return result
        }

        override suspend fun exportDiagnostics(): String =
            withContext(Dispatchers.Main.immediate) { shareDiagnostics() }

        override suspend fun savePngImage(filename: String, bytes: ByteArray): String =
            withContext(Dispatchers.IO) { savePngImageToPictures(filename, bytes) }

        override suspend fun saveAuthorizationFile(filename: String, bytes: ByteArray): String =
            withContext(Dispatchers.IO) {
                saveAuthorizationFileToDownloads(filename, bytes)
            }

        private fun requireNativeUpdateManager(): NativeUpdateManager =
            updateManager ?: throw BridgeRuntimeFailure(
                BridgeError.NATIVE_INTERNAL,
                "The native update verifier could not be initialized.",
                userAction = "update_native",
            )
    }

    private suspend fun confirmNativePairing(
        gatewayName: String,
        verificationCode: String,
    ): Boolean = suspendCancellableCoroutine { continuation ->
        val dialog = AlertDialog.Builder(this)
            .setTitle("Pair with $gatewayName?")
            .setMessage(
                "Confirm that this code matches the Gateway:\n\n$verificationCode\n\n" +
                    "This grants the Gateway permission to exchange encrypted Malink commands with this device.",
            )
            .setPositiveButton("Pair") { _, _ ->
                diagnostics.record("activity.pairing_confirmation.accepted")
                if (continuation.isActive) continuation.resume(true)
            }
            .setNegativeButton("Cancel") { _, _ ->
                diagnostics.record("activity.pairing_confirmation.rejected")
                if (continuation.isActive) continuation.resume(false)
            }
            .create()
        // Backgrounding the Activity, a transient window replacement, or an
        // Android back gesture must not be interpreted as an explicit denial.
        // Pairing is durable and remains pending until the user chooses one of
        // the two buttons (or the owning bridge call is genuinely cancelled).
        dialog.setCancelable(false)
        dialog.setCanceledOnTouchOutside(false)
        continuation.invokeOnCancellation { dialog.dismiss() }
        dialog.show()
    }

    companion object {
        private const val KEY_NOTIFICATION_REQUESTED = "notification-permission-requested"
        private const val SERVICE_BIND_TIMEOUT_MS = 10_000L
        private const val MAX_SAVED_QR_DIMENSION = 2_048
        const val ACTION_EXPORT_DIAGNOSTICS =
            "id.my.anciety.malink.action.EXPORT_DIAGNOSTICS"
        const val ACTION_STATIC_SERVICE_SETTINGS =
            "id.my.anciety.malink.action.STATIC_SERVICE_SETTINGS"
        const val ACTION_INSTALL_NATIVE_UPDATE =
            "id.my.anciety.malink.action.INSTALL_NATIVE_UPDATE"
        const val ACTION_E2E_PUBLISH_NATIVE_RELEASE =
            "id.my.anciety.malink.action.E2E_PUBLISH_NATIVE_RELEASE"
        const val EXTRA_E2E_NATIVE_RELEASE = "native-release"
        const val ACTION_OPEN_SESSION =
            "id.my.anciety.malink.action.OPEN_SESSION"
        const val EXTRA_SESSION_ID =
            "id.my.anciety.malink.extra.SESSION_ID"
    }
}
