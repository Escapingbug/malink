package id.my.anciety.malink.service

import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.provider.Settings
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import id.my.anciety.malink.R
import id.my.anciety.malink.client.command.CommandCompletion
import id.my.anciety.malink.web.MainActivity

class AgentTaskNotifier(private val context: Context) {
    fun createChannel(): TaskNotificationChannelState {
        val manager = context.getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(
            NotificationChannel(
                CHANNEL_ID,
                context.getString(R.string.task_notification_channel_name),
                NotificationManager.IMPORTANCE_HIGH,
            ).apply {
                description = context.getString(R.string.task_notification_channel_description)
                lockscreenVisibility = Notification.VISIBILITY_PRIVATE
                setShowBadge(true)
                setSound(
                    RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION),
                    AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_NOTIFICATION)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                        .build(),
                )
                enableVibration(true)
                vibrationPattern = TASK_VIBRATION_PATTERN
            },
        )
        manager.deleteNotificationChannel(LEGACY_CHANNEL_ID)
        return channelState()
    }

    @SuppressLint("MissingPermission")
    fun show(kind: TaskNotificationKind, completion: CommandCompletion): TaskNotificationChannelState {
        val notificationId = notificationId(completion.sessionId ?: completion.commandId)
        val openSession = Intent(context, MainActivity::class.java)
            .setAction(MainActivity.ACTION_OPEN_SESSION)
            .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        completion.sessionId?.let { openSession.putExtra(MainActivity.EXTRA_SESSION_ID, it) }
        val contentIntent = PendingIntent.getActivity(
            context,
            notificationId,
            openSession,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val notification = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_malink_notification)
            .setContentTitle(context.getString(kind.titleResource()))
            .setContentText(context.getString(kind.bodyResource()))
            .setCategory(NotificationCompat.CATEGORY_STATUS)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setGroup(TASK_NOTIFICATION_GROUP)
            .setGroupAlertBehavior(NotificationCompat.GROUP_ALERT_ALL)
            .setAutoCancel(true)
            .setContentIntent(contentIntent)
            .addAction(
                0,
                context.getString(R.string.task_notification_settings),
                channelSettingsPendingIntent(),
            )
            .build()
        NotificationManagerCompat.from(context).notify(notificationId, notification)
        return channelState()
    }

    fun channelState(): TaskNotificationChannelState {
        val manager = context.getSystemService(NotificationManager::class.java)
        val channel = manager.getNotificationChannel(CHANNEL_ID)
        val appNotificationsEnabled = NotificationManagerCompat.from(context).areNotificationsEnabled()
        return TaskNotificationChannelState(
            appNotificationsEnabled = appNotificationsEnabled,
            channelExists = channel != null,
            importance = channel?.importance ?: NotificationManager.IMPORTANCE_NONE,
            soundEnabled = channel?.sound != null,
            vibrationEnabled = channel?.shouldVibrate() == true,
        )
    }

    fun channelSettingsPendingIntent(): PendingIntent = PendingIntent.getActivity(
        context,
        TASK_NOTIFICATION_SETTINGS_REQUEST_ID,
        Intent(Settings.ACTION_CHANNEL_NOTIFICATION_SETTINGS)
            .putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
            .putExtra(Settings.EXTRA_CHANNEL_ID, CHANNEL_ID)
            .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )

    private fun TaskNotificationKind.titleResource(): Int = when (this) {
        TaskNotificationKind.SUCCEEDED -> R.string.task_notification_succeeded_title
        TaskNotificationKind.FAILED -> R.string.task_notification_failed_title
        TaskNotificationKind.CANCELLED -> R.string.task_notification_cancelled_title
    }

    private fun TaskNotificationKind.bodyResource(): Int = when (this) {
        TaskNotificationKind.SUCCEEDED -> R.string.task_notification_succeeded_body
        TaskNotificationKind.FAILED -> R.string.task_notification_failed_body
        TaskNotificationKind.CANCELLED -> R.string.task_notification_cancelled_body
    }

    private fun notificationId(value: String): Int =
        TASK_NOTIFICATION_ID_BASE + (value.hashCode() and TASK_NOTIFICATION_ID_MASK)

    companion object {
        const val CHANNEL_ID = "malink-agent-tasks-v2"
        private const val LEGACY_CHANNEL_ID = "malink-agent-tasks"
        private const val TASK_NOTIFICATION_GROUP = "malink-agent-task-updates"
        private const val TASK_NOTIFICATION_ID_BASE = 20_000_000
        private const val TASK_NOTIFICATION_ID_MASK = 0x00ffffff
        private const val TASK_NOTIFICATION_SETTINGS_REQUEST_ID = 1_904
        private val TASK_VIBRATION_PATTERN = longArrayOf(0L, 250L, 150L, 250L)
    }
}

data class TaskNotificationChannelState(
    val appNotificationsEnabled: Boolean,
    val channelExists: Boolean,
    val importance: Int,
    val soundEnabled: Boolean,
    val vibrationEnabled: Boolean,
) {
    val health: TaskNotificationChannelHealth = TaskNotificationChannelPolicy.evaluate(
        appNotificationsEnabled = appNotificationsEnabled,
        channelExists = channelExists,
        channelEnabled = importance != NotificationManager.IMPORTANCE_NONE,
        interruptive = importance >= NotificationManager.IMPORTANCE_HIGH,
        soundEnabled = soundEnabled,
        vibrationEnabled = vibrationEnabled,
    )
}
