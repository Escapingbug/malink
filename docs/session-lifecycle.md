# Session archive and delete

- Archive retains the same session identity, Matrix thread, provider session, message history, and working directory. It releases the idle runtime without deleting storage. Running sessions must be stopped first. Archived sessions appear in the Archived list and can be restored in place.
- Restore marks a retained archive active and creates its runtime again; the existing provider session is used when work resumes. It never recreates a deleted session.
- Delete uses the existing durable cleanup flow: detach the runtime, publish logical deletion, and retry Matrix/history-room/scratch cleanup in the background. Provider History remains the way to continue the provider conversation, when that provider still has it.

The authenticated MLP/3 `session.set_lifecycle` command distinguishes `archived`, `active`, and `deleted`. Dispatch rechecks the corresponding archive, restore, or delete permission. Batch archive retains sessions and skips running sessions.

New retained archives carry `retainedArchive: true` in Gateway metadata. Older `archived` records are deletion tombstones and must never be restored or exposed as retained archives. The existing internal archive cleanup checkpoint format is preserved for in-flight deletions. Restart publishes full session metadata for retained archives, while cleanup only operates on deletion checkpoints.

Upgrade Gateway and Android to enable the new lifecycle actions: older Android hosts map both archive and delete to `archived`. The PWA also requires the optional `commands.session-lifecycle` Android bridge capability before lifecycle actions, so older APKs show an update requirement. The PWA checks the signed `session.archive.retain` Gateway capability before single/batch archive or restore, preventing a new archive request from reaching a Gateway with the old destructive archive behavior.
