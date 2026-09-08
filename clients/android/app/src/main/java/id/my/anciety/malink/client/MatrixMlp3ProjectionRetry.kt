package id.my.anciety.malink.client

import id.my.anciety.malink.matrix.MatrixApplicationReadException
import java.io.IOException

/** Transport availability is not evidence that a signed event is invalid. */
internal fun isRetryableMatrixMlp3ProjectionFailure(error: Throwable): Boolean = when (error) {
    is IOException -> true
    is MatrixApplicationReadException -> error.status == 404 || error.status == 408 ||
        error.status == 429 || error.status in 500..599
    else -> false
}

// Older APKs retained only the exception class when compacting quarantines.
// Recover only unambiguously transient codes; never release security tombstones.
internal fun isLegacyTransientMatrixMlp3Quarantine(errorCode: String?): Boolean =
    errorCode in setOf("SocketTimeoutException", "ConnectException", "UnknownHostException")
