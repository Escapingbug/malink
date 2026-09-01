# Malink Android native host

This is the Android-first native host for the continuously updated static
Malink UI. The official default is
`https://escapingbug.github.io/malink/`; the user can select another HTTPS
mirror or a self-hosted base URL without rebuilding the APK. A saved custom
choice for that exact Pages address is normalized back to Official after an
upgrade. It is a Kotlin Android application; it does not use Tauri and does
not bundle a second offline frontend.

The browser PWA remains a complete standalone client. Inside the APK, the same
hosted UI selects the native client only after a strict capability handshake
and after the Matrix session has been bootstrapped as native-owned. A
browser-owned Matrix session continues to use the Web client, which prevents
one identity from being driven by both transports.

## Runtime and lifecycle

- The main Activity loads only the selected HTTPS static-service origin and
  base path in a secured WebView. Compatible UI releases are ordinary static
  file deployments and arrive without installing another APK.
- AndroidX WebKit exposes an origin-restricted, main-frame-only JSON-RPC port.
  The application never uses `addJavascriptInterface`.
- `MalinkConnectionService` owns Matrix SDK login, E2EE, native sliding sync,
  the bound
  room timeline, Malink trust, replay state, commands, history, and transfers.
- The service is `START_STICKY`, restores after reboot when persistent
  connection is enabled, and stays alive when the Activity/WebView is closed or
  replaced.
- The service never holds a process-lifetime CPU wake lock or opens an
  application-owned `/sync` long poll. The Matrix SDK owns the single live sync
  connection, its retry policy, room subscriptions, and encrypted timelines.
- Activity backgrounding pauses the WebView and its timers; the native service
  remains the only owner of background Matrix delivery and task notifications.
  Every newly projected, authenticated `turn.completed` or `turn.failed` event
  is eligible regardless of which trusted Malink device submitted the prompt.
  A separate encrypted notification outbox retries failed delivery and dedupes
  logical event IDs across Matrix replay and Android process restart.
- A visible ongoing `remoteMessaging` notification is mandatory. There is no
  battery-saving or connection-mode selector. Refusing notification permission
  blocks native connection startup with a visible explanation.
- The ongoing notification exposes **Export logs**. It creates a bounded text
  report that can be shared directly to Telegram even when the hosted Web UI
  cannot connect. Reports contain the exact APK build, Android version, native
  lifecycle transitions, Matrix startup stages, timeouts, retries, and exception
  class names. Exported reports never include tokens, message content, room/user
  identifiers, device keys, raw SDK messages, or free-form exception messages.
- The ongoing notification and PWA settings expose **Static service**. The user
  can return to the built-in official endpoint or enter any credential-free
  HTTPS base URL, including a regional mirror or self-hosted path. A native
  confirmation explains that this origin supplies executable UI code and
  receives the origin-restricted native bridge. If the selected service cannot
  load, the native recovery screen retains the same setting action. A selected
  address is first stored as a candidate; Android commits it only after the new
  presentation restores and activates the native projection. Otherwise Android
  restores the last-known-good address after 30 seconds. The launcher shortcut
  also opens this setting without depending on a working PWA.
- Explicit Disconnect finishes the native runtime before stopping the service.
  Remove This Device requires a native confirmation, logs the Matrix device out
  while online, and only then wipes local credentials. A failed remote logout
  fails closed and retains the local identity so revocation cannot be falsely
  reported as complete.

Android's explicit force-stop remains a platform override: no application can
restart itself until the user opens it again.

`MalinkApplication` initializes the Matrix FFI platform and its multithreaded
Tokio runtime before an Activity, boot receiver, or connection service can open
a client. Every client explicitly uses the SDK's single-process store mode. The
Matrix SDK `SyncService` then supervises native sliding sync for the room list,
encryption, pairing, and all live MLP/3 timeline events.

Existing v2 sessions are migrated to the native sliding-sync session mode while
preserving the Matrix crypto/data store and Malink pairing identity. Only the
disposable SDK cache is rotated to `cache-v2`, and the room list uses the
versioned `malink-native-v2` connection ID. The bound room is subscribed before
the service starts. `SyncService.RUNNING` means only that its child tasks were
spawned; readiness requires room-list progress from a completed sync before
E2EE finalization, timeline construction, and transport publication. A running
SDK supervisor is allowed to keep waiting for that first response: its own
`ERROR` and `TERMINATED` states are authoritative, so a slow homeserver cannot
be misreported as a permanent native failure. Android does not run a periodic
polling watchdog beside the SDK supervisor.

The SDK publishes one readiness barrier after E2EE initialization and timeline
construction succeed for every bound project room. Pairing and trusted commands
consume those same SDK timelines; Android owns no second sync cursor, long poll,
gap worker, or receiver watchdog. Pairing storage commits under the domain-state
lock, while all Matrix network I/O runs after that lock is released.

