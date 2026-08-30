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

- The public site owns discovery. `latest.json` tells clients that a version is
  available; `releases/<release-id>.json` is the immutable signed Prompt.
- PWA and Android WebView clients discover the same `latest.json`, compare its
  build ID with every node in the signed Gateway Directory, and send normal
  authenticated MLP/3 update commands through a project owned by that node.
- The Gateway owns the maintenance Agent session. It supplies only the exact
  signed repository, commit, Prompt, isolated workspace, and supervisor submit
  command. The session uses the Gateway's configured project provider and is
  visible in the ordinary session model.
- The maintenance Agent owns Git checkout, dependency/runtime preparation,
  build, test, and candidate assembly. It never owns activation.
- The launchd supervisor owns the pinned ES256 public key, Prompt verification,
  state-compatibility check, candidate copy and local SHA-256 seal, atomic
  switch, deep Matrix health checks, probation, and rollback.

The release signing private key stays off Gateways. A Matrix server or web site
cannot make a Gateway execute an unsigned Prompt. An Agent cannot activate an
unsealed candidate, and changing its candidate after submission cannot change
the staged release.

## Network behavior

For each update a Gateway downloads only one JSON Prompt (bounded to 128 KiB)
plus the Git objects and genuinely changed dependencies needed by the exact
commit. The active Node runtime and unchanged production files are copied
locally with copy-on-write when supported. Node is downloaded only when the
target source requires a newer runtime; the Agent verifies the official
runtime checksum and stores the executable inside the release.

The old signed-manifest/artifact flow remains as a compatibility path when no
Agent Prompt base URL is configured. It is not the primary release channel.

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
- Failed activation restores the previous symlink and restarts the previous
  release. If rollback cannot be proven, the supervisor enters
  `repair_required` and stops automatic switching.
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

Automatic activation rejects protected state schema changes and new
security-critical or durable-command stores that the previous release could
not resume. Such changes require a separately designed forward-only migration.

The Agent-built candidate must contain regular files at:

```text
runtime/node
ops/matrix-local-gateway.js
mcp/stdio.js
ops/gatewayUpdateSupervisorMain.js
ops/gatewayAgentUpdateCli.js
```

It must be self-contained and contain no symlinks. The supervisor rejects
reserved release metadata, empty required entrypoints, special files, more than
10,000 files, or more than 1 GiB. Empty regular dependency files are permitted
and covered by the release seal. On submission the supervisor copies the
candidate into an immutable release directory and records every path, byte
count, executable bit, and SHA-256 digest in `release-seal.json` alongside the
signed `release-prompt.json`. It verifies that seal again immediately before
apply.

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

The publisher refuses to replace an immutable release file. Upload the version
file first and atomically replace `latest.json` last. Server routing and the
complete order are in `deploy/gateway-agent-update/README.md`.

The PWA checks `latest.json` on load, every 15 minutes, and whenever it becomes
visible. A newly published version therefore reaches both browser and Android
clients without rebuilding either client. Each client records one attempt per
Gateway and version; the supervisor independently deduplicates concurrent
requests from multiple clients.

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
  --agent-prompt-base-url https://rd.anciety.my.id/gateway-agent-updates/releases/ \
  --signer-file ./release-signer.json
