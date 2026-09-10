# Stable-data Gateway execution tracks

The stable Host retains two release-pinned controllers. Only the selected
controller starts a business Gateway, its Matrix sync/outbox and Agent children.
Both versions use the same current business directory and stable node identity;
switching software never restores a historical data snapshot or clones sessions.

Admission verifies the signed release, immutable file seal and exact state
catalog compatibility. Incompatible old readers are not offered a writable
directory. A standby admission failure does not prevent the healthy default
from running; the status reports the reduced rollback availability.

Version selection is an authenticated `gateway.update.apply` carrying the
displayed `executionGeneration`. The supervisor persists the intent, returns
the command result, drains and terminates the previous writer and its process
group, then grants the selected writer and verifies its real identity/build and
directory lock. It does not automatically roll back after a failure. Interrupted
handoffs resume the persisted target; stale user selections cannot race them.

An independent, restricted Matrix control receiver remains reachable when the
business executable fails. It accepts only authorized status/version-selection
commands, and has a separate control-room journal and directory. It does not
own business projects, provider history scanning or Agent execution. The signed
status supplies its project route. `Check available versions` and `Use version`
in the APK/PWA use this same signed path, not an owner socket shortcut.

New status fields are opt-in (`includeExecutionTracks: true`) so old strict
native projections still read existing shared snapshots. Old clients can still
install the exact newly staged signed release; selecting a retained version
requires the generation-bound new UI. No MLP version change is required.

## Bootstrap from the older macOS deployment

First publish and seal the new release through the existing update supervisor.
With the business writer stopped and the previous committed handoff's isolated
repair route available, the owner runs:

```
tsx scripts/migrate-gateway-execution-tracks.ts <sealed-release-id>
```

The bootstrap validates both releases and the existing node/room bindings,
backs up control configuration, repairs the known missing control node field,
pins the restricted receiver and stable supervisor to the admitted release,
and creates `execution-tracks-config.json`. It never replaces business data.
The new supervisor disables the legacy business launchd spawn authority; worker
controllers become its only business launch authority. This bootstrap currently
requires the existing macOS repair route; unsupported layouts fail explicitly.

After bootstrap verify `execution-tracks.json`, both real admin sockets and an
authenticated APK version selection. A passing process fixture alone is not
online acceptance. Future signed installs need no bootstrap or data migration.
