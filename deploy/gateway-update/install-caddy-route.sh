#!/bin/sh
set -eu

if [ "$(id -u)" -ne 0 ]; then
    echo "Run install-caddy-route.sh with sudo." >&2
    exit 1
fi

CONFIG="${CADDY_CONFIG:-/etc/caddy/Caddyfile}"
SITE_ADDRESS="${MALINK_PWA_SITE_ADDRESS:-rd.anciety.my.id}"
CANDIDATE="$(mktemp)"
trap 'rm -f "$CANDIDATE"' EXIT

install -d -o root -g root -m 755 \
    /srv/malink-gateway-updates/artifacts \
    /srv/malink-gateway-updates/manifests

if grep -q '# Malink Gateway updates' "$CONFIG"; then
    cp "$CONFIG" "$CANDIDATE"
else
    awk -v site_address="$SITE_ADDRESS" '
        BEGIN { inserted = 0 }
        {
            line = $0
            sub(/^[[:space:]]*/, "", line)
            sub(/[[:space:]]*$/, "", line)
            print $0
            if (!inserted && line == site_address " {") {
                print "\t# Malink Gateway updates"
                print "\thandle_path /gateway-updates/* {"
                print "\t\troot * /srv/malink-gateway-updates"
                print "\t\theader Cache-Control \"public, max-age=31536000, immutable\""
                print "\t\tfile_server"
                print "\t}"
                print ""
                inserted = 1
            }
        }
        END { if (!inserted) exit 42 }
    ' "$CONFIG" > "$CANDIDATE"
fi

caddy validate --adapter caddyfile --config "$CANDIDATE"
cp "$CONFIG" "${CONFIG}.before-malink-gateway-updates"
install -o root -g root -m 644 "$CANDIDATE" "$CONFIG"
systemctl reload caddy
