# Gateway blue/green updates

This document defines the update model for a Workspace computer. It
replaces restart-in-place activation with a temporary, user-controlled pair of
fully usable Gateway deployments. The implementation retains the legacy
restart-in-place protocol only for older installed Gateways that do not publish
the blue/green deployment capability.

## Product contract

A Workspace computer normally has exactly one active Gateway deployment. An
update may temporarily add one candidate deployment on the same computer:

```text
steady                         trial

computer                       computer
└── active release A           ├── active release A
                               └── candidate release B
```

The following rules are normative:

- One computer may expose at most two usable Gateway deployments: one active
  deployment and one update candidate. Cached release files do not count as a
  deployment and have no Matrix or execution authority.
- The two-deployment state exists only for an update. It is not a general
  multi-instance or load-balancing mode.
- The candidate is a real Gateway. The user can explicitly create and use
  candidate-owned projects and sessions before deciding whether to switch.
- Existing projects and sessions remain owned by the active deployment during
  the trial. Selecting a version therefore creates or opens a project route
  owned by that deployment; it is not a per-Prompt traffic toggle inside one
  session.
- The trial has no automatic expiry. Only an explicit **Switch all work** or
  **Discard candidate** action ends it.
- **Switch all work** transfers every project and every persisted session owned
  by the old deployment in one computer-level transaction. Candidate-owned
  trial work remains on the candidate. No individual session can be left on the
  old deployment.
- Both processes remain usable until the user explicitly starts **Switch all
  work**. That transaction closes both command gates, drains accepted work and
  durable delivery queues, then stops their writers long enough to construct a
  consistent merged deployment. A pre-commit failure restarts the old active
  deployment; after the ownership commit, only the promoted deployment may
  start. The old immutable release may remain as a non-runnable local cache.
- **Discard candidate** stops and removes only the candidate deployment and its
  explicitly candidate-owned trial state. It never restarts or modifies the
  active deployment.

“Temporary” describes the topology, not a timer. Malink must not switch or
discard a deployment merely because the PWA closed, a device went offline, or
a trial has lasted a long time.

## Identity model

`computerName` is presentation and cannot group or authorize deployments. The
host persists a random stable `computerId`; each runnable deployment retains a
distinct `gatewayNodeId`. A signed deployment record binds them:

```text
computerId
├── activeGatewayNodeId
├── candidateGatewayNodeId?       # absent outside an update trial
├── generation                    # monotonic ownership generation
├── updateId?
└── phase
```

The `computerId` survives Gateway releases, display-name changes, Matrix device
replacement, and successful promotion. `gatewayNodeId` identifies one
deployment; after that deployment is retired, the ID is never reused. Reusing
the old node ID would make stale Directory snapshots and command recovery
ambiguous.

The existing strict Gateway Directory v1 remains valid during mixed-version
operation. It may list the candidate as a second ordinary Gateway with only its
own trial routes. A separately versioned, signed deployment record lets new
clients group both nodes under one computer and render their active/candidate
roles. Adding deployment fields to the strict v1 descriptor is forbidden
because older clients would reject the whole Workspace Directory.

## State machine

The same local coordinator serializes every transition for a `computerId` and
enforces the two-deployment limit.

| Phase | Runnable deployments | Project ownership | User actions |
| --- | --- | --- | --- |
| `steady` | active | all routes on active | Prepare candidate |
| `preparing` | active | all existing routes on active | Wait for preparation |
| `trial` | active + candidate | existing routes on active; new trial routes may be assigned to candidate | Switch all work, discard candidate |
| `draining` | active + candidate, both command gates closing | unchanged | Wait, or explicitly cancel active turns |
| `transferring` | neither accepts business commands | frozen at prior generation | Wait/recover |
| `committing` | candidate only | one signed atomic route revision assigns every route to candidate | Wait/recover |
| `steady` | promoted candidate | all routes on promoted deployment | Prepare a later candidate |
| `repair_required` | whichever side is proven authoritative | last committed generation only | Local recovery |

`preparing`, `draining`, `transferring`, and `committing` are durable coordinator
states, not PWA progress guesses. Repeating an operation with the same
`updateId` is idempotent. A different prepare request while a candidate exists
is rejected; replacing the candidate requires an explicit discard first.

