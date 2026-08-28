package id.my.anciety.malink.client

import android.content.Context
import id.my.anciety.malink.BuildConfig
import id.my.anciety.malink.client.command.CommandCompletion as DurableCompletion
import id.my.anciety.malink.client.command.CommandAuthorizationPolicy
import id.my.anciety.malink.client.command.CommandPayloadValidator
import id.my.anciety.malink.client.command.CommandOutcome as DurableOutcome
import id.my.anciety.malink.client.command.CommandOperation
import id.my.anciety.malink.client.command.requiredCertificateOperation
import id.my.anciety.malink.client.command.CommandReceipt as DurableReceipt
import id.my.anciety.malink.client.command.CommandState as DurableState
import id.my.anciety.malink.client.command.CommandTransmission
import id.my.anciety.malink.client.command.CommandView as DurableView
import id.my.anciety.malink.client.command.DurableCommandOutbox
import id.my.anciety.malink.client.command.PublicCommandError as DurableError
import id.my.anciety.malink.client.command.RevisionConflictAction
import id.my.anciety.malink.client.command.UnknownCommandException
import id.my.anciety.malink.client.events.ClientEventHub
import id.my.anciety.malink.client.events.ClientEventListener
import id.my.anciety.malink.client.events.ClientEventType
import id.my.anciety.malink.client.events.ClientLifecycle
import id.my.anciety.malink.client.events.ClientMessage
import id.my.anciety.malink.client.events.ClientMessageFormat
import id.my.anciety.malink.client.events.ClientMessageKind
import id.my.anciety.malink.client.events.ClientSnapshot
import id.my.anciety.malink.client.events.CommandCompletion
import id.my.anciety.malink.client.events.CommandOutcome
import id.my.anciety.malink.client.events.CommandState
import id.my.anciety.malink.client.events.CommandView
import id.my.anciety.malink.client.events.EncryptedAtomicClientEventPersistence
import id.my.anciety.malink.client.events.ClientEventStateCodec
import id.my.anciety.malink.client.events.ForegroundServiceState
import id.my.anciety.malink.client.events.HistoryPage
import id.my.anciety.malink.client.events.LifecyclePhase
import id.my.anciety.malink.client.events.MAX_BRIDGE_EVENT_PAYLOAD_BYTES
import id.my.anciety.malink.client.events.PublicClientJson
import id.my.anciety.malink.client.events.PublicCommandError
import id.my.anciety.malink.client.events.PublicTrustState
import id.my.anciety.malink.client.events.SubscriptionBootstrap
import id.my.anciety.malink.client.events.SubscriptionCursorResult
import id.my.anciety.malink.client.events.ToolGroupPresentation
import id.my.anciety.malink.client.events.compactSnapshotCommands
import id.my.anciety.malink.diagnostics.NativeDiagnosticLog
import id.my.anciety.malink.update.NativeUpdateStore
import id.my.anciety.malink.update.NativeUpdateManager
import id.my.anciety.malink.matrix.MatrixBootstrap
import id.my.anciety.malink.matrix.MALINK_MATRIX_APPLICATION_CONTROL_EVENT_TYPE
import id.my.anciety.malink.matrix.MatrixDecryptedEvent
import id.my.anciety.malink.matrix.MatrixIdentifiers
import id.my.anciety.malink.matrix.MatrixLoginTokenIssueResult
import id.my.anciety.malink.matrix.MatrixRuntimePhase
import id.my.anciety.malink.matrix.MatrixTransportIdentity
import id.my.anciety.malink.matrix.PublicMatrixSession
import id.my.anciety.malink.security.AndroidKeystoreSecretCipher
import id.my.anciety.malink.security.SecretCipher
import id.my.anciety.malink.security.malink.AndroidKeystoreP256Identity
import id.my.anciety.malink.security.malink.Base64Url
import id.my.anciety.malink.security.malink.CanonicalJson
import id.my.anciety.malink.security.malink.CapabilityRenewalCodec
import id.my.anciety.malink.security.malink.CapabilityRenewalOffer
import id.my.anciety.malink.security.malink.CapabilityRenewalRequest
import id.my.anciety.malink.security.malink.MalinkCrypto
import id.my.anciety.malink.security.malink.MalinkPrivateIdentity
import id.my.anciety.malink.security.malink.MalinkSecurityException
import id.my.anciety.malink.security.malink.EncryptedGatewayTrustStore
import id.my.anciety.malink.security.malink.GatewayTrust
import id.my.anciety.malink.security.malink.GatewayTransportCodec
import id.my.anciety.malink.security.malink.MatrixTransportBinding
import id.my.anciety.malink.security.malink.MLP3_MATRIX_KEY_GRANT_EVENT_TYPE
import id.my.anciety.malink.security.malink.MLP3_MATRIX_PROJECT_POINTER_EVENT_TYPE
import id.my.anciety.malink.security.malink.MLP3_MATRIX_WORKSPACE_POINTER_EVENT_TYPE
import id.my.anciety.malink.security.malink.MLP3_MATRIX_WORKSPACE_DIRECTORY_EVENT_TYPE
import id.my.anciety.malink.security.malink.MatrixMlp3Protocol
import id.my.anciety.malink.security.malink.PairingCodec
import id.my.anciety.malink.security.malink.PairingOperation
import id.my.anciety.malink.security.malink.PairingRequest
import id.my.anciety.malink.security.malink.PairingSecurity
import id.my.anciety.malink.security.malink.SignedPairingOffer
import id.my.anciety.malink.security.malink.SignedPairingRequest
import id.my.anciety.malink.security.malink.SignedPairingResponse
import id.my.anciety.malink.security.malink.SecureEnvelopeBindings
import id.my.anciety.malink.security.malink.SecureEnvelopeCodec
import id.my.anciety.malink.security.malink.SecureEnvelopeDirection
import id.my.anciety.malink.security.malink.SecureEnvelopes
import id.my.anciety.malink.security.malink.requiredObject
import id.my.anciety.malink.security.malink.requiredOpaqueId
import java.security.SecureRandom
import java.security.MessageDigest
import java.util.ArrayDeque
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

data class NativePairingPreview(
    val pairingId: String,
    val gatewayId: String,
    val gatewayName: String,
    val verificationCode: String,
    val expiresAt: Long,
)

class NativePairingRejectedException(
    message: String,
    val retryable: Boolean = true,
) : IllegalStateException(message)
class NativeTrustRequiredException(message: String) : IllegalStateException(message)
private class MatrixMlp3EventDeferredException(message: String) : IllegalStateException(message)

/**
 * Service-owned Malink domain runtime. Matrix tokens, application private
 * keys, raw Matrix events and encrypted payloads terminate here and never
 * become bridge values.
 */
