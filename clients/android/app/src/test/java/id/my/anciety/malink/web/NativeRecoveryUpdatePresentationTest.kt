package id.my.anciety.malink.web

import id.my.anciety.malink.update.NativeUpdatePhase
import id.my.anciety.malink.update.NativeUpdateStatus
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class NativeRecoveryUpdatePresentationTest {
    @Test
    fun `checking does not depend on broken hosted or workspace services`() {
        val presentation = nativeRecoveryUpdatePresentation(status(NativeUpdatePhase.CHECKING))

        assertEquals(NativeRecoveryUpdateAction.NONE, presentation.action)
        assertTrue(presentation.showProgress)
        assertTrue(presentation.detail.contains("Official GitHub Pages"))
        assertTrue(presentation.detail.contains("does not require the PWA"))
    }

    @Test
    fun `download reports bounded determinate progress`() {
        val presentation = nativeRecoveryUpdatePresentation(
            status(NativeUpdatePhase.DOWNLOADING).copy(
                downloadedBytes = 10L * 1024L * 1024L,
                totalBytes = 40L * 1024L * 1024L,
            ),
        )

        assertEquals(25, presentation.progressPercent)
        assertTrue(presentation.detail.contains("10.0 MB of 40.0 MB"))
        assertTrue(nativeRecoveryUpdateShouldPoll(status(NativeUpdatePhase.DOWNLOADING)))
    }

    @Test
    fun `ready update offers a real installation action`() {
        val presentation = nativeRecoveryUpdatePresentation(
            status(NativeUpdatePhase.READY).copy(latestVersionName = "new-build"),
        )

        assertEquals(NativeRecoveryUpdateAction.INSTALL, presentation.action)
        assertEquals("Install verified update", presentation.actionLabel)
        assertTrue(presentation.detail.contains("signing certificate"))
        assertFalse(nativeRecoveryUpdateShouldPoll(status(NativeUpdatePhase.READY)))
    }

    @Test
    fun `current release returns user to interface recovery`() {
        val presentation = nativeRecoveryUpdatePresentation(status(NativeUpdatePhase.CURRENT))

        assertEquals(NativeRecoveryUpdateAction.BACK, presentation.action)
        assertTrue(presentation.detail.contains("reinstalling the same APK would not change"))
        assertNull(presentation.progressPercent)
    }

    @Test
    fun `network failure offers retry and diagnostic code`() {
        val presentation = nativeRecoveryUpdatePresentation(
            status(NativeUpdatePhase.FAILED).copy(detailCode = "sockettimeoutexception"),
        )

        assertEquals(NativeRecoveryUpdateAction.CHECK, presentation.action)
        assertTrue(presentation.detail.contains("internet connection"))
        assertTrue(presentation.detail.contains("sockettimeoutexception"))
    }

    private fun status(phase: NativeUpdatePhase) = NativeUpdateStatus(
        phase = phase,
        currentVersionCode = 41,
        currentVersionName = "current-build",
        latestVersionCode = 42,
    )
}
