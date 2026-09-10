package id.my.anciety.malink.diagnostics

/** Never export Throwable messages: they may contain credentials or content. */
internal fun recordCrash(error: Throwable, diagnostics: DiagnosticRecorder) {
    fun token(value: String) = value.replace(Regex("[^A-Za-z0-9_.-]"), "_").take(120)
    val seen = java.util.Collections.newSetFromMap(java.util.IdentityHashMap<Throwable, Boolean>())
    var cause: Throwable? = error
    var depth = 0
    while (cause != null && depth < 5 && seen.add(cause)) {
        diagnostics.record("process.uncaught_exception", mapOf("error" to token(cause.javaClass.name), "count" to depth.toString()))
        cause.stackTrace.take(16).forEach { frame ->
            diagnostics.record("process.crash_frame", mapOf(
                "type" to token(frame.className), "stage" to token(frame.methodName),
                "count" to frame.lineNumber.toString(),
            ))
        }
        cause = cause.cause
        depth++
    }
}

internal fun installCrashDiagnostics(diagnostics: DiagnosticRecorder) {
    val previous = Thread.getDefaultUncaughtExceptionHandler() ?: return
    Thread.setDefaultUncaughtExceptionHandler { thread, error ->
        try { runCatching { recordCrash(error, diagnostics) } }
        finally { previous.uncaughtException(thread, error) }
    }
}
