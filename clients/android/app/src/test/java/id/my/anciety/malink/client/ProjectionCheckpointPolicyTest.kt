package id.my.anciety.malink.client

import org.junit.Assert.*
import org.junit.Test

class ProjectionCheckpointPolicyTest {
    @Test fun `unchanged observations clean raw records without rewriting projection`() {
        val policy = ProjectionCheckpointPolicy()
        var saves = 0
        var cleanups = 0
        repeat(100) {
            policy.note(false)
            policy.flush({ saves++; true }, { cleanups++ })
        }
        assertEquals(0, saves)
        assertEquals(100, cleanups)
    }

    @Test fun `unchanged observation cannot release raw events after failed state save`() {
        val policy = ProjectionCheckpointPolicy()
        var cleanups = 0
        policy.note(true)
        policy.note(false)
        policy.flush({ false }, { cleanups++ })
        assertTrue(policy.dirty)
        assertEquals(0, cleanups)
        policy.note(false)
        policy.flush({ true }, { cleanups++ })
        assertFalse(policy.dirty)
        assertEquals(1, cleanups)
    }
}
