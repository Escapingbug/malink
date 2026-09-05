package id.my.anciety.malink.matrix

import id.my.anciety.malink.diagnostics.DiagnosticRecorder
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeout
import org.matrix.rustcomponents.sdk.Client
import org.matrix.rustcomponents.sdk.ClientBuilder
import org.matrix.rustcomponents.sdk.ClientException
import org.matrix.rustcomponents.sdk.ClientSessionDelegate
import org.matrix.rustcomponents.sdk.CrossProcessLockConfig
import org.matrix.rustcomponents.sdk.EventOrTransactionId
import org.matrix.rustcomponents.sdk.MediaSource
import org.matrix.rustcomponents.sdk.Membership
import org.matrix.rustcomponents.sdk.Room
import org.matrix.rustcomponents.sdk.RoomListService
import org.matrix.rustcomponents.sdk.RoomListServiceState
import org.matrix.rustcomponents.sdk.RoomListServiceStateListener
import org.matrix.rustcomponents.sdk.ReceiptThread
import org.matrix.rustcomponents.sdk.ReceiptType
import org.matrix.rustcomponents.sdk.SqliteStoreBuilder
import org.matrix.rustcomponents.sdk.SlidingSyncVersion
import org.matrix.rustcomponents.sdk.SlidingSyncVersionBuilder
import org.matrix.rustcomponents.sdk.SyncService
import org.matrix.rustcomponents.sdk.SyncServiceState
import org.matrix.rustcomponents.sdk.SyncServiceStateObserver
import org.matrix.rustcomponents.sdk.TaskHandle
import org.matrix.rustcomponents.sdk.Timeline
import org.matrix.rustcomponents.sdk.TimelineDiff
import org.matrix.rustcomponents.sdk.TimelineItem
import org.matrix.rustcomponents.sdk.TimelineListener

interface MatrixSdkDriver {
    suspend fun start(
        secrets: PersistedMatrixSecrets,
        files: MatrixAccountFiles,
        onSyncUpdate: () -> Unit,
        onSessionUpdated: (StoredMatrixSession) -> Unit,
        onTransportReady: (MatrixTransportIdentity) -> Unit,
        onTimelineEvent: suspend (MatrixDecryptedEvent) -> Unit,
        onRuntimeFailure: (Throwable) -> Unit,
    )

    fun isSyncRunning(): Boolean

    suspend fun setNetworkAvailable(available: Boolean)

    suspend fun sendPairingMessage(contentJson: String)

    suspend fun closePairingChannel()

    suspend fun uploadMedia(mimeType: String, bytes: ByteArray): String

    suspend fun downloadMedia(url: String): ByteArray

    suspend fun sendPrivateReadReceipt(
        roomId: String,
        threadRootEventId: String,
        eventId: String,
    ): Unit = throw UnsupportedOperationException("Matrix read receipts are unavailable.")

    suspend fun loadPrivateReadReceipt(
        roomId: String,
        threadRootEventId: String,
    ): String? = null

    /**
     * Extends one already-open SDK timeline towards older events. The same
     * persistent SDK listener remains the sole owner of decrypted delivery.
     */
    suspend fun paginateApplicationTimelineBackwards(
        roomId: String,
        eventLimit: Int,
    ): Boolean

    suspend fun logout()

    suspend fun stop()
}

data class MatrixTransportIdentity(
    val userId: String,
    val deviceId: String,
    val ed25519: String,
)

data class MatrixDecryptedEvent(
    val roomId: String,
    val eventId: String,
    val sender: String,
    val timestamp: Long,
    /** Complete decrypted Matrix event JSON. It never crosses the Web bridge. */
    val rawJson: String,
)