## Trial routing and single execution authority

Both deployments may be online during `trial`, but one Matrix project room has
exactly one execution owner:

- the active deployment owns every pre-update room;
- the candidate owns only rooms created explicitly for candidate trial work;
- both may shadow-persist encrypted events for the other's rooms, but a shadow
  path cannot authorize, journal, dispatch, or emit a terminal result;
- the signed Workspace Directory continues to contain one unique
  `gatewayNodeId` for each `projectId` and `roomId` route;
- only locally configured project routes enter a Gateway's command authorizer;
  shadow routes are staged in a separate inbox before that boundary.

The candidate must shadow every active-owned room from the point at which the
trial reports ready. This closes the per-device Matrix sync gap: its global sync
cursor may otherwise advance past commands in rooms it did not yet own. Shadow
events are raw durable input only. They become eligible after promotion and
only after reconciliation with the source command journal.

Project provisioning remains immutable history. Transferable ownership uses a
new generation-bearing state event rather than rewriting
`io.malink.project.provisioning.v1`, whose strict schema permanently names the
creator node.

## Candidate preparation

The independent host coordinator, not either versioned Gateway process, owns
the update transaction. It performs these steps without closing the active
command gate:

1. Verify and seal the signed release as today.
2. Refuse preparation when a candidate deployment already exists.
3. Allocate a distinct data directory, admin socket, launchd label, Matrix
   device, and `gatewayNodeId` under the same stable `computerId`.
4. Copy only the Workspace signing and authorization foundation into the
   isolated candidate directory. Active runtime state is never opened for
   writing by the candidate; the target release creates its own trial stores.
5. Start the candidate against its isolated deployment data and require local
   health, a fresh Matrix sync, a readable inbox and command journal, provider
   startup, and shadow readiness for every active route.
6. Publish the signed candidate deployment and its own trial routes, then enter
   `trial`.

This is more than a self-test: after step 6 the user can perform ordinary Agent
work on the candidate. Health checks are admission conditions for exposing it,
not the evidence by which Malink chooses to promote it.

Forward-only state changes use copy-and-migrate preparation too. The final
handoff is built from a fresh frozen source snapshot, so a successful rehearsal
does not mutate the rollback authority or silently discard work created during
the trial.

## Switch-all transaction

Promotion is one coordinator-owned transaction. The PWA sends one command; it
does not enumerate or rewrite sessions.

1. Persist the exact `updateId`, source and target node IDs, source generation,
   intended next generation, and complete source route set.
2. Close both business-command gates. In the default mode, wait for active Agent
   turns and accepted commands to settle. An explicit force mode cancels turns;
   a running turn is never described as migrated.
3. Require both durable inboxes to be empty. Normally both Matrix delivery
   outboxes drain before the switch. If a legacy source sender cannot retire an
   already-persisted delivery, fence its command gate and preserve that WAL for
   target-side takeover instead of deleting the delivery or blocking its own
   upgrade.
4. Seal the candidate and make both deployments close their writable stores.
   A source using durable-queue takeover is gracefully stopped only after its
   active turns and commands reach zero; shutdown awaits its event chain and
   execution tasks. A quiescent-state handoff manifest hashes every transferred
   file. The old process can reopen its unchanged stores if a pre-commit step
   fails.
5. Build new target state in a third, transaction-private directory. Merge the
   source project catalog, runtime metadata, provider session IDs, command
   journal, replay ledger, timeline key rings, provider-history metadata,
   artifacts, scratch-session data, Matrix delivery WAL, and any pending inbox
   records with the candidate's trial-owned state. A duplicate command key is
   accepted only when its fingerprint and durable outcome match exactly. A
   duplicate delivery ID is accepted only when its exact retained ciphertext
   agrees; a durable terminal receipt wins over pending state.
6. Validate the merged state using the target release and require its inherited
   inbox and outbox to reach zero while the command fence remains closed. No
   source or candidate directory is changed in place.
7. Atomically install the merged target directory, restart the candidate against
   it, and require it to acknowledge the complete route set and next ownership
   generation while its business-command gate remains closed. It must reconcile
   the source journal with its shadow inbox before dispatching any newly owned
   command.
