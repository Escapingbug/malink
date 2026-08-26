package id.my.anciety.malink.service

enum class TaskNotificationChannelHealth(val wireName: String) {
    READY("ready"),
    APP_BLOCKED("app_blocked"),
    CHANNEL_MISSING("channel_missing"),
    CHANNEL_BLOCKED("channel_blocked"),
    NON_INTERRUPTIVE("non_interruptive"),
    SOUND_DISABLED("sound_disabled"),
    VIBRATION_DISABLED("vibration_disabled"),
}

object TaskNotificationChannelPolicy {
    fun evaluate(
        appNotificationsEnabled: Boolean,
        channelExists: Boolean,
        channelEnabled: Boolean,
        interruptive: Boolean,
        soundEnabled: Boolean,
        vibrationEnabled: Boolean,
    ): TaskNotificationChannelHealth = when {
        !appNotificationsEnabled -> TaskNotificationChannelHealth.APP_BLOCKED
        !channelExists -> TaskNotificationChannelHealth.CHANNEL_MISSING
        !channelEnabled -> TaskNotificationChannelHealth.CHANNEL_BLOCKED
        !interruptive -> TaskNotificationChannelHealth.NON_INTERRUPTIVE
        !soundEnabled -> TaskNotificationChannelHealth.SOUND_DISABLED
        !vibrationEnabled -> TaskNotificationChannelHealth.VIBRATION_DISABLED
        else -> TaskNotificationChannelHealth.READY
    }
}