class NativeClientRuntime(
    context: Context,
    private val matrix: NativeMatrixPort = MatrixNativePort(context),
    private val identity: MalinkPrivateIdentity = AndroidKeystoreP256Identity(),
    private val cipher: SecretCipher = AndroidKeystoreSecretCipher(),
    private val foregroundState: () -> Pair<Boolean, Boolean>,
    private val onCommandCompletion: (CommandOperation, DurableCompletion) -> Unit = { _, _ -> },
    private val now: () -> Long = System::currentTimeMillis,
) : NativeMatrixObserver {
    internal fun injectNetworkAvailabilityForE2e(available: Boolean) {
        matrix.injectNetworkAvailabilityForE2e(available)
    }

    fun onSystemWake(reason: String) {
        matrix.onSystemWake(reason)
    }

    private data class PendingPairing(
        val offer: SignedPairingOffer,
        var request: SignedPairingRequest? = null,
        var receivedResponse: SignedPairingResponse? = null,
        var response: CompletableDeferred<SignedPairingResponse>? = null,
        val repairingSession: Boolean = false,
    )

    private data class ActivePairingCompletion(
        val pairingId: String,
        val result: CompletableDeferred<Pair<PublicTrustState.Trusted, ClientSnapshot>>,
        val job: Job,
    )

    private data class CapabilityRenewalWaiter(
        val certificateId: String,
        val result: CompletableDeferred<CapabilityRenewalOffer>,
    )

    val deviceId: String = identity.publicIdentity.keyId
    private val appContext = context.applicationContext
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val mutex = Mutex()
    private val capabilityRenewalMutex = Mutex()
    // History pagination is an explicit, per-conversation user action. Never
    // serialize unrelated sessions behind one slow Matrix relation page.
    private val historyMutexes = ConcurrentHashMap<String, Mutex>()
    private val diagnostics = NativeDiagnosticLog.get(context)
    private val files = NativeRuntimeFiles(context, deviceId)
    private val stateUpgrade = NativeStateUpgradeCoordinator(
        files.stateManifest,
        diagnostics,
        now,
    ).begin(BuildConfig.NATIVE_BUILD_ID)
    private val eventPersistence = EncryptedAtomicClientEventPersistence(
        files.events,
        cipher,
        deviceId,
    ).also { persistence ->
        stateUpgrade.recoverRebuildable(
            "client-event-projection",
            validate = {
                persistence.load()?.let { bytes ->
                    try {
                        ClientEventStateCodec.decode(bytes)
                    } finally {
                        bytes.fill(0)
                    }
                }
            },
            reset = persistence::clear,
        )
    }
    private val replayStore = AtomicEncryptedReplayStore(files.replay, cipher, deviceId).also {
        stateUpgrade.recoverPreserved("replay-ledger", validate = it::validateStoredState)
    }
    private val pairingStore = AtomicEncryptedPairingTransactionStore(
        files.pairing,
        cipher,
        deviceId,
    )
    private val timelineKeys = AtomicEncryptedTimelineKeyStore(
        files.timelineKeys,
        cipher,
        deviceId,
    ).also {
        stateUpgrade.recoverPreserved("timeline-key-ring", validate = it::validateStoredState)
    }
    private val matrixMlp3ProjectKeys = AtomicEncryptedMatrixMlp3ProjectKeyStore(
        files.matrixMlp3ProjectKeys,
        cipher,
        deviceId,
    ).also {
        stateUpgrade.recoverPreserved("matrix-v3-project-keys", validate = it::validateStoredState)
    }
    private val matrixMlp3Inbox = AtomicEncryptedMatrixMlp3InboxStore(
        files.matrixMlp3Inbox,
        cipher,
        deviceId,
    ).also {
        stateUpgrade.recoverPreserved("matrix-v3-raw-inbox", validate = it::validateStoredState)
    }
    private val matrixMlp3ProjectionStore = AtomicEncryptedMatrixMlp3ProjectionStore(
        files.matrixMlp3Projection,
        cipher,
        deviceId,
    ).also {
        stateUpgrade.recoverRebuildable(
            "matrix-v3-projection",
            validate = it::validateStoredState,
            reset = it::clear,
        )
    }
    private val matrixMlp3CommandContent = AtomicEncryptedMatrixMlp3CommandContentStore(
        files.matrixMlp3CommandContent,
        cipher,
        deviceId,
    ).also {
        stateUpgrade.recoverPreserved(
            "matrix-v3-command-content",
            validate = it::validateStoredState,
        )
    }
    private val trustStore = EncryptedGatewayTrustStore(
        AtomicEncryptedTrustBlobStore(files.trust),
        cipher,
        now,
    )
    private val outbox = DurableCommandOutbox.encrypted(files.matrixMlp3Commands, cipher, deviceId) { migration ->
        diagnostics.record(
            "command.outbox.migrated",
            mapOf(
                "schema" to migration.fromSchemaVersion.toString(),
                "quarantined" to migration.quarantinedCommandCount.toString(),
            ),
        )
    }.also {
        // The owning codec performs and atomically rewrites supported legacy
        // schemas during construction. Replaying these coordinator steps is
        // harmless because opening the current codec is idempotent.
        stateUpgrade.recoverPreserved(
            "command-outbox",
            migrate = { _, _ -> it.list() },
            validate = { it.list() },
        )
    }
    private val transfers = AttachmentTransferManager(files.transfers, matrix, cipher, now).also {
        stateUpgrade.recoverRebuildable(
            "attachment-transfer-scratch",
            validate = files::validateTransferScratch,
            reset = files::clearTransferScratch,
        )
    }
    private val nativeUpdateStore = NativeUpdateStore(context).also {
        stateUpgrade.recoverRebuildable(
            "native-update-cache",
            validate = it::validate,
            reset = it::reset,
        )
    }
    private val commandTransmissionJobs = ConcurrentHashMap<String, Job>()
    private val commandRecoveryJobs = ConcurrentHashMap<String, Job>()
    private val commandRecoveryAttempts = ConcurrentHashMap<String, Int>()
    private val capabilityRenewalWaiters =
        ConcurrentHashMap<String, CapabilityRenewalWaiter>()
    private val json = Json { isLenient = false; allowSpecialFloatingPointValues = false }
    private val restoredTrust = runCatching { trustStore.load() }
    private val restoredPairing: Result<PersistedPairingTransaction?> = runCatching {
        pairingStore.load()?.let(::validateRestoredPairingTransaction)?.let transaction@{ transaction ->
            restoredTrust.getOrNull()?.let { activeTrust ->
                if (
                    transaction.response?.response?.certificate?.certificate?.certificateId ==
                    activeTrust.certificate.certificateId
                ) {
                    pairingStore.clear()
                    diagnostics.record("pairing.transaction.stale_cleanup")
                    return@transaction null
                }
                MatrixSessionRepairPolicy.requirePinnedOffer(activeTrust, transaction.offer)
            }
            transaction
        }
    }
    @Volatile private var transportIdentity: MatrixTransportIdentity? = null
    @Volatile private var trust: GatewayTrust? = restoredTrust.getOrNull()
    @Volatile private var trustStorageBlocked = restoredTrust.isFailure
    @Volatile private var pairingStorageBlocked = restoredPairing.isFailure
    @Volatile private var gatewayState: JsonObject? = null
    @Volatile private var gatewayStateSynchronized = false
    @Volatile private var authoritativeStateRefreshJob: Job? = null
    @Volatile private var gatewayConvergenceFallbackJob: Job? = null
    @Volatile private var workspaceDirectoryConvergenceJob: Job? = null
    @Volatile private var gatewayConvergenceMinimumRevision: Long? = null
    @Volatile private var pendingPairing: PendingPairing? = restoredPairing.getOrNull()?.let {
        PendingPairing(
            it.offer,
            it.request,
            it.response,
            repairingSession = restoredTrust.getOrNull() != null,
        )
    }
    @Volatile private var activePairingCompletion: ActivePairingCompletion? = null
    @Volatile private var pairingAutoResumeJob: Job? = null
    @Volatile private var pairingExpiryJob: Job? = null
    private val preTrustEvents = ArrayDeque<MatrixDecryptedEvent>()
    private val initializedHistoryRelations = mutableSetOf<String>()
    private val historyRelationTokens = mutableMapOf<String, String>()
    @Volatile private var lastLifecycle: Pair<LifecyclePhase, String?>? = null
    private val matrixMlp3Projection = MatrixMlp3NativeProjection(
        gatewayId = { trust?.gatewayId ?: "gateway" },
        activeDeviceCount = { trust?.response?.response?.activeDeviceCount ?: 1 },
        initialState = matrixMlp3ProjectionStore.load(),
    )

    private val eventHub = ClientEventHub(
        eventPersistence,
        initialSnapshot(),
        // Matrix and the per-session history cache remain authoritative. This
        // window only bridges short WebView detach/reattach gaps.
        maxReplayEvents = BRIDGE_REPLAY_EVENT_LIMIT,
    )

    init {
        if (restoredTrust.isFailure) {
            stateUpgrade.blockPreserved("gateway-trust")
        } else {
            stateUpgrade.recoverPreserved("gateway-trust", validate = { restoredTrust.getOrThrow() })
        }
        if (restoredPairing.isFailure) {
            stateUpgrade.blockPreserved("pairing-transaction")
        } else {
            stateUpgrade.recoverPreserved(
                "pairing-transaction",
                validate = { restoredPairing.getOrThrow() },
            )
        }
        stateUpgrade.complete()
        gatewayState = matrixMlp3Projection.snapshot() ?: eventHub.snapshot().gatewayState
        if (gatewayState != null) {
            diagnostics.record("gateway.state.cache.restored")
        }
        matrix.setObserver(this)
        refreshSnapshot(publishLifecycle = false)
        schedulePendingPairingExpiry()
    }

    fun start(): ClientSnapshot {
        matrix.start()
        refreshSnapshot(publishLifecycle = true)
        return snapshot()
    }

    suspend fun bootstrap(input: MatrixBootstrap): Pair<PublicMatrixSession, ClientSnapshot> =
        mutex.withLock {
            val session = matrix.bootstrap(input)
            refreshSnapshot(publishLifecycle = true)
            session to snapshot()
        }

    fun snapshot(): ClientSnapshot = eventHub.snapshot()

    fun trustState(): PublicTrustState = publicTrust()

    fun subscribe(
        afterCursor: String?,
        maxReplayEvents: Int,
        listener: ClientEventListener,
    ): SubscriptionBootstrap = eventHub.subscribe(afterCursor, maxReplayEvents, listener)

    fun activate(subscriptionId: String, throughCursor: String): SubscriptionCursorResult =
        eventHub.activate(subscriptionId, throughCursor)

    fun acknowledge(subscriptionId: String, throughCursor: String): SubscriptionCursorResult =
        eventHub.acknowledge(subscriptionId, throughCursor)

    fun unsubscribe(subscriptionId: String): Boolean = eventHub.unsubscribe(subscriptionId)

    suspend fun historyPage(
        sessionId: String,
        before: String?,
        limit: Int,
        allowRemote: Boolean,
    ): HistoryPage {
        return try {
            // The Web bridge gives history.page 60 seconds. Bound the complete
            // native operation, including lock wait, pagination, verification,
            // and persistence, so a timed-out RPC cannot continue occupying a
            // hidden queue after the WebView has stopped waiting.
            withTimeout(HISTORY_PAGE_TOTAL_TIMEOUT_MS) {
                historyMutexes.computeIfAbsent(sessionId) { Mutex() }.withLock {
                    diagnostics.record("history.page.requested")
                val online = matrix.status.phase == MatrixRuntimePhase.SYNCING
                val initialized = sessionId in initializedHistoryRelations
                val externalHasMore = allowRemote && online && (
                    !initialized || historyRelationTokens.containsKey(sessionId)
                )
                var local = eventHub.historyPage(
                    sessionId,
                    before,
                    limit,
                    externalHasMore = externalHasMore,
                )
                val needsInitialRemotePage = before == null
                val needsOlderPage = before != null && local.messages.isEmpty() && externalHasMore
                if (!allowRemote || !online || (!needsInitialRemotePage && !needsOlderPage)) {
                    diagnostics.record("history.page.local")
                    return@withLock local
                }

                val threadRoot = matrixMlp3Projection.threadRootEventId(sessionId)
                if (threadRoot == null) {
                    // A newly-created session has no Matrix thread until its
                    // first prompt. Match the browser client: this is a valid
                    // empty history, not a restoration failure.
                    initializedHistoryRelations += sessionId
                    historyRelationTokens.remove(sessionId)
                    local = eventHub.historyPage(
                        sessionId,
                        before,
                        limit,
                        externalHasMore = false,
                    )
                    diagnostics.record(
                        "history.page.completed",
                        mapOf("received" to "0"),
                    )
                    return@withLock local
                }
                val projectId = matrixMlp3Projection.projectId(sessionId)
                    ?: throw IllegalStateException("The session has no project route.")
                val projectKeys = matrixMlp3ProjectKeys.value(projectId)
                    ?: throw IllegalStateException("The session project key is unavailable.")
                val roomId = try {
                    projectKeys.roomId
                } finally {
                    projectKeys.wipe()
                }
                var from = if (needsOlderPage) historyRelationTokens[sessionId] else null
                var imported = 0
                val visitedTokens = mutableSetOf<String?>()
                repeat(MAX_HISTORY_RELATION_PAGES_PER_REQUEST) {
                    check(visitedTokens.add(from)) {
                        "Matrix thread history repeated a pagination token."
                    }
                    val remote = matrix.loadThreadHistory(
                        threadRoot,
                        from,
                        maxOf(30, limit),
                        roomId,
                    )
                    val historicalMessages = mutableListOf<ClientMessage>()
                    mutex.withLock {
                        for (event in remote.events) {
                            decodeHistoricalMessage(event, sessionId)?.let(historicalMessages::add)
                        }
                        eventHub.upsertMessages(
                            sessionId,
                            historicalMessages,
                            refreshedSnapshot(),
                        )
                    }
                    imported += historicalMessages.size
                    initializedHistoryRelations += sessionId
                    if (!initialized || needsOlderPage) {
                        if (remote.nextBatch == null) historyRelationTokens.remove(sessionId)
                        else historyRelationTokens[sessionId] = remote.nextBatch
                    }
                    local = eventHub.historyPage(
                        sessionId,
                        before,
                        limit,
                        externalHasMore = online && historyRelationTokens.containsKey(sessionId),
                    )
                    if (local.messages.isNotEmpty() || remote.nextBatch == null) {
                        diagnostics.record(
                            "history.page.completed",
                            mapOf("received" to imported.toString()),
                        )
                        return@withLock local
                    }
                    from = remote.nextBatch
                }
                throw IllegalStateException(
                    "Matrix thread history exceeded the bounded pagination window.",
                )
                }
            }
        } catch (error: TimeoutCancellationException) {
            diagnostics.record(
                "history.page.failed",
                mapOf(
                    "type" to error::class.java.simpleName,
                ),
            )
            throw error
        } catch (error: CancellationException) {
            diagnostics.record("history.page.cancelled")
            throw error
        } catch (error: Exception) {
            diagnostics.record(
                "history.page.failed",
                mapOf(
                    "type" to error::class.java.simpleName,
                ),
            )
            throw error
        }
    }

    suspend fun inspectPairing(link: String): NativePairingPreview = mutex.withLock {
        val offer = PairingCodec.decodePairingLink(link)
        PairingSecurity.verifyOffer(offer, now = now())
        assertOfferRoute(offer)
        val activeTrust = trust
        val repairingSession = activeTrust != null
        if (activeTrust != null) {
            check(MatrixSessionRepairPolicy.required(activeTrust, matrix.publicSession())) {
                "Disconnect the current Gateway before pairing another one."
            }
            MatrixSessionRepairPolicy.requirePinnedOffer(activeTrust, offer)
        }
        pendingPairing?.let { current ->
            if (current.offer == offer) {
                pairingStorageBlocked = false
                return@withLock previewFor(current.offer)
            }
            check(current.request == null) {
                "Finish or cancel the confirmed pairing transaction before scanning another invitation."
            }
        }
        pairingStore.save(PersistedPairingTransaction(offer, null, null))
        clearPreTrustEvents()
        pendingPairing = PendingPairing(offer, repairingSession = repairingSession)
        schedulePendingPairingExpiry()
        pairingStorageBlocked = false
        val preview = NativePairingPreview(
            pairingId = offer.offer.offerId,
            gatewayId = offer.offer.gatewayId,
            gatewayName = offer.offer.gatewayName,
            verificationCode = verificationCode(offer),
            expiresAt = offer.offer.expiresAt,
        )
        eventHub.publish(ClientEventType.PAIRING_CHANGED, preview.toJson(), refreshedSnapshot())
        preview
    }

    suspend fun pairingConfirmation(pairingId: String): Pair<NativePairingPreview, Boolean>? =
        mutex.withLock {
            pendingPairing
                ?.takeIf { it.offer.offer.offerId == pairingId }
                ?.let { previewFor(it.offer) to (it.request != null) }
        }

    suspend fun completePairing(
        pairingId: String,
        deviceName: String,
    ): Pair<PublicTrustState.Trusted, ClientSnapshot> {
        diagnostics.record("pairing.transaction.completion_requested")
        val result = mutex.withLock {
            val pending = pendingPairing?.takeIf { it.offer.offer.offerId == pairingId }
                ?: throw IllegalArgumentException("The pairing preview is no longer available.")
            activePairingCompletion?.let { active ->
                check(active.pairingId == pairingId) {
                    "Another pairing transaction is already active."
                }
                return@withLock active.result
            }
            val deferred = CompletableDeferred<Pair<PublicTrustState.Trusted, ClientSnapshot>>()
            val job = scope.launch {
                try {
                    deferred.complete(executePairing(pending, deviceName))
                } catch (error: CancellationException) {
                    deferred.cancel(error)
                    throw error
                } catch (error: Exception) {
                    if (error is NativePairingRejectedException && !error.retryable) {
                        abandonPairing(pending, error.message ?: "Pairing was rejected.")
                    }
                    deferred.completeExceptionally(error)
                } finally {
                    mutex.withLock {
                        if (activePairingCompletion?.result === deferred) {
                            activePairingCompletion = null
                        }
                    }
                    if (
                        (trust == null || pending.repairingSession) &&
                        pendingPairing === pending &&
                        pending.request != null
                    ) {
                        pairingAutoResumeJob?.cancel()
                        pairingAutoResumeJob = scope.launch {
                            delay(PAIRING_AUTO_RESUME_DELAY_MS)
                            pairingAutoResumeJob = null
                            resumeConfirmedPairing()
                        }
                    }
                }
            }
            activePairingCompletion = ActivePairingCompletion(pairingId, deferred, job)
            deferred
        }
        return result.await()
    }

    private suspend fun executePairing(
        expectedPending: PendingPairing,
        deviceName: String,
    ): Pair<PublicTrustState.Trusted, ClientSnapshot> {
        val (pending, signedRequest, response) = mutex.withLock {
            val pending = pendingPairing?.takeIf { it === expectedPending }
                ?: throw IllegalStateException("The pairing transaction is no longer active.")
            val existingRequest = pending.request
            if (existingRequest == null) {
                check(now() < pending.offer.offer.expiresAt) { "The pairing offer has expired." }
            } else {
                check(now() < pairingTransactionExpiresAt(pending)) {
                    "The approved pairing recovery window expired. Scan a new invitation."
                }
            }
            val session = matrix.publicSession()
                ?: throw IllegalStateException("A native Matrix session is required before pairing.")
            val transport = transportIdentity
                ?: throw IllegalStateException("Matrix encryption keys are not ready yet.")
            assertOfferRoute(pending.offer)
            trust?.takeIf { pending.repairingSession }?.let { activeTrust ->
                MatrixSessionRepairPolicy.requirePinnedOffer(activeTrust, pending.offer)
                if (MatrixSessionRepairPolicy.required(activeTrust, session)) {
                    MatrixSessionRepairPolicy.requireReplacement(
                        activeTrust,
                        MatrixTransportBinding(
                            homeserver = session.homeserver,
                            roomId = session.roomBinding.roomId,
                            userId = session.userId,
                            deviceId = transport.deviceId,
                            ed25519 = transport.ed25519,
                        ),
                    )
                }
            }
            val signedRequest = existingRequest ?: run {
                val issuedAt = now()
                val request = PairingRequest(
                    requestId = UUID.randomUUID().toString(),
                    offerId = pending.offer.offer.offerId,
                    offerDigest = PairingSecurity.offerDigest(pending.offer),
                    gatewayId = pending.offer.offer.gatewayId,
                    deviceId = deviceId,
                    deviceName = deviceName.trim().ifEmpty { "Malink Android" }.take(128),
                    deviceKey = identity.publicIdentity,
                    deviceTransport = MatrixTransportBinding(
                        homeserver = session.homeserver,
                        roomId = session.roomBinding.roomId,
                        userId = session.userId,
                        deviceId = transport.deviceId,
                        ed25519 = transport.ed25519,
                    ),
                    requestedOperations = pending.offer.offer.allowedOperations,
                    issuedAt = issuedAt,
                    expiresAt = minOf(pending.offer.offer.expiresAt, issuedAt + PAIRING_REQUEST_MS),
                )
                PairingSecurity.signRequest(request, pending.offer, identity)
            }
            assertPairingRequestRoute(pending.offer, signedRequest, session, transport)
            pairingStore.save(PersistedPairingTransaction(
                pending.offer,
                signedRequest,
                pending.receivedResponse,
            ))
            diagnostics.record("pairing.transaction.request_persisted")
            val response = CompletableDeferred<SignedPairingResponse>()
            pending.request = signedRequest
            pending.response = response
            schedulePendingPairingExpiry()
            pending.receivedResponse?.let(response::complete)
            Triple(pending, signedRequest, response)
        }
        // Matrix I/O never runs under the domain-state mutex. A slow homeserver
        // must not starve pairing cancellation, process-death persistence, or
        // unrelated command recovery.
        if (response.isActive) {
            try {
                matrix.sendPairingMessage(pairingRequestContent(signedRequest).toString())
            } catch (error: Exception) {
                runCatching { matrix.closePairingChannel() }
                    .onFailure { closeError ->
                        diagnostics.record(
                            "matrix.pairing_channel.close_failure",
                            mapOf("error" to diagnosticErrorName(closeError)),
                        )
                    }
                throw error
            }
        }
        // A Gateway persists approval before provisioning current Room State.
        // If that publication or its response is interrupted, resending the
        // exact signed request resumes the same transaction without creating a
        // second identity, certificate, or approval.
        val retryJob = scope.launch {
            var completedRetries = 0
            while (isActive && response.isActive) {
                delay(pairingRequestRetryDelayMs(completedRetries))
                if (!response.isActive) break
                runCatching {
                    matrix.sendPairingMessage(pairingRequestContent(signedRequest).toString())
                }.onSuccess {
                    diagnostics.record(
                        "matrix.pairing_request.retried",
                        mapOf("attempt" to completedRetries.toString()),
                    )
                }.onFailure { error ->
                    diagnostics.record(
                        "matrix.pairing_request.retry_failure",
                        mapOf("error" to diagnosticErrorName(error)),
                    )
                }
                completedRetries += 1
            }
        }
        val signedResponse = try {
            try {
                withTimeout(PAIRING_RESPONSE_TIMEOUT_MS) { response.await() }
            } catch (_: TimeoutCancellationException) {
                throw NativePairingRejectedException(
                    "The Gateway did not answer the native pairing request in time.",
                )
            }
        } finally {
            retryJob.cancel()
            mutex.withLock {
                if (pendingPairing === pending && pending.response === response) {
                    pending.response = null
                }
            }
            runCatching { matrix.closePairingChannel() }
                .onFailure { error ->
                    diagnostics.record(
                        "matrix.pairing_channel.close_failure",
                        mapOf("error" to diagnosticErrorName(error)),
                    )
                }
        }
        val public = mutex.withLock {
            check(pendingPairing === pending) { "The pairing request is no longer active." }
            val synchronizedBeforeTrustCommit = gatewayStateSynchronized
            PairingSecurity.verifyResponse(
                signedResponse,
                pending.offer,
                signedRequest,
                pending.offer.offer.gatewayKey,
                now(),
            )
            val nextTrust = GatewayTrust(pending.offer, signedRequest, signedResponse).validate(now())
            trustStore.save(nextTrust)
            trust = nextTrust
            trustStorageBlocked = false
            gatewayStateSynchronized = MatrixSessionRepairPolicy.retainSynchronizedGatewayState(
                repairingSession = pending.repairingSession,
                synchronizedBeforeTrustCommit = synchronizedBeforeTrustCommit,
            )
            diagnostics.record(
                "pairing.transaction.trust_committed",
                mapOf(
                    "repair" to pending.repairingSession.toString(),
                    "state_synchronized" to gatewayStateSynchronized.toString(),
                ),
            )
            pendingPairing = null
            cancelPendingPairingExpiry()
            runCatching { pairingStore.clear() }
                .onFailure { error ->
                    // Trust is the authoritative commit. If the process stops
                    // here, startup ignores and retries deletion of the stale
                    // pre-trust transaction instead of rolling trust back.
                    diagnostics.record(
                        "pairing.transaction.cleanup_failure",
                        mapOf("error" to diagnosticErrorName(error)),
                    )
                }
            pairingStorageBlocked = false
            replayPreTrustEvents()
            replayMatrixMlp3InboxLocked()
            val public = publicTrust() as PublicTrustState.Trusted
            val nextSnapshot = refreshedSnapshot()
            eventHub.publish(ClientEventType.TRUST_CHANGED, PublicClientJson.encodeTrust(public), nextSnapshot)
            public
        }
        val workspaceBindings = workspaceRoomBindings(
            signedResponse,
            matrix.publicSession()?.roomBinding,
        )
        if (matrix.publicSession()?.roomBindings != workspaceBindings) {
            matrix.updateRoomBindings(workspaceBindings)
        }
        // Pairing commits trust before state convergence. The Gateway publishes
        // a key bundle addressed to this device before acknowledging a new
        // pairing, but Matrix delivery and a retry of an already accepted
        // request may still race. Keep the service-owned connection converging
        // until one complete authenticated MLP/3 projection is committed; never
        // make the WebView stay foreground merely to wait for that round trip.
        startMatrixMlp3ProjectionRefresh(recoverTransport = false)
        return mutex.withLock { public to snapshot() }
    }

    private fun workspaceRoomBindings(
        response: SignedPairingResponse,
        current: id.my.anciety.malink.matrix.MatrixRoomBinding?,
    ): List<id.my.anciety.malink.matrix.MatrixRoomBinding> {
        val signedDirectory = response.response.gatewayDirectory
            ?: return listOfNotNull(current)
        return workspaceRoomBindingsFromDirectory(
            signedDirectory,
            response.response.gatewayId,
        )
    }

    private fun workspaceRoomBindingsFromDirectory(
        signedDirectory: JsonObject,
        workspaceId: String,
    ): List<id.my.anciety.malink.matrix.MatrixRoomBinding> {
        val output = linkedMapOf<String, id.my.anciety.malink.matrix.MatrixRoomBinding>()
        val projectIds = mutableSetOf<String>()
        val directory = signedDirectory.requiredObject("directory")
        require(directory.requiredOpaqueId("workspaceId") == workspaceId) {
            "Gateway Directory belongs to another Workspace."
        }
        val gateways = directory["gateways"] as? JsonArray
            ?: throw IllegalArgumentException("Gateway Directory gateways are invalid.")
        for (gatewayElement in gateways) {
            val gateway = gatewayElement as? JsonObject
                ?: throw IllegalArgumentException("Gateway Directory entry is invalid.")
            require(gateway.requiredOpaqueId("workspaceId") == workspaceId)
            val transport = PairingCodec.parseTransport(gateway.requiredObject("transport"))
            val projects = gateway["projects"] as? JsonArray ?: continue
            for (projectElement in projects) {
                val project = projectElement as? JsonObject
                    ?: throw IllegalArgumentException("Workspace project route is invalid.")
                val projectId = project.requiredOpaqueId("projectId")
                require(projectIds.add(projectId)) { "Workspace project route is duplicated." }
                val roomId = project.requiredOpaqueId("roomId")
                require(roomId !in output) { "Workspace project room is duplicated." }
                output[roomId] = id.my.anciety.malink.matrix.MatrixRoomBinding(
                    roomId = roomId,
                    gatewayId = workspaceId,
                    conversationId = project.requiredOpaqueId("conversationId"),
                    gatewayUserId = transport.userId,
                    gatewayDeviceId = transport.deviceId,
                    gatewayDeviceEd25519 = transport.ed25519,
                )
            }
        }
        require(output.isNotEmpty()) { "Workspace Gateway Directory contains no project rooms." }
        return output.values.toList()
    }

    suspend fun cancelPairing(pairingId: String): Boolean = mutex.withLock {
        val pending = pendingPairing?.takeIf { it.offer.offer.offerId == pairingId } ?: return false
        pairingStore.clear()
        pending.response?.completeExceptionally(NativePairingRejectedException("Pairing was cancelled."))
        activePairingCompletion?.takeIf { it.pairingId == pairingId }?.job?.cancel()
        activePairingCompletion = null
        pairingAutoResumeJob?.cancel()
        pairingAutoResumeJob = null
        pendingPairing = null
        cancelPendingPairingExpiry()
        pairingStorageBlocked = false
        clearPreTrustEvents()
        eventHub.publish(
            ClientEventType.PAIRING_CHANGED,
            buildJsonObject { put("pairingId", pairingId); put("cancelled", true) },
            refreshedSnapshot(),
        )
        true
    }

    suspend fun sendCommand(
        idempotencyKey: String,
        payload: JsonObject,
        projectId: String? = null,
    ): DurableReceipt {
        val validatedPayload = CommandPayloadValidator.validate(payload)
        ensureCommandCapability(validatedPayload.operation)
        return mutex.withLock {
            val activeTrust = trust
                ?: throw NativeTrustRequiredException("Pair the Gateway before sending commands.")
            check(
                gatewayState != null &&
                gatewayStateSynchronized &&
                matrix.commandTransportReady
            ) { "Gateway command transport is not synchronized yet." }
            CommandAuthorizationPolicy.requireAuthorized(
                validatedPayload,
                activeTrust.certificate.allowedOperations,
            )
            val receipt = outbox.enqueue(
                idempotencyKey,
                payload,
                payload.string("sessionId"),
                projectId,
            )
            val current = outbox.get(receipt.commandId) ?: error("Durable command disappeared.")
            if (current.state == DurableState.QUEUED) {
                launchCommandTransmission(current.commandId, recovery = false)
            }
            publicReceipt(outbox.get(receipt.commandId) ?: current)
        }
    }

    suspend fun cancelCommand(
        idempotencyKey: String,
        sessionId: String,
        targetCommandId: String?,
    ): DurableReceipt = sendCommand(
        idempotencyKey,
        buildJsonObject {
            put("operation", "cancel")
            put("sessionId", sessionId)
            targetCommandId?.let { put("targetCommandId", it) }
        },
    )

    suspend fun recoverCommand(commandId: String): DurableReceipt {
        val current = outbox.resolveCurrent(commandId)
            ?: throw UnknownCommandException("Command was not found.")
        diagnostics.record(
            "command.recovery.requested",
            mapOf(
                "action" to (outbox.operation(current.commandId)?.wireName ?: "unknown"),
                "stage" to current.state.wireName,
            ),
        )
        when (current.state) {
            DurableState.QUEUED -> launchCommandTransmission(current.commandId, recovery = false)
            DurableState.RECOVERY_REQUIRED -> {
                cancelScheduledCommandRecovery(current.commandId, resetAttempts = false)
                launchCommandTransmission(current.commandId, recovery = true)
            }
            DurableState.PUBLISHED, DurableState.RUNNING -> {
                // Matrix already durably accepted this transaction. Sending
                // the same transaction again can only return its original
                // event id; it cannot create a new timeline delivery. Recover
                // any missed signed progress/terminal events through /sync.
                startMatrixMlp3ProjectionRefresh(recoverTransport = false)
            }
            else -> Unit
        }
        return publicReceipt(outbox.get(current.commandId) ?: current)
    }

    fun command(commandId: String): CommandView = outbox.resolveCurrent(commandId)?.let(::publicCommand)
        ?: throw UnknownCommandException("Command was not found.")

    suspend fun issueMatrixLoginToken(
        invitationId: String,
        password: String?,
    ): MatrixLoginTokenIssueResult {
        mutex.withLock {
            check(trust != null) { "Pair the Gateway before creating another device invitation." }
            check(outbox.operation(invitationId) == CommandOperation.DEVICE_INVITE) {
                "The invitation is not owned by this native bridge."
            }
            check(outbox.get(invitationId)?.completion?.outcome == DurableOutcome.SUCCEEDED) {
                "The Gateway must accept the device invitation before Matrix sign-in is issued."
            }
        }
        // The one-time token is returned directly from the in-memory Matrix
        // session and is never written to the native command/event stores.
        return matrix.issueLoginToken(password)
    }

    fun releaseCommand(commandId: String): Boolean {
        cancelCommandTransmission(commandId)
        cancelScheduledCommandRecovery(commandId)
        val released = outbox.release(commandId)
        if (released) matrixMlp3CommandContent.remove(commandId)
        if (released) refreshSnapshot(publishLifecycle = false)
        return released
    }

    suspend fun resolveConflict(commandId: String, action: RevisionConflictAction): DurableReceipt =
        throw IllegalStateException(
            "MLP/3 command $commandId has no global revision conflict to ${action.name.lowercase()}.",
        )

    fun openUpload(name: String, mimeType: String, size: Long, sha256: String): UploadTransfer =
        transfers.openUpload(name, mimeType, size, sha256)

    fun uploadChunk(
        transferId: String,
        index: Int,
        dataBase64Url: String,
        chunkSha256: String,
    ): UploadChunkReceipt = transfers.writeUploadChunk(transferId, index, dataBase64Url, chunkSha256)

    suspend fun finishUpload(transferId: String) = transfers.finishUpload(transferId)
    fun abortUpload(transferId: String): Boolean = transfers.abortUpload(transferId)
    suspend fun openDownload(attachment: id.my.anciety.malink.client.events.MalinkAttachment) =
        transfers.openDownload(attachment)
    fun readDownload(transferId: String, index: Int) = transfers.readDownload(transferId, index)
    fun closeDownload(transferId: String): Boolean = transfers.closeDownload(transferId)

    suspend fun disconnect(revoke: Boolean): ClientSnapshot = mutex.withLock {
        if (revoke) {
            matrix.revokeSession()
        } else {
            matrix.stop(clearSession = false)
        }
        cancelAllCommandTransmissions()
        cancelAllCommandRecoveries()
        authoritativeStateRefreshJob?.cancel()
        authoritativeStateRefreshJob = null
        cancelGatewayConvergenceFallback()
        workspaceDirectoryConvergenceJob?.cancel()
        workspaceDirectoryConvergenceJob = null
        gatewayStateSynchronized = false
        if (revoke) {
            trustStore.clear()
            replayStore.clear()
            timelineKeys.clear()
            matrixMlp3ProjectKeys.clear()
            matrixMlp3Inbox.clear()
            matrixMlp3Projection.clear()
            matrixMlp3ProjectionStore.clear()
            matrixMlp3CommandContent.clear()
            pairingStore.clear()
            outbox.clear()
            transfers.clear()
            trust = null
            trustStorageBlocked = false
            pairingStorageBlocked = false
            gatewayState = null
            pendingPairing = null
            cancelPendingPairingExpiry()
            pairingAutoResumeJob?.cancel()
            pairingAutoResumeJob = null
            clearPreTrustEvents()
        }
        refreshSnapshot(publishLifecycle = true)
        snapshot()
    }

    suspend fun close() {
        matrix.setObserver(null)
        cancelAllCommandTransmissions()
        cancelAllCommandRecoveries()
        authoritativeStateRefreshJob?.cancel()
        authoritativeStateRefreshJob = null
        cancelGatewayConvergenceFallback()
        workspaceDirectoryConvergenceJob?.cancel()
        workspaceDirectoryConvergenceJob = null
        transfers.clear()
        matrix.close()
        scope.cancel()
    }

    override fun onPairingTransportReady(identity: MatrixTransportIdentity) {
        transportIdentity = identity
        diagnostics.record("matrix.pairing_transport.ready")
        if (
            (trust == null || pendingPairing?.repairingSession == true) &&
            !pairingStorageBlocked &&
            pendingPairing?.request != null
        ) {
            resumeConfirmedPairing()
        }
    }

    override fun onRuntimeStatusChanged() {
        refreshSnapshot(publishLifecycle = true)
    }

    override fun onTransportReady(identity: MatrixTransportIdentity) {
        transportIdentity = identity
        gatewayStateSynchronized = trust != null &&
            matrixMlp3ProjectKeys.isNotEmpty() &&
            matrixMlp3Projection.snapshot() != null
        refreshSnapshot(publishLifecycle = true)
        if (trust != null) {
            scheduleWorkspaceDirectoryConvergence()
            scope.launch {
                mutex.withLock {
                    runCatching { recoverGatewayTransportSnapshotLocked() }
                        .onFailure { error ->
                            diagnostics.record(
                                "gateway.transport.recovery.failure",
                                mapOf("error" to diagnosticErrorName(error)),
                            )
                        }
                    replayMatrixMlp3InboxLocked()
                    matrixMlp3Projection.snapshot()?.let(::acceptMatrixMlp3GatewayState)
                }
            }
        } else if (
            pendingPairing?.repairingSession == true &&
            !pairingStorageBlocked &&
            pendingPairing?.request != null
        ) {
            resumeConfirmedPairing()
        }
    }

    override fun hasCachedApplicationProjection(): Boolean =
        trust != null &&
            matrixMlp3ProjectKeys.isNotEmpty() &&
            matrixMlp3Projection.snapshot() != null

    override fun onConvergenceRequired(reason: String) {
        requestAuthoritativeConvergence(reason)
    }

    fun requestAuthoritativeConvergence(reason: String) {
        val diagnosticReason = reason
            .replace(Regex("[^A-Za-z0-9._:+/-]"), "_")
            .take(160)
            .ifBlank { "unspecified" }
        diagnostics.record(
            "gateway.convergence.requested",
            mapOf("reason" to diagnosticReason),
        )
        if (trust == null || authoritativeStateRefreshJob?.isActive == true) return
        startMatrixMlp3ProjectionRefresh(recoverTransport = false)
    }

    override suspend fun onDecryptedEvent(event: MatrixDecryptedEvent) {
        mutex.withLock {
            val isV3 = isMatrixMlp3RawEvent(event.rawJson)
            if (isV3) matrixMlp3Inbox.put(event)
            try {
                processMatrixEvent(event)
                if (isV3) matrixMlp3Inbox.projected(event.eventId)
            } catch (error: MatrixMlp3EventDeferredException) {
                diagnostics.record(
                    "matrix.v3_event.deferred",
                    mapOf("reason" to diagnosticErrorName(error)),
                )
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                diagnostics.record(
                    "matrix.native_event.rejected",
                    mapOf(
                        "error" to diagnosticErrorName(error),
                        "code" to if (error is MalinkSecurityException) {
                            error.code.name
                        } else {
                            "NONE"
                        },
                    ),
                )
                if (isV3) {
                    matrixMlp3Inbox.quarantine(event.eventId, error)
                    publishStatus(lifecycle().phase, "matrix_v3_event_quarantined")
                    return@withLock
                }
                if (error !is MalinkSecurityException) {
                    publishStatus(lifecycle().phase, "native_event_rejected")
                    throw error
                }
            }
        }
    }

    private fun launchCommandTransmission(
        commandId: String,
        recovery: Boolean,
    ) {
        synchronized(commandTransmissionJobs) {
            if (commandTransmissionJobs[commandId]?.isActive == true) return
            val job = scope.launch(start = CoroutineStart.LAZY) {
                try {
                    transmit(commandId, recovery)
                } catch (error: CancellationException) {
                    throw error
                } catch (error: Exception) {
                    diagnostics.record(
                        "command.transmission.failure",
                        mapOf(
                            "action" to (outbox.operation(commandId)?.wireName ?: "unknown"),
                            "stage" to when {
                                recovery -> "recovery"
                                else -> "initial"
                            },
                            "error" to diagnosticErrorName(error),
                        ),
                    )
                } finally {
                    val currentJob = coroutineContext[Job]
                    if (currentJob != null) commandTransmissionJobs.remove(commandId, currentJob)
                }
            }
            commandTransmissionJobs[commandId] = job
            job.start()
        }
    }

    private fun cancelCommandTransmission(commandId: String) {
        commandTransmissionJobs.remove(commandId)?.cancel()
    }

    private fun cancelAllCommandTransmissions() {
        commandTransmissionJobs.values.forEach(Job::cancel)
        commandTransmissionJobs.clear()
    }

    /**
     * Command Matrix I/O must never run while [mutex] is held. Bridge mutations
     * only commit durable command state synchronously; delivery continues in a
     * background task so a slow Matrix send cannot starve local recovery RPCs.
     */
    private suspend fun transmit(
        commandId: String,
        recovery: Boolean,
    ) {
        val transmission = mutex.withLock {
            val claimed = if (recovery) {
                outbox.claimRecovery(commandId)
            } else {
                outbox.claimForTransmission(commandId)
            } ?: return@withLock null
            publishCommand(outbox.get(commandId) ?: return@withLock null)
            claimed
        } ?: return
        try {
            val content = signedCommandContent(transmission)
            val roomId = commandRoomId(transmission)
            val matrixEventId = sendTrustedControlMessage(
                content.toString(),
                "malink.v3.command.${transmission.commandId}",
                roomId,
            )
            mutex.withLock {
                if (outbox.recordPublished(transmission.commandId, matrixEventId)) {
                    outbox.get(transmission.commandId)?.let(::publishCommand)
                }
                applyOwnMatrixMlp3Command(content, matrixEventId, transmission.issuedAt, roomId)
            }
        } catch (error: Exception) {
            val remainsCurrent = mutex.withLock {
                val current = outbox.get(commandId)
                if (current == null || current.state.isTerminal) return@withLock false
                outbox.markTransmissionUncertain(commandId)?.let(::publishCommand)
                scheduleCommandRecovery(commandId)
                true
            }
            if (!remainsCurrent) {
                diagnostics.record(
                    "command.transmission.superseded",
                    mapOf("action" to (transmission.payload.string("operation") ?: "unknown")),
                )
                return
            }
            throw error
        }
    }

    private fun schedulePendingCommandRecoveries(immediate: Boolean) {
        val commands = outbox.list()
        queuedCommandIds(commands).forEach { commandId ->
            launchCommandTransmission(commandId, recovery = false)
        }
        recoverableCommandIds(commands).forEach { commandId ->
            scheduleCommandRecovery(commandId, immediate)
        }
    }

    private fun scheduleCommandRecovery(commandId: String, immediate: Boolean = false) {
        synchronized(commandRecoveryJobs) {
            if (commandRecoveryJobs[commandId]?.isActive == true) return
            val completedAttempts = commandRecoveryAttempts[commandId] ?: 0
            val retryDelayMs = if (immediate) 0L else commandRecoveryDelayMs(completedAttempts)
            val job = scope.launch {
                var retryAfterFailure = false
                try {
                    if (retryDelayMs > 0) delay(retryDelayMs)
                    val readyToTransmit = mutex.withLock {
                        val command = outbox.get(commandId)
                        if (command?.state != DurableState.RECOVERY_REQUIRED) return@withLock false
                        if (
                            trust == null ||
                            transportIdentity == null ||
                            gatewayState == null ||
                            !gatewayStateSynchronized
                        ) {
                            diagnostics.record(
                                "command.recovery.waiting_for_connection",
                                mapOf("action" to (outbox.operation(commandId)?.wireName ?: "unknown")),
                            )
                            return@withLock false
                        }
                        commandRecoveryAttempts[commandId] = completedAttempts + 1
                        diagnostics.record(
                            "command.recovery.attempted",
                            mapOf(
                                "action" to (outbox.operation(commandId)?.wireName ?: "unknown"),
                                "stage" to if (completedAttempts == 0) "initial" else "retry",
                            ),
                        )
                        true
                    }
                    if (readyToTransmit) {
                        try {
                            transmit(commandId, recovery = true)
                        } catch (error: CancellationException) {
                            throw error
                        } catch (error: Exception) {
                            retryAfterFailure = true
                            diagnostics.record(
                                "command.recovery.failure",
                                mapOf("error" to diagnosticErrorName(error)),
                            )
                        }
                    }
                } finally {
                    val currentJob = coroutineContext[Job]
                    if (currentJob != null) commandRecoveryJobs.remove(commandId, currentJob)
                }
                if (retryAfterFailure) scheduleCommandRecovery(commandId)
            }
            commandRecoveryJobs[commandId] = job
        }
    }

    private fun cancelScheduledCommandRecovery(
        commandId: String,
        resetAttempts: Boolean = true,
    ) {
        commandRecoveryJobs.remove(commandId)?.cancel()
        if (resetAttempts) commandRecoveryAttempts.remove(commandId)
    }

    private fun cancelAllCommandRecoveries() {
        commandRecoveryJobs.values.forEach(Job::cancel)
        commandRecoveryJobs.clear()
        commandRecoveryAttempts.clear()
    }

    private fun signedCommandContent(transmission: CommandTransmission): JsonObject {
        matrixMlp3CommandContent.get(transmission.commandId)?.let { return it }
        val activeTrust = trust ?: throw NativeTrustRequiredException("Pair the Gateway before sending commands.")
        val targetProjectId = transmission.projectId
            ?: matrixMlp3ProjectKeys.values().singleOrNull()?.projectId
            ?: throw IllegalStateException("A target project is required for this command.")
        val keys = matrixMlp3ProjectKeys.value(targetProjectId)
            ?: throw IllegalStateException("The MLP/3 project key grant is unavailable.")
        val roomId = keys.roomId
        require(matrix.publicSession()?.roomBindings?.any { it.roomId == roomId } == true) {
            "The target project room is not bound to this Matrix session."
        }
        val raw = transmission.payload
        val operation = raw.string("operation")
            ?: throw IllegalArgumentException("Command operation is invalid.")
        val sessionId = raw.string("sessionId")
        val v3Operation: String
        val v3Payload: JsonObject
        val v3SessionId: String?
        when (operation) {
            "session.create" -> {
                v3Operation = "session.create"
                v3SessionId = transmission.commandId
                v3Payload = buildJsonObject {
                    put("operation", v3Operation)
                    raw.string("scope")?.let { put("scope", it) }
                    raw.string("provider")?.let { put("provider", it) }
                    raw.string("providerSessionId")?.let { put("providerSessionId", it) }
                    raw.string("title")?.let { put("title", it) }
                    raw.string("model")?.let { put("model", it) }
                    raw.string("reasoningEffort")?.let { put("reasoningEffort", it) }
                    raw.string("permissionMode")?.let { put("permissionMode", it) }
                    raw["extensions"]?.let { put("extensions", it) }
                    raw.string("initialPrompt")?.let { prompt ->
                        put("initialPrompt", buildJsonObject { put("text", prompt) })
                    }
                }
            }
            "prompt" -> {
                v3Operation = "prompt.submit"
                v3SessionId = sessionId ?: throw IllegalArgumentException("Prompt session is missing.")
                v3Payload = buildJsonObject {
                    put("operation", v3Operation)
                    put("text", raw.string("text") ?: "")
                    raw["attachments"]?.let { put("attachments", it) }
                }
            }
            "cancel" -> {
                v3Operation = "turn.cancel"
                v3SessionId = sessionId ?: throw IllegalArgumentException("Cancel session is missing.")
                v3Payload = buildJsonObject {
                    put("operation", v3Operation)
                    put(
                        "turnId",
                        raw.string("targetCommandId")
                            ?: throw IllegalArgumentException("The active turn ID is required to cancel."),
                    )
                }
            }
            "decision" -> {
                v3Operation = "decision.answer"
                v3SessionId = sessionId ?: throw IllegalArgumentException("Decision session is missing.")
                v3Payload = buildJsonObject {
                    put("operation", v3Operation)
                    put("requestId", raw.string("requestId")!!)
                    put("decision", raw.string("decision")!!)
                    raw.string("totp")?.let { put("totp", it) }
                }
            }
            "artifact.materialize" -> {
                v3Operation = "artifact.materialize"
                v3SessionId = sessionId
                    ?: throw IllegalArgumentException("Artifact session is missing.")
                v3Payload = buildJsonObject {
                    put("operation", v3Operation)
                    put(
                        "referenceId",
                        raw.string("referenceId")
                            ?: throw IllegalArgumentException("Artifact reference is missing."),
                    )
                    put(
                        "expectedStatRevision",
                        raw.string("expectedStatRevision")
                            ?: throw IllegalArgumentException("Artifact stat revision is missing."),
                    )
                }
            }
            "session.settings" -> {
                v3Operation = "session.update"
                v3SessionId = sessionId ?: throw IllegalArgumentException("Settings session is missing.")
                val patch = buildJsonObject {
                    raw.string("model")?.let { put("model", it) }
                    raw.string("reasoningEffort")?.let { put("reasoningEffort", it) }
                    raw.string("permissionMode")?.let { put("permissionMode", it) }
                }
                require(patch.isNotEmpty()) {
                    "Project directory changes belong to a Matrix project room in MLP/3."
                }
                v3Payload = buildJsonObject {
                    put("operation", v3Operation)
                    put("patch", patch)
                }
            }
            "project.settings" -> {
                v3Operation = "project.update"
                v3SessionId = null
                v3Payload = buildJsonObject {
                    put("operation", v3Operation)
                    put("patch", buildJsonObject {
                        raw.string("name")?.let { put("name", it) }
                        raw["model"]?.let { put("model", it) }
                        raw["reasoningEffort"]?.let { put("reasoningEffort", it) }
                        raw["defaultExtensions"]?.let { put("defaultExtensions", it) }
                    })
                }
            }
            "project.delete" -> {
                v3Operation = "project.delete"
                v3SessionId = null
                v3Payload = buildJsonObject { put("operation", v3Operation) }
            }
            "project.create" -> {
                v3Operation = "project.create"
                v3SessionId = null
                v3Payload = buildJsonObject {
                    put("operation", v3Operation)
                    put("name", raw.string("name")!!)
                    put("cwd", raw.string("cwd")!!)
                    raw.string("provider")?.let { put("provider", it) }
                    raw["createDirectory"]?.let { put("createDirectory", it) }
                }
            }
            "provider.sessions.list" -> {
                v3Operation = "provider.sessions.list"
                v3SessionId = null
                v3Payload = buildJsonObject {
                    put("operation", v3Operation)
                    put("provider", raw.string("provider")!!)
                    raw.string("cursor")?.let { put("cursor", it) }
                }
            }
            "provider.session.inspect" -> {
                v3Operation = "provider.session.inspect"
                v3SessionId = null
                v3Payload = buildJsonObject {
                    put("operation", v3Operation)
                    put("provider", raw.string("provider")!!)
                    put("providerSessionId", raw.string("providerSessionId")!!)
                }
            }
            "session.archive", "session.restore", "session.delete" -> {
                v3Operation = "session.set_lifecycle"
                v3SessionId = sessionId ?: throw IllegalArgumentException("Session lifecycle target is missing.")
                v3Payload = buildJsonObject {
                    put("operation", v3Operation)
                    put("state", when (operation) {
                        "session.archive", "session.delete" -> "archived"
                        "session.restore" -> "active"
                        else -> "archived"
                    })
                }
            }
            "device.invite" -> {
                v3Operation = "device.invitation.create"
                v3SessionId = null
                v3Payload = buildJsonObject {
                    put("operation", v3Operation)
                    raw.long("lifetimeMs")?.let { put("lifetimeMs", it) }
                }
            }
            "gateway.enrollment.invite" -> {
                v3Operation = "gateway.enrollment.invitation.create"
                v3SessionId = null
                v3Payload = buildJsonObject {
                    put("operation", v3Operation)
                    raw.long("lifetimeMs")?.let { put("lifetimeMs", it) }
                }
            }
            "gateway.enrollment.approve" -> {
                v3Operation = "gateway.enrollment.approve"
                v3SessionId = null
                v3Payload = buildJsonObject {
                    put("operation", v3Operation)
                    put(
                        "enrollmentId",
                        raw.string("enrollmentId")
                            ?: throw IllegalArgumentException("Gateway enrollment ID is missing."),
                    )
                }
            }
            "gateway.profile.update" -> {
                v3Operation = operation
                v3SessionId = null
                v3Payload = buildJsonObject {
                    put("operation", v3Operation)
                    put(
                        "gatewayNodeId",
                        raw.string("gatewayNodeId")
                            ?: throw IllegalArgumentException("Gateway node ID is missing."),
                    )
                    put(
                        "gatewayName",
                        raw.string("gatewayName")
                            ?: throw IllegalArgumentException("Gateway name is missing."),
                    )
                }
            }
            "gateway.update.stage" -> {
                v3Operation = operation
                v3SessionId = null
                v3Payload = buildJsonObject {
                    put("operation", v3Operation)
                    put(
                        "releaseId",
                        raw.string("releaseId")
                            ?: throw IllegalArgumentException("Gateway release ID is missing."),
                    )
                }
            }
            "gateway.update.apply" -> {
                v3Operation = operation
                v3SessionId = null
                v3Payload = buildJsonObject {
                    put("operation", v3Operation)
                    put(
                        "releaseId",
                        raw.string("releaseId")
                            ?: throw IllegalArgumentException("Gateway release ID is missing."),
                    )
                    put("mode", raw.string("mode") ?: "when_idle")
                }
            }
            "gateway.update.status" -> {
                v3Operation = operation
                v3SessionId = null
                v3Payload = buildJsonObject { put("operation", v3Operation) }
            }
            else -> throw IllegalArgumentException("Unsupported MLP/3 command operation.")
        }
        val command = buildJsonObject {
            put("kind", "malink.command")
            put("version", 3)
            put("commandId", transmission.commandId)
            put("workspaceId", activeTrust.gatewayId)
            put("projectId", keys.projectId)
            v3SessionId?.let { put("sessionId", it) }
            put("deviceId", deviceId)
            put("certificateId", activeTrust.certificate.certificateId)
            put("createdAt", transmission.issuedAt)
            put("operation", v3Operation)
            put("payload", v3Payload)
        }
        val nonce = MessageDigest.getInstance("SHA-256")
            .digest("malink-v3-command-nonce\u0000${transmission.commandId}".toByteArray())
            .copyOfRange(0, 12)
        val activeKey = keys.activeKey()
        val envelope = try {
            MatrixMlp3Protocol.sealSignedCommand(
                command,
                identity,
                roomId,
                keys.projectId,
                activeKey,
                nonce,
            )
        } finally {
            nonce.fill(0)
            keys.wipe()
        }
        val threadRoot = v3SessionId?.let(matrixMlp3Projection::threadRootEventId)
        val content = buildJsonObject {
            put("msgtype", "m.notice")
            put("body", "Encrypted Malink command")
            if (threadRoot != null && v3Operation != "session.create") {
                put("m.relates_to", buildJsonObject {
                    put("rel_type", "m.thread")
                    put("event_id", threadRoot)
                    put("is_falling_back", true)
                    put("m.in_reply_to", buildJsonObject { put("event_id", threadRoot) })
                })
            }
            put("io.malink", buildJsonObject {
                put("version", 3)
                put("envelope", envelope)
            })
        }
        return matrixMlp3CommandContent.putIfAbsent(transmission.commandId, content)
    }

    private fun commandRoomId(transmission: CommandTransmission): String {
        val targetProjectId = transmission.projectId
            ?: matrixMlp3ProjectKeys.values().singleOrNull()?.projectId
            ?: throw IllegalStateException("A target project is required for this command.")
        val keys = matrixMlp3ProjectKeys.value(targetProjectId)
            ?: throw IllegalStateException("The MLP/3 project key grant is unavailable.")
        return try {
            keys.roomId
        } finally {
            keys.wipe()
        }
    }

    private fun startMatrixMlp3ProjectionRefresh(
        recoverTransport: Boolean,
    ) {
        authoritativeStateRefreshJob?.cancel()
        authoritativeStateRefreshJob = scope.launch {
            if (recoverTransport) {
                mutex.withLock {
                    runCatching { recoverGatewayTransportSnapshotLocked() }
                        .onFailure { error ->
                            diagnostics.record(
                                "gateway.transport.recovery.failure",
                                mapOf("error" to diagnosticErrorName(error)),
                            )
                        }
                }
            }
            var completedAttempts = 0
            do {
                if (trust == null) break
                var refreshed = false
                runCatching { matrix.refreshApplicationProjection() }
                    .onSuccess {
                        refreshed = true
                        diagnostics.record("matrix.v3_projection.refresh_completed")
                    }
                    .onFailure { error ->
                        diagnostics.record(
                            "matrix.v3_projection.refresh_failure",
                            mapOf("error" to diagnosticErrorName(error)),
                        )
                    }
                if (
                    (gatewayStateSynchronized && refreshed) ||
                    trust == null
                ) break
                val delayMs = authoritativeStateRefreshDelayMs(completedAttempts)
                diagnostics.record(
                    "matrix.v3_projection.refresh_retry_scheduled",
                    mapOf(
                        "attempt" to completedAttempts.toString(),
                        "transport_ready" to matrix.commandTransportReady.toString(),
                    ),
                )
                completedAttempts += 1
                delay(delayMs)
            } while (isActive)
            if (gatewayStateSynchronized) {
                diagnostics.record("matrix.v3_projection.converged")
            }
        }
    }

    private fun diagnosticErrorName(error: Throwable): String =
        error::class.simpleName?.take(160)?.takeIf { it.isNotBlank() } ?: "Exception"

    /**
     * The content is already signed and encrypted to the paired Gateway by
     * Malink. Sending it as an application control event avoids coupling
     * command and recovery traffic to Matrix Megolm device-key distribution.
     */
    private suspend fun sendTrustedControlMessage(
        contentJson: String,
        transactionId: String,
        roomId: String? = null,
    ): String {
        val eventId = if (roomId == null) {
            matrix.sendApplicationControlEvent(contentJson, transactionId)
        } else {
            matrix.sendApplicationControlEvent(contentJson, transactionId, roomId)
        }
        diagnostics.record("matrix.application_control.sent")
        return eventId
    }

    private suspend fun ensureCommandCapability(operation: CommandOperation) {
        val requiredOperation = requiredCertificateOperation(operation)
        val currentTrust = mutex.withLock {
            val activeTrust = trust
                ?: throw NativeTrustRequiredException("Pair the Gateway before sending commands.")
            check(
                gatewayState != null &&
                    gatewayStateSynchronized &&
                    matrix.commandTransportReady
            ) { "Gateway command transport is not synchronized yet." }
            activeTrust
        }
        if (requiredOperation in currentTrust.certificate.allowedOperations) return
        capabilityRenewalMutex.withLock renewal@{
            var activeTrust = mutex.withLock {
                trust ?: throw NativeTrustRequiredException("Pair the Gateway before sending commands.")
            }
            if (requiredOperation in activeTrust.certificate.allowedOperations) {
                return@renewal
            }
            require(PairingOperation.DEVICE_INVITE in activeTrust.certificate.allowedOperations) {
                "This device certificate cannot renew its permissions. Pair this device again with a new invitation."
            }

            val resumable = mutex.withLock {
                pendingPairing?.takeIf { pending ->
                    pending.repairingSession &&
                        requiredOperation in pending.offer.offer.allowedOperations
                }
            }
            if (resumable != null) {
                completePairing(
                    resumable.offer.offer.offerId,
                    activeTrust.certificate.deviceName,
                )
                activeTrust = mutex.withLock {
                    trust ?: throw NativeTrustRequiredException(
                        "The renewed Gateway trust was not saved.",
                    )
                }
                if (requiredOperation in activeTrust.certificate.allowedOperations) {
                    return@renewal
                }
            }

            val renewal = requestCapabilityRenewalOffer(activeTrust, listOf(requiredOperation))
            val offer = PairingCodec.decodePairingLink(renewal.pairingLink)
            PairingSecurity.verifyOffer(offer, now = now())
            assertOfferRoute(offer)
            MatrixSessionRepairPolicy.requirePinnedOffer(activeTrust, offer)
            require(requiredOperation in offer.offer.allowedOperations) {
                "The Gateway renewal offer does not authorize ${requiredOperation.wireName}."
            }
            val pending = mutex.withLock {
                pendingPairing?.let { existing ->
                    check(existing.request == null) {
                        "A confirmed pairing transaction must finish before permissions can be renewed."
                    }
                    pairingStore.clear()
                }
                pairingStore.save(PersistedPairingTransaction(offer, null, null))
                PendingPairing(offer, repairingSession = true).also {
                    pendingPairing = it
                    schedulePendingPairingExpiry()
                }
            }
            completePairing(
                pending.offer.offer.offerId,
                activeTrust.certificate.deviceName,
            )
            activeTrust = mutex.withLock {
                trust ?: throw NativeTrustRequiredException(
                    "The renewed Gateway trust was not saved.",
                )
            }
            require(requiredOperation in activeTrust.certificate.allowedOperations) {
                "The renewed device certificate does not authorize ${requiredOperation.wireName}."
            }
        }
    }

    private suspend fun requestCapabilityRenewalOffer(
        activeTrust: GatewayTrust,
        requestedOperations: List<PairingOperation>,
    ): CapabilityRenewalOffer {
        val session = matrix.publicSession()
            ?: throw IllegalStateException("A native Matrix session is required to renew permissions.")
        val issuedAt = now()
        val request = CapabilityRenewalRequest(
            requestId = UUID.randomUUID().toString(),
            gatewayId = activeTrust.gatewayId,
            deviceId = activeTrust.certificate.deviceId,
            certificateId = activeTrust.certificate.certificateId,
            requestedOperations = requestedOperations.distinct(),
            issuedAt = issuedAt,
            expiresAt = issuedAt + CAPABILITY_RENEWAL_REQUEST_MS,
        )
        val waiter = CapabilityRenewalWaiter(
            certificateId = request.certificateId,
            result = CompletableDeferred(),
        )
        check(capabilityRenewalWaiters.putIfAbsent(request.requestId, waiter) == null)
        try {
            val plaintext = buildJsonObject {
                put("msgtype", "m.notice")
                put("body", "Encrypted Malink device permission renewal")
                put("io.malink", request.toJson())
            }
            val secureEnvelope = SecureEnvelopes.sealSecureEnvelope(
                bindings = SecureEnvelopeBindings(
                    gatewayId = activeTrust.gatewayId,
                    conversationId = session.roomBinding.conversationId,
                    direction = SecureEnvelopeDirection.DEVICE_TO_GATEWAY,
                    senderDeviceId = activeTrust.certificate.deviceId,
                    recipientDeviceId = activeTrust.certificate.gatewayId,
                    senderKeyId = identity.publicIdentity.keyId,
                    recipientKeyId = activeTrust.gatewayKey.keyId,
                ),
                plaintext = plaintext,
                senderIdentity = identity,
                recipientPublicKey = activeTrust.gatewayKey,
                envelopeId = "capability-renewal.${request.requestId}",
                now = issuedAt,
                lifetimeMs = CAPABILITY_RENEWAL_REQUEST_MS,
            )
            val content = buildJsonObject {
                put("msgtype", "m.notice")
                put("body", "Encrypted Malink device permission renewal")
                put("io.malink", buildJsonObject {
                    put("version", 1)
                    put("kind", "secure_envelope")
                    put("secure_envelope", secureEnvelope.toJson())
                })
            }
            sendTrustedControlMessage(
                content.toString(),
                "malink.capability-renewal.${request.requestId}",
            )
            return try {
                withTimeout(CAPABILITY_RENEWAL_TIMEOUT_MS) { waiter.result.await() }
            } catch (_: TimeoutCancellationException) {
                throw IllegalStateException(
                    "The Gateway did not renew this device's permissions in time.",
                )
            }
        } finally {
            capabilityRenewalWaiters.remove(request.requestId, waiter)
        }
    }

    private fun acceptCapabilityRenewalOffer(
        event: MatrixDecryptedEvent,
        extension: JsonObject,
    ) {
        val activeTrust = trust ?: return
        if (event.sender != activeTrust.transportTrust.currentTransport.userId) return
        require(extension.long("version") == 1L)
        require(extension.string("kind") == "secure_envelope")
        val session = matrix.publicSession()
            ?: throw IllegalStateException("The Matrix room binding is unavailable.")
        val signed = SecureEnvelopeCodec.parse(
            extension.objectValue("secure_envelope").toString(),
        )
        val opened = SecureEnvelopes.openSecureEnvelope(
            signed = signed,
            recipientIdentity = identity,
            senderPublicKey = activeTrust.gatewayKey,
            expected = SecureEnvelopeBindings(
                gatewayId = activeTrust.gatewayId,
                conversationId = session.roomBinding.conversationId,
                direction = SecureEnvelopeDirection.GATEWAY_TO_DEVICE,
                senderDeviceId = activeTrust.certificate.gatewayId,
                recipientDeviceId = activeTrust.certificate.deviceId,
                senderKeyId = activeTrust.gatewayKey.keyId,
                recipientKeyId = identity.publicIdentity.keyId,
            ),
            replayStore = replayStore,
            now = now(),
        )
        val offer = CapabilityRenewalCodec.parseOfferContent(opened.plaintext)
        require(offer.expiresAt > now()) { "The capability renewal offer has expired." }
        val waiter = capabilityRenewalWaiters[offer.requestId] ?: return
        require(waiter.certificateId == offer.certificateId) {
            "The capability renewal offer is bound to a different certificate."
        }
        waiter.result.complete(offer)
    }

    private suspend fun processMatrixEvent(event: MatrixDecryptedEvent) {
        if (matrix.publicSession()?.roomBindings?.none { it.roomId == event.roomId } != false) return
        val root = json.parseToJsonElement(event.rawJson).jsonObject
        val content = (root["content"] as? JsonObject) ?: return
        val eventType = root.string("type") ?: return
        if (eventType == MLP3_MATRIX_WORKSPACE_DIRECTORY_EVENT_TYPE) {
            acceptWorkspaceGatewayDirectory(content)
            return
        }
        if (processMatrixMlp3Event(event, root, content, eventType)) return
        val extension = content["io.malink"] as? JsonObject ?: return
        val kind = extension.string("kind") ?: return
        if (eventType == MALINK_MATRIX_APPLICATION_CONTROL_EVENT_TYPE) {
            if (kind == "secure_envelope") {
                acceptCapabilityRenewalOffer(event, extension)
            }
            return
        }
        if (kind == "pairing_response") {
            acceptPairingResponse(event, extension)
            return
        }
        if (kind == "pairing_rejection") {
            val pending = pendingPairing ?: return
            val request = pending.request ?: return
            if (event.sender != pending.offer.offer.gatewayTransport.userId) return
            val signed = PairingCodec.parseRejection(
                extension.objectValue("pairing_rejection").toString(),
            )
            val rejection = PairingSecurity.verifyRejection(
                signed,
                pending.offer,
                request,
                now(),
            )
            pending.response?.completeExceptionally(
                NativePairingRejectedException(rejection.message, rejection.retryable),
            )
            return
        }
        if (trust == null) return
        if (kind == "gateway_device_rotation") {
            acceptGatewayDeviceRotation(event, extension)
        }
    }

    private suspend fun processMatrixMlp3Event(
        event: MatrixDecryptedEvent,
        root: JsonObject,
        content: JsonObject,
        eventType: String,
    ): Boolean {
        if (
            eventType != MLP3_MATRIX_KEY_GRANT_EVENT_TYPE &&
            eventType != MLP3_MATRIX_PROJECT_POINTER_EVENT_TYPE &&
            eventType != MLP3_MATRIX_WORKSPACE_POINTER_EVENT_TYPE &&
            !(eventType == "m.room.message" &&
                (content["io.malink"] as? JsonObject)?.long("version") == 3L)
        ) return false
        val activeTrust = trust ?: throw MatrixMlp3EventDeferredException("gateway_trust_pending")
        val binding = matrix.publicSession()?.roomBindings?.singleOrNull {
            it.roomId == event.roomId
        } ?: throw MatrixMlp3EventDeferredException("matrix_room_pending")
        if (event.sender != binding.gatewayUserId) {
            // The application /sync lane accepts Gateway output only. A local
            // command is projected optimistically at the durable send boundary.
            return true
        }
        val roomId = event.roomId
        if (eventType == MLP3_MATRIX_KEY_GRANT_EVENT_TYPE) {
            // Key grants are directly addressed Room State. Matrix sync sends
            // every state key in the room, including grants for other paired
            // devices; those are ordinary irrelevant state, not poison input.
            if (content.string("deviceId") != identity.publicIdentity.keyId) return true
            val grant = MatrixMlp3Protocol.openProjectKeyGrant(
                state = content,
                identity = identity,
                gatewayKey = activeTrust.gatewayKey,
                expectedWorkspaceId = activeTrust.gatewayId,
                expectedRoomId = roomId,
                expectedCertificateId = activeTrust.certificate.certificateId,
            )
            matrixMlp3ProjectKeys.save(grant)
            grant.wipe()
            diagnostics.record("matrix.v3_project_keys.accepted")
            matrixMlp3Projection.snapshot()?.let(::acceptMatrixMlp3GatewayState)
            scope.launch {
                mutex.withLock { replayMatrixMlp3InboxLocked() }
            }
            return true
        }
        if (
            eventType == MLP3_MATRIX_PROJECT_POINTER_EVENT_TYPE ||
            eventType == MLP3_MATRIX_WORKSPACE_POINTER_EVENT_TYPE
        ) {
            val pointer = if (
                eventType == MLP3_MATRIX_PROJECT_POINTER_EVENT_TYPE
            ) {
                MatrixMlp3Protocol.verifyProjectPointer(
                    content,
                    activeTrust.gatewayKey,
                    activeTrust.gatewayId,
                    roomId,
                )
            } else {
                MatrixMlp3Protocol.verifyWorkspacePointer(
                    content,
                    activeTrust.gatewayKey,
                    activeTrust.gatewayId,
                    roomId,
                )
            }
            val keys = matrixMlp3ProjectKeys.values().firstOrNull { it.roomId == roomId }
                ?: throw MatrixMlp3EventDeferredException("project_key_grant_pending")
            try {
                require(pointer.string("projectId") == keys.projectId) {
                    "The MLP/3 project pointer targets another project."
                }
            } finally {
                keys.wipe()
            }
            val snapshotEvent = matrix.fetchApplicationEvent(
                pointer.string("eventId")
                    ?: throw IllegalArgumentException("The MLP/3 pointer event ID is missing."),
                roomId,
            )
            val inserted = matrixMlp3Inbox.put(snapshotEvent)
            if (inserted) {
                try {
                    processMatrixEvent(snapshotEvent)
                    matrixMlp3Inbox.projected(snapshotEvent.eventId)
                } catch (error: MatrixMlp3EventDeferredException) {
                    throw error
                } catch (error: Exception) {
                    matrixMlp3Inbox.quarantine(snapshotEvent.eventId, error)
                    throw error
                }
            }
            return true
        }
        val keys = matrixMlp3ProjectKeys.values().firstOrNull { it.roomId == roomId }
            ?: throw MatrixMlp3EventDeferredException("project_key_grant_pending")
        val extension = content["io.malink"] as? JsonObject
            ?: throw IllegalArgumentException("The MLP/3 extension is missing.")
        val opened = try {
            MatrixMlp3Protocol.openContent(extension, roomId, keys.projectId, keys)
        } finally {
            keys.wipe()
        }
        val kind = opened.plaintext.string("kind")
        if (kind != "signed_event") return true
        val signed = opened.plaintext.objectValue("value")
        val protocolEvent = MatrixMlp3Protocol.verifyGatewayEvent(
            signed,
            activeTrust.gatewayKey,
            activeTrust.gatewayId,
            opened.projectId,
        )
        val protocolPayload = protocolEvent.objectValue("payload")
        if (protocolPayload.string("type") == "workspace.snapshot") {
            require(protocolPayload.string("gatewayKeyId") == activeTrust.gatewayKey.keyId) {
                "The MLP/3 workspace snapshot names another Gateway key."
            }
            (protocolPayload["gatewayDirectory"] as? JsonObject)?.let {
                acceptWorkspaceGatewayDirectory(it)
            }
        }
        require(opened.logicalEventId == protocolEvent.string("eventId")) {
            "The MLP/3 event envelope logical ID is invalid."
        }
        val relation = content["m.relates_to"] as? JsonObject
        val threadRootHint = relation
            ?.takeIf { it.string("rel_type") == "m.thread" }
            ?.string("event_id")
        val result = matrixMlp3Projection.applyGatewayEvent(
            protocolEvent,
            event.eventId,
            threadRootHint,
        )
        result.messages.forEach { message ->
            val sessionId = message.sessionId ?: return@forEach
            eventHub.upsertMessage(sessionId, message, refreshedSnapshot())
        }
        result.progressedCommandId?.let { commandId ->
            if (outbox.recordProgress(commandId, protocolEvent.string("sessionId"))) {
                cancelScheduledCommandRecovery(commandId)
                outbox.get(commandId)?.let(::publishCommand)
            }
        }
        result.terminal?.let(::recordMatrixMlp3Terminal)
        matrixMlp3Projection.snapshot()?.let(::acceptMatrixMlp3GatewayState)
        // Projection persistence follows ClientEventHub persistence. If the
        // process stops between them, replay is harmless and history upsert
        // IDs deduplicate; the inverse order could lose a public message.
        matrixMlp3ProjectionStore.save(matrixMlp3Projection.durableState())
        return true
    }

    private fun acceptWorkspaceGatewayDirectory(signed: JsonObject) {
        val activeTrust = trust
            ?: throw MatrixMlp3EventDeferredException("gateway_trust_pending")
        MatrixMlp3Protocol.verifyWorkspaceGatewayDirectory(
            signed,
            activeTrust.gatewayKey,
            activeTrust.gatewayId,
            matrixMlp3Projection.workspaceGatewayDirectoryRevision(),
        )
        if (!matrixMlp3Projection.applyWorkspaceGatewayDirectory(signed)) return
        val bindings = workspaceRoomBindingsFromDirectory(signed, activeTrust.gatewayId)
        val gateways = signed.requiredObject("directory")["gateways"] as? JsonArray
            ?: throw IllegalArgumentException("Gateway Directory gateways are invalid.")
        val projectIds = gateways.flatMap { gateway ->
            val projects = (gateway as? JsonObject)?.get("projects") as? JsonArray
                ?: throw IllegalArgumentException("Gateway Directory entry is invalid.")
            projects.map { project ->
                (project as? JsonObject)
                    ?.requiredOpaqueId("projectId")
                    ?: throw IllegalArgumentException("Workspace project route is invalid.")
            }
        }.toSet()
        matrixMlp3ProjectKeys.retain(projectIds)
        matrixMlp3Projection.retainProjects(projectIds)
        matrixMlp3Projection.snapshot()?.let(::acceptMatrixMlp3GatewayState)
        matrixMlp3ProjectionStore.save(matrixMlp3Projection.durableState())
        diagnostics.record(
            "matrix.workspace_directory.accepted",
            mapOf(
                "revision" to matrixMlp3Projection.workspaceGatewayDirectoryRevision().toString(),
                "rooms" to bindings.size.toString(),
            ),
        )
        scheduleWorkspaceDirectoryConvergence(bindings)
    }

    private fun scheduleWorkspaceDirectoryConvergence(
        initialBindings: List<id.my.anciety.malink.matrix.MatrixRoomBinding>? = null,
    ) {
        if (workspaceDirectoryConvergenceJob?.isActive == true) return
        workspaceDirectoryConvergenceJob = scope.launch {
            var bindings = initialBindings
            val retryDelays = longArrayOf(1_000L, 5_000L, 15_000L, 30_000L)
            for (attempt in 0..retryDelays.size) {
                val result = runCatching {
                    val next = bindings ?: mutex.withLock {
                        val activeTrust = trust
                            ?: throw IllegalStateException("Workspace trust is unavailable.")
                        val directory = matrixMlp3Projection.workspaceGatewayDirectory()
                            ?: return@withLock null
                        workspaceRoomBindingsFromDirectory(directory, activeTrust.gatewayId)
                    }
                    if (next == null) return@launch
                    bindings = null
                    val bindingsChanged = matrix.publicSession()?.roomBindings != next
                    if (bindingsChanged) {
                        matrix.updateRoomBindings(next)
                    }
                    if (bindingsChanged || !gatewayStateSynchronized) {
                        matrix.refreshApplicationProjection()
                    }
                }
                if (result.isSuccess) return@launch
                diagnostics.record(
                    "matrix.workspace_directory.convergence_failure",
                    mapOf(
                        "attempt" to (attempt + 1).toString(),
                        "error" to diagnosticErrorName(result.exceptionOrNull()!!),
                    ),
                )
                if (attempt < retryDelays.size) delay(retryDelays[attempt])
            }
        }
    }

    private suspend fun applyOwnMatrixMlp3Command(
        content: JsonObject,
        matrixEventId: String,
        timestamp: Long,
        roomId: String,
    ) {
        val activeTrust = trust ?: return
        if (matrix.publicSession()?.roomBindings?.none { it.roomId == roomId } != false) return
        val keys = matrixMlp3ProjectKeys.values().firstOrNull { it.roomId == roomId } ?: return
        val opened = try {
            MatrixMlp3Protocol.openContent(
                content.objectValue("io.malink"),
                roomId,
                keys.projectId,
                keys,
            )
        } finally {
            keys.wipe()
        }
        if (opened.plaintext.string("kind") != "signed_command") return
        val command = MatrixMlp3Protocol.verifyDeviceCommand(
            opened.plaintext.objectValue("value"),
            identity.publicIdentity,
            activeTrust.gatewayId,
            opened.projectId,
            activeTrust.certificate.certificateId,
        )
        require(opened.logicalEventId == command.string("commandId")) {
            "The MLP/3 command envelope logical ID is invalid."
        }
        val commandId = command.string("commandId")
            ?: throw IllegalArgumentException("The MLP/3 command id is missing.")
        val result = matrixMlp3Projection.applyOwnCommand(command, matrixEventId, timestamp)
        if (outbox.recordPublished(commandId, matrixEventId)) {
            outbox.get(commandId)?.let(::publishCommand)
        }
        result.messages.forEach { message ->
            val sessionId = message.sessionId ?: return@forEach
            eventHub.upsertMessage(sessionId, message, refreshedSnapshot())
        }
        matrixMlp3Projection.snapshot()?.let(::acceptMatrixMlp3GatewayState)
        matrixMlp3ProjectionStore.save(matrixMlp3Projection.durableState())
    }

    private fun recordMatrixMlp3Terminal(terminal: MatrixMlp3NativeTerminal) {
        val current = outbox.get(terminal.commandId) ?: return
        val outcome = when (terminal.outcome) {
            "succeeded" -> DurableOutcome.SUCCEEDED
            "cancelled" -> DurableOutcome.CANCELLED
            else -> DurableOutcome.FAILED
        }
        recordCommandCompletion(
            DurableCompletion(
                commandId = terminal.commandId,
                outcome = outcome,
                sessionId = terminal.sessionId,
                result = terminal.result,
                error = terminal.errorMessage?.let {
                    DurableError(
                        terminal.errorCode ?: "gateway_failed",
                        it.take(4_096),
                        terminal.retryable,
                    )
                },
            ),
            diagnosticEvent = "command.v3_completion.received",
            scheduleConvergenceFallback = false,
        )
    }

    private fun acceptMatrixMlp3GatewayState(snapshot: JsonObject) {
        if (snapshot.toString().toByteArray().size > MAX_BRIDGE_EVENT_PAYLOAD_BYTES) return
        val changed = gatewayState != snapshot
        gatewayState = snapshot
        gatewayStateSynchronized = trust != null && matrixMlp3ProjectKeys.values().isNotEmpty()
        acceptPublishedNativeRelease(snapshot)
        if (changed) {
            eventHub.publish(
                ClientEventType.GATEWAY_STATE_CHANGED,
                snapshot,
                refreshedSnapshot(),
            )
        }
        schedulePendingCommandRecoveries(immediate = true)
        refreshSnapshot(publishLifecycle = true)
    }

    private fun acceptPublishedNativeRelease(snapshot: JsonObject) {
        val release = (snapshot["native_client_releases"] as? JsonArray)
            .orEmpty()
            .mapNotNull { it as? JsonObject }
            .filter { candidate ->
                candidate["platform"]?.let { it as? JsonPrimitive }
                    ?.contentOrNull == "android" &&
                    candidate["channel"]?.let { it as? JsonPrimitive }
                        ?.contentOrNull == "alpha"
            }
            .maxByOrNull { candidate ->
                candidate["versionCode"]?.let { it as? JsonPrimitive }
                    ?.longOrNull ?: 0L
            }
            ?: return
        scope.launch {
            runCatching { NativeUpdateManager.get(appContext).acceptPublishedRelease(release) }
                .onFailure { error ->
                    diagnostics.record(
                        "update.gateway_release_dispatch_failed",
                        mapOf("error" to diagnosticErrorName(error)),
                    )
                }
        }
    }

    private suspend fun replayMatrixMlp3InboxLocked() {
        drainMatrixMlp3Inbox(matrixMlp3Inbox) { record ->
            try {
                processMatrixEvent(record.event)
                matrixMlp3Inbox.projected(record.event.eventId)
                MatrixMlp3InboxProjectionStep.ADVANCED
            } catch (_: MatrixMlp3EventDeferredException) {
                MatrixMlp3InboxProjectionStep.DEFERRED
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                matrixMlp3Inbox.quarantine(record.event.eventId, error)
                diagnostics.record(
                    "matrix.v3_event.quarantined",
                    mapOf("error" to diagnosticErrorName(error)),
                )
                MatrixMlp3InboxProjectionStep.ADVANCED
            }
        }
    }

    private suspend fun decodeHistoricalMessage(
        event: MatrixDecryptedEvent,
        expectedSessionId: String,
    ): ClientMessage? {
        val binding = matrix.publicSession()?.roomBindings?.singleOrNull {
            it.roomId == event.roomId
        } ?: return null
        val root = json.parseToJsonElement(event.rawJson).jsonObject
        val content = root["content"] as? JsonObject ?: return null
        val eventType = root.string("type") ?: return null
        if (eventType != "m.room.message") return null
        val extension = content["io.malink"] as? JsonObject ?: return null
        if (extension.long("version") == 3L) {
            val activeTrust = trust ?: return null
            if (event.sender != binding.gatewayUserId) return null
            val keys = matrixMlp3ProjectKeys.values().firstOrNull { it.roomId == event.roomId }
                ?: return null
            val opened = try {
                MatrixMlp3Protocol.openContent(extension, event.roomId, keys.projectId, keys)
            } finally {
                keys.wipe()
            }
            if (opened.plaintext.string("kind") != "signed_event") return null
            val protocolEvent = MatrixMlp3Protocol.verifyGatewayEvent(
                opened.plaintext.objectValue("value"),
                activeTrust.gatewayKey,
                activeTrust.gatewayId,
                opened.projectId,
            )
            require(opened.logicalEventId == protocolEvent.string("eventId")) {
                "The MLP/3 historical event envelope logical ID is invalid."
            }
            if (protocolEvent.string("sessionId") != expectedSessionId) return null
            val relation = content["m.relates_to"] as? JsonObject
            val threadRootHint = relation
                ?.takeIf { it.string("rel_type") == "m.thread" }
                ?.string("event_id")
            val projected = matrixMlp3Projection.applyGatewayEvent(
                protocolEvent,
                event.eventId,
                threadRootHint,
            )
            projected.progressedCommandId?.let { commandId ->
                outbox.recordProgress(commandId, protocolEvent.string("sessionId"))
            }
            projected.terminal?.let(::recordMatrixMlp3Terminal)
            matrixMlp3Projection.snapshot()?.let(::acceptMatrixMlp3GatewayState)
            matrixMlp3ProjectionStore.save(matrixMlp3Projection.durableState())
            return projected.messages.singleOrNull()?.copy(historical = true)
        }
        return null
    }


    private fun acceptPairingResponse(event: MatrixDecryptedEvent, extension: JsonObject) {
        val pending = pendingPairing ?: return
        if (event.sender != pending.offer.offer.gatewayTransport.userId) return
        val request = pending.request ?: return
        val signed = PairingCodec.parseResponse(extension.objectValue("pairing_response").toString())
        if (signed.response.requestId != request.request.requestId) return
        PairingSecurity.verifyResponse(
            signed,
            pending.offer,
            request,
            pending.offer.offer.gatewayKey,
            now(),
        )
        pairingStore.save(PersistedPairingTransaction(pending.offer, request, signed))
        pending.receivedResponse = signed
        schedulePendingPairingExpiry()
        diagnostics.record("pairing.transaction.response_persisted")
        pending.response?.complete(signed)
    }

    private fun bufferPreTrustEvent(event: MatrixDecryptedEvent) {
        synchronized(preTrustEvents) {
            if (preTrustEvents.size >= MAX_PRE_TRUST_EVENTS) {
                preTrustEvents.removeFirst()
                diagnostics.record("matrix.pretrust_event.evicted")
            }
            preTrustEvents.addLast(event)
        }
    }

    private suspend fun replayPreTrustEvents() {
        val buffered = synchronized(preTrustEvents) {
            preTrustEvents.toList().also { preTrustEvents.clear() }
        }
        if (buffered.isEmpty()) return
        diagnostics.record(
            "matrix.pretrust_events.replaying",
            mapOf("count" to buffered.size.toString()),
        )
        buffered.forEach { event ->
            runCatching { processMatrixEvent(event) }
                .onFailure { error ->
                    diagnostics.record(
                        "matrix.pretrust_event.rejected",
                        mapOf("error" to diagnosticErrorName(error)),
                    )
                }
        }
    }

    private fun clearPreTrustEvents() {
        synchronized(preTrustEvents) { preTrustEvents.clear() }
    }

    private fun acceptGatewayDeviceRotation(event: MatrixDecryptedEvent, extension: JsonObject) {
        val activeTrust = trust ?: return
        val signed = GatewayTransportCodec.parseRotation(
            extension.objectValue("gateway_device_rotation").toString(),
        )
        if (event.sender != signed.rotation.nextTransport.userId) return
        val next = activeTrust.copy(
            transportTrust = activeTrust.transportTrust.applyRotation(signed, now()),
        )
        trustStore.save(next)
        trust = next
        eventHub.publish(
            ClientEventType.TRUST_CHANGED,
            PublicClientJson.encodeTrust(publicTrust()),
            refreshedSnapshot(),
        )
    }

    private suspend fun recoverGatewayTransportSnapshotLocked() {
        val activeTrust = trust ?: return
        val current = activeTrust.transportTrust.currentTransport
        val profile = matrix.profileProperty(current.userId, GATEWAY_TRANSPORT_PROFILE_FIELD) ?: return
        require(profile.keys == setOf("version", "signed_snapshot")) {
            "Gateway transport recovery profile has an invalid shape."
        }
        require(profile.long("version") == 1L)
        val signed = GatewayTransportCodec.parseSnapshot(
            profile.objectValue("signed_snapshot").toString(),
        )
        val nextTransport = try {
            activeTrust.transportTrust.applySnapshot(signed, now())
        } catch (error: MalinkSecurityException) {
            if (error.code == id.my.anciety.malink.security.malink.SecurityErrorCode.REPLAY) return
            throw error
        }
        val next = activeTrust.copy(transportTrust = nextTransport)
        trustStore.save(next)
        trust = next
        diagnostics.record("gateway.transport.recovery.accepted")
        eventHub.publish(
            ClientEventType.TRUST_CHANGED,
            PublicClientJson.encodeTrust(publicTrust()),
            refreshedSnapshot(),
        )
    }


    private fun recordCommandCompletion(
        completion: DurableCompletion,
        diagnosticEvent: String,
        scheduleConvergenceFallback: Boolean,
    ) {
        // Capture metadata before publishing the terminal event. A Web client
        // may synchronously consume it and release the durable command.
        val operation = outbox.operation(completion.commandId)
        val recorded = outbox.recordCompletion(completion)
        diagnostics.record(
            diagnosticEvent,
            mapOf(
                "available" to recorded.toString(),
                "action" to (operation?.wireName ?: "unavailable"),
                "stage" to completion.outcome.wireName,
            ),
        )
        if (!recorded) return
        // Matrix can deliver the authenticated result through /sync before
        // the SDK call which sent that same event has returned. Once the
        // command is terminal, its transmission lease has no remaining work;
        // cancelling it prevents the late sender from observing a rotated
        // Gateway scope and reporting a spurious transmission failure.
        cancelCommandTransmission(completion.commandId)
        cancelScheduledCommandRecovery(completion.commandId)
        outbox.get(completion.commandId)?.let(::publishCommand)
        runCatching {
            operation?.let { completedOperation ->
                if (scheduleConvergenceFallback) {
                    scheduleGatewayConvergenceFallback(
                        completion.revision,
                        completedOperation,
                    )
                }
                onCommandCompletion(completedOperation, completion)
            }
        }.onFailure { error ->
            diagnostics.record(
                "command.completion.callback_failed",
                mapOf("error" to error.javaClass.simpleName.take(160)),
            )
        }
    }


    private fun pairingRequestContent(request: SignedPairingRequest): JsonObject = buildJsonObject {
        put("msgtype", "m.notice")
        put("body", "Malink pairing request")
        put("io.malink", buildJsonObject {
            put("version", 1)
            put("kind", "pairing_request")
            put("pairing_request", request.toJson())
        })
    }

    private fun assertOfferRoute(offer: SignedPairingOffer) {
        val session = matrix.publicSession()
            ?: throw IllegalStateException("A native Matrix session is required before pairing.")
        val binding = session.roomBinding
        val route = offer.offer.gatewayTransport
        require(offer.offer.gatewayId == binding.gatewayId)
        require(MatrixIdentifiers.normalizeHomeserver(route.homeserver) ==
            MatrixIdentifiers.normalizeHomeserver(session.homeserver))
        require(route.roomId == binding.roomId)
        require(route.userId == binding.gatewayUserId)
        require(route.deviceId == binding.gatewayDeviceId)
        require(route.ed25519 == binding.gatewayDeviceEd25519)
    }

    private fun assertPairingRequestRoute(
        offer: SignedPairingOffer,
        request: SignedPairingRequest,
        session: PublicMatrixSession,
        transport: MatrixTransportIdentity,
    ) {
        PairingSecurity.verifyRequest(request, offer, now = request.request.issuedAt)
        val document = request.request
        require(document.deviceId == deviceId)
        require(document.deviceKey == identity.publicIdentity)
        require(document.deviceTransport == MatrixTransportBinding(
            homeserver = session.homeserver,
            roomId = session.roomBinding.roomId,
            userId = session.userId,
            deviceId = transport.deviceId,
            ed25519 = transport.ed25519,
        )) { "The pairing request no longer matches this Matrix device." }
        require(transport.userId == session.userId) {
            "The active Matrix transport does not match its restored session."
        }
    }

    private fun resumeConfirmedPairing() {
        val pending = pendingPairing ?: return
        val request = pending.request ?: return
        if (activePairingCompletion?.job?.isActive == true) return
        pairingAutoResumeJob?.cancel()
        pairingAutoResumeJob = null
        scope.launch {
            diagnostics.record("pairing.transaction.auto_resume")
            runCatching {
                completePairing(pending.offer.offer.offerId, request.request.deviceName)
            }.onFailure { error ->
                if (error !is CancellationException) {
                    diagnostics.record(
                        "pairing.transaction.auto_resume_failure",
                        mapOf("error" to diagnosticErrorName(error)),
                    )
                    refreshSnapshot(publishLifecycle = true)
                }
            }
        }
    }

    private suspend fun abandonPairing(pending: PendingPairing, reason: String) {
        mutex.withLock {
            if (
                pendingPairing !== pending ||
                (trust != null && !pending.repairingSession)
            ) return
            pairingStore.clear()
            pendingPairing = null
            cancelPendingPairingExpiry()
            pairingStorageBlocked = false
            clearPreTrustEvents()
            diagnostics.record("pairing.transaction.rejected")
            eventHub.publish(
                ClientEventType.PAIRING_CHANGED,
                buildJsonObject {
                    put("pairingId", pending.offer.offer.offerId)
                    put("rejected", true)
                    put("reason", reason.take(256))
                },
                refreshedSnapshot(),
            )
        }
    }

    private fun expirePendingPairingIfNeeded() {
        val pending = pendingPairing ?: return
        val expiresAt = pairingTransactionExpiresAt(pending)
        if (expiresAt > now()) return
        cancelPendingPairingExpiry()
        pairingStore.clear()
        pending.response?.completeExceptionally(
            NativePairingRejectedException("The pairing transaction expired."),
        )
        activePairingCompletion?.job?.cancel()
        activePairingCompletion = null
        pairingAutoResumeJob?.cancel()
        pairingAutoResumeJob = null
        pendingPairing = null
        clearPreTrustEvents()
        diagnostics.record("pairing.transaction.expired")
        eventHub.publish(
            ClientEventType.PAIRING_CHANGED,
            buildJsonObject {
                put("pairingId", pending.offer.offer.offerId)
                put("expired", true)
            },
            refreshedSnapshot(),
        )
    }

    private fun schedulePendingPairingExpiry() {
        cancelPendingPairingExpiry()
        val expected = pendingPairing ?: return
        val expiresAt = pairingTransactionExpiresAt(expected)
        val delayMs = pendingPairingExpiryDelayMs(now(), expiresAt)
        pairingExpiryJob = scope.launch {
            delay(delayMs)
            mutex.withLock {
                if (pendingPairing !== expected) return@withLock
                pairingExpiryJob = null
                expirePendingPairingIfNeeded()
                if (pendingPairing === expected) schedulePendingPairingExpiry()
            }
        }
    }

    private fun cancelPendingPairingExpiry() {
        pairingExpiryJob?.cancel()
        pairingExpiryJob = null
    }

    private fun validateRestoredPairingTransaction(
        transaction: PersistedPairingTransaction,
    ): PersistedPairingTransaction? {
        // Verify cryptographic integrity at the documents' issuance times so
        // an approved exact request remains recoverable after its short
        // admission window. The invitation lifetime still bounds the local
        // transaction as a whole.
        PairingSecurity.verifyOffer(
            transaction.offer,
            now = transaction.offer.offer.issuedAt,
        )
        transaction.request?.let { request ->
            PairingSecurity.verifyRequest(request, transaction.offer, request.request.issuedAt)
            require(request.request.deviceId == deviceId)
            require(request.request.deviceKey == identity.publicIdentity)
            transaction.response?.let { response ->
                PairingSecurity.verifyResponse(
                    response,
                    transaction.offer,
                    request,
                    transaction.offer.offer.gatewayKey,
                    now(),
                )
            }
        }
        val expiresAt = transaction.response?.response?.expiresAt
            ?: transaction.request?.let(::pairingRecoveryExpiresAt)
            ?: transaction.offer.offer.expiresAt
        if (expiresAt <= now()) {
            pairingStore.clear()
            diagnostics.record("pairing.transaction.expired")
            return null
        }
        diagnostics.record(
            "pairing.transaction.restored",
            mapOf("request" to (transaction.request != null).toString()),
        )
        return transaction
    }

    private fun verificationCode(offer: SignedPairingOffer): String {
        val digest = MalinkCrypto.sha256(CanonicalJson.bytes(buildJsonObject {
            put("offerId", offer.offer.offerId)
            put("challenge", offer.offer.challenge)
            put("gatewayKeyId", offer.offer.gatewayKey.keyId)
        }))
        val number = (((digest[0].toInt() and 0xff) shl 16) or
            ((digest[1].toInt() and 0xff) shl 8) or
            (digest[2].toInt() and 0xff)) % 1_000_000
        return number.toString().padStart(6, '0').let { "${it.take(3)} ${it.drop(3)}" }
    }

    private fun previewFor(offer: SignedPairingOffer): NativePairingPreview =
        NativePairingPreview(
            pairingId = offer.offer.offerId,
            gatewayId = offer.offer.gatewayId,
            gatewayName = offer.offer.gatewayName,
            verificationCode = verificationCode(offer),
            expiresAt = offer.offer.expiresAt,
        )

    private fun pairingTransactionExpiresAt(pending: PendingPairing): Long =
        pending.receivedResponse?.response?.expiresAt
            ?: pending.request?.let(::pairingRecoveryExpiresAt)
            ?: pending.offer.offer.expiresAt

    /**
     * Matrix restoration and bridge startup run on different dispatchers. Keep
     * snapshot replacement and lifecycle publication in one critical section
     * so an older RESTORING observation cannot be emitted after a newer
     * WAITING_FOR_SESSION/repair observation.
     */
    @Synchronized
    private fun refreshSnapshot(publishLifecycle: Boolean) {
        val next = refreshedSnapshot()
        eventHub.updateSnapshot(next)
        val lifecycle = next.lifecycle.phase to next.lifecycle.detailCode
        if (publishLifecycle && lifecycle != lastLifecycle) {
            lastLifecycle = lifecycle
            publishStatus(lifecycle.first, lifecycle.second)
        }
    }

    private fun refreshedSnapshot(): ClientSnapshot {
        val previous = runCatching { eventHub.snapshot() }.getOrNull()
        val (active, notificationVisible) = foregroundState()
        val lifecycle = lifecycle()
        return ClientSnapshot(
            deviceId = deviceId,
            cursor = previous?.cursor ?: "initial",
            generatedAt = now(),
            lifecycle = lifecycle,
            foregroundService = ForegroundServiceState(
                active = active,
                notificationVisible = notificationVisible,
            ),
            trust = publicTrust(),
            gatewayState = gatewayState,
            commands = snapshotCommands(),
            pairing = pendingPairing?.let {
                buildJsonObject {
                    put("pairingId", it.offer.offer.offerId)
                    put("expiresAt", pairingTransactionExpiresAt(it))
                }
            },
        )
    }

    private fun initialSnapshot(): ClientSnapshot {
        val (active, visible) = foregroundState()
        return ClientSnapshot(
            deviceId = deviceId,
            cursor = "initial",
            generatedAt = now(),
            lifecycle = lifecycle(),
            foregroundService = ForegroundServiceState(active = active, notificationVisible = visible),
            trust = publicTrust(),
            commands = snapshotCommands(),
            pairing = pendingPairing?.let {
                buildJsonObject {
                    put("pairingId", it.offer.offer.offerId)
                    put("expiresAt", pairingTransactionExpiresAt(it))
                }
            },
        )
    }

    private fun snapshotCommands(): List<CommandView> =
        compactSnapshotCommands(outbox.list().map(::publicCommand))

    private fun lifecycle(): ClientLifecycle {
        val status = matrix.status
        if (trustStorageBlocked || pairingStorageBlocked) {
            return ClientLifecycle(
                LifecyclePhase.BLOCKED,
                status.since,
                if (trustStorageBlocked) {
                    "gateway_trust_unreadable"
                } else {
                    "pairing_transaction_unreadable"
                },
            )
        }
        val activeTrust = trust
        val phase = when {
            status.phase == MatrixRuntimePhase.STOPPED -> LifecyclePhase.STOPPED
            status.phase == MatrixRuntimePhase.WAITING_FOR_SESSION && activeTrust != null ->
                LifecyclePhase.BLOCKED
            status.phase == MatrixRuntimePhase.WAITING_FOR_SESSION -> LifecyclePhase.UNPAIRED
            status.phase == MatrixRuntimePhase.BOOTSTRAPPING -> LifecyclePhase.STARTING
            status.phase == MatrixRuntimePhase.RESTORING -> LifecyclePhase.SECURING
            status.phase == MatrixRuntimePhase.CONNECTING -> LifecyclePhase.CONNECTING
            status.phase == MatrixRuntimePhase.OFFLINE -> LifecyclePhase.OFFLINE
            status.phase == MatrixRuntimePhase.RETRY_WAIT -> LifecyclePhase.RECONNECTING
            status.phase == MatrixRuntimePhase.BLOCKED -> LifecyclePhase.BLOCKED
            activeTrust == null -> LifecyclePhase.UNPAIRED
            !matrix.commandTransportReady || !gatewayStateSynchronized -> LifecyclePhase.CONNECTING
            else -> LifecyclePhase.READY
        }
        val detail = if (
            phase == LifecyclePhase.BLOCKED &&
            status.phase == MatrixRuntimePhase.WAITING_FOR_SESSION &&
            activeTrust != null
        ) {
            "matrix_session_repair_required"
        } else if (
            phase == LifecyclePhase.CONNECTING &&
            status.phase == MatrixRuntimePhase.SYNCING &&
            activeTrust != null &&
            (!matrix.commandTransportReady || !gatewayStateSynchronized)
        ) {
            "matrix_gateway_state_syncing"
        } else {
            status.detailCode
        }
        return ClientLifecycle(phase, status.since, detail)
    }

    private fun publishStatus(phase: LifecyclePhase, detail: String?) {
        eventHub.publishTransient(
            ClientEventType.STATUS_CHANGED,
            buildJsonObject {
                put("phase", phase.wireValue)
                detail?.let { put("detail", it) }
            },
            refreshedSnapshot(),
        )
    }

    private fun scheduleGatewayConvergenceFallback(
        expectedRevision: Long,
        operation: CommandOperation,
    ) {
        val currentRevision = gatewayState?.long("revision")
        if (!requiresGatewayConvergence(currentRevision, expectedRevision)) {
            diagnostics.record(
                "gateway.state.timeline_converged",
                mapOf("action" to operation.wireName, "stage" to "completion"),
            )
            return
        }
        cancelGatewayConvergenceFallback()
        gatewayConvergenceMinimumRevision = expectedRevision
        diagnostics.record(
            "gateway.state.fallback_scheduled",
            mapOf("action" to operation.wireName),
        )
        gatewayConvergenceFallbackJob = scope.launch {
            delay(GATEWAY_CONVERGENCE_GRACE_MS)
            val shouldBackfill = mutex.withLock {
                val stillBehind = requiresGatewayConvergence(
                    gatewayState?.long("revision"),
                    expectedRevision,
                )
                if (gatewayConvergenceMinimumRevision == expectedRevision) {
                    gatewayConvergenceMinimumRevision = null
                    gatewayConvergenceFallbackJob = null
                }
                stillBehind && trust != null
            }
            if (shouldBackfill) {
                diagnostics.record(
                    "gateway.state.fallback_requested",
                    mapOf("action" to operation.wireName),
                )
                startMatrixMlp3ProjectionRefresh(recoverTransport = false)
            }
        }
    }

    private fun cancelGatewayConvergenceFallback() {
        gatewayConvergenceFallbackJob?.cancel()
        gatewayConvergenceFallbackJob = null
        gatewayConvergenceMinimumRevision = null
    }

    private fun publishCommand(command: DurableView) {
        val public = publicCommand(command)
        eventHub.publish(
            ClientEventType.COMMAND_CHANGED,
            PublicClientJson.encodeCommand(public),
            refreshedSnapshot(),
        )
    }

    private fun publicTrust(): PublicTrustState {
        if (trustStorageBlocked) return PublicTrustState.Blocked("gateway_trust_unreadable")
        if (pairingStorageBlocked) return PublicTrustState.Blocked("pairing_transaction_unreadable")
        pendingPairing?.let {
            return PublicTrustState.Pairing(
                it.offer.offer.offerId,
                pairingTransactionExpiresAt(it),
            )
        }
        val active = trust ?: return PublicTrustState.Unpaired
        return PublicTrustState.Trusted(
            gatewayId = active.gatewayId,
            gatewayNodeId = active.offer.offer.gatewayNodeId ?: active.gatewayId,
            gatewayName = active.offer.offer.gatewayName,
            certificateId = active.certificate.certificateId,
            pairedAt = active.certificate.issuedAt,
            activeDeviceCount = active.response.response.activeDeviceCount,
        )
    }

    private fun publicCommand(value: DurableView) = CommandView(
        operationId = value.operationId,
        commandId = value.commandId,
        idempotencyKey = value.idempotencyKey,
        state = if (value.state == DurableState.PUBLISHED) {
            CommandState.ACCEPTED
        } else {
            CommandState.valueOf(value.state.name)
        },
        submittedAt = value.submittedAt,
        updatedAt = value.updatedAt,
        sessionId = value.sessionId,
        sequence = value.sequence,
        revision = value.revision,
        cancelRequested = value.cancelRequested.takeIf { it },
        completion = value.completion?.let { completion ->
            CommandCompletion(
                commandId = completion.commandId,
                sequence = completion.sequence,
                revision = completion.revision,
                outcome = CommandOutcome.valueOf(completion.outcome.name),
                sessionId = completion.sessionId,
                result = completion.result,
                error = completion.error?.let {
                    PublicCommandError(it.code, it.message, it.retryable)
                },
            )
        },
    )

    private fun publicReceipt(value: DurableView) = DurableReceipt(
        operationId = value.operationId,
        commandId = value.commandId,
        idempotencyKey = value.idempotencyKey,
        state = value.state,
        submittedAt = value.submittedAt,
        updatedAt = value.updatedAt,
        sessionId = value.sessionId,
        sequence = value.sequence,
        revision = value.revision,
    )

    private fun NativePairingPreview.toJson(): JsonObject = buildJsonObject {
        put("pairingId", pairingId)
        put("gatewayId", gatewayId)
        put("gatewayName", gatewayName)
        put("verificationCode", verificationCode)
        put("expiresAt", expiresAt)
        put("requiresNativeConfirmation", true)
    }

    private fun conversationId(): String = matrix.publicSession()?.roomBinding?.conversationId
        ?: throw IllegalStateException("Matrix room binding is unavailable.")

    private fun currentSessionId(): String? = gatewayState?.string("current_session_id")

    private fun randomNonce(): String = Base64Url.encode(ByteArray(24).also(SecureRandom()::nextBytes))

    private fun JsonObject.string(key: String): String? = get(key)?.let { value ->
        runCatching { value.jsonPrimitive.takeIf { it.isString }?.contentOrNull }.getOrNull()
    }

    private fun JsonObject.long(key: String): Long? = get(key)?.jsonPrimitive?.longOrNull
    private fun JsonObject.int(key: String): Int? = get(key)?.jsonPrimitive?.intOrNull
    private fun JsonObject.objectValue(key: String): JsonObject = get(key) as? JsonObject
        ?: throw IllegalArgumentException("$key must be an object.")


    private companion object {
        const val BRIDGE_REPLAY_EVENT_LIMIT = 100
        const val MAX_HISTORY_RELATION_PAGES_PER_REQUEST = 20
        const val HISTORY_PAGE_TOTAL_TIMEOUT_MS = 50_000L
        const val MAX_PRE_TRUST_EVENTS = 256
        const val PAIRING_REQUEST_MS = 2 * 60_000L
        const val PAIRING_RESPONSE_TIMEOUT_MS = 60_000L
        const val CAPABILITY_RENEWAL_REQUEST_MS = 2 * 60_000L
        const val CAPABILITY_RENEWAL_TIMEOUT_MS = 60_000L
        const val PAIRING_AUTO_RESUME_DELAY_MS = 30_000L
        const val GATEWAY_TRANSPORT_PROFILE_FIELD = "io.malink.gateway_transport"
        const val GATEWAY_CONVERGENCE_GRACE_MS = 3_000L
    }
}

