package id.my.anciety.malink.matrix

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit

/** Commit each room independently; a failed room still causes the owner to retry.
 * Two readers bound load without making healthy rooms wait behind one timeout.
 */
internal suspend fun recoverMatrixProjectRooms(
    roomIds: List<String>,
    recover: suspend (String) -> Int,
    onFailure: (Exception) -> Unit,
): Int = coroutineScope {
    val permits = Semaphore(2)
    val results = roomIds.map { roomId ->
        async {
            permits.withPermit {
                try {
                    Result.success(recover(roomId))
                } catch (error: CancellationException) {
                    throw error
                } catch (error: Exception) {
                    onFailure(error)
                    Result.failure<Int>(error)
                }
            }
        }
    }.awaitAll()
    results.firstOrNull { it.isFailure }?.getOrThrow()
    results.sumOf { it.getOrThrow() }
}