Cold projection recovery is bounded to six attempts and is started by native
transport readiness, not by screen-on, Doze-exit, or ordinary Activity focus.
Timeline event IDs are deduplicated within each SDK driver generation, command
sends are serialized, and successful raw-inbox cleanup is coalesced until the
next durable input or a clean lifecycle boundary.

For an Android outbox command already published to Matrix but still missing a
terminal event, native recovery immediately sends the exact stored
signed/encrypted content under a fresh
`malink.v3.reconcile.<commandId>.<uuid>` Matrix transaction, then scans the
bounded SDK timeline as an older-Gateway fallback. It never rebuilds the
command, and timeline pagination timeout cannot cancel or postpone the journal
probe. The Gateway journal deduplicates before execution and returns signed
`command.reconciled` state, allowing a restarted WebView to converge without
submitting the user action twice. APKs with this behavior advertise the
optional `commands.journal-reconciliation` bridge capability.

Debug builds write bounded private sync-profiling traces. Release builds retain
only bounded SDK warnings and errors. Diagnostic export converts those traces
to a fixed vocabulary of levels, targets, categories, and HTTP status codes;
raw SDK messages and identifiers never enter the shared report.

## Native capabilities

Bridge protocol version 1 currently implements:

- `client.lifecycle`
- `events.replay`
- `state.snapshot`
- `commands.durable` v4 (v2 adds project settings/provider history; v3 adds explicit project routing for simultaneous multi-Gateway management; v4 adds atomic project metadata/default updates and deletion)
- `commands.journal-reconciliation` v1
- `commands.orphan-retirement` v1 (diagnostic local retirement keeps an
  idempotency tombstone and never claims to cancel an accepted Gateway action;
  normal no-reply recovery remains automatic)
- `history.page` v2 (`source=local` is network-free; `source=matrix` is explicit pagination)
- `attachments.chunked`
- `pairing.native`
- `trust.native`
- `matrix.session-bootstrap` v2 (v2 adds credential-free discovery of an
  existing native-owned Matrix session for a newly loaded Web origin)
- `client.update` v1 (`status`/`install`, plus the additive idempotent
  `check` operation; Web clients fall back when a pre-extension v1 APK returns
  `METHOD_NOT_FOUND`)
- `client.pwa-source` v1
- `client.diagnostics` v1 (opens Android's native share sheet for the bounded
  native diagnostic report; hosted Web UI does not rely on WebView blob
  downloads for this action)
- `background.foreground-service`

The bridge has strict schemas, a 512 KiB RPC envelope limit, 256 KiB event
batches, mutation idempotency, cursor replay with snapshot fallback, and
chunked attachments up to 50 MiB. Reconnect snapshots reserve their budget for
active commands and terminal summaries; large terminal results remain
recoverable through `malink.command.get`.

Capability versions express compatibility, not semantic precision. Additive
optional operations stay on the existing capability version when old APKs can
reject them predictably and the PWA keeps a useful fallback. A new version may
become required only after a staged release proves both newest-PWA/oldest-APK
and oldest-PWA/newest-APK operation; native update recovery itself can never be
the feature that requires the new updater version.

Pairing uses a native confirmation dialog. Its signed certificate is the
complete command policy; the APK never adds implicit local grants. Signed pairing rejection, request
binding, Gateway root trust, transport-device rotation, and durable signed
transport snapshots are verified before changing trust. Commands are validated
and authorized against the current Gateway certificate before entering the
encrypted durable outbox. History first replays the encrypted local event
store, then paginates the signed Matrix room and thread timelines when needed;
it never requests transcript pages from the Gateway.

Native confirmation signs one request and atomically stores that transaction
in encrypted no-backup storage before sending it. A verified pairing response
is stored beside the request before success is exposed. The foreground
service automatically retransmits the identical request after transport loss,
WebView replacement, or process restart. A successful trust commit supersedes
and clears the pre-trust transaction; cancellation, terminal rejection,
revocation, and authorization expiry clear it explicitly.
Closing or reloading the hosted Web UI only detaches its waiter and does not
translate into a pairing cancellation.

## Secret handling

- The Matrix one-time login token is memory-only and is exchanged only with the
  exact HTTPS homeserver login endpoint.
- Matrix access tokens, Malink private keys, SDK database keys, and raw Matrix
  events never cross the JavaScript bridge.
- Malink P-256 signing/agreement keys are non-exportable Android Keystore keys.
- Long-lived Matrix session data, Gateway trust, command outbox, event state,
  thread-key ring, and attachment temporary chunks are encrypted at rest. Raw
  Matrix application events are not duplicated into a second native journal.
