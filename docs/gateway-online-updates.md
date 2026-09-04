# Gateway online updates

Malink publishes Gateway updates as a small versioned, signed Prompt. A
Gateway does not download a complete prebuilt application. An authenticated
client request makes the Gateway start a local maintenance Agent, which checks
out the exact signed Git commit, builds and tests it locally, and prepares a
self-contained candidate. The independent update supervisor then validates,
hash-seals, activates, health-checks, and if necessary rolls back that result.

The upstream repository defaults to:

```text
https://github.com/Escapingbug/malink.git
```

## Ownership and trust

The components deliberately have different authority:

- The public site owns availability. `channels/stable.json` is a signed mutable
  pointer; `releases/<release-id>.json` is the immutable signed Prompt.
- PWA and Android WebView clients discover the same channel, compare its build
  ID with every node in the signed Gateway Directory, and send normal
  authenticated MLP/3 update commands through a project owned by that node.
- The Gateway owns the maintenance Agent session. It supplies only the exact
  signed repository, commit, Prompt, isolated workspace, and supervisor submit
  command. The session uses the Gateway's configured project provider and is
  visible in the ordinary session model.
- The maintenance Agent owns Git checkout, dependency/runtime preparation,
  build, test, and candidate assembly. It never owns activation.
- The launchd supervisor owns the pinned ES256 public key, monotonic channel and
  Prompt verification, mirror failover, state-compatibility check, candidate
  copy and local SHA-256 seal, atomic switch, deep Matrix health checks,
  probation, and rollback.

The release signing private key stays off Gateways. A Matrix server or web site
cannot make a Gateway execute an unsigned Prompt. An Agent cannot activate an
unsealed candidate, and changing its candidate after submission cannot change
the staged release.

## Network behavior

For each update a Gateway downloads one small channel document (bounded to
64 KiB), one JSON Prompt (bounded to 128 KiB), plus the Git objects and
genuinely changed dependencies needed by the exact commit. The active Node
runtime and unchanged production files are copied locally with copy-on-write
when supported. Node is downloaded only when the target source requires a newer
runtime; the Agent verifies the official runtime checksum and stores the
executable inside the release.

The old signed-manifest/artifact flow remains as a compatibility path when
neither a signed channel nor an Agent Prompt base URL is configured. It is not
the primary release channel.

## Availability contract

The normal apply mode is `when_idle`:

- Matrix events are persisted in the Gateway inbox before the sync cursor is
  committed, and commands are journaled before execution.
- Apply closes the business-command gate immediately. Existing Agent turns may
  finish; later commands remain durably queued and cannot postpone the switch.
- The binary switch is one atomic `current` symlink rename. On macOS, launchd
  starts the stable `Malink Gateway Host.app` executable and passes
  `current/ops/matrix-local-gateway.js` as its entrypoint. The changing
  release runtime remains available for candidate construction and rollback,
  but does not replace the TCC identity used by the active service.
- A release commits only after the expected build reports `running`, Matrix has
  completed a fresh sync, the durable inbox is readable, and probation remains
  healthy.
- For rollback-safe releases, failed activation restores the previous symlink
  and restarts the previous release. If rollback cannot be proven, the
  supervisor enters `repair_required` and stops automatic switching.
- A release that changes security-critical or durable-command state is marked
  `forward-only`. It stops at `staged` until a second explicit confirmation,
  then stops the Gateway, makes and SHA-256 verifies a local state backup, and
  starts the target with binary rollback disabled. If the target has opened
  the new state and fails health, the supervisor leaves it stopped in
  `repair_required`; it never starts the older binary against newer state.
- After commit, launchd reloads the independent supervisor from `current`; the
  Gateway remains running during that supervisor reload.

In-flight ACP work cannot migrate across a process restart. The protocol also
supports `force`, which cancels active turns, but the normal product path does
not use it.

## Signed Prompt format

The signed object fixes:

- release ID, version name, build ID, publication time, and macOS platform;
- a credential-free HTTPS Git repository and exact 40-character commit;
- the bounded maintenance Prompt;
- the complete persistent-state catalog used to prove rollback compatibility.