internal fun decodeMatrixToolGroup(extension: JsonObject): ToolGroupPresentation? {
    val ui = extension["ui"] ?: return null
    return runCatching { PublicClientJson.decodeToolGroup(ui) }.getOrNull()
}

private fun isMatrixMlp3RawEvent(rawJson: String): Boolean = runCatching {
    val root = Json.parseToJsonElement(rawJson).jsonObject
    when (root["type"]?.jsonPrimitive?.contentOrNull) {
        MLP3_MATRIX_KEY_GRANT_EVENT_TYPE,
        MLP3_MATRIX_PROJECT_POINTER_EVENT_TYPE,
        MLP3_MATRIX_WORKSPACE_POINTER_EVENT_TYPE,
        MLP3_MATRIX_WORKSPACE_DIRECTORY_EVENT_TYPE,
        -> true
        "m.room.message" ->
            (root["content"] as? JsonObject)
                ?.get("io.malink")
                ?.jsonObject
                ?.get("version")
                ?.jsonPrimitive
                ?.longOrNull == 3L
        else -> false
    }
}.getOrDefault(false)

internal fun requiresGatewayConvergence(
    currentRevision: Long?,
    expectedRevision: Long,
): Boolean {
    require(expectedRevision >= 0)
    return currentRevision == null || currentRevision < expectedRevision
}


