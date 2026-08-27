package id.my.anciety.malink.client

import android.content.Context
import id.my.anciety.malink.diagnostics.NativeDiagnosticLog
import id.my.anciety.malink.matrix.MatrixBootstrap
import id.my.anciety.malink.matrix.MatrixConnectionRuntime
import id.my.anciety.malink.matrix.MatrixDecryptedEvent
import id.my.anciety.malink.matrix.MatrixLoginTokenIssueResult
import id.my.anciety.malink.matrix.MatrixThreadHistoryBatch
import id.my.anciety.malink.matrix.MatrixRuntimeStatus
import id.my.anciety.malink.matrix.MatrixTransportIdentity
import id.my.anciety.malink.matrix.PublicMatrixSession
import id.my.anciety.malink.matrix.MatrixRoomBinding
import kotlinx.serialization.json.JsonObject

interface NativeMatrixObserver {
    /** Megolm and the bound Matrix identity are ready for the pairing channel. */
    fun onPairingTransportReady(identity: MatrixTransportIdentity)

    /** The independent application-control receiver is ready for trusted commands. */
    fun onTransportReady(identity: MatrixTransportIdentity)
    fun onConvergenceRequired(reason: String)
    fun hasCachedApplicationProjection(): Boolean = false
    suspend fun onDecryptedEvent(event: MatrixDecryptedEvent)
}

interface NativeMatrixPort {
    val status: MatrixRuntimeStatus
    val commandTransportReady: Boolean
    fun setObserver(observer: NativeMatrixObserver?)
    fun start()
    fun onSystemWake(reason: String) = Unit
    fun publicSession(): PublicMatrixSession?
    suspend fun updateRoomBindings(bindings: List<MatrixRoomBinding>): PublicMatrixSession =
        throw UnsupportedOperationException("Workspace multi-room routing is unavailable.")
    suspend fun bootstrap(input: MatrixBootstrap): PublicMatrixSession
    suspend fun issueLoginToken(password: String?): MatrixLoginTokenIssueResult
    suspend fun sendPairingMessage(contentJson: String)
    suspend fun closePairingChannel()
    suspend fun loadThreadHistory(
        threadRootEventId: String,
        from: String?,
        limit: Int,
    ): MatrixThreadHistoryBatch
    suspend fun loadThreadHistory(
        threadRootEventId: String,
        from: String?,
        limit: Int,
        roomId: String,
    ): MatrixThreadHistoryBatch = throw UnsupportedOperationException(
        "Workspace multi-room history is unavailable.",
    )
    suspend fun sendApplicationControlEvent(contentJson: String, transactionId: String): String
    suspend fun sendApplicationControlEvent(
        contentJson: String,
        transactionId: String,
        roomId: String,
    ): String = throw UnsupportedOperationException("Workspace multi-room routing is unavailable.")
    suspend fun fetchApplicationEvent(eventId: String): MatrixDecryptedEvent =
        throw UnsupportedOperationException("Direct Matrix event recovery is unavailable.")
    suspend fun fetchApplicationEvent(eventId: String, roomId: String): MatrixDecryptedEvent =
        throw UnsupportedOperationException("Workspace multi-room recovery is unavailable.")
    suspend fun refreshThreadDirectory(): Int = 0
    suspend fun refreshApplicationProjection()
    suspend fun uploadMedia(mimeType: String, bytes: ByteArray): String
    suspend fun downloadMedia(url: String): ByteArray
    suspend fun profileProperty(userId: String, key: String): JsonObject?
    suspend fun stop(clearSession: Boolean)
    suspend fun revokeSession()
    suspend fun close()

    fun injectNetworkAvailabilityForE2e(available: Boolean) {
        throw UnsupportedOperationException("Synthetic Matrix networking is unavailable.")
    }
}

class MatrixNativePort(context: Context) : NativeMatrixPort {
    @Volatile
    private var observer: NativeMatrixObserver? = null
    private val diagnostics = NativeDiagnosticLog.get(context)
    private val runtime = MatrixConnectionRuntime(
        context = context,
        diagnostics = diagnostics,
        hasCachedApplicationProjection = {
            observer?.hasCachedApplicationProjection() == true
        },
        onPairingTransportReady = { identity -> observer?.onPairingTransportReady(identity) },
        onTransportReady = { identity -> observer?.onTransportReady(identity) },
        onConvergenceRequired = { reason -> observer?.onConvergenceRequired(reason) },
        onDecryptedEvent = { event -> observer?.onDecryptedEvent(event) },
    )

    override val status: MatrixRuntimeStatus get() = runtime.status
    override val commandTransportReady: Boolean get() = runtime.commandTransportReady

    override fun setObserver(observer: NativeMatrixObserver?) {
        this.observer = observer
    }

    override fun start() = runtime.start()
    override fun onSystemWake(reason: String) = runtime.onSystemWake(reason)
    override fun publicSession(): PublicMatrixSession? = runtime.publicSession()
    override suspend fun updateRoomBindings(bindings: List<MatrixRoomBinding>): PublicMatrixSession =
        runtime.updateRoomBindings(bindings)
    override suspend fun bootstrap(input: MatrixBootstrap): PublicMatrixSession = runtime.bootstrap(input)
    override suspend fun issueLoginToken(password: String?): MatrixLoginTokenIssueResult =
        runtime.issueLoginToken(password)
    override suspend fun sendPairingMessage(contentJson: String) =
        runtime.sendPairingMessage(contentJson)
    override suspend fun closePairingChannel() = runtime.closePairingChannel()
    override suspend fun loadThreadHistory(
        threadRootEventId: String,
        from: String?,
        limit: Int,
    ): MatrixThreadHistoryBatch = runtime.loadThreadHistory(threadRootEventId, from, limit)
    override suspend fun loadThreadHistory(
        threadRootEventId: String,
        from: String?,
        limit: Int,
        roomId: String,
    ): MatrixThreadHistoryBatch = runtime.loadThreadHistory(threadRootEventId, from, limit, roomId)
    override suspend fun sendApplicationControlEvent(contentJson: String, transactionId: String): String =
        runtime.sendApplicationControlEvent(contentJson, transactionId)
    override suspend fun sendApplicationControlEvent(
        contentJson: String,
        transactionId: String,
        roomId: String,
    ): String = runtime.sendApplicationControlEvent(contentJson, transactionId, roomId)
    override suspend fun fetchApplicationEvent(eventId: String): MatrixDecryptedEvent =
        runtime.fetchApplicationEvent(eventId)
    override suspend fun fetchApplicationEvent(eventId: String, roomId: String): MatrixDecryptedEvent =
        runtime.fetchApplicationEvent(eventId, roomId)
    override suspend fun refreshThreadDirectory(): Int = runtime.refreshThreadDirectory()
    override suspend fun refreshApplicationProjection() = runtime.refreshApplicationProjection()
    override suspend fun uploadMedia(mimeType: String, bytes: ByteArray): String =
        runtime.uploadMedia(mimeType, bytes)
    override suspend fun downloadMedia(url: String): ByteArray = runtime.downloadMedia(url)
    override suspend fun profileProperty(userId: String, key: String): JsonObject? =
        runtime.profileProperty(userId, key)
    override suspend fun stop(clearSession: Boolean) = runtime.stop(clearSession)
    override suspend fun revokeSession() {
        runtime.revokeSession()
    }
    override suspend fun close() = runtime.close()
    override fun injectNetworkAvailabilityForE2e(available: Boolean) =
        runtime.injectNetworkAvailabilityForE2e(available)
}
