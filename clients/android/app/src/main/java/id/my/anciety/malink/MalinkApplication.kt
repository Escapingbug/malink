package id.my.anciety.malink

import android.app.Application
import id.my.anciety.malink.diagnostics.NativeDiagnosticLog
import id.my.anciety.malink.diagnostics.ProcessExitDiagnostics

/** Lightweight process entry point; durable runtime initialization belongs to the service IO scope. */
class MalinkApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        ProcessExitDiagnostics.recordPreviousExits(
            context = this,
            diagnostics = NativeDiagnosticLog.get(this),
        )
    }
}
