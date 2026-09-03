package id.my.anciety.malink.matrix

import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class MatrixSessionRestoreBarrierTest {
    @Test
    fun `session discovery waits until encrypted local restoration completes`() = runBlocking {
        val barrier = MatrixSessionRestoreBarrier()
        var returned = false
        val waiting = async(start = CoroutineStart.UNDISPATCHED) {
            barrier.await()
            returned = true
        }

        assertFalse(returned)
        barrier.complete()
        waiting.await()
        assertTrue(returned)
    }
}
