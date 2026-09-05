package id.my.anciety.malink.matrix

import android.content.Context
import id.my.anciety.malink.BuildConfig
import id.my.anciety.malink.diagnostics.DiagnosticRecorder
import id.my.anciety.malink.security.AndroidKeystoreSecretCipher
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeout

fun interface MatrixSdkDriverFactory {
    fun create(scope: CoroutineScope): MatrixSdkDriver
}

class MatrixOfflineException(message: String = "The native Matrix connection is offline.") :
    IllegalStateException(message)

class MatrixReadReceiptRejectedException(
    val matrixErrorCode: String,
    cause: Throwable,
) : Exception("Matrix rejected the session read receipt.", cause)

internal enum class MatrixRemoteLogoutOutcome {
    CONFIRMED,
    SKIPPED_OFFLINE,
    TIMED_OUT,
    FAILED,
}

internal suspend fun attemptMatrixRemoteLogout(
    networkAvailable: Boolean,
    timeoutMs: Long,
    logout: suspend () -> Unit,
): MatrixRemoteLogoutOutcome {
    require(timeoutMs > 0)
    if (!networkAvailable) return MatrixRemoteLogoutOutcome.SKIPPED_OFFLINE
    return try {
        withTimeout(timeoutMs) { logout() }
        MatrixRemoteLogoutOutcome.CONFIRMED
    } catch (_: TimeoutCancellationException) {
        MatrixRemoteLogoutOutcome.TIMED_OUT
    } catch (error: CancellationException) {
        throw error
    } catch (_: Exception) {
        MatrixRemoteLogoutOutcome.FAILED
    }
}

