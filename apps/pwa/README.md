# Malink PWA

This package contains Malink's browser client and the web UI loaded by the
first-party Android host. Both surfaces use the same presentation and command
model; transport ownership differs after native capability negotiation.

The production result is a pure static site. `pnpm build` writes HTML, CSS,
JavaScript, WASM, the Web App Manifest, Service Worker, `version.json`, and a
GitHub Pages-compatible `404.html` to `dist/`. There is no PWA application
server, server-side rendering, database, invitation relay, or runtime API.
Matrix remains the durable data plane and is contacted directly by the browser
or by the Android native service.

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

The application requires Node.js 22.13 or newer. Node and Vite are build-time
tools only; a production host only needs to serve `dist/` over HTTPS.

For a path-based host such as GitHub Pages, set the public base path while
building:

```bash
MALINK_PWA_BASE_PATH=/malink/ pnpm --dir apps/pwa build
```

The host should serve `index.html` for unknown application paths, avoid caching
`index.html`, `404.html`, `version.json`, and `sw.js`, and cache hashed files in
`assets/` immutably. Pairing invitations are now self-contained fragment URLs;
the fragment never reaches the static host. If an unusually large invitation
cannot fit in one QR code, the UI asks the user to copy or share the full link.

An Android-selectable static service may also publish APK discovery under the
same base URL:

```text
native-updates/channels/alpha/client-release.json
```

The immutable APK can either remain under
`native-updates/releases/android/alpha/<versionCode>/` on that service or use
the fixed-version `Escapingbug/malink` GitHub Release URL accepted by the native
updater. This lets GitHub Pages host only the small manifest rather than the APK.

See [native update deployment](../../deploy/native-update/README.md) for the
acceptance and signing rules.

See the repository [architecture](../../docs/architecture.md),
[MLP/3 protocol](../../docs/malink-protocol.md), and
[state-upgrade rules](../../docs/state-upgrades.md).