Protected schema changes and new security-critical or durable-command stores
are classified as forward-only. Preparation may complete normally, but apply
requires an explicit `allowForwardOnly: true` confirmation. The supervisor
backs up stopped state before switching and disables automatic binary rollback.
Omitted state and state-class changes remain invalid releases.

The Agent-built candidate must contain regular files at:

```text
runtime/node
ops/matrix-local-gateway.js
mcp/stdio.js
ops/gatewayUpdateSupervisorMain.js
ops/gatewayAgentUpdateCli.js
ops/gatewayJournalRepairCli.js
```

It must be self-contained and contain no symlinks. The supervisor rejects
reserved release metadata, empty required entrypoints, special files, more than
10,000 files, or more than 1 GiB. Empty regular dependency files are permitted
and covered by the release seal. On submission the supervisor copies the
candidate into an immutable release directory and records every path, byte
count, executable bit, and SHA-256 digest in `release-seal.json` alongside the
signed `release-prompt.json`. It verifies that seal again immediately before
apply. Before stopping the active Gateway, static validation also parses every
production entrypoint import and requires each external package to exist inside
the candidate. Node-only built-ins retain their `node:` prefix, so a bundle that
would fail during ESM linking cannot reach activation.

## Publication

Create the release key once, preferably offline:

```sh
pnpm generate:gateway-release-key -- \
  --private-key /secure/malink-gateway-release-private.json \
  --public-key ./release-signer.json
```

Push the exact release commit first, then publish its Prompt:

```sh
pnpm release:gateway-agent-update \
  --out ./dist/gateway-agent-update \
  --commit "$(git rev-parse HEAD)" \
  --prompt-file deploy/gateway-agent-update/PROMPT.md \
  --private-key /secure/malink-gateway-release-private.json
```

The publisher derives all three human-facing identifiers from the UTC publish
time and target commit, for example
`2026.08.28-020315Z-12b086d` and
`gateway-2026.08.28-020315Z-12b086d`. This is sortable, collision-resistant,
and directly traceable to Git. `--release-id`, `--version-name`, and
`--build-id` remain available only for an intentional compatibility override.

The publisher refuses to replace an immutable release file. It also emits a
signed `channels/stable.json` document that binds a monotonically increasing
generation to the release ID, build ID, canonical Prompt SHA-256, and ordered
mirror list. Use repeatable `--mirror-base-url` arguments when more than the
default GitHub Pages mirror should be trusted. Upload the immutable version file
to every listed mirror first, verify each public URL, and replace the channel
document last. `latest.json` remains a transition pointer for older clients.
Server routing and the complete order are in
`deploy/gateway-agent-update/README.md`.

The PWA checks `channels/stable.json` on load, every 15 minutes, and whenever it
becomes visible, with a 404-only fallback to `latest.json` during migration. A
newly published version therefore reaches both browser and Android clients
without rebuilding either client. Each client records one attempt per Gateway
and version; the supervisor independently deduplicates concurrent requests from
multiple clients.

## One-time local installation

The active release must contain the supervisor and Agent-update CLI entrypoints.
Install the owner-only supervisor while local recovery access is available:

```sh
pnpm install:gateway-update-supervisor -- \
  --install-root "$HOME/Library/Application Support/Malink/gateway" \
  --gateway-launch-agent "$HOME/Library/LaunchAgents/io.malink.gateway.plist" \
  --gateway-service-label io.malink.gateway \
  --gateway-admin-socket "$HOME/.malink/gateway/admin.sock" \
  --current-build-id gateway-initial-arm64 \
  --agent-channel-url https://escapingbug.github.io/malink/gateway-agent-updates/channels/stable.json \
  --signer-file ./release-signer.json
```

Installation pins the public signer, starts the independent supervisor first,
and then reloads the Gateway with its owner-only socket. The channel argument
may be omitted for a new installation because GitHub Pages is the default. Its
URL is only a bootstrap location: the supervisor accepts the channel only under
the pinned signer, persists the highest verified generation, and downloads the
bound release from its signed mirror list. Matrix commands carry only the
release ID and cannot replace any URL.

