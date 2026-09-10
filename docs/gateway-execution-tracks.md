# Stable-identity Gateway execution tracks

Status: coordinator and process adapter implemented and tested; not yet wired into the product
update path. Existing blue/green deployment remains active until the integration
and on-device acceptance work below is complete.

## Contract

A release is executable software, not a Gateway node or a copy of a Workspace.
Both retained and default releases refer to the same stable `gatewayNodeId`,
project IDs, Matrix rooms, command journal, provider continuation IDs and current
business data directory. Selecting the retained release never restores an old
data snapshot. Results produced while either release is default remain current.

The default track owns Matrix sync, inbox/outbox delivery, writable stores and
Agent execution. The retained track stays available in standby, without opening
those resources. Only the current owner takes the existing data-directory lock.
Both versions being available does not permit two writers or two Matrix retry
authorities. The Host must keep standby control separate from business runtime
startup; running two ordinary Gateway entry points against one directory is not
a valid implementation.

## Selection

`GatewayExecutionTracks` durably records an explicit release selection before
releasing execution. It checks the displayed generation, validates compatibility
without mutation, releases both known potential writers, activates the selected
release against the stable directory and verifies ownership before completing.
An interrupted selection resumes its recorded target. A user may explicitly
select the former version after a failed activation. Neither path clones,
rewinds, merges or renames business data.

The coordinator is owned by one supervisor process. Its adapter must provide
idempotent release-specific operations: stopping release A must not stop B just
because B now owns a shared PID/socket path. Releasing execution must also
disable automatic respawn and settle Agent children and durable deliveries.
Every operation needs a bounded timeout in the concrete host implementation.

Both versions must be able to read current business state throughout the retained
window. Compatibility validation is a release admission requirement, not user
permission to discard newer data. No automatic Agent trial is allowed. Version
checks must not open a writable production database or run irreversible schema
migrations. A retained release cannot be replaced while it is executing tasks.

## Process adapter

`GatewayExecutionTrackProcessHost` starts pinned executables with an explicit
business data directory. Health acceptance requires the selected build and
stable node identity, Matrix readiness, and an actual data lock owned by the
spawned process. Relinquishment drains execution and waits for the whole dedicated
process group to exit; it does not force-kill active tasks on a timeout. A timed-out
drain remains tracked and blocks activation until its underlying work settles.

The adapter has a real child-process test that uses the production data-directory
lock and exercises old/new/old over a single current data directory. This is not
an actual MLP journal, ACP continuation, APK, or live Matrix acceptance test.

It is deliberately not enabled against the existing launchd service: a stable
owner must first disable the old automatic spawn authority and reconcile live
processes after restart. Its standby release admission is not yet a persistent
standby controller process. These integration requirements cannot be replaced
with a successful unit test or an available APK button.

The independent signed control receiver must remain reachable when the default
business Gateway cannot start. It needs its own control transport/outbox and
authenticated command journal; it must not compete for the business Gateway's
Matrix sync or its data directory. Ordinary Matrix messages and membership are
never authorization for a version switch. A local-only socket does not satisfy
the remote rollback requirement.

## Remaining integration and acceptance gates

- Implement release-pinned standby controllers and concrete process/data lock
  ownership verification; wire the coordinator into the supervisor.
- Expose authenticated, journaled selection through the existing Matrix command
  boundary and publish signed default/standby/transition status.
- Provide “Use previous version” and “Use latest version” actions with generation
  binding. Distinguish standby availability from actual execution health.
- Migrate existing blue/green installations without changing current project
  routes or throwing away the authoritative active data.
- Exercise real process crashes before/after every persisted transition, active
  Agent cancellation/drain, shared database exclusion, and restart recovery.
- Run real APK acceptance: create a session, produce a result, select the other
  version, continue the same session, and verify the original command identity
  cannot execute twice. No successful rollout claim until this passes.