- Cleartext traffic, mixed content, file/content access, wildcard bridge
  origins, external frames, redirects during sensitive profile recovery, and
  TLS/certificate errors fail closed.
- Changing the static service rebuilds the WebView and bridge allowlist before
  loading the new base URL. Browser storage remains isolated by Web origin;
  native Matrix credentials and private keys never move to JavaScript. The new
  origin recovers only public routing metadata, then reads trust and Workspace
  state from the native projection.

## Static APK updates

The foreground service checks the selected static service's Alpha channel on
startup and every 24 hours:

```text
native-updates/channels/alpha/client-release.json
```

When the manifest names a newer compatible build, Android downloads the
immutable APK, resumes partial downloads, and shows a native notification when
it is ready. The APK normally comes from the same selected base URL. It may
instead use the exact fixed tag
`Escapingbug/malink/releases/download/android-alpha-<versionCode>/...apk`;
mutable or foreign GitHub Release links are rejected, and only bounded HTTPS
redirects to GitHub asset hosts are followed. The static manifest is discovery
metadata, not update authority: before installation Malink verifies its bounded
size and SHA-256, package name, version code, ABI/Android/bridge compatibility,
and that the APK's actual signing certificate matches the installed app.
Android's `PackageInstaller` enforces the application signature again and keeps
the final installation confirmation native.

A mirror therefore hosts only files. It does not need a database, update API,
Gateway, Matrix credentials, or a second release-signing key. It must preserve
the `native-updates/channels/` layout and disable caching for the channel
manifest. When GitHub Releases stores the APK, the mirror does not need a
`native-updates/releases/` tree. See
[the deployment guide](../../deploy/native-update/README.md).

## Build and validation

The first APK supports Android 12 or newer (`minSdk 31`) and arm64. Set
`ANDROID_HOME` to an SDK containing API 36 and use JDK 17:

```sh
./gradlew --no-build-cache --rerun-tasks -Pkotlin.incremental=false \
  :app:testDebugUnitTest :app:lintDebug :app:assembleDebug
```

The debug APK is written to `app/build/outputs/apk/debug/app-debug.apk`. The
Matrix native libraries make it substantially larger than a WebView-only shell.
An unstrippable JNA native library is packaged as-is by the current dependency.

Every APK has its own build identity. `versionCode` advances with build time
(seconds since 2020-01-01), while `versionName` and the native bridge build ID
include the millisecond UTC build timestamp, Git revision, and a `dirty` suffix
when tracked source changes were present. Set
`MALINK_ANDROID_BUILD_EPOCH_MS` to an epoch timestamp in milliseconds when CI
needs a reproducible identity. The exact identity is visible in Android App
info, the persistent notification, and the PWA Gateway settings. This lets a
pairing failure screenshot identify the installed native binary independently
of the online PWA build.

The JVM suite covers static-service URL/origin isolation and release rebasing,
bridge negotiation and cancellation, pairing/trust and
cross-language crypto fixtures, transport rotation recovery, durable commands,
event persistence/replay, encrypted transfers, Matrix login/runtime recovery,
and lifecycle policy. The PWA has separate bridge selection, conformance, and
online-update tests.

For a paired debug APK on an emulator, the live device E2E drives the real
WebView through its debug protocol and the Android lifecycle through ADB. It
cold-starts online and offline, verifies cached conversations and history,
restores the native Matrix connection, and runs two complete
create/archive/restore/delete cycles. It creates uniquely named disposable
projects and only deletes sessions created by that run. Lifecycle operations
remain correctness failures after 90 seconds and are also reported as latency
warnings when they exceed 20 seconds. The opt-in guard keeps it out of normal
test runs:

```sh
MALINK_ANDROID_LIVE_E2E=1 pnpm test:e2e:android-live
```

The command requires exactly one connected emulator by default. Set
`MALINK_ANDROID_SERIAL` when several devices are attached. Physical-device
mutation is rejected unless `MALINK_ANDROID_ALLOW_PHYSICAL=1` is also set
after explicit approval.

## Remaining release work

- Complete the remaining physical-device Matrix/E2EE release checks: screen
  lock, reboot, device revocation, and prolonged OEM background restrictions.
- Make attachment transfer metadata process-durable. Current temporary chunks
  are encrypted, but an interrupted process discards orphan transfer state and
  the UI must restart that transfer.
- Add product message notifications beyond the current generic task-terminal
  alerts. Task-terminal notifications already open their owning session.
- Complete stable Android application-signing key custody and the one-time
  transition from existing debug-signed development installs. Static channel
  releases use the installed application's APK signature acceptance boundary;
  Gateway snapshot release metadata is display-only catalog data.
- Validate the `remoteMessaging` classification with Google Play policy before
  Play distribution. Directly distributed APKs do not undergo that review.