If the active release contains a valid signed `release-prompt.json` or legacy
`release-manifest.json`, the installer verifies it and derives the build ID;
otherwise the first installation needs `--current-build-id` so rollback can
prove the baseline returned. Signer rotation remains an explicit offline
migration.

### Bootstrap an older supervisor across a protected-state boundary

A supervisor released before forward-only support fails before it stages the
candidate, with a message such as `introduces protected state ...; automatic
rollback is unsafe`. Repeating the Matrix command cannot change that binary.
This is a one-time local bootstrap: prepare the exact signed target commit and
self-contained candidate using the release Prompt, then run the external
updater from that target checkout while local recovery access is available:

```sh
pnpm forward-update:matrix-gateway:macos -- \
  --release /absolute/path/to/prepared-candidate \
  --prompt-file /absolute/path/to/releases/<signed-release-id>.json \
  --install-root "$HOME/Library/Application Support/Malink/gateway" \
  --data-dir "$HOME/.malink/gateway" \
  --current-build-id <currently-installed-build-id> \
  --launch-agent "$HOME/Library/LaunchAgents/io.malink.gateway.plist" \
  --service-label io.malink.gateway \
  --admin-socket "$HOME/.malink/gateway/admin.sock" \
  --supervisor-socket "$HOME/Library/Application Support/Malink/gateway/update-supervisor.sock" \
  --supervisor-service-label io.malink.gateway-update-supervisor
```

Candidate verification and staging can take several minutes. Immediately
after that slow work, the external updater samples the owner-only Gateway
status again and requires three consecutive observations of the same runtime
with no active turns, active commands, unfinished journal commands, pending
inbox events, or pending outbox deliveries, plus fresh Matrix synchronization.
It waits up to 15 minutes by default; use `--idle-timeout-ms` to extend that
window. If the Gateway does not reach this checkpoint, the command stops before
shutdown, backup, state migration, or release activation.

The command verifies the Prompt against the signer pinned at
`<install-root>/release-signer.json`, derives the target release/build IDs from
that signed object, verifies that the current checkout is the exact clean signed
commit, checks that its state catalog and production bundles exactly match the
candidate, installs the same metadata into the candidate, and validates the
candidate before stopping anything. Run the Prompt's frozen install, tests,
type checks, production build, and candidate-assembly steps first. Optional `--release-id` and
`--target-build-id` arguments are accepted only as equality checks; they never
override the signed values. The updater rejects symlinks and special files,
copies the candidate into the immutable
`<install-root>/releases/<signed-release-id>` location, and only then stops
the Gateway, copies and hashes every regular state file, records symlinks and
skipped sockets in `backups/<release>-*/backup-manifest.json`, atomically
switches `current`, proves the expected build and fresh Matrix health through
probation, and finally restarts the independent supervisor from the new
release and reconciles its signed release status to `committed`. Backup failure
restarts the unchanged Gateway. Once the target may
have opened protected state, failure never starts the old binary.
On macOS, shutdown waits until launchd confirms that the previous job is no
longer registered before bootstrapping the replacement. A transient bootstrap
error is also reconciled against launchd state before it is treated as a failed
activation.

After this bootstrap, the installed supervisor can perform later protected
updates through the normal PWA flow; they stop at the visible forward-only
warning and require the second user confirmation. The local backup path is
kept in supervisor state and logs, not sent through Matrix.

The installer also creates the stable self-hosted macOS permission app. Before
it mutates either LaunchAgent, it runs a protected-folder probe through that
app. The first run therefore stops safely when Full Disk Access has not yet
been granted; add the printed app in System Settings and repeat the command.
Use repeatable `--gateway-host-preflight-path` arguments for project roots on
other locations or volumes. Complete setup and diagnostic commands are in
[Unattended macOS Gateway access](macos-gateway-host.md).

## Product flow

