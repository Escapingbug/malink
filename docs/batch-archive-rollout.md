# Protocol batch archive rollout (in progress)

The feature branch adds `session.archive.batch` (1–100 explicit project/session
targets) and revisioned per-item progress. Clients group by actual Gateway node,
not the presentation computer alias. The Gateway claims the parent command and
uses deterministic child command IDs with its ordinary session lifecycle journal
and session queues. Batch checkpoints are fsynced before progress publication.

## Release blockers — do not advertise yet

- Existing retained releases strictly decode the command journal. New batch
  records are not backward-readable merely because the SQLite schema is unchanged.
- `matrix-archive-batches` is a new durable state family. The stable supervisor's
  exact catalog admission check correctly rejects this release until compatibility
  preparation is complete. Do not remove the catalog entry or bypass admission.
- Prepare a reader-compatible fallback release and a coordinated stable-host
  transition before enabling batch submission. Preserve the independent recovery
  control route and verify new → fallback → new using current business data.
- Replace the temporary current-release-ID UI gate with an explicit signed,
  backward-compatible capability negotiation; a build matching the published
  version alone is not proof that an older release supports batches.
- Verify pending-item exclusion across UI reloads and clear batch UI state on
  account/workspace changes. Verify authorization again at child dispatch, not
  only before waiting in its session queue.
- A real Android/browser batch, interruption/restart, and cross-project success
  test are required; current integration tests cover mixed failures, archived
  target success and replay, not the entire live workflow.

Do not publish the PWA or APK separately while these release blockers remain.
The current production UI remains on its previous serial implementation.
