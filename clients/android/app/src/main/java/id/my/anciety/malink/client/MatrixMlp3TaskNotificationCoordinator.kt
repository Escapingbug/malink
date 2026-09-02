package id.my.anciety.malink.client

import id.my.anciety.malink.diagnostics.DiagnosticRecorder

/**
 * Delivers every authenticated task terminal independently of which Malink
 * device submitted the prompt. The encrypted store is the retry and dedupe
 * authority; the local command outbox is intentionally not consulted.
 */
internal class MatrixMlp3TaskNotificationCoordinator(
    private val store: AtomicEncryptedMatrixMlp3TaskNotificationStore,
    private val diagnostics: DiagnosticRecorder = DiagnosticRecorder.None,
    private val deliver: (MatrixMlp3TaskNotification) -> Unit,
) {
    @Synchronized
    fun accept(value: MatrixMlp3TaskNotification) {
        val accepted = try {
            store.enqueue(value)
        } catch (error: Exception) {
            diagnostics.record(
                "notification.task_outbox_failed",
                mapOf("error" to error.javaClass.simpleName.take(160)),
            )
            return
        }
        if (accepted) {
            diagnostics.record(
                "notification.task_enqueued",
                mapOf("stage" to value.outcome),
            )
        }
        drain()
    }

    @Synchronized
    fun drain() {
        for (value in store.pending()) {
            try {
                deliver(value)
                store.delivered(value.eventId)
            } catch (error: Exception) {
                diagnostics.record(
                    "notification.task_delivery_deferred",
                    mapOf("error" to error.javaClass.simpleName.take(160)),
                )
                return
            }
        }
    }
}
