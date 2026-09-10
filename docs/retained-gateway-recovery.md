# Retained Gateway recovery — implementation contract

Status: implementation in feature worktree; not yet shipped or online-accepted.

Implementation checkpoint:

- Optional typed recovery slot and two-slot invariant added to the protocol.
- Coordinator can retain a host-verified source recovery slot after commit.
- Host retains a dedicated repair room, rehomes its data, pins the previous
  executable, and verifies its process health before publishing recovery.
- The repair process starts before the new active process, so a new-version
  startup failure does not block old-version repair.
- Next-update rotation checkpoints the old slot; preparation failure and discard
  restore it. Healthy recovery is not restarted by repeated restore requests.
- Native strict parsing and web recovery routing accept the optional slot.
- Gateway full suite (1,204 tests at the earlier checkpoint), PWA full suite
  (590 tests), Android unit tests/lint/debug build, and production bundles pass.
  Additional host and client recovery tests were added afterward and pass.
- Existing maintenance sessions may share a Matrix project room with ordinary
  scratch conversations. Retaining that entire room is not an acceptable
  substitute for a dedicated repair route; moving a session alone also requires
  explicit preservation of its thread/history and provider continuation.
- Online acceptance is still required. The installed c962791 source does not
  provision dedicated repair rooms: the first update is a compatibility bootstrap;
  the second update must prove retained recovery and the following rotation.
- Publish updated native parsing before emitting recovery metadata to online
  clients. Do not claim online completion from a signed status fixture.

## User-visible semantics

Completing an update promotes the new Gateway and retains one previous version
as an independent repair environment. Completion does not close recovery.
Normal conversations use the promoted node. Settings exposes the recovery
version and an action to open its repair conversation. Recovery is not a second
equal-priority default node and does not claim arbitrary backwards-compatible
restoration of new-version data.

## Existing boundaries that must change together

- `GatewayDeploymentCoordinator.finishCommit` currently drops the source slot.
- `FileWorkspaceGatewayDirectory.promoteLocalOwnership` tombstones the source
  node and transfers every project route to the candidate.
- `MacosGatewayBlueGreenHost.completeCommittedActivation` archives source data,
  stops both processes, activates the candidate, and logs out the source login.
- Clients currently interpret `steady` as having no recovery environment.
- Maintenance archival guards currently stop protecting repair sessions after
  promotion. Those guards must instead follow explicit repair ownership.

Keeping the source process or restarting its archived directory without changing
these boundaries is unsafe: it can execute work against migrated session state.

## Required transaction

1. Prepare an isolated, release-pinned recovery environment using the old
   executable, independent Matrix device, and its own repair project route.
2. Preserve the old maintenance conversation and provider continuation state
   before promotion; the recovery path must not depend on a new-version history
   restoration request. Never reuse a thread as two active TopicSessions.
3. Verify recovery can start and receive authenticated commands. Stage its
   identity and route before committing normal-work ownership.
4. Commit new normal-work ownership while retaining only the isolated recovery
   route. Stop and fence source normal-work execution before activating either
   post-commit service. A crash must leave durable evidence sufficient to resume
   this operation idempotently.
5. Publish signed recovery metadata only after recovery health is established.
   Keep ordinary read/write state in the new Gateway; never mount its databases
   in the old executable.

## Next update and two-slot limit

Before replacing the retained slot, validate that the current version can be
the next repair environment. A signed, explicit update action authorizes this
rotation; a check-for-updates request does not. Preserve the prior checkpoint
until replacement recovery is verified. At most two executing Gateway services
may exist at once. A rotation failure must not silently discard the only usable
repair environment or label the update complete.

## Compatibility and acceptance gates

- Extend protocol and both client projections together: the current deployment
  schema is strict, so an unknown field can invalidate the entire event on old
  clients. Define a version/capability-compatible publication path first.
- Exercise interrupted promotion, recovery process restart, and next-update
  rotation failures, including new-version startup failure.
- Verify recovery still responds when the new Gateway is unavailable; the
  repair action must route directly to old execution, not through the new node.
- Confirm all ordinary project/session identities remain unique and retained,
  and protected repair conversations cannot be bulk-archived.
- Validate online Android and browser presentation before final release.

Do not publish a metadata-only implementation as retained recovery.
