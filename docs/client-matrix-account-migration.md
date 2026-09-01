# Client Matrix Account Migration Plan

This plan moves every Malink PWA and Android device onto one fixed,
Workspace-owned Matrix client user while preserving a separate Matrix user for
Gateway nodes. It is deliberately a staged plan: deploying identity detection
and invitation enforcement is not authorization to migrate or revoke any
existing account.

## Safety invariants

- Do not change the current Matrix session, revoke a device, leave a room,
  deactivate an account, rotate a project key, or delete local client storage
  until the owner explicitly approves the final migration window.
- Existing legacy certificates remain authorized for ordinary MLP/3 commands
  during the compatibility phase.
- New pairing and new-device invitations must use the fixed client Matrix user.
- A legacy device cannot authorize another legacy device.
- Migrate only one physical device at a time. Confirm convergence before
  starting the next device.
- Never copy a Matrix password or long-lived access token into a PWA URL, QR
  code, Matrix event, diagnostic report, or migration log.
- Matrix transports state; signed Malink certificates and Workspace grants
  remain the only execution authority.

## Observed pre-migration shape

The pre-implementation audit found six active client device records split
evenly across two Matrix client users. The Gateway already used a third,
separate Matrix user. No device had been revoked. Re-run the preflight before
the migration window; these counts are evidence from the audit, not a frozen
assumption.

The fixed target identity is read from the owner-only client token-issuer
credential configured by `MALINK_PWA_LOGIN_FILE`. Do not hard-code a target
Matrix ID independently in multiple services.

## Phase 0: backups and immutable inventory

Complete all of the following before changing a device:

1. Stop initiating new Agent turns and wait for active turns to reach a
   terminal state.
2. Record `malink gateway status` and `malink gateway devices` output. The
   status must expose `clientMatrixUserId`, `legacyClientDeviceCount`, and
   `clientMatrixIdentityStatus`.
3. Record, without access tokens, each Malink application device ID, Matrix
   user ID, Matrix device ID, certificate ID, certificate expiry, and last
   successful sync time.
4. Back up the Gateway data directory, its command journal and outbox, the
   owner-only Matrix credential files, Synapse data, and the PostgreSQL volume.
5. Export or snapshot each browser's Malink IndexedDB databases and each
   Android app's encrypted Matrix session, application keys, command outbox,
   raw inbox, and local projection.
6. Verify that backups can be read and record their checksums. A backup that
   has not been inspected is not a rollback plan.

Abort the migration if a command outbox is non-empty, a turn is running, a
client cannot produce a consistent snapshot, the fixed account cannot issue a
one-time login token, or the Gateway status does not agree with the device
inventory.

## Phase 1: compatibility deployment

Deploy in this order:

1. PWA code that accepts the optional signed-directory
   `clientMatrixUserId`, recognizes a mismatch, and displays the non-blocking
   legacy-account notice.
2. Android code with the same signed-directory validation and token-only
   `matrix.session-bootstrap` v3 support.
3. Gateway code that publishes the fixed client identity, reports legacy
   counts, rejects new pairing on other Matrix users, and prevents a legacy
   device from creating device invitations.

This order matters because older strict clients may reject a newly added field
in the signed Workspace directory. During this phase the upgrade button stays
disabled and explicitly says that no state has been changed.

Exit criteria:

- Existing legacy and target-account devices can still read history and run
  ordinary tasks.
- New invitations contain a one-time login token for exactly the fixed client
  Matrix user.
- A pairing request from any other Matrix user is rejected before a new
  certificate or Workspace grant is issued.
- Gateway status reports the expected nonzero legacy-device count.

## Phase 2: implement and rehearse the device transaction

The final upgrade action must not be enabled until both Web and Android have a
transactional migration implementation.

For each device, the transaction is:

1. Acquire an exclusive local migration lock and pause new commands.
2. Drain or prove empty the client outbox; persist every raw event and current
   projection cursor.
