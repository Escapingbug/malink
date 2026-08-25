# Malink

Malink is a secure, multi-device workspace for controlling ACP-compatible
coding agents remotely. A Gateway runs next to the agent and project files;
browser and Android clients communicate with it through a private Matrix
transport and Malink's signed, application-encrypted protocol (MLP/3).

The project is under active development. Its current product surface is the
Matrix Gateway, the online-updated PWA, and the first-party Android host. The
older Telegram channel remains in the repository only while shared runtime
pieces are extracted; it is not the target product architecture.

## Product shape

- **Local execution:** agents, provider credentials, and project files stay on
  the Gateway machine.
- **Durable multi-device conversations:** Matrix provides encrypted transport,
  synchronization, room/thread history, and media storage.
- **Application-level authorization:** MLP/3 signs commands and Gateway output,
  encrypts sensitive payloads, and rejects replayed or revoked-device actions.
- **Web and Android clients:** the PWA works independently in a browser; the
  Android foreground service keeps synchronization, projection, and task
  notifications alive while the UI is backgrounded.
- **ACP providers:** the shared semantic runtime supports OpenCode, CodeBuddy,
  Cursor Agent, and Codex ACP adapters.
- **Optional privileged execution:** a separately installed local helper can
  execute narrowly approved administrator commands without giving the Matrix
  transport or web UI general root access.

See [the architecture](docs/architecture.md),
[the MLP/3 specification](docs/malink-protocol.md), and
[the security threat model](docs/security-threat-model.md) before changing the
transport or trust boundaries.

## Repository layout

```text
apps/pwa/          Browser client and Android-hosted UI
clients/android/   Native Android host and background Matrix runtime
packages/          Shared protocol, security, and native-bridge packages
src/               Gateway, semantic runtime, providers, and transitional channels
scripts/           Local Gateway, release, and end-to-end workflows
deploy/            Matrix, PWA, and native-update deployment assets
docs/              Architecture, protocol, security, and operations documentation
```

## Requirements

- Node.js 22.13 or newer
- pnpm 11.9 (the repository pins the expected version)
- A supported ACP provider command for real agent sessions
- Docker for the local Synapse development environment
- JDK 17 and Android SDK API 36 only when building the Android client

## Install and verify

```bash
git clone git@github.com:Escapingbug/malink.git
cd malink
corepack enable
pnpm install
pnpm typecheck
pnpm test
pnpm build:workspace
```

Run the PWA locally:

```bash
pnpm --dir apps/pwa dev
```

## Provider configuration

Provider launch commands are configurable in `~/.config/malink/providers.json`.
For example, a packaged Codex ACP adapter can be selected without `npx`:

```json
{
  "defaultProvider": "codex",
  "providers": [
    {
      "id": "codex",
      "type": "codex",
      "command": "/absolute/path/to/codex-acp",
      "args": [],
      "env": {
        "CODEX_PATH": "/absolute/path/to/codex",
        "INITIAL_AGENT_MODE": "agent-full-access",
        "CODEX_CONFIG": "{\"approval_policy\":\"never\",\"sandbox_mode\":\"danger-full-access\"}"
      },
      "modelsCommand": "/absolute/path/to/codex",
      "modelsArgs": ["debug", "models"]
    }
  ]
}
```

When no command is configured, Malink uses `codex-acp` from `PATH` when
available and falls back to `npx -y @agentclientprotocol/codex-acp` otherwise.

`codex-acp` owns an ACP session mode in addition to Codex's user configuration.
Set `INITIAL_AGENT_MODE=agent-full-access` when Malink's Full access permission
mode must match `approval_policy=never` and `sandbox_mode=danger-full-access` in
`~/.codex/config.toml`. `CODEX_PATH` selects the same Codex executable used by
the terminal, while `CODEX_CONFIG` explicitly mirrors those settings into the
adapter's Codex session configuration.

The local Matrix environment and Gateway require generated development
credentials. Follow [the local Matrix guide](dev/matrix/README.md), then run:

```bash
pnpm dev:matrix-gateway
```

The first Gateway launch prints a QR code, a six-digit verification code, and
a pasteable `malink://pair` link. Pairing and device trust are documented in
[the Gateway pairing guide](docs/pairing-gateway.md).

## Common commands

```bash
pnpm typecheck             # Gateway and shared TypeScript checks
pnpm test                  # Gateway/unit and protocol integration tests
pnpm build:workspace       # Build every workspace package and the PWA
pnpm test:workspace        # Run package and PWA test suites
pnpm test:e2e:matrix-mlp3-live
pnpm test:e2e:alpha-live   # Opt-in real Matrix + Android acceptance gate
```

Android build and live-device requirements are documented in
[clients/android/README.md](clients/android/README.md). Production Matrix and
native-update deployment notes live under [`deploy/`](deploy/).

## Architecture boundary

```text
PWA or Android service
  -> signed/encrypted MLP/3 command
  -> Matrix project room and session thread
  -> Malink Gateway
  -> SemanticSessionRuntime
  -> ACP provider
  -> ConversationEvent
  -> signed/encrypted MLP/3 event
  -> Matrix timeline
  -> verified local client projection
```

Matrix is durable transport, not execution authority. Only commands signed by
a currently certified Malink device and accepted by the Gateway journal may
change local execution state.

## Project status

Malink is pre-release software. Protocol and persisted-state changes must follow
the migration rules in [docs/state-upgrades.md](docs/state-upgrades.md), and a
release that changes the secure vertical slice must pass the acceptance process
in [docs/real-matrix-testing.md](docs/real-matrix-testing.md).