The wire operations remain `gateway.update.stage`, `gateway.update.apply`, and
`gateway.update.status`; existing clients and Android native services therefore
need no separate Gateway implementation. Their shared `gateway.update` grant
authorizes only requests—the local pinned signer remains the release authority.

Release discovery never starts an update. The PWA presents a node-level update
notice, and its management panel identifies the exact Gateway name, stable short
node ID, current build, target build, and update capability. A Gateway publishes
one signed, encrypted uncaused `gateway.update.status` observation only when its
supervisor phase changes. Current liveness is checked with the existing signed
status command while the client is visible and connected; hiding the client or
losing the network cancels the schedule. Any newer signed node activity defers
the next check. A connected Matrix client or an old cached snapshot is not
Gateway liveness. The user then confirms one exact node. The client sends
`stage`, creates the visible maintenance Agent session, and sends `apply` as
soon as a rollback-safe signed checkpoint is ready. A forward-only checkpoint
stops instead, explains that automatic rollback is disabled, and requires a
second confirmation before the client sends `apply` with
`allowForwardOnly: true`. These remain separate compatible wire commands.
Multiple nodes are
updated as separate, concurrent node-local operations; one node's maintenance
Agent never disables another node's action.

Additive Gateway operations also remain mixed-version safe. A client must not
route `gateway.retire` through a Gateway build older than
`gateway-2026.09.03-081840Z-44d8e8a`: those releases cannot parse the operation
and therefore reject it before the command journal can produce a signed terminal
result. The recovery UI keeps removal disabled, identifies the required Gateway
update, and opens the existing per-node update flow. A removal already accepted
by Matrix remains one durable command identity; after the authority Gateway is
updated, normal journal reconciliation completes that same action rather than
submitting a second retirement.
The current client persists that explicit update intent before sending `stage`.
If it is closed between the two old wire commands, it resumes only that exact
project/node/release from `staged` after reconnecting. Pre-existing staged
updates without a current-client intent are never activated automatically. An
unused intent expires after 24 hours so old consent cannot activate a later,
coincidentally matching checkpoint.

The liveness check has a bounded foreground wait. It runs immediately when a
visible client becomes connected and at most once per minute while visible;
background, offline, and already-recent signed activity suppress it. The user
may also choose `Check live status`. If no signed reply arrives within 30 seconds,
the first miss is presented as `Gateway reply delayed`: it is a
warning that may still be caused by wake-up or Matrix latency, not proof of a
Gateway fault. A second consecutive miss becomes `Gateway needs attention`,
identifies the named Gateway computer as the component to inspect, and explains
that repeated checks cannot repair a startup failure. The recovery disclosure
provides the local restart command, bounded Gateway log paths, and a client
diagnostic export; it also states that the client report cannot replace logs
from a Gateway that is failing before it can reply. An
unanswered manual `gateway.update.status` is safe to retire because it is strictly
read-only; Android preserves an idempotency tombstone, and a newer status probe
for the same project atomically retires older unfinished probes. No other MLP/3
command gains this exception: unfinished session, Prompt, cancel, update-stage,
and update-apply commands remain durable until an authenticated terminal result
or an existing authoritative retirement rule applies.

If a foreground status command lacks a signed result, the UI keeps that exact
command identity and may reconcile it with exponential backoff starting at 60
seconds, capped at five minutes. Hiding the client or losing the network stops
those attempts. Repeated foreground actions do not emit a second reconciliation
while that command is already in flight or cooling down.

When a signed reply does arrive with `failed`, `rolled_back`, or
`repair_required`, the panel
shows that as an update error instead of the generic `Online now` state, retains
the supervisor's signed detail, and offers only recovery steps that can change
the result. Prompt/artifact downloads automatically retry bounded network,
408, 425, 429, and 5xx failures. If those attempts are exhausted, the client
offers a later retry. HTTP 404, invalid publication/signature, omitted or
reclassified state, candidate validation, integrity, and rollback failures do
not expose a same-release retry; the client offers diagnostic export and a
bug-report link. The exact failure emitted by an older supervisor for newly
introduced protected state is identified separately: the panel says the
current Gateway is unchanged and gives the local external-bootstrap
requirements instead of offering a retry that cannot succeed.
`repair_required` exposes local repair guidance, not update retry. A genuinely
new immutable release remains actionable after an older failure. Connection
diagnostics include bounded per-node liveness timestamps,
consecutive no-reply counts, and update phase/build identifiers without
exporting credentials or unstructured Gateway errors.

