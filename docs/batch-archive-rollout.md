# Protocol batch archive rollout (in progress)

The feature branch adds `session.archive.batch` (1–100 explicit project/session
targets) and revisioned per-item progress. Clients group by actual Gateway node,
not the presentation computer alias. The Gateway claims the parent command and
uses deterministic child command IDs with its ordinary session lifecycle journal
and session queues. Batch checkpoints are fsynced before progress publication.

## Implemented compatibility baseline

- Clients explicitly opt in to signed operation capabilities using
  `gateway.update.status.includeOperationCapabilities`. Ordinary status replies
  keep their existing shape. Every target owner is checked before any batch is
  submitted; missing capabilities require an update, never a serial fallback.
- Android negotiates `commands.batch-archive`, validates and forwards the query,
  and keeps capability probes distinct from ordinary coalesced status probes.
- `batchArchiveEnabled: false` is a reader-only compatibility mode: the runtime
  still understands and retains batch checkpoints and journal records, reports
  no batch capability, rejects new batch execution, and does not recover either
  batch parents or reserved `batch-archive-` child commands. Re-enable only on a
  capable business writer. This does not modify an already installed old binary.
- Archive authorization is checked again after waiting in the session queue.
  Storage/outbox failures keep the parent unfinished for restart recovery.
- UI uncertainty markers survive reload, are scoped to homeserver/account/
  workspace, and prevent reselecting unconfirmed items. Leaving/reentering
  selection does not erase them. Unreadable storage fails closed.
- Automated tests cover three fresh session archives, independent failures,
  replay, bounded concurrency, publication interruption recovery, ordinary vs
  capability status replies, and reader-only fallback retaining dispatched
  parent/child journals before capable-reader recovery.

## Release blockers — do not advertise yet

- Existing retained releases strictly decode the command journal. New batch
  records are not backward-readable merely because the SQLite schema is unchanged.
- `matrix-archive-batches` is a new durable state family. The stable supervisor's
  exact catalog admission check correctly rejects this release until compatibility
  preparation is complete. Do not remove the catalog entry or bypass admission.
- Prepare a reader-compatible fallback release and a coordinated stable-host
  transition before enabling batch submission. Preserve the independent recovery
  control route and verify new → fallback → new using current business data.
- A real Android/browser batch, interruption/restart, and cross-project success
  test are required; automated tests do not establish the entire live workflow.

Do not publish the PWA or APK separately while these release blockers remain.
The current production UI remains on its previous serial implementation.
