package id.my.anciety.malink.client

import org.junit.Assert.*
import org.junit.Test

class RecoveryPageCursorTest {
    @Test fun preservesProgressAcrossBoundedRoundsAndResetsAtEnd() {
        val cursor = RecoveryPageCursor()
        assertNull(cursor.next)
        assertTrue(cursor.advance("page-2"))
        assertEquals("page-2", cursor.next)
        assertTrue(cursor.advance("page-3"))
        assertEquals("page-3", cursor.next)
        assertFalse(cursor.advance(null))
        assertNull(cursor.next)
        assertTrue(cursor.advance("page-2"))
    }
    @Test(expected = IllegalStateException::class)
    fun rejectsCursorLoops() {
        val cursor = RecoveryPageCursor()
        cursor.advance("same")
        cursor.advance("same")
    }
}
