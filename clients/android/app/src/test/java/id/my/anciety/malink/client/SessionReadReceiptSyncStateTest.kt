package id.my.anciety.malink.client

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SessionReadReceiptSyncStateTest {
    @Test
    fun `explicit read is durable and publishes the exact physical target`() {
        val state = SessionReadReceiptSyncState(maxMarkers = 10)
        val target = target(eventId = "\$event-1", updatedAt = 100)

        assertTrue(state.markLocallyRead(target))
        state.requestPublish(target)

        assertEquals(mapOf("session-1" to 100L), state.readState())
        assertEquals(
            SessionReadReceiptWork(SessionReadReceiptWorkKind.PUBLISH, target),
            state.plan(listOf(target), limit = 4).single(),
        )
        assertEquals(1, state.recordPublishFailure(target))
        assertEquals(2, state.recordPublishFailure(target))
        state.requestPublish(target)
        assertEquals(2, state.maximumPublishAttempt())

        state.recordPublished(target)
        assertFalse(state.hasPendingPublish())
        state.requestPublish(target)
        assertFalse(state.hasPendingPublish())
        assertTrue(state.plan(listOf(target), limit = 4).isEmpty())
    }

    @Test
    fun `a stale pending target never marks a newer unseen update`() {
        val state = SessionReadReceiptSyncState(maxMarkers = 10)
        val opened = target(eventId = "\$event-1", updatedAt = 100)
        val newer = target(eventId = "\$event-2", updatedAt = 200)
        state.markLocallyRead(opened)
        state.requestPublish(opened)

        val work = state.plan(listOf(newer), limit = 4)

        assertEquals(SessionReadReceiptWorkKind.INSPECT, work.single().kind)
        assertEquals(newer, work.single().target)
        assertFalse(state.hasPendingPublish())
        assertEquals(mapOf("session-1" to 100L), state.readState())
    }

    @Test
    fun `durable local read reconstructs an interrupted publish after inspection`() {
        val state = SessionReadReceiptSyncState(maxMarkers = 10)
        val target = target(eventId = "\$event-1", updatedAt = 100)
        state.restoreReadState(mapOf("session-1" to 100L))

        assertEquals(
            SessionReadReceiptWorkKind.INSPECT,
            state.plan(listOf(target), limit = 4).single().kind,
        )
        assertFalse(state.observeRemote(target, remoteEventId = null))
        assertEquals(
            SessionReadReceiptWorkKind.PUBLISH,
            state.plan(listOf(target), limit = 4).single().kind,
        )
    }

    @Test
    fun `a permanently rejected target is quarantined until the projection advances`() {
        val state = SessionReadReceiptSyncState(maxMarkers = 10)
        val rejected = target(eventId = "\$event-1", updatedAt = 100)
        state.markLocallyRead(rejected)
        state.requestPublish(rejected)

        state.recordPublishRejected(rejected)

        assertFalse(state.hasPendingPublish())
        assertTrue(state.plan(listOf(rejected), limit = 4).isEmpty())
        state.requestPublish(rejected)
        assertFalse(state.hasPendingPublish())

        val advanced = target(eventId = "\$event-2", updatedAt = 200)
        state.requestPublish(advanced)
        assertEquals(
            SessionReadReceiptWork(SessionReadReceiptWorkKind.PUBLISH, advanced),
            state.plan(listOf(advanced), limit = 4).single(),
        )
    }

    @Test
    fun `another device receipt advances local state without a publish`() {
        val state = SessionReadReceiptSyncState(maxMarkers = 10)
        val target = target(eventId = "\$event-1", updatedAt = 100)

        assertTrue(state.observeRemote(target, remoteEventId = "\$event-1"))

        assertEquals(mapOf("session-1" to 100L), state.readState())
        assertFalse(state.hasPendingPublish())
        assertTrue(state.plan(listOf(target), limit = 4).isEmpty())
    }

    @Test
    fun `background inspection rotates fairly and can be suppressed for publish-only work`() {
        val state = SessionReadReceiptSyncState(maxMarkers = 10)
        val targets = (1L..3L).map { index ->
            MatrixMlp3SessionReadReceiptTarget(
                sessionId = "session-$index",
                projectId = "project-1",
                roomId = "!project:example.org",
                threadRootEventId = "\$root-$index",
                eventId = "\$event-$index",
                updatedAt = index,
            )
        }

        assertTrue(state.plan(targets, limit = 1, includeInspection = false).isEmpty())
        val inspected = (1..3).map {
            state.plan(targets, limit = 1).single().target.sessionId
        }

        assertEquals(listOf("session-3", "session-2", "session-1"), inspected)
    }

    @Test
    fun `retry delay is bounded exponential backoff`() {
        assertEquals(5_000L, sessionReadReceiptRetryDelay(0))
        assertEquals(5_000L, sessionReadReceiptRetryDelay(1))
        assertEquals(10_000L, sessionReadReceiptRetryDelay(2))
        assertEquals(120_000L, sessionReadReceiptRetryDelay(20))
    }

    private fun target(
        eventId: String,
        updatedAt: Long,
    ) = MatrixMlp3SessionReadReceiptTarget(
        sessionId = "session-1",
        projectId = "project-1",
        roomId = "!project:example.org",
        threadRootEventId = "\$root-1",
        eventId = eventId,
        updatedAt = updatedAt,
    )
}
