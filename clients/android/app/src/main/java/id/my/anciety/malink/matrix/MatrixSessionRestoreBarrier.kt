package id.my.anciety.malink.matrix

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred

/** Makes "no saved Matrix session" observable only after local restore ends. */
internal class MatrixSessionRestoreBarrier {
    private val completion = CompletableDeferred<Unit>()

    fun complete() {
        completion.complete(Unit)
    }

    fun fail(error: Throwable) {
        completion.completeExceptionally(error)
    }

    fun cancel(error: CancellationException) {
        completion.cancel(error)
    }

    suspend fun await() {
        completion.await()
    }
}
