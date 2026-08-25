# Private Matrix transport

This is a private, non-federating Matrix homeserver. Synapse supplies identity,
Olm/Megolm encryption, durable sync, timeline history and media storage. It is
not trusted to authorize Gateway execution: each command additionally carries
a short-lived COSE/CWT token signed by a Gateway-pinned Malink control root.

```sh
chmod +x bootstrap.sh
sudo ./bootstrap.sh
docker compose -f compose.server.yml up -d
```

Place `Caddyfile.fragment` inside the existing HTTPS site block before its
fallback handler, validate, then reload Caddy. Only Matrix client routes are
proxied; federation routes are not exposed.

For the current Malink server layout this can be applied idempotently with:

```sh
chmod +x install-caddy-route.sh
sudo ./install-caddy-route.sh
```

Create initial accounts from the server only:

```sh
docker compose -f compose.server.yml exec synapse \
  register_new_matrix_user --exists-ok --no-admin -u malink \
  --password-file /run/secrets/malink_account_password \
  -c /data/homeserver.yaml http://localhost:8008
```

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
report `m.get_login_token.enabled: true`. If a different homeserver cannot
provide this capability, Malink still creates a Gateway pairing invitation
and asks the receiving device to sign in to Matrix with its account password.

Public registration remains disabled. Back up `data/`, `secrets/`, and the
PostgreSQL volume. Never commit generated secrets.

Gateway and client setup, trust boundaries, and execution-root approval are
documented in [`../../docs/architecture.md`](../../docs/architecture.md) and
[`../../docs/privileged-execution.md`](../../docs/privileged-execution.md).
