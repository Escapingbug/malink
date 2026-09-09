package id.my.anciety.malink.web

import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import android.util.Base64
import java.io.File
import java.io.RandomAccessFile
import java.util.UUID
import kotlinx.serialization.json.*

/** Private, bounded staging only. Receiving a share never uploads or sends it. */
class SharedFileInbox(private val context: Context) {
    private val root get() = File(context.cacheDir, "incoming-share")
    private val manifest get() = File(root, "manifest.json")

    @Synchronized fun pending(): JsonObject = if (manifest.isFile && manifest.length() > 0) {
        runCatching { Json.parseToJsonElement(manifest.readText()).jsonObject }
            .getOrElse { clearCorruptManifest() }
    } else buildJsonObject { put("batchId", ""); put("files", JsonArray(emptyList())) }

    @Synchronized fun receive(uris: List<Uri>): String {
        require(uris.isNotEmpty() && uris.size <= 10) { "Share between 1 and 10 files." }
        require(!manifest.exists()) { "Finish or cancel the previous file share before sharing more files." }
        root.mkdirs()
        val id = UUID.randomUUID().toString()
        val directory = File(root, id).apply { mkdirs() }
        try {
            var total = 0L
            val files = uris.mapIndexed { index, uri ->
                require(uri.scheme == "content") { "Only readable content files can be shared." }
                val name = context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use {
                    if (it.moveToFirst()) it.getString(0) else null
                }?.substringAfterLast('/')?.substringAfterLast('\\')?.replace(Regex("[\\p{Cntrl}]"), "_")?.take(240)?.takeIf { it.isNotBlank() }
                    ?: "shared-file-${index + 1}"
                val target = File(directory, index.toString())
                var size = 0L
                context.contentResolver.openInputStream(uri)?.use { input ->
                    target.outputStream().use { output ->
                        val buffer = ByteArray(64 * 1024)
                        while (true) {
                            val count = input.read(buffer)
                            if (count < 0) break
                            size += count; total += count
                            require(size <= 50L * 1024 * 1024 && total <= 100L * 1024 * 1024) { "Shared files exceed the attachment size limit." }
                            output.write(buffer, 0, count)
                        }
                    }
                } ?: error("The shared file could not be opened.")
                buildJsonObject {
                    put("name", name); put("size", size)
                    put("mimeType", context.contentResolver.getType(uri)?.take(256) ?: "application/octet-stream")
                }
            }
            val nextManifest = File(root, "manifest.next")
            nextManifest.writeText(buildJsonObject { put("batchId", id); put("files", JsonArray(files)) }.toString())
            require(nextManifest.length() > 0) { "Shared file manifest could not be saved." }
            if (!nextManifest.renameTo(manifest)) error("Shared file manifest could not be committed.")
            return id
        } catch (error: Exception) { directory.deleteRecursively(); throw error }
    }

    @Synchronized fun read(batchId: String, index: Int, offset: Int): JsonObject {
        val state = pending()
        require(state["batchId"]?.jsonPrimitive?.content == batchId && batchId.isNotEmpty()) { "File share expired." }
        val files = state.getValue("files").jsonArray
        require(index in files.indices) { "Invalid shared file." }
        val file = File(File(root, batchId), index.toString())
        require(offset >= 0 && offset.toLong() <= file.length()) { "Invalid shared file offset." }
        val bytes = ByteArray(minOf(64 * 1024L, file.length() - offset).toInt())
        RandomAccessFile(file, "r").use { it.seek(offset.toLong()); it.readFully(bytes) }
        return buildJsonObject {
            put("data", Base64.encodeToString(bytes, Base64.NO_WRAP))
            put("nextOffset", offset + bytes.size); put("eof", offset.toLong() + bytes.size == file.length())
        }
    }

    @Synchronized fun dismiss(batchId: String) {
        require(pending()["batchId"]?.jsonPrimitive?.content == batchId && batchId.isNotEmpty()) { "File share expired." }
        File(root, batchId).deleteRecursively()
        manifest.delete()
    }

    private fun clearCorruptManifest(): JsonObject {
        manifest.delete()
        root.listFiles()?.filter { it.isDirectory }?.forEach { it.deleteRecursively() }
        return buildJsonObject { put("batchId", ""); put("files", JsonArray(emptyList())) }
    }
}