The maintenance session is transaction-owned state, not ordinary conversation
history. Neither a client nor the Gateway may archive the session while the
supervisor reports an active, staged, transiently retryable, or repair-required
update. A client may automatically archive only the exact maintenance session
named by a signed `committed` or `rolled_back` supervisor status. `idle` is not
a terminal boundary because it may be an older cached snapshot from before the
maintenance session appeared. Each signed status snapshot permits at most one
automatic cleanup attempt, so a rejected cleanup cannot become a Matrix command
loop. Legacy maintenance IDs and deterministic failed sessions remain visible
for explicit diagnosis and cleanup. The client rechecks signed live status
immediately before manual cleanup and the Gateway enforces the same rule before
changing session lifecycle.

## Agent-safe candidate completion

The maintenance Agent is never allowed to execute a candidate Gateway,
supervisor, MCP, or recovery entrypoint. Those programs are production
entrypoints, not validation commands; changing cwd or adding `--help` does not
clear inherited `MALINK_*` state. The signed Prompt gives the Agent one exact
`gatewayAgentUpdateCli.js finish` command. That owner-only command asks the
independent supervisor to copy and inspect the candidate, parse every JavaScript
entrypoint with the trusted Gateway Host runtime's non-executing `--check`
mode, hash-seal the result, and transition it to `staged`.

Before Matrix login or any replay/journal file is opened, the Gateway first
probes the configured admin socket for a live older Gateway and then acquires
`gateway-instance.lock` inside its production data directory. The legacy socket
probe protects the first upgrade from releases that predate the lock. The lock
is atomically published with its owner PID. A second live process fails closed
before it can read or append production state; a later process may quarantine a
stale lock only after the recorded owner PID is no longer alive.

## Duplicate-terminal journal recovery

This procedure applies only before the JSONL-to-SQLite migration. If an older
release has already allowed two processes to append terminal results for one
command, use the repair CLI from the matching release or exact source checkout.
`diagnose` is read-only. `recover` performs one bounded
operation: it stops the named
LaunchAgent, rechecks the journal, acquires the data-directory lock, writes a
byte-for-byte backup, removes only later terminal/delivery pairs whose first
terminal was already durably delivered, writes a JSON audit record, restarts
the same LaunchAgent, and waits for Matrix-ready admin health.

```sh
pnpm repair:gateway-journal -- recover \
  --data-dir "$HOME/.config/malink/gateway-data" \
  --service-label com.malink.matrix-gateway \
  --launch-agent "$HOME/Library/LaunchAgents/com.malink.matrix-gateway.plist" \
  --supervisor-socket "$HOME/.local/share/malink-matrix/update-supervisor.sock"
```

After Matrix-ready Gateway health is proven, the owner-only supervisor socket
acknowledges the recovery. A target build that is healthy becomes `committed`;
a healthy previous build becomes `rolled_back`, so stale `repair_required`
status cannot survive a successful recovery. Status reads perform the same
bounded reconciliation automatically: they clear `repair_required` only when
the installed build identity matches the failed target or previous build and
the Gateway reports fresh Matrix-ready health. A Gateway that is still down or
returns stale synchronization remains in `repair_required`.

The repair refuses to choose between different terminal results when the first
result was not already delivered. That ambiguity requires manual incident
review; it is never resolved by deleting the newest line or resetting the whole
journal.

After SQLite migration, `diagnose` reports `migrated` with the database and
legacy-source metadata. `recover` refuses to edit JSONL: the file is immutable,
hash-bound migration evidence and no longer active state. SQLite constraints
prevent duplicate terminal transitions in normal operation; database damage
is a separate fail-closed incident and must not be “repaired” by rewriting the
historical JSONL.