internal fun commandRecoveryDelayMs(completedAttempts: Int): Long {
    require(completedAttempts >= 0)
    return when (completedAttempts) {
        0 -> 5_000L
        1 -> 15_000L
        2 -> 30_000L
        else -> 60_000L
    }
}

internal fun authoritativeStateRefreshDelayMs(completedAttempts: Int): Long {
    require(completedAttempts >= 0)
    return when (completedAttempts) {
        0 -> 1_000L
        1 -> 2_000L
        2 -> 5_000L
        3 -> 10_000L
        else -> 30_000L
    }
}

internal fun pairingRequestRetryDelayMs(completedRetries: Int): Long {
    require(completedRetries >= 0)
    return when (completedRetries) {
        0 -> 2_000L
        1 -> 5_000L
        else -> 10_000L
    }
}

internal fun pendingPairingExpiryDelayMs(now: Long, expiresAt: Long): Long {
    require(now >= 0)
    require(expiresAt >= 0)
    if (expiresAt <= now) return 0L
    return (expiresAt - now).coerceAtMost(MAX_PAIRING_EXPIRY_SLEEP_MS)
}

internal fun pairingRecoveryExpiresAt(request: SignedPairingRequest): Long =
    Math.addExact(request.request.issuedAt, PAIRING_RECOVERY_WINDOW_MS)

private const val PAIRING_RECOVERY_WINDOW_MS = 366L * 24 * 60 * 60_000
private const val MAX_PAIRING_EXPIRY_SLEEP_MS = 24L * 60 * 60_000

internal fun recoverableCommandIds(commands: List<DurableView>): List<String> =
    commands
        .asSequence()
        .filter { it.state == DurableState.RECOVERY_REQUIRED }
        .sortedBy(DurableView::submittedAt)
        .map(DurableView::commandId)
        .toList()

internal fun queuedCommandIds(commands: List<DurableView>): List<String> =
    commands
        .asSequence()
        .filter { it.state == DurableState.QUEUED }
        .sortedBy(DurableView::submittedAt)
        .map(DurableView::commandId)
        .toList()
