# Private Matrix transport

This is a private, non-federating Matrix homeserver. Synapse supplies identity,
Olm/Megolm encryption, durable sync, timeline history and media storage. It is
not trusted to authorize Gateway execution: each command additionally carries
a short-lived COSE/CWT token signed by a Gateway-pinned Malink control root.

```sh
chmod +x bootstrap.sh
sudo ./bootstrap.sh
docker compose -f compose.server.yml up -d
chmod +x provision-workspace-accounts.sh
sudo ./provision-workspace-accounts.sh
```

Place `Caddyfile.fragment` inside the existing HTTPS site block before its
fallback handler, validate, then reload Caddy. Only Matrix client routes are
proxied; federation routes are not exposed.

For the current Malink server layout this can be applied idempotently with:

```sh
chmod +x install-caddy-route.sh
sudo ./install-caddy-route.sh
```

The provisioning step creates two intentionally distinct accounts:

- `malink_gateway` is shared only by Gateway nodes, with one Matrix device per
  Gateway.
- `malink_client` is shared by all PWA and Android clients, with one Matrix
  device per physical client.

It also writes the owner-only `secrets/client-login.json` session used solely
to request short-lived login tokens for authorized device invitations. The
script prints the exact Gateway environment variables; no client password or
long-lived access token belongs in the PWA, Android app, invitation link, or QR.
Rerunning the script preserves the existing issuer session unless
`MALINK_MATRIX_FORCE_CLIENT_SESSION=1` is explicitly set.

## One-time device login

The generated Synapse configuration enables `login_via_existing_session` for
Malink's one-time device invitations. The homeserver is private and dedicated
to Malink, and the login token expires after five minutes and can be used only
once. Existing Matrix access tokens remain server-side and are never placed in
an invitation link or QR code.

After changing the template, regenerate `data/homeserver.yaml` and restart
Synapse:

```sh
sudo ./bootstrap.sh
docker compose -f compose.server.yml up -d synapse
```

An authenticated `GET /_matrix/client/v3/capabilities` response should then
report `m.get_login_token.enabled: true`. This capability is required for new
Malink client devices. Malink no longer falls back to an arbitrary Matrix
username/password login; if token issuance is unavailable, invitation creation
fails without changing the receiving device.

Public registration remains disabled. Back up `data/`, `secrets/`, and the
PostgreSQL volume. Never commit generated secrets.

Gateway and client setup, trust boundaries, and execution-root approval are
documented in [`../../docs/architecture.md`](../../docs/architecture.md) and
[`../../docs/privileged-execution.md`](../../docs/privileged-execution.md).
