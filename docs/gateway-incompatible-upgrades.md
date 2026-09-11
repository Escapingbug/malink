# Incompatible Gateway upgrades

There are two upgrade paths. Compatible updates keep the previous release and
allow generation-bound selection against the same current data. An incompatible
update requires explicit risk confirmation: the Agent may not reconnect, and
the old binary must not read data once the new version may have opened it.
We do not require every historical Gateway to understand future stores.

The signed release and immutable seal are always checked. Confirmation relaxes
only the state-catalog equality check; it does not relax release authenticity,
writer exclusivity, or backup verification.

For an existing capable Host, the PWA/APK's update action presents the risk
confirmation and sends `allowForwardOnly: true` with the observed execution
generation. The independent supervisor then:

1. Persists the forward-only intent before responding to the signed command.
2. Drains and stops all known business writers and Agent descendants.
3. Locks the business directory and creates a file-hashed, fsynced local backup,
   including execution configuration and local recovery metadata.
4. Pins `current` to the sealed target and requests its independent supervisor
   through launchd. The Host app executable/TCC identity is unchanged.
5. Resumes the same intent, revalidates the backup, persists the write boundary,
   starts the target and verifies its actual build/node/lock/Matrix health.
6. Removes the incompatible old version from selectable fallback. A failed
   startup retains the original backup and target for recovery; no implicit
   rollback or data restoration occurs.

The isolated Matrix control receiver is not upgraded in this transaction and
does not open business data. It can forward version-control requests while the
business Agent is offline. Local recovery remains necessary if the Host itself
cannot start or the new runtime repeatedly fails.

## Local entry point (no Agent or browser needed)

Use the known-working absolute Node executable and the sealed target's
`ops/gatewayForwardRecoveryCli.js`; do not run a changing PATH shim. For example:

```sh
/absolute/known-working/node /absolute/sealed-release/ops/gatewayForwardRecoveryCli.js status /absolute/install-root
/absolute/known-working/node /absolute/sealed-release/ops/gatewayForwardRecoveryCli.js resume /absolute/install-root
```

`status` reads the local journal even if the supervisor is offline. It reports
the phase, target, original backup path and whether the target may have written.
`resume` asks the owner-only supervisor socket to continue that exact generation;
it never invents another upgrade or restores old data.

For the first upgrade from an older macOS Host that lacks this online path,
prepare and seal the target first, then run externally:

```sh
/absolute/known-working/node /absolute/sealed-release/ops/gatewayForwardRecoveryCli.js bootstrap /absolute/install-root sealed-release-id --allow-forward-only
```

The local bootstrap supports the existing `io.malink.gateway-update-supervisor`
current-linked launchd layout. It validates the signer/seal, stable identity and
directory binding, acquires the controller lock, waits for live work to finish,
stops the old supervisor, verifies a stopped-state backup and hands off to the
target Host. Unsupported layouts fail explicitly. Do not run it in the Agent
that is itself waiting to finish; use a local terminal or an independent owner
process. “Host started” is not a successful health-check claim: inspect status.

If the supervisor is offline, correct its local launch/runtime issue and start
the same pinned Host through launchd before `resume`. If choosing backup restore
instead, stop the supervisor and every business writer first. Preserve the
current data separately, verify `backup-manifest.json`, and inspect the backup
in a separate directory before restoring it and its matching source release.
The backup is pre-upgrade state, so restoring it does not include later work.
Before reconnecting Matrix after a restore, reconcile any commands executed
after the backup against the preserved current journal. Blindly rolling back
the journal and transport cursor can replay already-executed commands; a backup
restore is therefore an offline recovery procedure, not a normal version switch.
No automatic destructive restore command is provided.

## Acceptance boundary

Automated tests cover confirmation gating, stop/backup/write ordering, Host
handoff persistence, backup corruption, target failure and no-old-reader guards.
Real macOS bootstrap, APK/browser upgrade and reconnect acceptance are still
required before claiming an online release.
