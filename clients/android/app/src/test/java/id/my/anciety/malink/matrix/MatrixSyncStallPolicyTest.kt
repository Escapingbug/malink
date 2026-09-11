package id.my.anciety.malink.matrix

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class MatrixSyncStallPolicyTest {
    @Test fun repeatedTimeoutsWithoutSyncRecoverWithCooldown() {
        val policy = MatrixSyncStallPolicy()
        policy.progress(0)
        assertFalse(policy.operationTimedOut(30_000))
        assertTrue(policy.operationTimedOut(50_000))
        policy.progress(55_000)
        assertFalse(policy.operationTimedOut(100_000))
        assertFalse(policy.operationTimedOut(110_000))
        assertTrue(policy.operationTimedOut(175_000))
    }

    @Test fun syncProgressAndIsolatedTimeoutsDoNotRestartHealthyConnection() {
        val policy = MatrixSyncStallPolicy()
        policy.progress(0)
        assertFalse(policy.operationTimedOut(80_000))
        policy.progress(81_000)
        assertFalse(policy.operationTimedOut(90_000))
        assertFalse(policy.operationTimedOut(100_000))
        policy.progress(110_000)
        assertFalse(policy.operationTimedOut(160_000))
    }
}
