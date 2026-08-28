# Static native client releases

An Android update is a static channel manifest plus an immutable APK. The APK
checks the currently selected static service on startup and every six hours, so
automatic update discovery does not require a web application, database,
Gateway, or Matrix connection.

The client reads:

```text
<static-base>/native-updates/channels/alpha/client-release.json
```

It rebases the immutable APK path onto that same selected base URL. This makes
one portable release tree mirrorable across an international CDN, a regional
service, GitHub Pages, or a private static host. The compatibility path that
receives a release from a signed Gateway workspace snapshot remains supported,
but is no longer required for discovery.

The manifest is not a code-signing key. The client bounds and parses it, refuses
redirects, verifies the downloaded size and SHA-256, inspects the real APK
package/version, and requires the APK signing certificate to match the
currently installed app. Android verifies the application signature again
before installation.

## One-time Caddy setup

Install the static routes inside the existing HTTPS site:

```sh
sudo deploy/native-update/install-caddy-route.sh
```

The route serves `/native-updates/releases/...` with immutable caching and the
Alpha channel manifest with `no-store` caching. For object storage or GitHub
Pages, upload the generated tree with the same relative paths and configure the
equivalent cache rules where the platform permits them.

## Build a release bundle

Use one stable Android application-signing key for every Alpha APK. Supply all
four variables to Gradle; the bundle generator rejects an unsigned APK.

```sh
cd clients/android
MALINK_ANDROID_SIGNING_STORE_FILE=/secure/malink-alpha.jks \
MALINK_ANDROID_SIGNING_STORE_PASSWORD=... \
MALINK_ANDROID_SIGNING_KEY_ALIAS=malink-alpha \
MALINK_ANDROID_SIGNING_KEY_PASSWORD=... \
./gradlew :app:assembleRelease

cd ../..
pnpm release:android-update -- \
  --apk clients/android/app/build/outputs/apk/release/app-release.apk \
  --release-note "Background connection reliability improvements"
```

This creates:

```text
dist/native-update/client-release.json
dist/native-update/channels/alpha/client-release.json
dist/native-update/releases/android/alpha/<versionCode>/<immutable>.apk
```

`channels/alpha/client-release.json` is the public static discovery document.
`client-release.json` is the identical operator/Gateway compatibility input.
Use `--base-url https://host.example/path/` when generating a tree intended for
a path-based host. Android still resolves the artifact against the service the
user selected.

## Upload the static channel

The checked publisher uploads the APK and atomically replaces the Alpha
manifest on the SSH artifact host. Two arguments are enough:

```sh
pnpm publish:android-update -- \
  dist/native-update \
  ubuntu@rd.anciety.my.id
```

This bundled publisher targets the origin-root Caddy layout installed above.
For a CDN, Pages, or base-path deployment, upload the generated `channels/` and
`releases/` directories with the host's own static deployment mechanism.

Optionally pass the local Gateway admin socket as a third argument to publish
the same release into the signed workspace snapshot for older clients:

```sh
pnpm publish:android-update -- \
  dist/native-update \
  ubuntu@rd.anciety.my.id \
  /absolute/path/to/gateway-data/admin.sock
```

The admin socket path can instead be supplied through
`MALINK_NATIVE_UPDATE_ADMIN_SOCKET`. If the artifact host uses a dedicated SSH
key, set its absolute path through
`MALINK_NATIVE_UPDATE_SSH_IDENTITY_FILE`.

## Android signing transition

Android only accepts an in-place update signed by the same application key as
the installed APK. Existing development APKs are debug-signed, so the first
move to the stable Alpha key needs one manual reinstall (or uninstall/install
if Android rejects the key change). After that transition, static releases
update in place. Losing the Android signing key prevents future in-place
upgrades; no separate Malink update key exists.
