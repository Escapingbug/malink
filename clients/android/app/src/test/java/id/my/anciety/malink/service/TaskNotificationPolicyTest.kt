package id.my.anciety.malink.service

import id.my.anciety.malink.client.command.CommandOutcome
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class TaskNotificationPolicyTest {
    @Test
    fun `background prompt completion is visible for every terminal outcome`() {
        assertEquals(
            TaskNotificationKind.SUCCEEDED,
            TaskNotificationPolicy.decide(false, CommandOutcome.SUCCEEDED),
        )
        assertEquals(
            TaskNotificationKind.FAILED,
            TaskNotificationPolicy.decide(false, CommandOutcome.FAILED),
        )
        assertEquals(
            TaskNotificationKind.CANCELLED,
            TaskNotificationPolicy.decide(false, CommandOutcome.CANCELLED),
        )
    }

    @Test
    fun `foreground prompt completion is handled in app`() {
        assertNull(
            TaskNotificationPolicy.decide(true, CommandOutcome.SUCCEEDED),
        )
    }
}
