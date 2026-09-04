package id.my.anciety.malink.client

internal enum class SessionReadReceiptWorkKind {
    INSPECT,
    PUBLISH,
}

internal data class SessionReadReceiptWork(
    val kind: SessionReadReceiptWorkKind,
    val target: MatrixMlp3SessionReadReceiptTarget,
)

/**
 * Durable intent and process-local delivery state for Matrix session receipts.
 *
 * The read timestamp is persisted as part of ClientSnapshot. A pending publish
 * can therefore be reconstructed after process death by inspecting Matrix and
 * comparing that durable timestamp with the current, exact projection target.
 * Process-local pending targets retain the physical event identity so a retry
 * can never mark a newer, unseen session update as read.
 */
internal class SessionReadReceiptSyncState(
    private val maxMarkers: Int,
) {
    private data class Route(
        val sessionId: String,
        val projectId: String,
    )

    private val readUpdatedAt = linkedMapOf<String, Long>()
    private val pending = linkedMapOf<Route, MatrixMlp3SessionReadReceiptTarget>()
    private val confirmedEventIds = mutableMapOf<Route, String>()
    private val publishAttempts = mutableMapOf<Route, Int>()
    private var inspectionOffset = 0

    init {
        require(maxMarkers > 0)
    }

    @Synchronized
    fun restoreReadState(restored: Map<String, Long>) {
        readUpdatedAt.clear()
        restored.entries
            .sortedByDescending(Map.Entry<String, Long>::value)
            .take(maxMarkers)
            .forEach { (sessionId, updatedAt) -> readUpdatedAt[sessionId] = updatedAt }
    }

    @Synchronized
    fun readState(): Map<String, Long> = readUpdatedAt.toMap()

    @Synchronized
    fun markLocallyRead(target: MatrixMlp3SessionReadReceiptTarget): Boolean {
        val previous = readUpdatedAt[target.sessionId] ?: -1L
        if (previous >= target.updatedAt) return false
        readUpdatedAt[target.sessionId] = target.updatedAt
        trimReadState()
        return true
    }

    @Synchronized
    fun requestPublish(target: MatrixMlp3SessionReadReceiptTarget) {
        val route = target.route()
        if (confirmedEventIds[route] == target.eventId || pending[route] == target) return
        pending[route] = target
        confirmedEventIds.remove(route)
        publishAttempts.remove(route)
    }

    /**
     * Explicit publishes are prioritized. Remaining targets are inspected to
     * import another device's receipt or reconstruct a durable local publish
     * that was interrupted before Matrix confirmed it.
     */
    @Synchronized
    fun plan(
        currentTargets: List<MatrixMlp3SessionReadReceiptTarget>,
        limit: Int,
        includeInspection: Boolean = true,
    ): List<SessionReadReceiptWork> {
        require(limit > 0)
        val currentByRoute = currentTargets.associateBy { it.route() }
        pending.entries.removeAll { (route, target) -> currentByRoute[route] != target }
        publishAttempts.keys.removeAll { route -> route !in pending }
        confirmedEventIds.entries.removeAll { (route, eventId) ->
            currentByRoute[route]?.eventId != eventId
        }

        val publish = pending.values
            .sortedByDescending(MatrixMlp3SessionReadReceiptTarget::updatedAt)
            .take(limit)
            .map { SessionReadReceiptWork(SessionReadReceiptWorkKind.PUBLISH, it) }
        if (publish.size == limit || !includeInspection) return publish

        val publishingRoutes = publish.mapTo(mutableSetOf()) { it.target.route() }
        val inspectionCandidates = currentTargets
            .asSequence()
            .filter { target ->
                val route = target.route()
                route !in publishingRoutes && confirmedEventIds[route] != target.eventId
            }
            .sortedByDescending(MatrixMlp3SessionReadReceiptTarget::updatedAt)
            .toList()
        if (inspectionCandidates.isEmpty()) return publish
        val inspectionLimit = limit - publish.size
        val start = inspectionOffset % inspectionCandidates.size
        val inspect = (inspectionCandidates.drop(start) + inspectionCandidates.take(start))
            .take(inspectionLimit)
            .map { SessionReadReceiptWork(SessionReadReceiptWorkKind.INSPECT, it) }
        inspectionOffset = (start + inspect.size) % inspectionCandidates.size
        return publish + inspect
    }

    /** Returns true when a matching remote receipt advanced local read state. */
    @Synchronized
    fun observeRemote(
        target: MatrixMlp3SessionReadReceiptTarget,
        remoteEventId: String?,
    ): Boolean {
        val route = target.route()
        if (remoteEventId == target.eventId) {
            confirmedEventIds[route] = target.eventId
            if (pending[route] == target) pending.remove(route)
            publishAttempts.remove(route)
            return markLocallyRead(target)
        }
        if ((readUpdatedAt[target.sessionId] ?: -1L) >= target.updatedAt) {
            pending[route] = target
        }
        return false
    }

    @Synchronized
    fun recordPublished(target: MatrixMlp3SessionReadReceiptTarget) {
        val route = target.route()
        confirmedEventIds[route] = target.eventId
        if (pending[route] == target) pending.remove(route)
        publishAttempts.remove(route)
    }

    @Synchronized
    fun recordPublishFailure(target: MatrixMlp3SessionReadReceiptTarget): Int {
        val route = target.route()
        if (pending[route] != target) return 0
        val attempt = (publishAttempts[route] ?: 0) + 1
        publishAttempts[route] = attempt
        return attempt
    }

    @Synchronized
    fun hasPendingPublish(): Boolean = pending.isNotEmpty()

    @Synchronized
    fun maximumPublishAttempt(): Int = publishAttempts.values.maxOrNull() ?: 0

    private fun trimReadState() {
        if (readUpdatedAt.size <= maxMarkers) return
        readUpdatedAt.entries
            .sortedBy(Map.Entry<String, Long>::value)
            .take(readUpdatedAt.size - maxMarkers)
            .forEach { (sessionId, _) -> readUpdatedAt.remove(sessionId) }
    }

    private fun MatrixMlp3SessionReadReceiptTarget.route() = Route(sessionId, projectId)
}
