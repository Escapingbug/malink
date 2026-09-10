# Stable-identity Gateway execution tracks

Status: coordinator implemented and unit-tested; not yet wired into the product
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