8. Commit one signed Workspace Directory revision locally that moves all source
   routes to the candidate and tombstones the source node. The candidate
   becomes active only at this commit point; startup republishes that signed
   revision through the Workspace control room.
9. Open the candidate command gate, replace the active launchd job with the new
   release, attempt to revoke the old Matrix login, archive its data directory
   as non-runnable recovery evidence, and return to `steady`.

Candidate trial sessions are not overwritten by the import. Source and
candidate project IDs, room IDs, and command keys must be disjoint or exactly
equivalent; any other conflict aborts before step 7.

## Failure and recovery boundaries

The coordinator records one authoritative generation at all times:

- Failure before the directory/ownership commit removes the transaction-private
  target, reopens both prior deployments, and returns to `trial`. Source routes
  and source sessions are unchanged.
- Failure after the source gates close but before target readiness reopens the
  old generation only after verifying its unchanged hashes and journal
  generation.
- Failure after the candidate has opened forward-only merged state never starts
  the older release against that state. If the signed route commit has not
  happened, the untouched source deployment remains the execution authority;
  otherwise the coordinator enters `repair_required` with the candidate fenced
  until local recovery can prove it ready.
- A stale old process cannot regain authority from its local catalog. The
  launchd lease is disabled, its Matrix credential is revoked, and the signed
  Directory tombstone causes a manually launched compatible process to stop.
- Commands sent during the short stopped interval remain in Matrix. The source
  final watermark plus candidate shadow/catch-up watermark must cover them
  before the candidate opens its command gate.

The user never sees a successful switch until the candidate has opened the
merged sessions and owns every route. Conversely, candidate trial success alone
must never change an old session's owner.

## Wire compatibility

The blue/green workflow needs separately negotiated operations such as
`gateway.update.prepare`, `gateway.update.promote`,
`gateway.update.discard`, and a deployment-aware status. Reinterpreting the
existing `gateway.update.apply` operation is unsafe: current clients send it
automatically after a rollback-safe stage and would therefore promote without
the new explicit user decision.

During migration:

- a blue/green coordinator advertises the new capability in the separately
  signed deployment record;
- it withholds the legacy `onlineUpdate: true` descriptor flag when legacy
  apply is disabled, so an old client cannot start the restart-in-place flow;
- new clients use only the new operations when the capability is present;
- unknown-operation rejection remains terminal and signed;
- Directory v1 and MLP/3 envelopes remain parseable by old clients. They may
  display the candidate as another Gateway, but unique project routing still
  prevents double execution.

`gateway.update.status` can remain a read-only liveness observation. Deployment
phase and role are separate semantic state and must not be inferred from two
independent node-local timestamps.

## Product presentation

The Computers card groups deployments by stable `computerId` and shows:

- **Current Gateway** with its version and all existing work;
- **Candidate Gateway** with its version, readiness, and trial-owned work;
- an explicit version selector when creating a trial project; sessions then stay
  on their owning project's Gateway;
- **Switch all work to this version**, with the number of projects and sessions
  that will move and a wait/cancel-running-work choice;
- **Discard candidate**, explaining that only candidate-owned trial work is
  removed;
- no control for preparing a third version and no per-session migration action.

After promotion, the computer card immediately becomes a one-Gateway steady
view. Old sessions keep their IDs, Matrix threads, history, and provider resume
identifiers; only their owning deployment and ownership generation change.

## Acceptance criteria

The feature is not complete until automated and real-Matrix tests prove all of
the following:

1. A live old session continues while a candidate session runs concurrently on
   the same computer, with no shared writable store.
2. A third prepare request is rejected under concurrent client requests.
3. The candidate cannot claim a command from an active-owned room during trial.
4. Promotion preserves every old and candidate trial session and their provider
   resume IDs.
5. A command arriving before, during, and after the final watermark executes
   exactly once after promotion.
6. Killing the coordinator at every durable phase recovers to exactly one
   authoritative generation.
7. Pre-commit migration, validation, launch, Matrix, and publication failures
   leave the old Gateway usable.
8. Discarding the candidate never changes the old route set or state hashes.
9. Old clients can parse the Directory and cannot accidentally invoke legacy
   automatic apply against a blue/green-only coordinator.
10. Successful promotion disables the old process and moves all old routes in
    one signed Directory revision; no session remains owned by the retired node.