class MatrixConnectionRuntime(
    context: Context,
    private val loginClient: MatrixTokenLoginClient = MatrixTokenLoginClient(),
    private val loginTokenIssueClient: MatrixLoginTokenIssueClient = MatrixLoginTokenIssueClient(),
    private val profileClient: MatrixProfileClient = MatrixProfileClient(),
    private val applicationControlClient: MatrixApplicationControlClient =
        MatrixApplicationControlClient(),
    private val applicationRoomStateClient: MatrixApplicationRoomStateClient =
        MatrixApplicationRoomStateClient(),
    private val threadDirectoryClient: MatrixThreadDirectoryClient =
        MatrixThreadDirectoryClient(),
    private val applicationEventClient: MatrixApplicationEventClient =
        MatrixApplicationEventClient(),
    private val applicationTimelineClient: MatrixApplicationTimelineClient =
        MatrixApplicationTimelineClient(),
    private val threadHistoryClient: MatrixThreadHistoryClient = MatrixThreadHistoryClient(),
    private val roomMembershipClient: MatrixRoomMembershipClient = MatrixRoomMembershipClient(),
    private val providerHistoryClient: MatrixProviderHistoryClient = MatrixProviderHistoryClient(),
    private val networkMonitor: NetworkMonitor = AndroidNetworkMonitor(context),
    private val accountStorage: MatrixAccountStorage = MatrixAccountStorage(
        context,
        AndroidKeystoreSecretCipher(),
    ),
    private val diagnostics: DiagnosticRecorder = DiagnosticRecorder.None,
    private val driverFactory: MatrixSdkDriverFactory = MatrixSdkDriverFactory { scope ->
        OfficialMatrixSdkDriver(scope, diagnostics = diagnostics)
    },
    private val stateMachine: MatrixRuntimeStateMachine = MatrixRuntimeStateMachine(),
    private val onPairingTransportReady: (MatrixTransportIdentity) -> Unit = {},
    private val onTransportReady: (MatrixTransportIdentity) -> Unit = {},
    private val onStatusChanged: () -> Unit = {},
    private val onSyncUpdated: () -> Unit = {},
    private val onDecryptedEvent: suspend (MatrixDecryptedEvent) -> Unit = {},
) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val mutex = Mutex()
    private val networkTransitionMutex = Mutex()
    private val threadDirectoryMutex = Mutex()
    private val networkTransitionGeneration = AtomicLong(0)
    private val started = AtomicBoolean(false)
    private var networkAvailable = networkMonitor.isAvailable()
    @Volatile
    private var files: MatrixAccountFiles? = null
    @Volatile
    private var secrets: PersistedMatrixSecrets? = null
    private var driver: MatrixSdkDriver? = null
    @Volatile
    private var driverGeneration = 0L
    private var retryJob: Job? = null
    private var reconnectFailures = 0
    @Volatile
    private var sdkTimelineReady = false
    private val initialSessionRestore = MatrixSessionRestoreBarrier()

    val status: MatrixRuntimeStatus
        get() = stateMachine.status

    val commandTransportReady: Boolean
        get() = sdkTimelineReady

    fun start() {
        if (!started.compareAndSet(false, true)) return
        diagnostics.record("matrix.runtime.start")
        accept(MatrixRuntimeEvent.Start(hasSession = true, networkAvailable))
        networkMonitor.start(::onNetworkChanged)
        scope.launch {
            try {
                mutex.withLock {
                    restorePersistedSessionLocked()
                    accept(MatrixRuntimeEvent.Start(secrets != null, networkAvailable))
                    // Session discovery depends only on the encrypted local
                    // record. Do not make the WebView wait for Matrix network
                    // sync or SDK crypto startup before it can recover routing.
                    initialSessionRestore.complete()
                    if (secrets != null && networkAvailable) runCatching { connectLocked() }
                }
            } catch (error: CancellationException) {
                initialSessionRestore.cancel(error)
                throw error
            } catch (error: Exception) {
                initialSessionRestore.fail(error)
                diagnostics.record("matrix.recovery.failure", errorAttributes(error))
                accept(
                    MatrixRuntimeEvent.Failed("matrix_recovery_blocked", blocked = true),
                )
            }
        }
    }

    internal fun injectNetworkAvailabilityForE2e(available: Boolean) {
        check(BuildConfig.ALLOW_INSECURE_E2E_LOOPBACK) {
            "Synthetic network transitions are available only in E2E builds."
        }
        diagnostics.record(
            "matrix.network.e2e_injected",
            mapOf("available" to available.toString()),
        )
        onNetworkChanged(available)
    }

    suspend fun bootstrap(input: MatrixBootstrap): PublicMatrixSession = scope.async {
        mutex.withLock { bootstrapLocked(input) }
    }.await()

    suspend fun issueLoginToken(password: String?): MatrixLoginTokenIssueResult = scope.async {
        val session = mutex.withLock {
            check(started.get()) { "The native Matrix runtime is stopped." }
            if (!networkAvailable) throw MatrixOfflineException()
            secrets?.session
                ?: throw IllegalStateException("The native Matrix session is unavailable.")
        }
        withTimeout(LOGIN_TOKEN_OPERATION_TIMEOUT_MS) {
            loginTokenIssueClient.issue(session, password)
        }
    }.await()

    suspend fun sendPairingMessage(contentJson: String) = scope.async {
        val current = mutex.withLock {
            check(started.get()) { "The native Matrix runtime is stopped." }
            if (!networkAvailable) throw MatrixOfflineException()
            driver ?: throw IllegalStateException("The native Matrix connection is not ready.")
        }
        withTimeout(SEND_OPERATION_TIMEOUT_MS) {
            current.sendPairingMessage(contentJson)
        }
    }.await()

    suspend fun closePairingChannel() = scope.async {
        val current = mutex.withLock { driver } ?: return@async
        withTimeout(SEND_OPERATION_TIMEOUT_MS) {
            current.closePairingChannel()
        }
    }.await()

    suspend fun sendApplicationControlEvent(
        contentJson: String,
        transactionId: String,
        roomId: String? = null,
    ): String = scope.async {
        val session = mutex.withLock {
            check(started.get()) { "The native Matrix runtime is stopped." }
            if (!networkAvailable) throw MatrixOfflineException()
            secrets?.session
                ?: throw IllegalStateException("The native Matrix session is unavailable.")
        }
        // Application-control commands are signed by Malink and sent through
        // an independent Matrix HTTP client. Do not couple this durable outbound
        // lane to the inbound SDK sync driver's current generation: a stalled
        // /sync may restart that driver while the homeserver's send endpoint is
        // still healthy. New commands are already gated on an authenticated,
        // synchronized Gateway state by NativeClientRuntime; persisted recovery
        // commands must remain able to retry during an inbound-sync restart.
        withTimeout(SEND_OPERATION_TIMEOUT_MS) {
            applicationControlClient.send(session, contentJson, transactionId, roomId)
        }
    }.await()

    suspend fun uploadMedia(mimeType: String, bytes: ByteArray): String = scope.async {
        val current = mutex.withLock {
            check(started.get()) { "The native Matrix runtime is stopped." }
            if (!networkAvailable) throw MatrixOfflineException()
            driver ?: throw IllegalStateException("The native Matrix connection is not ready.")
        }
        withTimeout(MEDIA_OPERATION_TIMEOUT_MS) {
            current.uploadMedia(mimeType, bytes)
        }
    }.await()

    suspend fun downloadMedia(url: String): ByteArray = scope.async {
        val current = mutex.withLock {
            check(started.get()) { "The native Matrix runtime is stopped." }
            if (!networkAvailable) throw MatrixOfflineException()
            driver ?: throw IllegalStateException("The native Matrix connection is not ready.")
        }
        withTimeout(MEDIA_OPERATION_TIMEOUT_MS) {
            current.downloadMedia(url)
        }
    }.await()

    suspend fun profileProperty(userId: String, key: String) = scope.async {
        val session = mutex.withLock {
            check(started.get()) { "The native Matrix runtime is stopped." }
            if (!networkAvailable) throw MatrixOfflineException()
            secrets?.session
                ?: throw IllegalStateException("The native Matrix session is unavailable.")
        }
        withTimeout(PROFILE_OPERATION_TIMEOUT_MS) {
            profileClient.get(session, userId, key)
        }
    }.await()

    suspend fun revokeSession() = scope.async {
        val (current, canReachServer) = mutex.withLock {
            runCatching { restorePersistedSessionLocked() }
                .onFailure {
                    diagnostics.record(
                        "matrix.account_removal_restore_failed",
                        errorAttributes(it),
                    )
                }
            driver to (networkAvailable && driver != null)
        }
        val remoteOutcome = attemptMatrixRemoteLogout(
            canReachServer,
            REMOTE_LOGOUT_GRACE_MS,
        ) { current!!.logout() }
        diagnostics.record(
            "matrix.account_removal.remote_logout",
            mapOf("outcome" to remoteOutcome.name.lowercase()),
        )
        mutex.withLock {
            retryJob?.cancel()
            retryJob = null
            networkMonitor.stop()
            sdkTimelineReady = false
            driver?.let { stopDriver(it, ACCOUNT_REMOVAL_DRIVER_STOP_TIMEOUT_MS) }
            driver = null
            driverGeneration += 1
            accountStorage.clearAll()
            secrets?.sdkStoreKey?.fill(0)
            secrets = null
            files = null
            started.set(false)
            accept(MatrixRuntimeEvent.Stop)
        }
    }.await()

    private suspend fun bootstrapLocked(input: MatrixBootstrap): PublicMatrixSession {
        check(started.get()) { "The persistent native runtime must be started before bootstrap." }
        MatrixIdentifiers.validateBootstrap(input)
        restorePersistedSessionLocked()
        secrets?.session?.let { existing ->
            require(
                MatrixIdentifiers.normalizeHomeserver(existing.homeserverUrl) ==
                    MatrixIdentifiers.normalizeHomeserver(input.homeserver) &&
                    existing.userId == input.expectedUserId &&
                    existing.roomBinding == input.roomBinding,
            ) { "A different Matrix session is already active." }
            return existing.toPublic()
        }

        accept(MatrixRuntimeEvent.BootstrapStarted)
        val session = try {
            loginClient.exchange(input)
        } catch (error: Exception) {
            accept(
                MatrixRuntimeEvent.Failed(
                    detailCode = if ((error as? MatrixLoginException)?.retryable == true) {
                        "matrix_login_retryable"
                    } else {
                        "matrix_login_rejected"
                    },
                    blocked = (error as? MatrixLoginException)?.retryable != true,
                ),
            )
            throw error
        }
        val candidateFiles = accountStorage.forSession(session)
        // Never delete the only durable login before its atomic replacement is
        // ready. A process death in this window previously left Gateway trust
        // intact but made the Matrix session impossible to restore.
        accountStorage.prepareForBootstrap(candidateFiles)
        val nextFiles = accountStorage.forSession(session)
        val nextSecrets = PersistedMatrixSecrets(
            sdkStoreKey = EncryptedMatrixSessionStore.newStoreKey(),
            session = session,
        )
        nextFiles.sessionStore.save(nextSecrets)
        files = nextFiles
        secrets = nextSecrets
        accept(MatrixRuntimeEvent.SessionReady(networkAvailable))
        if (networkAvailable) connectLocked()
        return session.toPublic()
    }

    fun publicSession(): PublicMatrixSession? = secrets?.session?.toPublic()

    suspend fun awaitPublicSessionRestored(): PublicMatrixSession? {
        initialSessionRestore.await()
        return publicSession()
    }

    suspend fun updateRoomBindings(bindings: List<MatrixRoomBinding>): PublicMatrixSession {
        val normalized = bindings.map(MatrixIdentifiers::validateRoomBinding)
            .distinctBy(MatrixRoomBinding::roomId)
        require(normalized.isNotEmpty()) { "At least one Workspace room is required." }
        require(normalized.all { it.gatewayId == normalized.first().gatewayId }) {
            "All Matrix rooms must belong to one Workspace authorization."
        }
        val previousSession = mutex.withLock {
            check(started.get()) { "The native Matrix runtime is stopped." }
            if (!networkAvailable) throw MatrixOfflineException()
            secrets?.session
                ?: throw IllegalStateException("The native Matrix session is not available.")
        }
        if (previousSession.roomBindings == normalized) return previousSession.toPublic()
        val existingRoomIds = previousSession.roomBindings.mapTo(mutableSetOf()) { it.roomId }
        for (binding in normalized) {
            if (binding.roomId !in existingRoomIds) {
                withTimeout(SEND_OPERATION_TIMEOUT_MS) {
                    roomMembershipClient.join(previousSession, binding.roomId)
                }
            }
        }
        return mutex.withLock {
            val currentSecrets = secrets
                ?: throw IllegalStateException("The native Matrix session is not available.")
            if (currentSecrets.session.roomBindings == normalized) {
                return@withLock currentSecrets.session.toPublic()
            }
            val currentDriver = driver
            sdkTimelineReady = false
            driver = null
            driverGeneration += 1
            if (currentDriver != null) stopDriver(currentDriver)
            val updated = PersistedMatrixSecrets(
                currentSecrets.sdkStoreKey,
                currentSecrets.session.withRoomBindings(normalized),
            )
            val currentFiles = files ?: accountStorage.forSession(updated.session).also { files = it }
            currentFiles.sessionStore.save(updated)
            secrets = updated
            if (started.get() && networkAvailable) connectLocked()
            updated.session.toPublic()
        }
    }

    suspend fun refreshApplicationProjection(
        roomIds: Set<String>? = null,
        includeThreadDirectory: Boolean = true,
    ) {
        val session = secrets?.session
            ?: throw MatrixOfflineException("The Matrix session is unavailable.")
        val accepted = refreshApplicationProjectionBaseline(session, roomIds)
        val threads = if (includeThreadDirectory) refreshThreadDirectory(session) else 0
        diagnostics.record(
            "matrix.application_state.refreshed",
            mapOf(
                "accepted" to accepted.toString(),
                "threads" to threads.toString(),
                "rooms" to (roomIds?.size ?: session.roomBindings.size).toString(),
            ),
        )
    }

    suspend fun sendPrivateReadReceipt(
        roomId: String,
        threadRootEventId: String,
        eventId: String,
    ): Unit = scope.async {
        val current = mutex.withLock {
            check(started.get()) { "The native Matrix runtime is stopped." }
            if (!networkAvailable) throw MatrixOfflineException()
            driver ?: throw IllegalStateException("The native Matrix connection is not ready.")
        }
        try {
            withTimeout(RECEIPT_OPERATION_TIMEOUT_MS) {
                current.sendPrivateReadReceipt(roomId, threadRootEventId, eventId)
            }
        } catch (error: TimeoutCancellationException) {
            diagnostics.record(
                "matrix.session_read.operation_timeout",
                mapOf("stage" to "publish"),
            )
            throw error
        }
    }.await()

    suspend fun loadPrivateReadReceipt(
        roomId: String,
        threadRootEventId: String,
    ): String? = scope.async {
        val current = mutex.withLock {
            check(started.get()) { "The native Matrix runtime is stopped." }
            driver ?: throw IllegalStateException("The native Matrix connection is not ready.")
        }
        try {
            withTimeout(RECEIPT_OPERATION_TIMEOUT_MS) {
                current.loadPrivateReadReceipt(roomId, threadRootEventId)
            }
        } catch (error: TimeoutCancellationException) {
            diagnostics.record(
                "matrix.session_read.operation_timeout",
                mapOf("stage" to "inspect"),
            )
            throw error
        }
    }.await()

    suspend fun refreshThreadDirectory(): Int {
        val session = mutex.withLock {
            check(started.get()) { "The native Matrix runtime is stopped." }
            if (!networkAvailable) throw MatrixOfflineException()
            secrets?.session ?: throw MatrixOfflineException("The Matrix session is unavailable.")
        }
        return refreshThreadDirectory(session)
    }

    suspend fun fetchApplicationEvent(
        eventId: String,
        roomId: String? = null,
    ): MatrixDecryptedEvent {
        val session = mutex.withLock {
            check(started.get()) { "The native Matrix runtime is stopped." }
            if (!networkAvailable) throw MatrixOfflineException()
            secrets?.session ?: throw MatrixOfflineException("The Matrix session is unavailable.")
        }
        return withTimeout(HISTORY_OPERATION_TIMEOUT_MS) {
            applicationEventClient.event(session, eventId, roomId)
        }
    }

    suspend fun loadThreadHistory(
        threadRootEventId: String,
        from: String?,
        limit: Int,
        roomId: String? = null,
    ): MatrixThreadHistoryBatch {
        val session = mutex.withLock {
            check(started.get()) { "The native Matrix runtime is stopped." }
            if (!networkAvailable) throw MatrixOfflineException()
            secrets?.session ?: throw MatrixOfflineException("The Matrix session is unavailable.")
        }
        diagnostics.record(
            "matrix.thread_history.requested",
            mapOf("paged" to (from != null).toString(), "limit" to limit.toString()),
        )
        return try {
            withTimeout(HISTORY_OPERATION_TIMEOUT_MS) {
                threadHistoryClient.page(session, threadRootEventId, from, limit, roomId)
            }.also { batch ->
                diagnostics.record(
                    "matrix.thread_history.received",
                    mapOf(
                        "events" to batch.events.size.toString(),
                        "has_more" to (batch.nextBatch != null).toString(),
                    ),
                )
            }
        } catch (error: TimeoutCancellationException) {
            diagnostics.record(
                "matrix.thread_history.failed",
                mapOf("type" to error::class.java.simpleName),
            )
            throw error
        } catch (error: CancellationException) {
            diagnostics.record("matrix.thread_history.cancelled")
            throw error
        } catch (error: Exception) {
            diagnostics.record(
                "matrix.thread_history.failed",
                mapOf("type" to error::class.java.simpleName),
            )
            throw error
        }
    }

    suspend fun loadProviderHistory(
        roomId: String,
        from: String?,
        limit: Int,
    ): MatrixThreadHistoryBatch {
        val session = mutex.withLock {
            check(started.get()) { "The native Matrix runtime is stopped." }
            if (!networkAvailable) throw MatrixOfflineException()
            secrets?.session ?: throw MatrixOfflineException("The Matrix session is unavailable.")
        }
        return withTimeout(HISTORY_OPERATION_TIMEOUT_MS) {
            providerHistoryClient.page(session, roomId, from, limit)
        }
    }

    suspend fun recoverApplicationTimeline(
        roomId: String,
        stopWhen: () -> Boolean,
    ): Int {
        val session = mutex.withLock {
            check(started.get()) { "The native Matrix runtime is stopped." }
            if (!networkAvailable) throw MatrixOfflineException()
            secrets?.session ?: throw MatrixOfflineException("The Matrix session is unavailable.")
        }
        // Read exactly one recent durable page. This bypasses a Matrix SDK UI
        // timeline callback that can omit an otherwise synchronized event,
        // while the native raw inbox keeps verification and deduplication
        // identical to the live path.
        return withTimeout(COMMAND_TIMELINE_RECOVERY_TIMEOUT_MS) {
            if (stopWhen()) return@withTimeout 0
            val page = applicationTimelineClient.latest(
                session,
                roomId,
                MAX_COMMAND_TIMELINE_RECOVERY_EVENTS,
            )
            for (event in page.events) {
                if (stopWhen()) break
                onDecryptedEvent(event)
            }
            1
        }.also { pages ->
            diagnostics.record(
                "matrix.command_recovery.timeline_scanned",
                mapOf("pages" to pages.toString()),
            )
        }
    }

    suspend fun stop(clearSession: Boolean) = mutex.withLock {
        if (!started.compareAndSet(true, false)) return@withLock
        retryJob?.cancel()
        retryJob = null
        reconnectFailures = 0
        networkMonitor.stop()
        sdkTimelineReady = false
        driver?.let { stopDriver(it) }
        driver = null
        driverGeneration += 1
        if (clearSession) {
            files?.let(accountStorage::clear)
            secrets?.sdkStoreKey?.fill(0)
            secrets = null
            files = null
        }
        accept(MatrixRuntimeEvent.Stop)
    }

    suspend fun close() {
        stop(clearSession = false)
        secrets?.sdkStoreKey?.fill(0)
        scope.cancel()
    }

    private fun onNetworkChanged(available: Boolean) {
        val transitionGeneration = networkTransitionGeneration.incrementAndGet()
        scope.launch {
            // ConnectivityManager may emit a rapid false/true burst when a
            // validated network changes capabilities. Serialize the matching
            // SDK controls so an older pause cannot finish after a newer
            // resume and leave native transport state inverted.
            networkTransitionMutex.withLock networkTransition@{
                if (transitionGeneration != networkTransitionGeneration.get()) {
                    diagnostics.record(
                        "matrix.network.coalesced",
                        mapOf("available" to available.toString()),
                    )
                    return@networkTransition
                }
                val currentDriver = mutex.withLock {
                    networkAvailable = available
                    if (available) reconnectFailures = 0
                    diagnostics.record(
                        "matrix.network.changed",
                        mapOf("available" to available.toString()),
                    )
                    if (!available) accept(MatrixRuntimeEvent.NetworkLost)
                    driver
                }
                if (transitionGeneration != networkTransitionGeneration.get()) {
                    return@networkTransition
                }
                if (!available) {
                    try {
                        withTimeout(NETWORK_CONTROL_TIMEOUT_MS) {
                            currentDriver?.setNetworkAvailable(false)
                        }
                    } catch (error: CancellationException) {
                        throw error
                    } catch (error: Exception) {
                        diagnostics.record("matrix.network.pause_failure", errorAttributes(error))
                    }
                    return@networkTransition
                }
                val resumeError = try {
                    withTimeout(NETWORK_CONTROL_TIMEOUT_MS) {
                        currentDriver?.setNetworkAvailable(true)
                    }
                    null
                } catch (error: CancellationException) {
                    throw error
                } catch (error: Exception) {
                    error
                }
                if (transitionGeneration != networkTransitionGeneration.get()) {
                    return@networkTransition
                }
                val recovered = mutex.withLock runtimeState@{
                    if (transitionGeneration != networkTransitionGeneration.get()) {
                        return@runtimeState false
                    }
                    if (!started.get() || !networkAvailable) return@runtimeState false
                    if (currentDriver != null && driver !== currentDriver) {
                        return@runtimeState false
                    }
                    if (resumeError != null && currentDriver != null) {
                        diagnostics.record(
                            "matrix.network.resume_failure",
                            errorAttributes(resumeError),
                        )
                        accept(
                            MatrixRuntimeEvent.Failed(
                                "matrix_send_queue_resume_failed",
                                blocked = false,
                            ),
                        )
                        sdkTimelineReady = false
                        stopDriver(currentDriver)
                        if (driver === currentDriver) {
                            driver = null
                            driverGeneration += 1
                        }
                        scheduleRetryLocked()
                        return@runtimeState false
                    }
                    val running = runCatching {
                        driver?.isSyncRunning() == true
                    }.getOrDefault(false)
                    accept(MatrixRuntimeEvent.NetworkAvailable(syncRunning = running))
                    if (!running && started.get() && secrets != null) {
                        runCatching { connectLocked() }
                    }
                    true
                }
                if (!recovered || transitionGeneration != networkTransitionGeneration.get()) {
                    return@networkTransition
                }
            }
        }
    }

    private fun restorePersistedSessionLocked() {
        if (secrets != null) return
        val currentFiles = accountStorage.findCurrent()
        if (currentFiles == null) {
            diagnostics.record("matrix.session.restore", mapOf("stage" to "missing"))
            return
        }
        val loaded = currentFiles.sessionStore.load()
        if (loaded == null) {
            diagnostics.record("matrix.session.restore", mapOf("stage" to "missing"))
            return
        }
        check(
            MatrixIdentifiers.accountStoreName(
                loaded.session.homeserverUrl,
                loaded.session.userId,
            ) == currentFiles.accountScope,
        ) { "Encrypted Matrix session is bound to a different account scope." }
        check(loaded.session.slidingSyncVersion == org.matrix.rustcomponents.sdk.SlidingSyncVersion.NATIVE) {
            "The stored Matrix session uses an unsupported sync format. Pair this APK again."
        }
        files = currentFiles
        secrets = loaded
        diagnostics.record("matrix.session.restore", mapOf("stage" to "restored"))
    }

    private suspend fun connectLocked() {
        val currentSecrets = secrets ?: return
        val currentFiles = files ?: return
        if (!networkAvailable || !started.get()) return
        retryJob?.cancel()
        retryJob = null
        sdkTimelineReady = false
        driver?.let { stopDriver(it) }
        driver = null
        driverGeneration += 1
        val generation = driverGeneration
        val nextDriver = try {
            driverFactory.create(scope)
        } catch (error: Exception) {
            accept(
                MatrixRuntimeEvent.Failed("matrix_driver_create_failed", blocked = false),
            )
            scheduleRetryLocked()
            throw error
        }
        driver = nextDriver
        accept(MatrixRuntimeEvent.SessionReady(networkAvailable = true))
        try {
            withTimeout(DRIVER_START_TIMEOUT_MS) {
                nextDriver.start(
                    secrets = currentSecrets,
                    files = currentFiles,
                    onSyncUpdate = {
                        scope.launch {
                            val current = mutex.withLock {
                                if (driver === nextDriver && driverGeneration == generation) {
                                    retryJob?.cancel()
                                    retryJob = null
                                    reconnectFailures = 0
                                    accept(MatrixRuntimeEvent.SyncUpdated)
                                    true
                                } else {
                                    false
                                }
                            }
                            if (current) onSyncUpdated()
                        }
                    },
                    onSessionUpdated = { updated ->
                        scope.launch {
                            mutex.withLock {
                                if (driver === nextDriver && driverGeneration == generation) {
                                    val updatedSecrets = PersistedMatrixSecrets(
                                        currentSecrets.sdkStoreKey,
                                        updated,
                                    )
                                    currentFiles.sessionStore.save(updatedSecrets)
                                    secrets = updatedSecrets
                                }
                            }
                        }
                    },
                    onTransportReady = { identity ->
                        scope.launch {
                            val current = mutex.withLock {
                                if (driver === nextDriver && driverGeneration == generation) {
                                    sdkTimelineReady = true
                                    true
                                } else {
                                    false
                                }
                            }
                            if (current) {
                                onPairingTransportReady(identity)
                                onTransportReady(identity)
                            }
                        }
                    },
                    onTimelineEvent = onDecryptedEvent,
                    onRuntimeFailure = { error ->
                        diagnostics.record("matrix.driver.runtime_failure", errorAttributes(error))
                        scope.launch {
                            mutex.withLock {
                                if (driver === nextDriver && driverGeneration == generation) {
                                    val decision = MatrixRuntimeFailurePolicy.decide(error)
                                    accept(
                                        MatrixRuntimeEvent.Failed(
                                            decision.detailCode,
                                            blocked = decision.blocked,
                                        ),
                                    )
                                    sdkTimelineReady = false
                                    stopDriver(nextDriver)
                                    driver = null
                                    driverGeneration += 1
                                    if (!decision.blocked) scheduleRetryLocked()
                                }
                            }
                        }
                    },
                )
            }
            accept(MatrixRuntimeEvent.SyncStarted)
        } catch (error: Exception) {
            diagnostics.record("matrix.driver.start_failure", errorAttributes(error))
            sdkTimelineReady = false
            stopDriver(nextDriver)
            if (driver === nextDriver && driverGeneration == generation) {
                driver = null
                driverGeneration += 1
            }
            val decision = if (error is TimeoutCancellationException) {
                MatrixRuntimeFailureDecision("matrix_driver_start_timeout", blocked = false)
            } else {
                MatrixRuntimeFailurePolicy.decide(error).let {
                    if (it.blocked) it else it.copy(detailCode = "matrix_restore_or_sync_failed")
                }
            }
            accept(MatrixRuntimeEvent.Failed(decision.detailCode, decision.blocked))
            if (!decision.blocked) scheduleRetryLocked()
            throw error
        }
    }

    private suspend fun refreshApplicationProjectionBaseline(
        session: StoredMatrixSession,
        roomIds: Set<String>? = null,
    ): Int {
        // Live events come only from the SDK timeline. A cold projection reads
        // current bounded MLP/3 Room State on demand; this request never polls
        // and owns no independent Matrix sync cursor.
        val batch = applicationRoomStateClient.currentMlp3(session, roomIds)
        val processed = processMatrixApplicationEventBatch(
            events = batch.events,
            onEvent = onDecryptedEvent,
            onQuarantined = { event, error ->
                diagnostics.record(
                    "matrix.v3_baseline.event_quarantined",
                    mapOf(
                        "kind" to malinkApplicationEventKind(event.rawJson),
                        "error" to error.javaClass.simpleName.take(160),
                    ),
                )
            },
        )
        return processed.committed
    }

    private suspend fun refreshThreadDirectory(session: StoredMatrixSession): Int =
        threadDirectoryMutex.withLock {
            withTimeout(THREAD_DIRECTORY_OPERATION_TIMEOUT_MS) {
                var accepted = 0
                for (binding in session.roomBindings) {
                    var from: String? = null
                    val seenTokens = mutableSetOf<String>()
                    var pages = 0
                    while (true) {
                        if (pages >= MAX_THREAD_DIRECTORY_PAGES) {
                            throw MatrixApplicationControlPayloadException(
                                "The Matrix thread directory exceeded the session safety limit.",
                            )
                        }
                        pages += 1
                        val page = threadDirectoryClient.page(session, from, binding.roomId)
                        val processed = processMatrixApplicationEventBatch(
                            events = page.latestEvents,
                            onEvent = onDecryptedEvent,
                            onQuarantined = { event, error ->
                                diagnostics.record(
                                    "matrix.thread_directory.event_quarantined",
                                    mapOf(
                                        "kind" to malinkApplicationEventKind(event.rawJson),
                                        "error" to error.javaClass.simpleName.take(160),
                                    ),
                                )
                            },
                        )
                        accepted += processed.committed
                        val next = page.nextBatch ?: break
                        require(seenTokens.add(next)) {
                            "The Matrix thread directory repeated a pagination token."
                        }
                        from = next
                    }
                }
                accepted
            }
        }

    private fun scheduleRetryLocked() {
        if (retryJob?.isActive == true || !networkAvailable || secrets == null || !started.get()) return
        val completedFailures = reconnectFailures
        reconnectFailures = (reconnectFailures + 1).coerceAtMost(Int.MAX_VALUE)
        val delayMs = MatrixRetryBackoff.transportDelayMs(completedFailures)
        diagnostics.record(
            "matrix.retry.scheduled",
            mapOf(
                "attempt" to completedFailures.toString(),
                "delay_ms" to delayMs.toString(),
            ),
        )
        retryJob = scope.launch {
            delay(delayMs)
            mutex.withLock {
                retryJob = null
                if (networkAvailable && secrets != null && started.get()) {
                    runCatching { connectLocked() }
                }
            }
        }
    }

    private fun accept(event: MatrixRuntimeEvent): MatrixRuntimeStatus {
        val previous = stateMachine.status
        val next = stateMachine.accept(event)
        if (next != previous) {
            diagnostics.record(
                "matrix.state",
                mapOf(
                    "phase" to next.phase.name,
                    "detail" to next.detailCode,
                ),
            )
            onStatusChanged()
        }
        return next
    }

    private suspend fun stopDriver(
        current: MatrixSdkDriver,
        timeoutMs: Long = DRIVER_STOP_TIMEOUT_MS,
    ) {
        try {
            withTimeout(timeoutMs) { current.stop() }
        } catch (_: TimeoutCancellationException) {
            diagnostics.record("matrix.driver.stop_timeout")
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            diagnostics.record("matrix.driver.stop_failure", errorAttributes(error))
        }
    }

    private fun errorAttributes(error: Throwable): Map<String, String> = buildMap {
        put(
            "error",
            error.javaClass.simpleName.replace(Regex("[^A-Za-z0-9._:+/-]"), "_").take(160),
        )
        if (error is MatrixApplicationReadException) {
            put("status", error.status.toString())
            error.retryAfterMs?.let { put("retry_after_ms", it.toString()) }
        }
    }

    private fun StoredMatrixSession.toPublic() = PublicMatrixSession(
        homeserver = homeserverUrl,
        userId = userId,
        matrixDeviceId = deviceId,
        roomBindings = roomBindings,
    )

    private companion object {
        const val DRIVER_START_TIMEOUT_MS = 30_000L
        const val DRIVER_STOP_TIMEOUT_MS = 10_000L
        const val ACCOUNT_REMOVAL_DRIVER_STOP_TIMEOUT_MS = 2_000L
        const val NETWORK_CONTROL_TIMEOUT_MS = 10_000L
        const val SEND_OPERATION_TIMEOUT_MS = 45_000L
        const val PROFILE_OPERATION_TIMEOUT_MS = 45_000L
        const val LOGIN_TOKEN_OPERATION_TIMEOUT_MS = 45_000L
        const val HISTORY_OPERATION_TIMEOUT_MS = 45_000L
        const val RECEIPT_OPERATION_TIMEOUT_MS = 15_000L
        const val COMMAND_TIMELINE_RECOVERY_TIMEOUT_MS = 10_000L
        const val THREAD_DIRECTORY_OPERATION_TIMEOUT_MS = 120_000L
        const val MEDIA_OPERATION_TIMEOUT_MS = 120_000L
        const val REMOTE_LOGOUT_GRACE_MS = 3_000L
        const val MAX_THREAD_DIRECTORY_PAGES = 1_000
        const val MAX_COMMAND_TIMELINE_RECOVERY_EVENTS = 32
    }
}
