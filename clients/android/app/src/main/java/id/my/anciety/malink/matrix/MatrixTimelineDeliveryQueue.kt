package id.my.anciety.malink.matrix

import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/** Serialize individual events, not a whole historical batch. */
internal class MatrixTimelineDeliveryQueue {
    private val mutex = Mutex()
    private val batches = ConcurrentHashMap.newKeySet<CompletableDeferred<Unit>>()

    fun <T> enqueue(scope: CoroutineScope, events: List<T>, deliver: suspend (T) -> Unit) {
        val completed = CompletableDeferred<Unit>()
        batches.add(completed)
        scope.launch(start = CoroutineStart.UNDISPATCHED) {
            try {
                for (event in events) mutex.withLock { deliver(event) }
            } finally {
                completed.complete(Unit)
                batches.remove(completed)
            }
        }
    }

    /** Pagination must await complete batches, not merely one free mutex slot. */
    suspend fun drainSubmitted() { batches.toList().forEach { it.await() } }
}