3. Create a local rollback bundle containing the old account-scoped Matrix
   session, crypto store reference, room bindings, Malink application key,
   trusted Gateway state, and local projection metadata. Encrypt it using the
   platform's existing secret-storage boundary.
4. Obtain a fresh, required-login device invitation from the local Gateway or
   from an already migrated target-account device. The legacy device itself is
   not allowed to create the invitation.
5. Consume the one-time token into a new Matrix device session and verify that
   the returned Matrix user ID exactly matches the signed directory target.
6. Re-pair using the same Malink application device ID and application key.
   The Gateway may replace that device's certificate only after verifying the
   same application key; it must not create a duplicate application identity.
7. Join or confirm every authorized project room, restore the room bindings,
   complete Matrix crypto initialization, and rebuild the local projection from
   authenticated MLP/3 state.
8. Verify conversation inventory, recent history, attachments, command
   acknowledgements, read-receipt behavior, Gateway directory revision, and
   active certificate ID.
9. Resume command submission only after a signed Gateway state snapshot and a
   successful no-op/read-only health probe have converged.
10. Retain the rollback bundle and old Matrix session without using them until
    the owner approves the end of the observation window.

Android additionally requires a native migration coordinator because its
Matrix session, crypto store, outbox, raw inbox, and encrypted projection are
account-scoped and currently have one active owner. The coordinator must use a
prepare/commit/rollback journal so a process death cannot leave two runtimes
owning one Malink application session or leave neither account recoverable.

Browser migration must similarly stage the new Matrix sync/crypto databases
under the target account scope before atomically switching the saved public
session pointer. It must not clear the old account databases during commit.

## Phase 3: controlled migration window

After explicit owner approval:

1. Re-run Phase 0 and compare the new inventory with the recorded baseline.
2. Migrate one noncritical browser device first.
3. Observe at least one complete reconnect, one history restore, one ordinary
   Agent turn, one read-receipt update, and one application restart.
4. Migrate remaining browser devices one at a time.
5. Migrate one Android device and exercise background stop/start, network loss,
   process death recovery, notification delivery, history restore, and a full
   command round trip.
6. Continue until Gateway status reports zero legacy devices and
   `clientMatrixIdentityStatus=converged`.

Stop immediately if a device loses local history, a pending command changes
identity, a certificate is duplicated, Matrix crypto cannot decrypt previously
accessible room state, Gateway status counts diverge, or a migrated device
cannot survive restart.

## Rollback

Rollback is per device until final cleanup:

1. Pause the failed target-account runtime and preserve its diagnostics.
2. Restore the old local session pointer and account-scoped stores from the
   rollback bundle.
3. Re-pair the old Matrix transport with the same Malink application key only
   if its previous certificate was replaced. This requires an explicitly
   approved recovery invitation; do not weaken the fixed-account rule globally.
4. Confirm the old projection, outbox, and command identities before resuming
   work.
5. Leave all other devices and the legacy Matrix account untouched while the
   failure is investigated.

Do not deactivate the old account or delete rollback bundles during the
observation window.

## Phase 4: final cleanup (separate approval)

Final cleanup requires a second explicit approval after every device is
converged and the observation window has passed:

1. Take a final backup and confirm zero legacy devices in Gateway status.
2. Revoke remaining legacy Malink certificates and publish Workspace
   revocations.
3. Remove the legacy Matrix user from Malink project rooms.
4. Invalidate its Matrix access tokens and devices, then deactivate the legacy
   account if no other service owns it.
5. Rotate affected MLP/3 project encryption keys and publish grants only to
   active target-account device certificates.
6. Verify every client after rotation, then securely delete rollback bundles
   and obsolete owner-only credential files.

None of these cleanup actions are part of the compatibility implementation.

## State-sync scope

Using one Matrix client user lets standard Matrix read receipts converge across
that user's devices. Small non-message state may later use account data with
bounded, replace-in-place documents; it must not be modeled as an ever-growing
RPC timeline. Draft synchronization is a separate feature and is not enabled by
this migration.
