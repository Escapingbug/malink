package id.my.anciety.malink.service

import android.content.Context
import androidx.core.content.edit
import java.util.UUID

class ServicePreferenceStore(context: Context) {
    private val preferences = context.getSharedPreferences(FILE_NAME, Context.MODE_PRIVATE)

    var restoreEnabled: Boolean
        get() = preferences.getBoolean(KEY_RESTORE_ENABLED, false)
        set(value) {
            preferences.edit { putBoolean(KEY_RESTORE_ENABLED, value) }
        }

    val hasRestorePreference: Boolean
        get() = preferences.contains(KEY_RESTORE_ENABLED)

    /**
     * Survives a process interruption between native Matrix revocation and the
     * hosted UI clearing its account projections. A successful bootstrap is
     * the only operation that retires this marker.
     */
    var accountSetupRequired: Boolean
        get() = preferences.getBoolean(KEY_ACCOUNT_SETUP_REQUIRED, false)
        set(value) {
            preferences.edit(commit = true) { putBoolean(KEY_ACCOUNT_SETUP_REQUIRED, value) }
        }

    val nativeDeviceId: String
        get() = preferences.getString(KEY_NATIVE_DEVICE_ID, null) ?: synchronized(DEVICE_ID_LOCK) {
            preferences.getString(KEY_NATIVE_DEVICE_ID, null) ?: UUID.randomUUID().toString().also {
                preferences.edit(commit = true) { putString(KEY_NATIVE_DEVICE_ID, it) }
                check(preferences.getString(KEY_NATIVE_DEVICE_ID, null) == it) {
                    "Native device identity could not be persisted."
                }
            }
        }

    private companion object {
        const val FILE_NAME = "malink-native-host"
        const val KEY_RESTORE_ENABLED = "foreground-service-enabled"
        const val KEY_ACCOUNT_SETUP_REQUIRED = "account-setup-required"
        const val KEY_NATIVE_DEVICE_ID = "native-device-id"
        val DEVICE_ID_LOCK = Any()
    }
}
