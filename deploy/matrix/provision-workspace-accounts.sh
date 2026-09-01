#!/bin/sh
set -eu

if [ "$(id -u)" -ne 0 ]; then
    echo "Run provision-workspace-accounts.sh with sudo to protect Matrix credentials." >&2
    exit 1
fi

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
SECRETS="$ROOT/secrets"
COMPOSE_FILE="$ROOT/compose.server.yml"
HOMESERVER="${MALINK_MATRIX_LOCAL_URL:-http://127.0.0.1:8008}"
SERVER_NAME="${MALINK_MATRIX_SERVER_NAME:-rd.anciety.my.id}"
GATEWAY_USER="${MALINK_MATRIX_GATEWAY_LOCALPART:-malink_gateway}"
CLIENT_USER="${MALINK_MATRIX_CLIENT_LOCALPART:-malink_client}"

if [ "$GATEWAY_USER" = "$CLIENT_USER" ]; then
    echo "Gateway and client Matrix account names must be distinct." >&2
    exit 1
fi
if [ ! -s "$SECRETS/gateway-account-password" ] || [ ! -s "$SECRETS/client-account-password" ]; then
    echo "Run bootstrap.sh before provisioning Workspace accounts." >&2
    exit 1
fi

register_account() {
    user="$1"
    password_secret="$2"
    docker compose -f "$COMPOSE_FILE" exec -T synapse \
        register_new_matrix_user --exists-ok --no-admin -u "$user" \
        --password-file "$password_secret" \
        -c /data/homeserver.yaml http://localhost:8008
}

register_account "$GATEWAY_USER" /run/secrets/gateway_account_password
register_account "$CLIENT_USER" /run/secrets/client_account_password

CLIENT_LOGIN="$SECRETS/client-login.json"
if [ -s "$CLIENT_LOGIN" ] && [ "${MALINK_MATRIX_FORCE_CLIENT_SESSION:-0}" != "1" ]; then
    echo "Keeping existing owner-only client token issuer session: $CLIENT_LOGIN"
else
    TEMPORARY_DIRECTORY="$(mktemp -d "$SECRETS/.account-provision.XXXXXX")"
    trap 'rm -rf "$TEMPORARY_DIRECTORY"' EXIT HUP INT TERM
    chmod 700 "$TEMPORARY_DIRECTORY"
    REQUEST="$TEMPORARY_DIRECTORY/login-request.json"
    RESPONSE="$TEMPORARY_DIRECTORY/login-response.json"
    OUTPUT="$TEMPORARY_DIRECTORY/client-login.json"
    python3 - "$CLIENT_USER" "$SECRETS/client-account-password" "$REQUEST" <<'PY'
import json
import pathlib
import sys

user, password_path, output_path = sys.argv[1:]
password = pathlib.Path(password_path).read_text(encoding="utf-8").strip()
pathlib.Path(output_path).write_text(json.dumps({
    "type": "m.login.password",
    "identifier": {"type": "m.id.user", "user": user},
    "password": password,
    "device_id": "MALINK_CLIENT_TOKEN_ISSUER",
    "initial_device_display_name": "Malink client token issuer",
}), encoding="utf-8")
PY
    chmod 600 "$REQUEST"
    curl --fail --silent --show-error \
        -H 'content-type: application/json' \
        --data-binary "@$REQUEST" \
        "$HOMESERVER/_matrix/client/v3/login" > "$RESPONSE"
    chmod 600 "$RESPONSE"
    python3 - "$RESPONSE" "$OUTPUT" "@$CLIENT_USER:$SERVER_NAME" <<'PY'
import json
import pathlib
import sys

response_path, output_path, expected_user_id = sys.argv[1:]
value = json.loads(pathlib.Path(response_path).read_text(encoding="utf-8"))
required = ("user_id", "access_token", "device_id")
if any(not isinstance(value.get(field), str) or not value[field] for field in required):
    raise SystemExit("Matrix returned an invalid client login response")
if value["user_id"] != expected_user_id:
    raise SystemExit("Matrix logged the client token issuer into an unexpected account")
pathlib.Path(output_path).write_text(json.dumps({
    "user_id": value["user_id"],
    "access_token": value["access_token"],
    "device_id": value["device_id"],
}) + "\n", encoding="utf-8")
PY
    install -m 600 "$OUTPUT" "$CLIENT_LOGIN"
    echo "Created owner-only client token issuer session: $CLIENT_LOGIN"
fi

cat <<EOF

Workspace Matrix identities are provisioned:
  Gateway account: @$GATEWAY_USER:$SERVER_NAME
  Client account:  @$CLIENT_USER:$SERVER_NAME

Configure the Gateway with:
  MALINK_MATRIX_GATEWAY_USER=$GATEWAY_USER
  MALINK_MATRIX_GATEWAY_PASSWORD_FILE=$SECRETS/gateway-account-password
  MALINK_PWA_LOGIN_FILE=$CLIENT_LOGIN
  MALINK_MATRIX_CLIENT_PASSWORD_FILE=$SECRETS/client-account-password
  MALINK_PWA_URL=https://your-malink-pwa.example/

No client password belongs in the PWA or Android app. New devices receive a
single-use Matrix login token only after an authorized Malink invitation.
EOF