internal fun shouldDeliverMatrixSdkTimelineEvent(
    binding: MatrixRoomBinding,
    primaryRoomId: String,
    pairingChannelOpen: Boolean,
    sender: String,
    rawJson: String,
): Boolean {
    val pairing = binding.roomId == primaryRoomId && pairingChannelOpen &&
        isMalinkPairingResponseEvent(rawJson)
    val application = isMalinkApplicationControlEvent(rawJson) &&
        (malinkApplicationEventKind(rawJson) == "workspace_gateway_directory" ||
            sender == binding.gatewayUserId)
    return pairing || application
}

internal enum class MatrixBoundRoomMembershipAction {
    READY,
    JOIN,
    REJECT,
}

internal fun matrixBoundRoomMembershipAction(
    membership: Membership,
): MatrixBoundRoomMembershipAction = when (membership) {
    Membership.JOINED -> MatrixBoundRoomMembershipAction.READY
    Membership.INVITED -> MatrixBoundRoomMembershipAction.JOIN
    Membership.LEFT,
    Membership.KNOCKED,
    Membership.BANNED,
    -> MatrixBoundRoomMembershipAction.REJECT
}

internal class MatrixTimelineEventDeduplicator(
    private val capacity: Int = 4_096,
) {
    private val eventIds = LinkedHashSet<String>()

    init {
        require(capacity > 0)
    }

    @Synchronized
    fun accept(eventId: String): Boolean {
        if (!eventIds.add(eventId)) return false
        if (eventIds.size > capacity) {
            val oldest = eventIds.iterator()
            oldest.next()
            oldest.remove()
        }
        return true
    }

    @Synchronized
    fun clear() = eventIds.clear()
}

