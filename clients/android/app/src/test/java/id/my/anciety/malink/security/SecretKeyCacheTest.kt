package id.my.anciety.malink.security

import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicInteger
import javax.crypto.spec.SecretKeySpec
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Test

class SecretKeyCacheTest {
    @Test
    fun `loads once across concurrent callers and reloads after invalidation`() {
        val loads = AtomicInteger()
        val cache = SecretKeyCache {
            SecretKeySpec(ByteArray(32) { loads.incrementAndGet().toByte() }, "AES")
        }
        val start = CountDownLatch(1)
        val pool = Executors.newFixedThreadPool(8)
        try {
            val results = (1..32).map {
                pool.submit<Any> {
                    start.await()
                    cache.get()
                }
            }
            start.countDown()
            val first = results.first().get()
            results.forEach { assertSame(first, it.get()) }
            assertEquals(32, loads.get())

            cache.invalidate()
            val second = cache.get()
            assertEquals(64, loads.get())
            org.junit.Assert.assertNotSame(first, second)
        } finally {
            pool.shutdownNow()
        }
    }
}
