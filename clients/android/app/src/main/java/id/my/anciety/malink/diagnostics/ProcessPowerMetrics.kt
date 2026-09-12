package id.my.anciety.malink.diagnostics

/** Activity-driven sampling only. Both clocks return milliseconds, not wall-clock dates. */
internal class ProcessPowerMetrics(
    private val elapsedMillis: () -> Long,
    private val cpuMillis: () -> Long,
) {
    private var elapsedStart = elapsedMillis()
    private var cpuStart = cpuMillis()

    fun sample(force: Boolean): Map<String, String>? {
        val elapsed = elapsedMillis()
        if (!force && elapsed - elapsedStart < 60_000) return null
        val cpu = cpuMillis()
        val result = mapOf(
            "window_ms" to (elapsed - elapsedStart).coerceAtLeast(0).toString(),
            "cpu_ms" to (cpu - cpuStart).coerceAtLeast(0).toString(),
        )
        elapsedStart = elapsed
        cpuStart = cpu
        return result
    }
}
