# Unattended macOS Gateway access

Malink supports a locally built, unsigned distribution on macOS without
requiring an Apple Developer ID. The one-time setup creates an ad-hoc signed
background application at:

```text
~/Applications/Malink Gateway Host.app
```

The app gives macOS a stable application identity for Transparency, Consent,
and Control (TCC). Its main executable is a fixed, self-contained Node runtime;
online Gateway releases remain outside the app and are passed to that runtime
as JavaScript entrypoints. Updating the Gateway therefore does not replace the
identity to which Full Disk Access was granted.

This is the supported self-hosted setup for unattended remote use. Running a
release's `runtime/node` directly from a changing release directory is not:
macOS may identify it as `node`, display a protected-folder prompt on the local
desktop, and leave a remote request waiting for consent that nobody can answer.

## One-time local setup

Run the update-supervisor installer while local desktop access is available.
It creates or validates the Host app first, then executes a short filesystem
probe as that app. The default probe target is `~/Documents`:

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

On a Mac where access has not been granted, the first run is expected to stop
with `local_permission_required`. It stops before changing or restarting either
LaunchAgent, so the existing Gateway keeps running.

Open **System Settings > Privacy & Security > Full Disk Access**, add
`Malink Gateway Host.app`, and enable it. Then run the same installer command
again. This time the Host preflight must succeed before the installer changes
the Gateway and supervisor LaunchAgents to use the Host executable.

For a Gateway whose important data is on another local or mounted volume, add
one or more explicit probes:

```sh
  --gateway-host-preflight-path /absolute/project/path \
  --gateway-host-preflight-path /Volumes/Work/projects
```

macOS requires a local user or an authorized device-management policy to grant
Full Disk Access. Malink cannot safely click through, write, or bypass the TCC
database. Per-folder consent can work for a fixed folder, but Full Disk Access
is the mature option for a self-hosted Gateway that must create projects and
run Agents in changing locations while nobody is at the Mac.

## Verification

After installation, verify the app signature, LaunchAgent executable, running
Gateway, and every configured project directory:

```sh
pnpm doctor:gateway-host -- \
  --gateway-admin-socket "$HOME/.malink/gateway/admin.sock"
```

To verify a location before it is in the project catalog, repeat `--path`:

```sh
pnpm doctor:gateway-host -- \
  --gateway-admin-socket "$HOME/.malink/gateway/admin.sock" \
  --path "$HOME/Documents" \
  --path /Volumes/Work/projects/existing-project
```

The doctor is successful only when the LaunchAgent uses the Host and every
probe reports `ready`. `missing` or `not_directory` is a path/configuration
problem. `denied` or `timeout` means local macOS consent still blocks reliable
remote operation.

At runtime, project creation, project-scoped session creation, prompts, and
provider-history operations run a killable child-process preflight. A TCC stall
is terminated after the configured deadline instead of blocking the Gateway's
Matrix command chain. The remote command receives
`local_permission_required`, tells the user to grant access to Malink Gateway
Host, and can be retried after local remediation.

## Security and lifecycle

Full Disk Access is intentionally broad. Any code executing inside the Gateway
Host—including a configured Agent working under the user's authority—can reach
files available to that macOS account. Only pair trusted devices, keep provider
and release credentials private, and do not install untrusted Gateway code.

The Host is ad-hoc signed for self-hosted use and contains only the fixed Node
runtime, stable metadata, the V8 JIT entitlement, and disabled library
validation so Node can load Malink's signed native Matrix encryption module.
It does not enable Node's development debugger or DYLD environment access.
Installation validates its signature and executes JavaScript through it before
any service switch. An existing valid Host is reused byte-for-byte; normal
online updates must never overwrite it. A future Host/runtime-format upgrade
is an explicit local migration and may require granting Full Disk Access again.