Workspace membership and the signed Gateway Directory are inventory, not
presence. The main Gateway card, computer filter, and Settings therefore keep a
separate status for every stable `gatewayNodeId`. A fresh signed status reply is
shown as `Online now`; that proof expires after 90 seconds instead of remaining
green indefinitely. A request accepted by Matrix without a signed reply becomes
`Not responding`, while a route or capability mismatch is shown as `Live check
unavailable`. While a connected client page is visible, Malink rechecks before
the 90-second proof expires. Any newer signed Agent/session activity from that
node also refreshes the proof, and a delayed status timeout cannot overwrite
that newer evidence with an offline state. Manual status refresh remains
available per node.
This visibility does not turn liveness into execution authority or a global
write lock: ordinary authenticated commands remain durable and may wait for an
offline Gateway to return.

The directory's build ID is also only a discovery hint. Once a signed
`gateway.update.status` reply arrives, its installed build is authoritative for
that check and immediately corrects the node's displayed current/target state.
Each Gateway owns its own directory descriptor: relayed copies from another
node cannot replace that local runtime description merely by carrying a newer
timestamp, and an online Gateway periodically republishes its actual build and
routes so stale inventory converges without a restart.

The `Gateway software` row remains visible whenever App & updates is available.
Gateway release discovery resolves
`gateway-agent-updates/channels/stable.json` below the compiled static-service
base path. Root-hosted services therefore use
`/gateway-agent-updates/channels/stable.json`, while a GitHub Pages deployment
at `/malink/` uses
`/malink/gateway-agent-updates/channels/stable.json`.
Release discovery, Gateway Directory projection, and live node status are shown
as separate states instead of hiding the entry. A primary action is rendered
only when it can change the blocking state: discovery failures can retry release
discovery, disconnected clients can reconnect Matrix, and an available release
can open the management panel. When Matrix is already connected but no Gateway
Directory has arrived, the UI explains that a Gateway must be brought online and
that projection will resume automatically; it does not present a no-op reconnect
or status-check button.

`stage` now progresses through:

```text
staging -> agent_required -> agent_running -> agent_validating -> staged
```

The PWA then sends `apply`, which progresses through:

```text
waiting_for_idle -> scheduled -> activating -> probation -> committed
```

Malink polls signed status during nonterminal maintenance and activation phases
even after the panel is closed. The current client automatically continues a
`staged` checkpoint only when its persisted user intent matches the exact
project, node, release, and build. An older staged checkpoint without that
intent exposes `Continue update`, even if the static release channel has since
advanced. If the supervisor finds
that the signed installed build already equals its target while an older state
still says `agent_running`, `agent_validating`, or `staged`, it atomically
converges that state to `committed`; the UI then treats the update as installed
instead of presenting obsolete maintenance cleanup as a blocking error.

The maintenance Agent's session is deterministic per physical Gateway node and
release: its identity is derived from `gatewayNodeId`, never the shared
Workspace `gatewayId`. Two nodes updating the same release therefore cannot
collide. Legacy Workspace-scoped IDs are not rewritten. Current clients select,
open, restore history for, and archive them by `projectId + sessionId`; the old
scalar browser selection is read as a compatibility fallback and dual-written
alongside the exact route. Cleanup on one Gateway cannot mark or command the
other one. Users never enter
a release ID or manually transfer Gateway credentials or artifacts.

## Recovery

- `failed`: the active release was not changed. Transient delivery failures
  have already received bounded automatic retries and may be tried later.
  Deterministic failures require diagnostics and a corrected immutable release,
  not the same command again; their maintenance session may be archived.
- `rolled_back`: the candidate failed health or probation and the previous
  release is running.
- `repair_required`: activation and safe rollback could not be proven. Preserve
  the inbox, journal, Matrix crypto store, supervisor state, Agent workspace,
  release directories, and logs for local diagnosis. Once the installed target
  or previous build returns with fresh Matrix-ready health, the supervisor
  converges automatically. The same update request is not a repair action.

Quarantined inbox records are retained evidence of invalid or unsupported
Matrix events and are never silently deleted during update.
