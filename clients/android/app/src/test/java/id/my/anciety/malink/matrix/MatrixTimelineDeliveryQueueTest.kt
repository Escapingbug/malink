package id.my.anciety.malink.matrix

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

class MatrixTimelineDeliveryQueueTest {
    @Test
    fun `live reply interleaves with historical batch and pagination awaits its tail`() = runBlocking {
        withTimeout(2000) {
            val queue = MatrixTimelineDeliveryQueue()
            val first = CompletableDeferred<Unit>()
            val tail = CompletableDeferred<Unit>()
            val reachedTail = CompletableDeferred<Unit>()
            val delivered = mutableListOf<String>()
            queue.enqueue(this, listOf("old-1", "old-2", "old-3")) {
                if (it == "old-1") first.await()
                if (it == "old-3") { reachedTail.complete(Unit); tail.await() }
                delivered.add(it)
            }
            queue.enqueue(this, listOf("live-reply")) { delivered.add(it) }
            val drained = async(start = CoroutineStart.UNDISPATCHED) { queue.drainSubmitted() }
            first.complete(Unit)
            reachedTail.await()
            assertEquals(listOf("old-1", "live-reply", "old-2"), delivered)
            assertFalse(drained.isCompleted)
            tail.complete(Unit)
            drained.await()
            assertEquals(listOf("old-1", "live-reply", "old-2", "old-3"), delivered)
        }
    }
}
