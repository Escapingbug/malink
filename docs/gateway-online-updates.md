# Gateway online updates

Gateway updates are designed for installations that may be reachable only
through Malink. The update owner is a separate launchd service, so replacing or
crashing the Gateway process does not remove the component that can restore the
previous release.

Publication is intentionally manual. There is no CI requirement, latest-release
channel, or Gateway polling loop. The operator uploads one immutable signed
release, then deploys a PWA build containing that exact release ID and build ID.
The new PWA triggers one authenticated update attempt per older Gateway node.

## Availability contract

The default drain-and-switch mode (named `when_idle` on the wire for protocol
compatibility) provides these guarantees:

- Matrix `/sync` events are written to the Gateway inbox before its sync cursor
  is committed. A restart may replay an event but cannot skip a cursor-accepted
  command.
- The Gateway closes its business-command execution gate as soon as apply is
  accepted. Work that was already running may finish, but later commands are
  journaled and queued instead of starting, so a continuous stream of new work
  cannot postpone the switch forever.
- New Matrix events continue entering the durable inbox while the old Gateway
  drains. The replacement Gateway resumes queued commands exactly once after
  it owns the Matrix crypto store and sync cursor.
- The PWA remains connected to Matrix while the Gateway process changes. The
  affected node is briefly unavailable, but the application connection, queued
  commands, and verified client projection remain intact.
- The binary switch is one atomic `current` symlink rename. launchd always
  starts `current/runtime/node current/ops/matrix-local-gateway.js`.
- A release is committed only after the expected build ID reports `running`,
  Matrix has completed a fresh sync, the durable inbox is readable, and the
  probation interval remains healthy. By default Matrix must keep completing
  sync cycles within a 45-second freshness window during the 60-second
  probation.
- Failed activation restores the previous symlink and restarts that release.
  If rollback cannot be proven healthy, status becomes `repair_required` and
  automatic switching stops.
- After commit, launchd reloads the independent supervisor from the new
  `current` release as well; the Gateway remains running during that reload.

A coding-agent process cannot migrate an in-flight ACP turn across a binary
restart. Apply therefore first blocks new work from starting, then waits only
for turns that were already active to complete. The protocol also defines
`force`, which cancels active turns before switching, but the product UI
intentionally does not offer it as the normal remote path.

## Trust and release format

Remote clients never provide an artifact URL. They can name only a release ID.
The supervisor downloads `<manifest-base>/<release-id>.json`, requires HTTPS
(loopback HTTP is test-only), verifies an ES256 signature against the locally
pinned release key, and then downloads only the exact files in that manifest.

Every file has a normalized relative path, exact byte count, SHA-256 digest,
and executable bit. Symlinks, path traversal, cross-origin artifacts, mutable
release IDs, oversized manifests, and releases for another CPU are rejected.
The Node runtime, Gateway entrypoint, and independent supervisor entrypoint are
fixed mandatory paths, so a release cannot commit while silently removing its
own future update/recovery mechanism.
Manifest fetches time out after 30 seconds and each artifact after 10 minutes
by default; the Gateway-to-supervisor command window is 30 minutes so a valid
large download is not reported as failed while it is still being verified.
The release contains its complete persistent-state catalog. Automatic
activation rejects any security-critical or durable-command schema change,
or the addition of a protected store unknown to the current release, because
an old binary could not safely resume that state after rollback. The
supervisor activation journal and pinned release signer are themselves
protected catalog entries. Such migrations require a separately designed
forward-only maintenance procedure.

The release signing private key is a deployment secret and must not be copied
to a Gateway. A Gateway stores only `release-signer.json`, the public key pinned
during local supervisor installation.

## Release directory

A prepared release is self-contained and has at least:

```text
prepared/
  runtime/node
  ops/matrix-local-gateway.js
  ops/gatewayUpdateSupervisorMain.js
  node_modules/                    # production dependencies required by the bundle
```

Build the two bundled entry points with `pnpm build`. Copy a real Node runtime,
the two `dist/ops` files, and dereferenced production dependencies into the
prepared directory. Do not leave pnpm symlinks in it: the release publisher
rejects symlinks by design. Run the prepared Gateway locally against a test
Matrix account before signing it.

