package id.my.anciety.malink.diagnostics

import android.content.Context
import android.os.Build
import id.my.anciety.malink.BuildConfig
import java.io.File
import java.time.Instant

class NativeDiagnosticLog private constructor(
    context: Context,
    private val now: () -> Long = System::currentTimeMillis,
) : DiagnosticRecorder {
    private val applicationContext = context.applicationContext
    private val lock = Any()
    private val directory = File(context.filesDir, "diagnostics")
    private val current = File(directory, "native-current.log")
    private val previous = File(directory, "native-previous.log")
    private val exportDirectory = File(context.cacheDir, "diagnostics")
    private val frequent = FrequentDiagnosticCounts()
    private val power = PowerDiagnosticMetrics()

    override fun record(event: String, attributes: Map<String, String>) {
        synchronized(lock) {
            runCatching {
                val time = now()
                val aggregate = power.accept(event, attributes, time) || frequent.accept(event, attributes, time)
                val force = event == "service.ui_foreground"
                val line = frequent.drain(time, force) + power.drain(time, force) + if (aggregate) "" else
                    DiagnosticLine.encode(Instant.ofEpochMilli(time).toString(), event, attributes) + "\n"
                appendLines(line)
            }
        }
    }

    private fun appendLines(lines: String) {
        if (lines.isEmpty()) return
        directory.mkdirs()
        rotateIfNeeded(lines.toByteArray(Charsets.UTF_8).size)
        current.appendText(lines, Charsets.UTF_8)
    }

    fun export(): File = synchronized(lock) {
        appendLines(frequent.drain(now(), force = true))
        appendLines(power.drain(now(), force = true))
        exportDirectory.mkdirs()
        exportDirectory.listFiles()?.forEach { candidate ->
            if (candidate.isFile && candidate.name != EXPORT_FILE_NAME) candidate.delete()
        }
        val destination = File(exportDirectory, EXPORT_FILE_NAME)
        destination.bufferedWriter(Charsets.UTF_8).use { output ->
            output.appendLine("Malink native diagnostics")
            output.appendLine("exported_at=${Instant.ofEpochMilli(now())}")
            output.appendLine("version_name=${BuildConfig.VERSION_NAME}")
            output.appendLine("native_build=${BuildConfig.NATIVE_BUILD_ID}")
            output.appendLine("android_sdk=${Build.VERSION.SDK_INT}")
            output.appendLine("device=${safeDeviceLabel()}")
            output.appendLine("privacy=No_tokens_message_content_room_ids_user_ids_or_key_material")
            output.appendLine()
            appendFile(previous, output)
            appendFile(current, output)
            runCatching {
                MatrixSdkTraceLog.appendSanitizedSummary(applicationContext, output)
            }.onFailure {
                output.appendLine()
                output.appendLine("Matrix SDK trace summary unavailable")
            }
        }
        destination
    }

    private fun rotateIfNeeded(incomingBytes: Int) {
        if (current.length() + incomingBytes <= MAX_FILE_BYTES) return
        previous.delete()
        if (!current.renameTo(previous)) current.delete()
    }

    private fun appendFile(source: File, output: Appendable) {
        if (!source.isFile) return
        source.forEachLine(Charsets.UTF_8) { line -> output.appendLine(line) }
    }

    private fun safeDeviceLabel(): String = listOf(Build.MANUFACTURER, Build.MODEL)
        .joinToString("-")
        .lowercase()
        .replace(Regex("[^a-z0-9._+-]"), "_")
        .take(160)
        .ifEmpty { "unknown" }

    companion object {
        private const val MAX_FILE_BYTES = 256L * 1024L
        private const val EXPORT_FILE_NAME = "malink-native-diagnostics.txt"
        @Volatile private var instance: NativeDiagnosticLog? = null

        fun get(context: Context): NativeDiagnosticLog = instance ?: synchronized(this) {
            instance ?: NativeDiagnosticLog(context.applicationContext).also { created ->
                instance = created
            }
        }
    }
}
