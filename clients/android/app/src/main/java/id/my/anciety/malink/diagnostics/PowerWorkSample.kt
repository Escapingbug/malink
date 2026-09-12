package id.my.anciety.malink.diagnostics

/** Synchronous work only: thread CPU is not valid across a coroutine suspension. */
internal inline fun <T> DiagnosticRecorder.measurePowerWork(stage: String, work: () -> T): T {
    val started = System.nanoTime()
    val cpu = threadCpuNanos()
    var success = false
    try {
        return work().also { success = true }
    } finally {
        val elapsed = (System.nanoTime() - started).coerceAtLeast(0) / 1_000_000
        val endedCpu = threadCpuNanos()
        val attributes = mutableMapOf(
            "stage" to stage,
            "reason" to if (success) "success" else "failure",
            "elapsed_ms" to elapsed.toString(),
        )
        if (cpu >= 0 && endedCpu >= cpu) attributes["thread_cpu_ms"] = ((endedCpu - cpu) / 1_000_000).toString()
        record("power.storage_stage", attributes)
    }
}
