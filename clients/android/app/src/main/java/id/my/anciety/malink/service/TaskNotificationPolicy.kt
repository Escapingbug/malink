package id.my.anciety.malink.service

import id.my.anciety.malink.client.command.CommandOutcome

enum class TaskNotificationKind {
    SUCCEEDED,
    FAILED,
    CANCELLED,
}

object TaskNotificationPolicy {
    fun decide(
        uiForeground: Boolean,
        outcome: CommandOutcome,
    ): TaskNotificationKind? {
        if (uiForeground) return null
        return when (outcome) {
            CommandOutcome.SUCCEEDED -> TaskNotificationKind.SUCCEEDED
            CommandOutcome.FAILED -> TaskNotificationKind.FAILED
            CommandOutcome.CANCELLED -> TaskNotificationKind.CANCELLED
        }
    }
}
