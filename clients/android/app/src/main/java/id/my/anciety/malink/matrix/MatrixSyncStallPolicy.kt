package id.my.anciety.malink.matrix

/** Passive evidence only: a quiet room alone must never trigger reconnects. */
internal class MatrixSyncStallPolicy {
    private var lastProgressMs = 0L
    private var consecutiveTimeouts = 0
    private var lastRecoveryMs: Long? = null

    fun progress(nowMs: Long) {
        lastProgressMs = nowMs
        consecutiveTimeouts = 0
    }

    fun operationTimedOut(nowMs: Long): Boolean {
        consecutiveTimeouts += 1
        if (consecutiveTimeouts < 2 || nowMs - lastProgressMs < 45_000) return false
        if (lastRecoveryMs?.let { nowMs - it < 120_000 } == true) return false
        lastRecoveryMs = nowMs
        consecutiveTimeouts = 0
        return true
    }
}
