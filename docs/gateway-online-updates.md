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
- The binary switch is one atomic `current` symlink rename. launchd always
  starts `current/runtime/node current/ops/matrix-local-gateway.js`.
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
reserved release metadata, empty or special files, more than 10,000 files, or
more than 1 GiB. On submission it copies the candidate into an immutable
release directory and records every path, byte count, executable bit, and
SHA-256 digest in `release-seal.json` alongside the signed
`release-prompt.json`. It verifies that seal again immediately before apply.

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
  --gateway-admin-socket "$HOME/Library/Application Support/Malink/gateway/admin.sock" \
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

## Product flow

The wire operations remain `gateway.update.stage`, `gateway.update.apply`, and
`gateway.update.status`; existing clients and Android native services therefore
need no separate Gateway implementation. Their shared `gateway.update` grant
authorizes only requests—the local pinned signer remains the release authority.

`stage` now progresses through:

```text
staging -> agent_required -> agent_running -> agent_validating -> staged
```

The PWA then sends `apply`, which progresses through:

```text
waiting_for_idle -> scheduled -> activating -> probation -> committed
```

The maintenance Agent's session is deterministic per Gateway and release, so a
retry resumes the same visible session and supervisor workspace. Advanced
diagnostics contains status and a single retry action; users never enter a
release ID or manually transfer Gateway credentials or artifacts.

## Recovery

- `failed`: the active release was not changed. Inspect the maintenance session
  and supervisor detail, correct the Prompt/commit, and publish a new immutable
  release ID.
- `rolled_back`: the candidate failed health or probation and the previous
  release is running.
- `repair_required`: activation and safe rollback could not be proven. Preserve
  the inbox, journal, Matrix crypto store, supervisor state, Agent workspace,
  release directories, and logs for local diagnosis.

Quarantined inbox records are retained evidence of invalid or unsupported
Matrix events and are never silently deleted during update.
