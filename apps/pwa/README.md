# Malink PWA

This package contains Malink's browser client and the web UI loaded by the
first-party Android host. Both surfaces use the same presentation and command
model; transport ownership differs after native capability negotiation.

## Runtime modes

- **Browser:** the PWA owns Matrix synchronization, encrypted local state, the
  durable command outbox, and the verified MLP/3 projection in IndexedDB.
- **Android host:** the native foreground service owns Matrix credentials,
  synchronization, trust, commands, projection, and notifications. The WebView
  accesses that state through the versioned native bridge.

The UI must never start a second Matrix client after native ownership has been
established. Matrix events are persisted before projection, and the UI reads
only the verified local projection.

## Development

From the repository root:

```bash
pnpm install
pnpm --dir apps/pwa dev
```

Build, test, and lint this package with:

```bash
pnpm --dir apps/pwa build
pnpm --dir apps/pwa test
pnpm --dir apps/pwa lint
```

The application requires Node.js 22.13 or newer. `vite.config.ts` supplies
local stand-ins for the bindings declared in `.openai/hosting.json`; the
production data plane remains Matrix and does not depend on those bindings.

See the repository [architecture](../../docs/architecture.md),
[MLP/3 protocol](../../docs/malink-protocol.md), and
[state-upgrade rules](../../docs/state-upgrades.md).
