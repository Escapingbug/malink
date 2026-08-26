# Gateway Agent update publication

The public site publishes one small signed Prompt per Gateway version. It does
not host a complete Node runtime or Gateway dependency tree. Each Gateway uses
its configured coding Agent to build the exact signed Git commit locally, then
the independent supervisor seals, switches, health-checks, and rolls back the
result.

## One-time server route

```sh
chmod +x deploy/gateway-agent-update/install-caddy-route.sh
sudo deploy/gateway-agent-update/install-caddy-route.sh
```

The route exposes immutable version files under
`/gateway-agent-updates/releases/` and serves `/gateway-agent-updates/latest.json`
with `no-store`, so already-open PWA and Android WebView clients can discover a
new version without a client rebuild.

## Publish a version

Use the existing offline Gateway release signing key and the exact pushed Git
commit:

```sh
pnpm release:gateway-agent-update -- \
  --out ./dist/gateway-agent-update \
  --release-id 2026.08.26.4 \
  --version-name 2026.08.26.4 \
  --build-id gateway-2026.08.26.4 \
  --commit "$(git rev-parse HEAD)" \
  --prompt-file deploy/gateway-agent-update/PROMPT.md \
  --private-key /secure/malink-gateway-release-private.json
```

Upload `releases/<release-id>.json` without replacing an existing file. Upload
`release-signer.json` only when initially provisioning the route. Replace
`latest.json` atomically only after the immutable version file is public. The
repository defaults to `https://github.com/Escapingbug/malink.git`; override it
only with another credential-free HTTPS upstream.

Configure each supervisor with:

```text
https://rd.anciety.my.id/gateway-agent-updates/releases/
```

as its Agent Prompt base URL. The PWA polls the mutable `latest.json` pointer,
but a Gateway accepts the release only after downloading the immutable version
file and verifying its ES256 signature against its locally pinned public key.
