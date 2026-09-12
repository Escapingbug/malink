package id.my.anciety.malink.client

/** Runtime mutex owns this state. Raw cleanup may never pass an unsaved mutation. */
internal class ProjectionCheckpointPolicy {
    var dirty = false
        private set

    fun note(projectionChanged: Boolean) { dirty = dirty || projectionChanged }

    fun flush(save: () -> Boolean, cleanup: () -> Unit) {
        if (dirty && !save()) return
        dirty = false
        cleanup()
    }
}
