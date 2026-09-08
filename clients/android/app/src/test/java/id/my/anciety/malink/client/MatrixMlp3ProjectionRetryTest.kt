package id.my.anciety.malink.client

import id.my.anciety.malink.matrix.MatrixApplicationReadException
import java.net.SocketTimeoutException
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class MatrixMlp3ProjectionRetryTest {
    @Test
    fun `transport failures retry but invalid content and authorization do not`() {
        assertTrue(isRetryableMatrixMlp3ProjectionFailure(SocketTimeoutException()))
        for (status in listOf(404, 408, 429, 500, 502, 503)) {
            assertTrue(isRetryableMatrixMlp3ProjectionFailure(MatrixApplicationReadException(status, null)))
        }
        for (status in listOf(400, 401, 403)) {
            assertFalse(isRetryableMatrixMlp3ProjectionFailure(MatrixApplicationReadException(status, null)))
        }
        assertFalse(isRetryableMatrixMlp3ProjectionFailure(IllegalArgumentException("bad signature")))
        assertFalse(isLegacyTransientMatrixMlp3Quarantine("MalinkSecurityException"))
        assertFalse(isLegacyTransientMatrixMlp3Quarantine("MatrixApplicationReadException"))
    }
}
