#!/bin/sh
set -eu

if [ "$(id -u)" -ne 0 ]; then
    echo "Run install-caddy-performance.sh with sudo." >&2
    exit 1
fi

CONFIG="${CADDY_CONFIG:-/etc/caddy/Caddyfile}"
SITE_ADDRESS="${MALINK_PWA_SITE_ADDRESS:-rd.anciety.my.id}"
CANDIDATE="$(mktemp)"
trap 'rm -f "$CANDIDATE"' EXIT

if grep -q '# Malink PWA performance' "$CONFIG"; then
    if grep -q '@malink_compressible' "$CONFIG"; then
        cp "$CONFIG" "$CANDIDATE"
    else
        awk '
            BEGIN { in_performance = 0; updated = 0 }
            {
                line = $0
                sub(/^[[:space:]]*/, "", line)
                sub(/[[:space:]]*$/, "", line)
                if (line == "# Malink PWA performance") in_performance = 1
                if (in_performance && !updated && line == "encode zstd gzip") {
                    print "\t@malink_compressible {"
                    print "\t\tnot path /gateway-updates/artifacts/* /native-updates/releases/*"
                    print "\t}"
                    print "\tencode @malink_compressible zstd gzip"
                    updated = 1
                    next
                }
                print $0
            }
            END { if (!updated) exit 42 }
        ' "$CONFIG" > "$CANDIDATE"
    fi
else
    awk -v site_address="$SITE_ADDRESS" '
        BEGIN { inserted = 0 }
        {
            line = $0
            sub(/^[[:space:]]*/, "", line)
            sub(/[[:space:]]*$/, "", line)
            print $0
            if (!inserted && line == site_address " {") {
                print "\t# Malink PWA performance"
                print "\t@malink_compressible {"
                print "\t\tnot path /gateway-updates/artifacts/* /native-updates/releases/*"
                print "\t}"
                print "\tencode @malink_compressible zstd gzip"
                print ""
                print "\t@malink_service_worker path /sw.js"
                print "\theader @malink_service_worker Cache-Control \"no-cache, no-store, must-revalidate\""
                print ""
                inserted = 1
            }
        }
        END { if (!inserted) exit 42 }
    ' "$CONFIG" > "$CANDIDATE"
fi

caddy validate --adapter caddyfile --config "$CANDIDATE"
cp "$CONFIG" "${CONFIG}.before-malink-pwa-performance"
install -o root -g root -m 644 "$CANDIDATE" "$CONFIG"
systemctl reload caddy