class OfficialMatrixSdkDriver(
    private val callbackScope: CoroutineScope,
    private val diagnostics: DiagnosticRecorder = DiagnosticRecorder.None,
) : MatrixSdkDriver {
    private var client: Client? = null
    private var syncService: SyncService? = null
    private var syncServiceStateTask: TaskHandle? = null
    private var roomListService: RoomListService? = null
    private var roomListStateTask: TaskHandle? = null
    private var syncLifecycle: MatrixSyncServiceLifecycle? = null
    private val applicationTimelines = linkedMapOf<String, MatrixSdkTimeline>()
    private val deliveredTimelineEvents = MatrixTimelineEventDeduplicator()
    private var syncedBoundRoomReady = CompletableDeferred<Unit>()
    private val active = AtomicBoolean(false)
    private val pairingChannelOpen = AtomicBoolean(false)
    private val firstSyncFinalizing = AtomicBoolean(false)
    private val firstSyncWorkScheduled = AtomicBoolean(false)
    private val transportReadyPublished = AtomicBoolean(false)
    private val timelineDeliveryMutex = Mutex()
    private val timelinePaginationMutex = Mutex()
    private lateinit var activeSession: StoredMatrixSession
    private var runtimeFailure: (Throwable) -> Unit = {}
    private var timelineEvent: suspend (MatrixDecryptedEvent) -> Unit = {}

    override suspend fun start(
        secrets: PersistedMatrixSecrets,
        files: MatrixAccountFiles,
        onSyncUpdate: () -> Unit,
        onSessionUpdated: (StoredMatrixSession) -> Unit,
        onTransportReady: (MatrixTransportIdentity) -> Unit,
        onTimelineEvent: suspend (MatrixDecryptedEvent) -> Unit,
        onRuntimeFailure: (Throwable) -> Unit,
    ) {
        check(client == null) { "Matrix SDK driver is already started." }
        check(active.compareAndSet(false, true)) { "Matrix SDK driver is already active." }
        diagnostics.record("matrix.driver.start")
        syncedBoundRoomReady = CompletableDeferred()
        firstSyncFinalizing.set(false)
        firstSyncWorkScheduled.set(false)
        transportReadyPublished.set(false)
        deliveredTimelineEvents.clear()
        check(secrets.session.slidingSyncVersion == SlidingSyncVersion.NATIVE) {
            "Only native Matrix sliding sync sessions are supported."
        }
        activeSession = secrets.session
        runtimeFailure = onRuntimeFailure
        timelineEvent = onTimelineEvent
        val delegate = object : ClientSessionDelegate {
            override fun retrieveSessionFromKeychain(userId: String) = files.sessionStore.load()
                ?.session
                ?.takeIf { it.userId == userId }
                ?.also {
                    check(it.slidingSyncVersion == SlidingSyncVersion.NATIVE) {
                        "Only native Matrix sliding sync sessions are supported."
                    }
                }
                ?.toSdkSession()
                ?: throw IllegalStateException("The encrypted Matrix session is unavailable.")

            override fun saveSessionInKeychain(session: org.matrix.rustcomponents.sdk.Session) {
                if (!active.get()) return
                val updated = StoredMatrixSession.fromSdkSession(session, activeSession.roomBindings)
                files.sessionStore.save(PersistedMatrixSecrets(secrets.sdkStoreKey, updated))
                activeSession = updated
                onSessionUpdated(updated)
            }
        }
        val storeKey = secrets.sdkStoreKey.copyOf()
        val built = try {
            diagnostics.record("matrix.driver.store_opening")
            val sqliteStore = SqliteStoreBuilder(files.sdkDataPath, files.sdkCachePath)
                .key(storeKey)
            ClientBuilder()
                .homeserverUrl(activeSession.homeserverUrl)
                .slidingSyncVersionBuilder(SlidingSyncVersionBuilder.NATIVE)
                .crossProcessLockConfig(CrossProcessLockConfig.SingleProcess)
                .sqliteStore(sqliteStore)
                .setSessionDelegate(delegate)
                .build()
                .also { diagnostics.record("matrix.driver.store_opened") }
        } catch (error: Exception) {
            active.set(false)
            diagnostics.record("matrix.driver.store_failure", errorAttributes(error))
            throw error
        } finally {
            storeKey.fill(0)
        }
        try {
            diagnostics.record("matrix.driver.session_restoring")
            built.restoreSession(activeSession.toSdkSession())
            diagnostics.record("matrix.driver.session_restored")
            client = built
            diagnostics.record(
                "matrix.driver.client_ready",
                mapOf("stage" to "NATIVE_SINGLE_PROCESS"),
            )
            val ownEd25519 = built.encryption().ed25519Key()
                ?: throw IllegalStateException("Matrix did not publish this device's Ed25519 key.")
            val transportIdentity = MatrixTransportIdentity(
                userId = activeSession.userId,
                deviceId = activeSession.deviceId,
                ed25519 = ownEd25519,
            )
            diagnostics.record("matrix.driver.sync_service_building")
            val service = try {
                built.syncService()
                    // This runtime is explicitly single-process. Restoring a
                    // shared Sliding Sync position makes the first request a
                    // 30-second long poll when no event changed, so the app
                    // cannot install its live timeline listeners until that
                    // idle poll returns. Start this process's room-list stream
                    // without a persisted cross-process position instead.
                    .withSharePos(false)
                    .withRoomListTimelineLimit(ROOM_LIST_TIMELINE_LIMIT)
                    .finish()
            } catch (error: Exception) {
                diagnostics.record(
                    "matrix.driver.sync_service_build_failure",
                    errorAttributes(error),
                )
                throw MatrixSyncServiceBuildException(error)
            }
            val roomList = service.roomListService()
            roomList.subscribeToRooms(activeSession.roomBindings.map(MatrixRoomBinding::roomId))
            diagnostics.record("matrix.driver.room_subscription_ready")
            val lifecycle = MatrixSyncServiceLifecycle(
                onRoomListProgress = {
                    if (active.get() && client === built) {
                        diagnostics.record("matrix.driver.sync_update")
                        onSyncUpdate()
                        scheduleInitialSyncFinalization(
                            built,
                            transportIdentity,
                            onTransportReady,
                        )
                    }
                },
                onFailure = { failure ->
                    if (active.get() && client === built) {
                        diagnostics.record(
                            "matrix.driver.sync_failure",
                            errorAttributes(failure) + ("stage" to failure.stage),
                        )
                        runtimeFailure(failure)
                    }
                },
            )
            lifecycle.activate()
            syncService = service
            roomListService = roomList
            syncLifecycle = lifecycle
            syncServiceStateTask = service.state(object : SyncServiceStateObserver {
                override fun onUpdate(state: SyncServiceState) {
                    if (!active.get() || client !== built) return
                    diagnostics.record(
                        "matrix.driver.sync_service_state",
                        mapOf("stage" to state.name),
                    )
                    lifecycle.onServiceState(state)
                }
            })
            roomListStateTask = roomList.state(object : RoomListServiceStateListener {
                override fun onUpdate(state: RoomListServiceState) {
                    if (!active.get() || client !== built) return
                    diagnostics.record(
                        "matrix.driver.room_list_state",
                        mapOf("stage" to state.name),
                    )
                    lifecycle.onRoomListState(state)
                }
            })
            diagnostics.record("matrix.driver.sync_starting")
            service.start()
            lifecycle.markStarted()
            diagnostics.record("matrix.driver.sync_started")
        } catch (error: Exception) {
            active.set(false)
            diagnostics.record("matrix.driver.start_failure", errorAttributes(error))
            runCatching { syncService?.stop() }.onFailure { cleanupError ->
                diagnostics.record("matrix.driver.stop_failure", errorAttributes(cleanupError))
            }
            closeApplicationTimelines()?.let { cleanupError ->
                diagnostics.record("matrix.driver.stop_failure", errorAttributes(cleanupError))
            }
            closeSyncServiceResources()?.let { cleanupError ->
                diagnostics.record("matrix.driver.stop_failure", errorAttributes(cleanupError))
            }
            runCatching { built.close() }.onFailure { cleanupError ->
                diagnostics.record("matrix.driver.stop_failure", errorAttributes(cleanupError))
            }
            client = null
            throw error
        }
    }

    override fun isSyncRunning(): Boolean = syncLifecycle?.isRunning() == true

    override suspend fun setNetworkAvailable(available: Boolean) {
        client?.enableAllSendQueues(available)
    }

    override suspend fun sendPairingMessage(contentJson: String) {
        ensurePairingChannel()
        val room = awaitBoundRoom()
        check(room.isEncrypted()) { "Refusing to send Malink data to an unencrypted Matrix room." }
        // Matrix rotates and shares an outbound Megolm session automatically
        // when required. Forcing a discard here was a debugging operation in
        // the SDK, made every durable retry create fresh crypto traffic, and
        // could fail before a newly joined device had its first outbound
        // session. The signed pairing identity remains unchanged across
        // transport retries; use the SDK's normal encrypted send path.
        try {
            room.sendRaw("m.room.message", contentJson)
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            diagnostics.record("matrix.pairing_message.send_failure", errorAttributes(error))
            throw error
        }
    }

    override suspend fun closePairingChannel() {
        pairingChannelOpen.set(false)
        diagnostics.record("matrix.pairing_channel.closed")
    }

    override suspend fun uploadMedia(mimeType: String, bytes: ByteArray): String {
        require(bytes.isNotEmpty()) { "Cannot upload empty Matrix media." }
        return client?.uploadMedia(mimeType, bytes, null)
            ?: throw IllegalStateException("The Matrix client is unavailable.")
    }

    override suspend fun downloadMedia(url: String): ByteArray {
        val source = MediaSource.fromUrl(url)
        return try {
            client?.getMediaContent(source)
                ?: throw IllegalStateException("The Matrix client is unavailable.")
        } finally {
            source.close()
        }
    }

    override suspend fun sendPrivateReadReceipt(
        roomId: String,
        threadRootEventId: String,
        eventId: String,
    ) {
        try {
            val room = receiptRoom(roomId)
            room.sendSingleReceipt(
                ReceiptType.READ_PRIVATE,
                ReceiptThread.Thread(threadRootEventId),
                eventId,
            )
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            diagnostics.record(
                "matrix.session_read.sdk_failure",
                errorAttributes(error) + ("stage" to "publish"),
            )
            if (error is ClientException.MatrixApi && error.code == "M_INVALID_PARAM") {
                throw MatrixReadReceiptRejectedException(error.code, error)
            }
            throw error
        }
    }

    override suspend fun loadPrivateReadReceipt(
        roomId: String,
        threadRootEventId: String,
    ): String? = try {
        receiptRoom(roomId).loadUserReceipt(
            ReceiptType.READ_PRIVATE,
            ReceiptThread.Thread(threadRootEventId),
            activeSession.userId,
        )?.eventId
    } catch (error: CancellationException) {
        throw error
    } catch (error: Exception) {
        diagnostics.record(
            "matrix.session_read.sdk_failure",
            errorAttributes(error) + ("stage" to "inspect"),
        )
        throw error
    }

    override suspend fun paginateApplicationTimelineBackwards(
        roomId: String,
        eventLimit: Int,
    ): Boolean {
        require(eventLimit in 1..MAX_APPLICATION_TIMELINE_PAGE_SIZE)
        check(active.get()) { "The Matrix SDK driver is stopped." }
        val activeTimeline = applicationTimelines[roomId]
            ?: throw IllegalArgumentException("Unknown Matrix project room: $roomId")
        return timelinePaginationMutex.withLock {
            val reachedStart = activeTimeline.timeline.paginateBackwards(eventLimit.toUShort())
            // The listener starts delivery undispatched, so acquiring this
            // mutex is a barrier for every diff emitted by this pagination.
            timelineDeliveryMutex.withLock { }
            reachedStart
        }
    }

    override suspend fun logout() {
        client?.logout()
    }

    override suspend fun stop() {
        diagnostics.record("matrix.driver.stop")
        active.set(false)
        syncLifecycle?.deactivate()
        val service = syncService
        var stopFailure: Throwable? = null
        if (service != null) {
            runCatching { service.stop() }.onFailure { stopFailure = it }
        }
        val timelineFailure = closeApplicationTimelines()
        if (stopFailure == null) stopFailure = timelineFailure
        val closeFailure = closeSyncServiceResources()
        if (stopFailure == null) stopFailure = closeFailure
        pairingChannelOpen.set(false)
        client?.close()
        client = null
        firstSyncFinalizing.set(false)
        firstSyncWorkScheduled.set(false)
        transportReadyPublished.set(false)
        stopFailure?.let { throw it }
    }

    private suspend fun ensurePairingChannel() {
        if (pairingChannelOpen.get()) return
        diagnostics.record("matrix.pairing_channel.opening")
        awaitBoundRoom()
        check(applicationTimelines.containsKey(activeSession.roomBinding.roomId)) {
            "The Matrix application timeline is unavailable."
        }
        pairingChannelOpen.set(true)
        diagnostics.record("matrix.pairing_channel.open")
    }

    private fun timelineItems(diff: TimelineDiff): List<TimelineItem> = when (diff) {
        is TimelineDiff.Append -> diff.values
        is TimelineDiff.Insert -> listOf(diff.value)
        is TimelineDiff.PushBack -> listOf(diff.value)
        is TimelineDiff.PushFront -> listOf(diff.value)
        is TimelineDiff.Reset -> diff.values
        is TimelineDiff.Set -> listOf(diff.value)
        TimelineDiff.Clear,
        TimelineDiff.PopBack,
        TimelineDiff.PopFront,
        is TimelineDiff.Remove,
        is TimelineDiff.Truncate,
        -> emptyList()
    }

    private fun captureTimelineEvent(
        binding: MatrixRoomBinding,
        item: TimelineItem,
    ): MatrixDecryptedEvent? {
        val event = item.asEvent() ?: return null
        if (!event.isRemote) return null
        val eventId = (event.eventOrTransactionId as? EventOrTransactionId.EventId)?.eventId
            ?: return null
        val rawJson = event.lazyProvider.latestJson() ?: return null
        val shouldDeliver = shouldDeliverMatrixSdkTimelineEvent(
            binding = binding,
            primaryRoomId = activeSession.roomBinding.roomId,
            pairingChannelOpen = pairingChannelOpen.get(),
            sender = event.sender,
            rawJson = rawJson,
        )
        val kind = malinkApplicationEventKind(rawJson)
        if (!shouldDeliver) {
            if (kind != "unknown") {
                diagnostics.record(
                    "matrix.application_timeline.event_filtered",
                    mapOf(
                        "kind" to kind,
                        "gateway_sender" to (event.sender == binding.gatewayUserId).toString(),
                    ),
                )
            }
            return null
        }
        if (!deliveredTimelineEvents.accept(eventId)) {
            diagnostics.record(
                "matrix.application_timeline.event_duplicate",
                mapOf("kind" to kind),
            )
            return null
        }
        diagnostics.record(
            "matrix.application_timeline.event_received",
            mapOf("kind" to kind),
        )
        return MatrixDecryptedEvent(
            roomId = binding.roomId,
            eventId = eventId,
            sender = event.sender,
            timestamp = event.timestamp.toLong(),
            rawJson = rawJson,
        )
    }

    private suspend fun openApplicationTimelines(expectedClient: Client) {
        for (binding in activeSession.roomBindings) {
            if (applicationTimelines.containsKey(binding.roomId)) continue
            val room = expectedClient.getRoom(binding.roomId)
                ?: throw IllegalStateException(
                    "A bound Matrix project room was unavailable after native sliding sync.",
                )
            val timeline = room.timeline()
            val listener = timeline.addListener(object : TimelineListener {
                private var initialUpdate = true

                override fun onUpdate(diff: List<TimelineDiff>) {
                    if (!active.get() || client !== expectedClient) return
                    // addListener first publishes the timeline's existing
                    // contents as a Reset. Those events are history, not live
                    // transport. Replaying every room's initial window here
                    // can put fresh command terminals behind many pointer
                    // dereferences (each with a network timeout). Current Room
                    // State and explicit pagination already own cold recovery,
                    // so retain any concurrent non-Reset updates and start the
                    // live lane from the next callback.
                    val currentDiff = if (initialUpdate) {
                        initialUpdate = false
                        val retained = diff.filterNot { it is TimelineDiff.Reset }
                        val skipped = diff.size - retained.size
                        if (skipped > 0) {
                            diagnostics.record(
                                "matrix.application_timeline.initial_snapshot_skipped",
                                mapOf("count" to skipped.toString()),
                            )
                        }
                        retained
                    } else {
                        diff
                    }
                    val events = currentDiff.flatMap(::timelineItems)
                        .mapNotNull { captureTimelineEvent(binding, it) }
                    if (events.isEmpty()) return
                    callbackScope.launch(start = CoroutineStart.UNDISPATCHED) {
                        timelineDeliveryMutex.withLock {
                            for (event in events) {
                                runCatching { timelineEvent(event) }.onFailure(runtimeFailure)
                            }
                        }
                    }
                }
            })
            applicationTimelines[binding.roomId] = MatrixSdkTimeline(timeline, listener)
            diagnostics.record("matrix.application_timeline.open")
        }
    }

    private fun closeApplicationTimelines(): Throwable? {
        var failure: Throwable? = null
        applicationTimelines.values.forEach { activeTimeline ->
            activeTimeline.listener.cancelAndClose()
            runCatching { activeTimeline.timeline.close() }.onFailure {
                if (failure == null) failure = it
            }
        }
        applicationTimelines.clear()
        return failure
    }

    private fun closeSyncServiceResources(): Throwable? {
        var failure: Throwable? = null
        syncServiceStateTask.cancelAndClose()
        syncServiceStateTask = null
        roomListStateTask.cancelAndClose()
        roomListStateTask = null
        runCatching { roomListService?.close() }.onFailure {
            if (failure == null) failure = it
        }
        roomListService = null
        runCatching { syncService?.close() }.onFailure {
            if (failure == null) failure = it
        }
        syncService = null
        syncLifecycle?.deactivate()
        syncLifecycle = null
        return failure
    }

    private fun scheduleInitialSyncFinalization(
        expectedClient: Client,
        identity: MatrixTransportIdentity,
        onTransportReady: (MatrixTransportIdentity) -> Unit,
    ) {
        if (transportReadyPublished.get() || !firstSyncWorkScheduled.compareAndSet(false, true)) return
        callbackScope.launch {
            try {
                if (!finalizeInitialSync(expectedClient)) {
                    firstSyncWorkScheduled.set(false)
                    return@launch
                }
                if (
                    active.get() &&
                    client === expectedClient &&
                    transportReadyPublished.compareAndSet(false, true)
                ) {
                    diagnostics.record("matrix.transport.ready")
                    onTransportReady(identity)
                }
            } catch (error: CancellationException) {
                throw error
            } catch (error: Throwable) {
                diagnostics.record("matrix.driver.initialization_failure", errorAttributes(error))
                if (active.get() && client === expectedClient) runtimeFailure(error)
            }
        }
    }

    private suspend fun finalizeInitialSync(expectedClient: Client): Boolean {
        if (syncedBoundRoomReady.isCompleted) return true
        if (!firstSyncFinalizing.compareAndSet(false, true)) return false
        try {
            diagnostics.record("matrix.encryption.initializing")
            try {
                withTimeout(E2EE_INITIALIZATION_TIMEOUT_MS) {
                    expectedClient.encryption().waitForE2eeInitializationTasks()
                }
            } catch (_: TimeoutCancellationException) {
                throw IllegalStateException(
                    "Matrix E2EE initialization did not finish after native sliding sync.",
                )
            }
            if (!active.get() || client !== expectedClient) return false
            diagnostics.record("matrix.encryption.ready")
            try {
                withTimeout(BOUND_ROOM_READY_TIMEOUT_MS) {
                    while (
                        active.get() &&
                        client === expectedClient &&
                        activeSession.roomBindings.any { expectedClient.getRoom(it.roomId) == null }
                    ) {
                        delay(BOUND_ROOM_POLL_INTERVAL_MS)
                    }
                }
            } catch (_: TimeoutCancellationException) {
                throw IllegalStateException(
                    "The bound Matrix room was unavailable after native sliding sync.",
                )
            }
            if (active.get() && client === expectedClient) {
                ensureBoundRoomsJoined(expectedClient)
            }
            if (active.get() && client === expectedClient) {
                openApplicationTimelines(expectedClient)
                syncedBoundRoomReady.complete(Unit)
                diagnostics.record(
                    "matrix.bound_rooms.ready",
                    mapOf("count" to activeSession.roomBindings.size.toString()),
                )
            }
            return syncedBoundRoomReady.isCompleted
        } finally {
            firstSyncFinalizing.set(false)
        }
    }

    /**
     * An invited room already has an SDK Room object, but message sends fail
     * immediately until the current account joins it. Browser Matrix performs
     * the same transition before opening its application transport. Keep the
     * native readiness barrier closed until every root-authorized room is
     * joined, so pairing cannot start on an unusable Room handle.
     */
    private suspend fun ensureBoundRoomsJoined(expectedClient: Client) {
        for (binding in activeSession.roomBindings) {
            try {
                withTimeout(BOUND_ROOM_JOIN_TIMEOUT_MS) {
                    var joinSubmitted = false
                    while (active.get() && client === expectedClient) {
                        val room = expectedClient.getRoom(binding.roomId)
                            ?: throw IllegalStateException(
                                "The authorized Matrix room disappeared during setup.",
                            )
                        when (matrixBoundRoomMembershipAction(room.membership())) {
                            MatrixBoundRoomMembershipAction.READY -> return@withTimeout
                            MatrixBoundRoomMembershipAction.JOIN -> {
                                if (!joinSubmitted) {
                                    diagnostics.record("matrix.bound_room.joining")
                                    room.join()
                                    joinSubmitted = true
                                }
                            }
                            MatrixBoundRoomMembershipAction.REJECT ->
                                throw MatrixBoundRoomMembershipException(
                                    retryable = false,
                                    message = "The Matrix account is not invited to the authorized Workspace room.",
                                )
                        }
                        delay(BOUND_ROOM_POLL_INTERVAL_MS)
                    }
                }
            } catch (_: TimeoutCancellationException) {
                throw MatrixBoundRoomMembershipException(
                    retryable = true,
                    message = "Joining the authorized Workspace room timed out.",
                )
            } catch (error: CancellationException) {
                throw error
            } catch (error: MatrixBoundRoomMembershipException) {
                throw error
            } catch (error: Exception) {
                throw MatrixBoundRoomMembershipException(
                    retryable = true,
                    message = "The Matrix account could not join the authorized Workspace room.",
                    cause = error,
                )
            }
            if (active.get() && client === expectedClient) {
                diagnostics.record("matrix.bound_room.joined")
            }
        }
    }

    private suspend fun awaitBoundRoom(): Room {
        try {
            withTimeout(BOUND_ROOM_READY_TIMEOUT_MS) { syncedBoundRoomReady.await() }
        } catch (_: TimeoutCancellationException) {
            throw IllegalStateException(
                "The bound Matrix room and encryption state did not become ready after initial sync.",
            )
        }
        return client?.getRoom(activeSession.roomBinding.roomId)
            ?: throw IllegalStateException(
                "The bound Matrix room disappeared after initial sync.",
            )
    }

    private fun receiptRoom(roomId: String): Room {
        require(activeSession.roomBindings.any { it.roomId == roomId }) {
            "Unknown Matrix project room: $roomId"
        }
        check(active.get()) { "The Matrix SDK driver is stopped." }
        return client?.getRoom(roomId)
            ?: throw IllegalStateException("The Matrix project room is unavailable.")
    }

    private fun TaskHandle?.cancelAndClose() {
        this ?: return
        runCatching { cancel() }
        runCatching { close() }
    }

    private fun errorAttributes(error: Throwable): Map<String, String> = buildMap {
        put(
            "error",
            error.javaClass.simpleName.replace(Regex("[^A-Za-z0-9._:+/-]"), "_").take(160),
        )
        when (error) {
            is ClientException.MatrixApi -> {
                put("reason", "matrix_api")
                error.code
                    .replace(Regex("[^A-Za-z0-9._:+/-]"), "_")
                    .take(160)
                    .takeIf { it.isNotBlank() }
                    ?.let { put("code", it) }
            }
            is ClientException -> put("reason", "matrix_sdk")
        }
    }

    private companion object {
        const val ROOM_LIST_TIMELINE_LIMIT = 32u
        const val MAX_APPLICATION_TIMELINE_PAGE_SIZE = 128
        const val E2EE_INITIALIZATION_TIMEOUT_MS = 45_000L
        const val BOUND_ROOM_READY_TIMEOUT_MS = 30_000L
        const val BOUND_ROOM_JOIN_TIMEOUT_MS = 45_000L
        const val BOUND_ROOM_POLL_INTERVAL_MS = 100L
    }

    private data class MatrixSdkTimeline(
        val timeline: Timeline,
        val listener: TaskHandle,
    )
}
