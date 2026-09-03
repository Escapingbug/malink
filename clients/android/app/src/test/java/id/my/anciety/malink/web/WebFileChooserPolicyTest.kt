package id.my.anciety.malink.web

import org.junit.Assert.assertEquals
import org.junit.Test

class WebFileChooserPolicyTest {
    @Test
    fun `authorization extension remains visible in Android DocumentsUI`() {
        assertEquals(
            WebFileChooserMimePolicy(type = "*/*"),
            webFileChooserMimePolicy(arrayOf(
                ".malink-auth,application/vnd.malink.authorization+json,application/json",
            )),
        )
        assertEquals(
            WebFileChooserMimePolicy(type = "*/*"),
            webFileChooserMimePolicy(arrayOf(
                "application/vnd.malink.authorization+json",
                "application/json",
            )),
        )
    }

    @Test
    fun `image attachment chooser remains restricted to images`() {
        assertEquals(
            WebFileChooserMimePolicy(type = "image/*"),
            webFileChooserMimePolicy(arrayOf("image/*")),
        )
    }

    @Test
    fun `multiple MIME types use Android alternate MIME filters`() {
        assertEquals(
            WebFileChooserMimePolicy(
                type = "*/*",
                acceptedMimeTypes = listOf("application/json", "text/plain"),
            ),
            webFileChooserMimePolicy(arrayOf("application/json", "text/plain")),
        )
    }
}