Create the release key once, preferably on an offline signing machine:

```sh
pnpm generate:gateway-release-key -- \
  --private-key /secure/malink-gateway-release-private.json \
  --public-key ./release-signer.json
```

Publish an immutable release tree:

```sh
pnpm release:gateway-update -- \
  --source ./prepared \
  --out ./dist/gateway-update \
  --release-id 2026.08.26.1 \
  --version-name 0.2.0 \
  --build-id gateway-2026.08.26.1-arm64 \
  --base-url https://rd.anciety.my.id/gateway-updates/ \
  --private-key /secure/malink-gateway-release-private.json
```

Upload `dist/gateway-update` without changing its paths or contents. Configure
the supervisor manifest base as
`https://rd.anciety.my.id/gateway-updates/manifests/`. Re-running the publisher
with the same release ID succeeds only when every byte and the signed manifest
are identical. The Caddy route and manual deployment order are documented in
`deploy/gateway-update/README.md`.

## One-time local installation

The currently active release must already contain the supervisor entry point.
Install and pin the supervisor while local recovery access is available:

```sh
pnpm install:gateway-update-supervisor -- \
  --install-root "$HOME/Library/Application Support/Malink/gateway" \
  --gateway-launch-agent "$HOME/Library/LaunchAgents/io.malink.gateway.plist" \
  --gateway-service-label io.malink.gateway \
  --gateway-admin-socket "$HOME/Library/Application Support/Malink/gateway/admin.sock" \
  --current-build-id gateway-initial-arm64 \
  --manifest-base-url https://rd.anciety.my.id/gateway-updates/manifests/ \
  --signer-file ./release-signer.json
```

Installation creates an owner-only supervisor socket and LaunchAgent, pins the
public signer, starts the supervisor first, and reloads the Gateway LaunchAgent
with `MALINK_GATEWAY_UPDATE_SOCKET`. This is the only planned setup restart.
If `current/release-manifest.json` already exists, the installer verifies it
against the pinned signer and derives its build ID; omit `--current-build-id`
in that case. A legacy baseline without a signed manifest must supply the
argument so even the first rollback proves that the intended build returned.
Changing the pinned signer is deliberately refused; key rotation requires an
explicit offline migration and recovery plan.

## PWA-triggered operation

Build the manually deployed PWA with the immutable Gateway release identity:

```sh
MALINK_BUILD_VERSION=2026.08.26.2 \
MALINK_GATEWAY_RELEASE_ID=2026.08.26.2 \
MALINK_GATEWAY_BUILD_ID=gateway-2026.08.26.2-arm64 \
pnpm --dir apps/pwa build
```

Both Gateway variables must be present or absent together. A PWA without them
does not trigger Gateway updates. After the new PWA connects, it reads each
node's current build and update capability from the root-signed Gateway
Directory. For every reachable node whose build differs, it sends one stage
command through a project owned by that node, verifies the staged build ID,
and schedules drain-and-switch activation (`when_idle` on the wire). Multiple
PWA devices may observe the new release concurrently; the local supervisor
deduplicates the same staged or scheduled release.

The browser records its attempt before sending so a bad artifact cannot cause
an update loop. Failure remains visible in Connection → Advanced diagnostics,
where the operator can retry the same release manually after correcting the
problem. Manual status, download, and apply controls remain available there.

The signed/encrypted MLP/3 operations are `gateway.update.stage`,
`gateway.update.apply`, and `gateway.update.status`. Their certificate grant is
`gateway.update`; the grant authorizes activation only of releases signed by
the pinned local release key.

## Recovery

- `failed`: staging did not alter `current`; correct the release or network and
  retry with a new immutable release ID.
- `rolled_back`: the new build failed health/probation and the previous build is
  running. Inspect supervisor and Gateway logs before trying another release.
- `repair_required`: neither normal activation nor safe rollback was proven.
  Do not delete the inbox, command journal, Matrix crypto store, supervisor
  state, or release directories. Use local access to inspect
  `supervisor-state.json`, both LaunchAgent logs, the `current` symlink, and the
  admin socket before making a manual switch.

Quarantined inbox records are evidence of invalid or unsupported Matrix
events. They are retained and reported by deep health diagnostics; they are not
silently deleted during an update.
