package id.my.anciety.malink.matrix

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class AndroidNetworkMonitorTest {
    @Test
    fun `default loss does not depend on a stale system network query`() {
        val tracker = DefaultNetworkAvailability<String>()
        tracker.reset("cached")
        assertEquals(false, tracker.lost("cached"))
        assertNull(tracker.capabilities("cached", true))
        tracker.available("restored")
        assertEquals(true, tracker.capabilities("restored", true))
    }

    @Test
    fun `late callbacks cannot disconnect a replacement default network`() {
        val tracker = DefaultNetworkAvailability<String>()
        tracker.available("old")
        tracker.available("new")
        assertNull(tracker.lost("old"))
        assertNull(tracker.capabilities("old", false))
        assertEquals(true, tracker.capabilities("new", true))
        assertEquals(false, tracker.capabilities("new", false))
        assertEquals(false, tracker.lost("new"))
    }

    @Test
    fun `an internet-capable network may attempt Matrix without public validation`() {
        assertTrue(hasUsableMatrixNetwork(hasInternetCapability = true))
    }

    @Test
    fun `a network without internet capability remains unavailable`() {
        assertFalse(hasUsableMatrixNetwork(hasInternetCapability = false))
    }
}
