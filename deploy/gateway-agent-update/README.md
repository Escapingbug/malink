# Gateway Agent update publication

The public site publishes one small signed Prompt per Gateway version. It does
not host a complete Node runtime or Gateway dependency tree. Each Gateway uses
its configured coding Agent to build the exact signed Git commit locally, then
the independent supervisor seals, switches, health-checks, and rolls back the
result.

## Hosting

GitHub Pages is the primary static host. The published tree is copied below the
site's `gateway-agent-updates/` directory, which exposes:

```text
https://escapingbug.github.io/malink/gateway-agent-updates/channels/stable.json
https://escapingbug.github.io/malink/gateway-agent-updates/releases/<release-id>.json
```

The Caddy route below is optional and exists only when
`rd.anciety.my.id` is retained as a second signed mirror:

```sh
chmod +x deploy/gateway-agent-update/install-caddy-route.sh
sudo deploy/gateway-agent-update/install-caddy-route.sh
```

The route exposes immutable version files under
`/gateway-agent-updates/releases/` and mutable channel files under
`/gateway-agent-updates/channels/` with `no-store`. `latest.json` remains
available for older PWA builds.

## Publish a version

Use the existing offline Gateway release signing key and the exact pushed Git
commit:

```sh
pnpm release:gateway-agent-update \
  --out ./dist/gateway-agent-update \
  --commit "$(git rev-parse HEAD)" \
  --prompt-file deploy/gateway-agent-update/PROMPT.md \
  --private-key /secure/malink-gateway-release-private.json
```

The default signed mirror is GitHub Pages. To publish a transition release on
both hosts, include both URLs in the signed channel:

```sh
  --mirror-base-url https://escapingbug.github.io/malink/gateway-agent-updates/ \
  --mirror-base-url https://rd.anciety.my.id/gateway-agent-updates/
```

By default the release, version, and build identifiers are derived from the
UTC publication timestamp plus the target commit, for example
`2026.08.28-020315Z-12b086d` and
`gateway-2026.08.28-020315Z-12b086d`. Explicit identifier flags are reserved
for compatibility releases.

Publish in this order:

1. Upload `releases/<release-id>.json` without replacing an existing file on
   every mirror named by the new channel.
2. Upload `release-signer.json` only when initially provisioning a host.
3. Fetch and verify every public immutable release URL.
4. Replace `channels/stable.json` with the newly signed document.
5. Replace `latest.json` for older discovery clients.

Never publish the mutable channel before all signed mirrors contain the exact
immutable release. The repository defaults to
`https://github.com/Escapingbug/malink.git`; override it only with another
credential-free HTTPS upstream.

New supervisors bootstrap from:

```text
https://escapingbug.github.io/malink/gateway-agent-updates/channels/stable.json
```

The bootstrap URL is not release authority. A Gateway verifies the channel and
release Prompt with its locally pinned ES256 signer, rejects channel-generation
rollback or equivocation, persists the last verified channel, and fails over
only to mirror URLs contained in that signed document.

For migration, the first release containing channel-aware supervisor code must
remain available through both the old `rd.anciety.my.id` Prompt path and GitHub
Pages. An updated supervisor whose LaunchAgent still names the old Prompt base
will try the official GitHub Pages channel on its next signed update request and
persist it. Retire the old host after every Gateway has installed that bridge
release; its next update can then bootstrap and persist the Pages channel
without contacting the old host.
