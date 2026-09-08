package id.my.anciety.malink.matrix

import java.io.IOException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class MatrixProjectRecoveryTest {
    @Test
    fun `healthy rooms commit before an earlier stalled room finishes`() = runBlocking {
        val release = CompletableDeferred<Unit>()
        val healthy = CompletableDeferred<Unit>()
        val committed = mutableListOf<String>()
        val errors = mutableListOf<Exception>()
        val job = async {
            runCatching {
                recoverMatrixProjectRooms(listOf("stalled", "healthy", "candidate"), { room ->
                    if (room == "stalled") {
                        release.await()
                        throw IOException("timeout")
                    }
                    committed += room
                    if (room == "candidate") healthy.complete(Unit)
                    1
                }, errors::add)
            }
        }
        withTimeout(2_000) { healthy.await() }
        assertFalse(job.isCompleted)
        assertEquals(listOf("healthy", "candidate"), committed)
        release.complete(Unit)
        assertTrue(job.await().exceptionOrNull() is IOException)
        assertEquals(1, errors.size)
    }

    @Test
    fun `successful independent rooms retain the complete commit count`() = runBlocking {
        assertEquals(6, recoverMatrixProjectRooms(listOf("a", "b", "c"), { 2 }, {
            throw AssertionError(it)
        }))
    }
}