```

Installation pins the public signer, starts the independent supervisor first,
and then reloads the Gateway with its owner-only socket. If the active release
contains a valid signed `release-prompt.json` or legacy
`release-manifest.json`, the installer verifies it and derives the build ID;
otherwise the first installation needs `--current-build-id` so rollback can
prove the baseline returned. Signer rotation remains an explicit offline
migration.

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
notice, and its review panel identifies the exact Gateway name, stable short
node ID, current build, target build, and update capability. Opening the panel
sends a read-only `gateway.update.status` command to each routed capable node;
only a recent signed terminal reply is shown as `Online now`. A connected
Matrix client or an old cached snapshot is not Gateway liveness. The user then
confirms one exact node, which sends `stage` and creates the visible maintenance
Agent session for that Gateway and release. Multiple nodes are updated as
separate confirmed operations so it is always clear which node is executing.

The live check has a bounded foreground wait. If no signed reply arrives within
12 seconds, the first miss is presented as `Live check timed out`: it is a
warning that may still be caused by wake-up or Matrix latency, not proof of a
Gateway fault. A second consecutive miss becomes `Gateway needs attention`,
identifies the named Gateway computer as the component to inspect, and explains
that repeated checks cannot repair a startup failure. The recovery disclosure
provides the local restart command, bounded Gateway log paths, and a client
diagnostic export; it also states that the client report cannot replace logs
from a Gateway that is failing before it can reply. An
unanswered `gateway.update.status` is safe to retire because it is strictly
read-only; Android preserves an idempotency tombstone, and a newer status probe
for the same project atomically retires older unfinished probes. No other MLP/3
command gains this exception: unfinished session, Prompt, cancel, update-stage,
and update-apply commands remain durable until an authenticated terminal result
or an existing authoritative retirement rule applies.

When a signed reply does arrive with `failed` or `repair_required`, the panel
shows that as an update error instead of the generic `Online now` state, retains
the supervisor's signed detail, and offers recovery steps appropriate to that
phase. If that exact node is answering and a signed release is available, the
panel keeps a primary retry action even when an earlier maintenance session ID
exists. The new attempt rechecks the node and lets the supervisor replace the
interrupted update state; an obsolete session must never hide the recovery
entry point. Connection diagnostics include bounded per-node liveness timestamps,
consecutive no-reply counts, and update phase/build identifiers without
exporting credentials or unstructured Gateway errors.

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

If an older release has already allowed two processes to append terminal
results for one command, use the repair CLI from the matching release or exact
source checkout. `diagnose` is read-only. `recover` performs one bounded
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

Workspace membership and the signed Gateway Directory are inventory, not
presence. The main Gateway card, computer filter, and Settings therefore keep a
separate status for every stable `gatewayNodeId`. A fresh signed status reply is
shown as `Online now`; that proof expires after 90 seconds instead of remaining
green indefinitely. A request accepted by Matrix without a signed reply becomes
`Not responding`, while a route or capability mismatch is shown as `Live check
unavailable`. Malink checks once after each Matrix client start and when the app
returns to the foreground after the prior check is old; it does not create a
continuous Matrix-command heartbeat. Manual retry remains available per node.
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
Gateway release discovery resolves `gateway-agent-updates/latest.json` below the
compiled static-service base path. Root-hosted services therefore use
`/gateway-agent-updates/latest.json`, while a GitHub Pages deployment at
`/malink/` uses `/malink/gateway-agent-updates/latest.json`.
Release discovery, Gateway Directory projection, and live node status are shown
as separate states instead of hiding the entry. A primary action is rendered
only when it can change the blocking state: discovery failures can retry release
discovery, disconnected clients can reconnect Matrix, and an available release
can open the review panel. When Matrix is already connected but no Gateway
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

While the review panel is open, Malink polls signed status during nonterminal
maintenance and activation phases. Reaching `staged` stops automatic polling
and always exposes an explicit install action for that exact staged release,
even if the static release channel has since advanced. If the supervisor finds
that the signed installed build already equals its target while an older state
still says `agent_running`, `agent_validating`, or `staged`, it atomically
converges that state to `committed`; the UI then treats the update as installed
instead of presenting obsolete maintenance cleanup as a blocking error.

The maintenance Agent's session is deterministic per physical Gateway node and
release: its identity is derived from `gatewayNodeId`, never the shared
Workspace `gatewayId`. A retry on one node therefore resumes the same visible
session and supervisor workspace, while two nodes updating the same release
cannot collide. The normal Gateway software panel links to that session and
owns the confirmation and retry actions; advanced diagnostics is not the
product update entry point. Clients refuse to open a legacy maintenance ID if
it is attributed to multiple nodes or project rooms, or if its Workspace-scoped
format is unsafe in a multi-Gateway Workspace. The Gateway software panel can
still archive each legacy session through the named node's exact project route;
the client keys progress and recovery by both `projectId` and `sessionId`, so
cleanup on one Gateway cannot mark or command the other one. Users never enter
a release ID or manually transfer Gateway credentials or artifacts.

## Recovery

- `failed`: the active release was not changed. Inspect the maintenance session
  and supervisor detail, correct the Prompt/commit, and publish a new immutable
  release ID.
- `rolled_back`: the candidate failed health or probation and the previous
  release is running.
- `repair_required`: activation and safe rollback could not be proven. Preserve
  the inbox, journal, Matrix crypto store, supervisor state, Agent workspace,
  release directories, and logs for local diagnosis. Once the installed target
  or previous build returns with fresh Matrix-ready health, the supervisor
  converges automatically; if a signed release is available while the node is
  online, the Gateway software panel also permits a new supervised attempt.

Quarantined inbox records are retained evidence of invalid or unsupported
Matrix events and are never silently deleted during update.
