package id.my.anciety.malink.service

import org.junit.Assert.assertEquals
import org.junit.Test

class TaskNotificationChannelPolicyTest {
    @Test
    fun `ready channel requires heads up sound and vibration`() {
        assertEquals(
            TaskNotificationChannelHealth.READY,
            evaluate(),
        )
    }

    @Test
    fun `app and channel blocks win over alert behavior`() {
        assertEquals(
            TaskNotificationChannelHealth.APP_BLOCKED,
            evaluate(appNotificationsEnabled = false),
        )
        assertEquals(
            TaskNotificationChannelHealth.CHANNEL_MISSING,
            evaluate(channelExists = false),
        )
        assertEquals(
            TaskNotificationChannelHealth.CHANNEL_BLOCKED,
            evaluate(channelEnabled = false),
        )
    }

    @Test
    fun `non interruptive silent and vibration disabled channels are diagnosed`() {
        assertEquals(
            TaskNotificationChannelHealth.NON_INTERRUPTIVE,
            evaluate(interruptive = false),
        )
        assertEquals(
            TaskNotificationChannelHealth.SOUND_DISABLED,
            evaluate(soundEnabled = false),
        )
        assertEquals(
            TaskNotificationChannelHealth.VIBRATION_DISABLED,
            evaluate(vibrationEnabled = false),
        )
    }

    private fun evaluate(
        appNotificationsEnabled: Boolean = true,
        channelExists: Boolean = true,
        channelEnabled: Boolean = true,
        interruptive: Boolean = true,
        soundEnabled: Boolean = true,
        vibrationEnabled: Boolean = true,
    ): TaskNotificationChannelHealth = TaskNotificationChannelPolicy.evaluate(
        appNotificationsEnabled = appNotificationsEnabled,
        channelExists = channelExists,
        channelEnabled = channelEnabled,
        interruptive = interruptive,
        soundEnabled = soundEnabled,
        vibrationEnabled = vibrationEnabled,
    )
}
