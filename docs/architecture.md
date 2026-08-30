# Malink Matrix/PWA architecture

Status: MLP/3 implementation

Malink is an ACP coding-agent client built on Matrix. Matrix provides durable
encrypted store-and-forward, multi-device sync, room/thread history, and media;
it is not execution authority and is not used as an application RPC queue.

## Product shape

- A Gateway runs beside the coding agents on a workstation or server.
- A self-hosted macOS Gateway is launched through a stable background Host app
  so TCC consent survives online release-directory switches. Filesystem
  preflights run out of process and fail remotely with a bounded, actionable
  permission error instead of blocking the Matrix execution chain.
- The same statically hosted, online-updatable PWA is the UI in desktop browsers
  and inside the first-party Android shell. The APK can select an official,
  regional, or self-hosted HTTPS static-service base URL.
- The Android foreground connection service owns durable background Matrix
  sync, command reconciliation, local projection, and task notifications.
- A workspace is organized as project rooms; one encrypted room is exactly one
  project and each Agent session is an `m.thread` in that room.
- Future desktop shells may reuse the PWA and native-service boundary without
  moving the web application into a separately updated offline bundle.

## Workspace authorization and multiple Gateways

`gatewayId` is the stable Workspace authorization identifier retained on the
MLP/3 wire for compatibility. `gatewayNodeId` identifies one execution node.
Every Gateway node in a Workspace holds the same Workspace signing identity,
while its Matrix transport binding and working directories remain node-local.
Consequently a client is paired once with the Workspace, receives one portable
device grant, and manages every project route in the signed Gateway Directory
at the same time without pairing again.

Each node also has a durable, user-editable `gatewayName`. New installations
default that name to the machine hostname, while the UI appends a stable short
form of `gatewayNodeId` so duplicate hostnames remain distinguishable. The
signed Gateway Directory is the authority for the mapping from every project
ID to its owning node. Clients derive project labels from that mapping instead
of treating the Gateway used for initial pairing as a globally active node.

Android does not contain or run a Gateway. “Multiple Gateways on Android” means
that one native Matrix account session subscribes to every authorized project
room and routes each command to the Gateway node that owns that project. Browser
PWA and Android parse and persist the same authorization and project-routing
documents; their difference is only lifecycle ownership and durable native
storage. There is no active-Gateway switch in the product model.

Adding a trusted Gateway is normally an in-product enrollment:

1. An authorized client sends `gateway.enrollment.invitation.create` to an
   existing Gateway. The returned short-lived setup link contains the Matrix
   rendezvous, a one-time login token, the public Workspace key, and a random
   challenge; it does not contain the Workspace private identity.
2. The new node opens the setup link, creates a temporary application key and
   a stable `gatewayNodeId`, logs the new Matrix device into the Workspace-owned
   Gateway account, and publishes a signed enrollment request into the
   rendezvous project room.
3. Every authorized client receives the pending request inside the encrypted
   Workspace snapshot. The user compares the six-digit verification code shown
   by the client and the new node, then sends `gateway.enrollment.approve` to
   the Gateway node that issued the setup link.
4. Approval seals the high-authority `malink://gateway-join` material directly
   to the temporary key from that request and publishes the sealed response
   through Matrix. Matrix never receives the Workspace private identity in
   plaintext, and possession of a setup link alone cannot approve a node.
5. The new node decrypts the response, commits its Workspace identity, then
   reuses its new Matrix device session when the normal Gateway service starts.
   Signed directory, device-grant, and revocation state converges from the
   rendezvous room instead of inflating the approval event beyond Matrix's
   event-size limit.
6. The new node publishes its descriptor into the signed Gateway Directory on
   its stable bootstrap control route. Root-signed directory, portable grant,
   and revocation documents are not copied into every conversation room.
   Authorized clients are invited to new rooms, verify the directory signature,
   join automatically, and add the route to their existing Matrix session. No
   Gateway switch is exposed to the user.
7. To retire a node, run
   `malink gateway remove-gateway NODE_ID --gateway-data-dir PATH` on another
   active node. The signed tombstone removes its project routes from every
   client; the retired process stops when it observes the directory update.

The private Malink Synapse deployment enables `login_via_existing_session`
without an additional UIAA round trip for this owner-authorized operation. On
a compatible homeserver that does require UIAA, the existing Gateway can read
its Matrix account password through `MALINK_MATRIX_GATEWAY_PASSWORD` or
`MALINK_MATRIX_GATEWAY_PASSWORD_FILE`; that password is used locally for the
token request and is never placed in the setup link.

The original `invite-gateway` bearer command remains an offline recovery tool.
Its output contains the Workspace private identity and must never be posted to
Matrix, a public URL, logs, or chat.

Gateway nodes currently use the same Workspace-owned Matrix user account with
distinct Matrix device IDs. This lets a newly joined node publish the signed
directory into existing private project rooms immediately; client Matrix users
remain separate and are invited from their portable Workspace grants.
On first startup or `invite-gateway`, active certificates created before
portable grants existed are migrated in place with identical operations and
expiry, so existing clients do not need to pair again.

Gateway compromise and hostile Gateway nodes are outside this deployment's
threat model. Matrix remains untrusted transport: it cannot forge grants,
directories, commands, or snapshots, and a homeserver compromise does not
expose a direct control endpoint on a Gateway.

## Runtime shape

```text
PWA or Android native service
  -> durable signed/encrypted MLP/3 command event
  -> Matrix project-room timeline
  -> MatrixMlp3GatewayRunner
  -> durable command journal / authorization
  -> TopicSession -> SemanticSessionRuntime -> AgentProvider
  -> ConversationEvent
  -> signed/encrypted MLP/3 Gateway event
  -> durable Matrix outbox
  -> Matrix project thread
  -> client raw inbox -> verified local projection -> UI / notification
```

Edits, redactions, membership changes, Matrix state power, and ordinary Matrix
text never directly mutate local execution state. Only a Malink command signed
by a currently certified device and accepted by the Gateway journal can do so.

## Room and session model

```text
Gateway workspace
  └─ project room <-> projectId <-> fixed Gateway working directory
       └─ session root <-> m.thread <-> TopicSession
```

Project display names need not be unique, but project IDs and room bindings are.
A session stores its provider binding, model/reasoning configuration, lifecycle,
thread root, and immutable project ID. It cannot move between rooms.

The configured room is a bootstrap route, not a fixed project catalog. An
authorized PWA or Android client creates another project by sending
`project.create` through any existing route owned by the selected Gateway node.
The target node validates (and optionally creates) the absolute working
directory, provisions an encrypted Matrix room with a deterministic alias and
scope-bound ownership marker, commits the room to its durable project catalog,
then republishes its routes in the signed Workspace Gateway Directory. Clients
join and project the new room through the same multi-Gateway reconciliation
path; no local Gateway UI or shell access is required. Newly provisioned
project IDs include `gatewayNodeId` in their identity scope so identical paths
on different Gateway nodes cannot collide. Legacy bootstrap project IDs retain
their existing cwd-only identity.

Every active session owns its own `TopicSession`, `SemanticSessionRuntime`, and
provider instance. Sessions may execute concurrently. Selecting a conversation
is client-local view state and never suspends another session or mutates a
Gateway-wide “current session”. Archive releases runtime resources while
retaining metadata; restore recreates them; delete writes an authenticated
tombstone but does not claim to erase Matrix or provider-retained history.

Sensitive fields—including paths, prompts, Agent output, tool arguments,
provider session IDs, credentials, and execution grants—remain inside Malink
application encryption. Matrix-visible room names and message bodies are
non-sensitive placeholders.

## Protocol layers

1. Pairing pins the Gateway application key, Matrix transport binding, device
   identity, and command certificate. Pairing and Gateway transport rotation
   form an independently versioned pre-trust control plane.
2. The Gateway directly grants each trusted device the current project key ring
   through addressed `io.malink.project.key_grant.v3` Room State.
3. Commands and Gateway outputs use the same MLP/3 application envelope in
   ordinary `m.room.message` timeline events.
4. A device signature authorizes an exact command. A Gateway signature proves
   an exact lifecycle transition, Agent/tool event, snapshot, rejection, or
   terminal result. MLP/3 has no separate command-acknowledgement lane.
5. Application encryption binds workspace, project, room, key epoch, logical
   ID, nonce, and ciphertext. A homeserver cannot relocate or rewrite a signed
   relation without rejection.

A pairing certificate that includes `device.invite` represents a full
Workspace member: because that device can add another full member, it already
dominates every ordinary MLP/3 command capability. Gateways therefore map it to
the current protocol's ordinary operation set so existing clients inherit new
product operations without re-pairing or rotating every project key grant.
Explicitly restricted certificates remain restricted. Root privilege approval
is never inherited and still requires the separate `privilege.approve` grant.
Once a command signature and immutable bindings have been verified, a policy
denial is journaled and returned as a signed `command.rejected` terminal event;
unverified commands produce no application event.
6. Logical event identity is independent of the physical Matrix event ID.
   `causationCommandId` is a relationship, never message identity.
7. The client saves exact outbound content before send and reuses a stable
   Matrix transaction ID. A returned Matrix event ID records homeserver
   persistence and stops ordinary transport retransmission; terminal
   convergence comes from the signed Gateway chain. If bounded timeline
   recovery cannot find that terminal chain, the client may publish the exact
   saved content under a fresh reconciliation transaction ID. It must not
   create, resign, or re-encrypt a replacement command.
8. The Gateway journals a command before execution. Redelivery of the same
   exact command ID emits a signed `command.reconciled` view of its recorded
   accepted, running, or terminal state and cannot execute twice. A terminal
   reconciliation carries the durable outcome and structured result or error.
9. Current project state is an ordinary signed snapshot referenced by
   `io.malink.project.current.v3`. It is a recovery accelerator, not a separate
   mutable authority or a manual checkpoint.
10. The platform Matrix SDK is the sole client owner of live `/sync`. Android
    consumes MLP/3 events from SDK timelines and never opens an independent
    application `/sync`, cursor, gap worker, or receiver watchdog. Current Room
    State, signed snapshot pointers, and thread relations rebuild a cold local
    projection and page older history on demand.
11. Clients persist a raw event before projection. Poison is quarantined per
    event and dependency-deferred records converge in multiple passes.
12. MLP/1 and MLP/2 application events are neither emitted nor parsed by
    production Gateway, PWA, or APK entry points. There is no negotiated data
    downgrade.

The normative wire and recovery rules are in
[`malink-protocol.md`](malink-protocol.md).

## Compatibility-first protocol versioning

A protocol or capability version is a compatibility boundary, not a semantic
change counter. A clearer description, a new internal implementation, or an
additive optional operation does not by itself justify a version increase.
Version decisions start from the oldest independently deployed peer that the
product still supports:

- Keep the current version when an older peer can safely ignore or reject an
  additive operation and the newer peer retains a useful fallback.
- Add a separately negotiated optional capability when independent discovery
  is useful but the existing behavior remains valid.
- Increase a capability version only when using the same version could make a
  peer accept an unsafe or materially incompatible interpretation. Increase
  the whole bridge or MLP version only when the common envelope itself cannot
  remain compatible.
- Never use a newer version as a hard product gate merely because it describes
  the new behavior more precisely. Negotiation selects an enhancement; it must
  not remove the recovery path needed to install the enhancement.

Every version increase requires a staged compatibility proof: the provider
ships before a consumer requires it, the consumer keeps the previous supported
path, and tests exercise newest PWA against every supported released APK plus
oldest supported PWA against the new APK. An updater may not require the update
it is responsible for installing.

`malink.update.check` is the concrete compatibility example. It is an additive
`client.update` v1 operation. A pre-extension v1 APK returns
`METHOD_NOT_FOUND`; a current PWA falls back to v1 status/install behavior and
keeps an explicit upgrade route. Adding this operation is not a reason to
rename the capability v2.

## Android ownership boundary

The native foreground service remains connected while the Activity/WebView is
backgrounded. It owns:

- Matrix login, SDK-owned `/sync`, thread pagination, and media transfer;
- encrypted identity, trust, project keys, raw inbox, projection, and outbox;
- exactly-once command reconciliation across process death;
- notification emission when an Agent task reaches a user-relevant result;
- versioned store migrations before connection starts.

Native application releases are discovered from a bounded static Alpha channel
manifest under the user-selected UI service. The immutable APK may be stored
beside that manifest or as an exact fixed-version asset under the official
`Escapingbug/malink` GitHub Releases repository. The publisher installs or
uploads the APK first, then atomically replaces the channel JSON; Android checks
on startup and every 24 hours without requiring a Gateway or Matrix connection.
A Gateway may also include the same metadata in its signed, encrypted
`workspace.snapshot` for compatibility. Android verifies the APK hash, package
identity, monotonic version, architecture, and application signing certificate
before `PackageInstaller` can replace it. Downloads are resumable and
rebuildable; Matrix tokens, trust, commands, and history never enter update
storage. The public manifest is discovery metadata, not an update-signing key.

The WebView subscribes to a versioned native bridge and renders service-owned
state. Its `malink.events.ack` method advances only the local Native-to-WebView
event cursor; it is not a Matrix or MLP/3 command acknowledgement. Detaching,
reloading, or online-updating the PWA cannot cancel a running Agent or create a
second Matrix client. Android pauses WebView execution and timers whenever the
Activity is not resumed; background delivery and notifications remain native.
Browser-only use implements the same MLP/3
projection in IndexedDB. It cannot keep Matrix `/sync` executing after the
browser suspends it, but an opted-in standards-based Web Push subscription lets
the Service Worker wake for a generic task-terminal system notification.

## Browser Web Push boundary

```text
durable turn.completed / turn.failed
  -> Gateway Web Push outbox (dedupe + retry)
  -> browser push service (VAPID + encrypted payload)
  -> PWA Service Worker
  -> system notification -> #session=<id>
```

The PWA registers or removes only its own subscription through encrypted,
signed MLP/3 commands. The Gateway persists one subscription per Malink device
and a stable VAPID key pair beside the replay ledger. Push is an attention
signal, not another conversation transport: the payload contains only bounded
workspace/project/session routing IDs and terminal status, and the UI still
loads and verifies the result from Matrix. Visible clients receive a lightweight
Service Worker message and suppress the duplicate system popup. Expired 404/410
subscriptions are removed; transient delivery remains in the outbox. A bounded
Service Worker `eventId` cache absorbs the residual duplicate case where a push
provider accepted delivery immediately before the Gateway process stopped.

## Attachment and artifact flow

Matrix media is storage only. A sender encrypts every attachment with a fresh
AES-256-GCM key before upload and signs the `mxc://` locator, key, IV, hashes,
name, MIME type, and bounded size inside the application event. The Gateway
downloads only signed descriptors, enforces limits, authenticates/decrypts the
bytes, and converts supported media to ACP rich content.

Agent Markdown local-file destinations are never exposed as browser URLs. The
Gateway resolves each candidate against the session's fixed working directory,
rejects paths outside that directory, records bounded stat metadata, and
rewrites the destination to an opaque `malink-artifact:` reference. This
metadata travels inside the original `assistant.message`; no extra stat event
is emitted. Up to four safe raster images no larger than 4 MiB each and 12 MiB
in total are encrypted/uploaded before that assistant event and embedded by
reference. Larger images use the file path below.

A file reference expands to the already-projected stat locally. Only explicit
confirmation sends one signed `artifact.materialize` command as an ordinary
Matrix timeline message. The Gateway verifies that the reference belongs to
the command's room/project/session and re-stats the canonical path. A changed
file produces a higher-version `assistant.message` containing the new stat and
requires another confirmation; an unchanged file is encrypted/uploaded and
the same higher-version message gains its signed attachment descriptor. That
replacement is also the command's terminal event, so there is no RPC,
acknowledgement, or progress-message lane. Artifact media uploads share one
serial lane and honor Matrix 429 retry hints locally without adding timeline
events. Explicit `send_file` and authenticated artifact materialization are the
two Agent-to-client local-file delivery authorities; both terminate in the
same signed attachment model.

## Delivery and recovery ownership

- Gateway command journal: deduplication and execution outcome.
- Gateway raw Matrix inbox: cursor-commit barrier before authorization and execution.
- Gateway Matrix outbox: exact content, ordering, retry-after, transaction ID.
- Client durable command outbox: intent and Matrix-send reconciliation.
- Client raw inbox: crash-safe receipt before verification/projection.
- Client projection: rebuildable sessions, messages, lifecycle, and snapshot.
- Matrix timeline/threads: durable cross-device history and audit.

The UI reads only the local projection. A session `updatedAt` change, browser
focus, visibility change, or network recovery never synchronously reloads its
recent thread relations. SDK timeline events update the projection directly;
current Room State, signed pointers, thread-directory recovery, and
user-requested older pagination are the only paths allowed to read remote
history.

Warm startup is likewise SDK-driven. A browser may skip thread-directory
recovery only when its application projection checkpoint exactly matches the
Matrix SDK's durably saved sync token. Android resumes from its encrypted
projection and SDK store; a missing application projection triggers current
MLP/3 Room State and thread-directory recovery without creating another sync
cursor. Additional Workspace project rooms converge independently in the
background and cannot hold an already-authoritative primary project in
`Connecting`.

No layer substitutes for another. In particular, increasing an in-memory event
window or publishing a manual checkpoint is not a recovery strategy. An
already-published command may only be sent again as an explicit reconciliation
probe: exact signed/encrypted content, the same logical command ID, and a fresh
Matrix transport transaction ID. The Gateway command journal—not Matrix send
success—then answers with signed `command.reconciled` state. This additive
event remains MLP/3 because older peers safely ignore it and current peers keep
their existing terminal-event fallback; protocol versions are compatibility
boundaries rather than semantic revision counters.

Recovery presentation follows the same ownership boundary. A primary UI action
is rendered only when it can change the blocking state at its owning layer. An
older Android host that cannot query the Gateway journal must offer the Android
update path, not another Matrix-history scan. An offline Gateway is described
as an external prerequisite and is retried automatically; the client does not
present a no-op “check again” button. Release discovery, Workspace projection,
and Gateway liveness remain separate visible states, so a missing prerequisite
never hides the Gateway software panel or masquerades as another layer's retry.
If a bounded journal check receives no signed reply, the client records the
check time and presents that outcome separately from the command's unchanged
durable timestamp. An available Gateway release becomes the recovery action;
otherwise the client explains the target Gateway prerequisites and continues
automatic same-identity recovery without offering another immediate no-op check.

## Gateway online-update boundary

The Gateway process does not update itself. An independently launched,
owner-only supervisor constructs a complete signed release, reusing verified
files from the active release and downloading only changed files. It verifies
every staged file against a locally pinned release key, switches the stable
`current` symlink, and asks launchd to restart the Gateway. The old Gateway
first enters a drain state: it stops starting commands, waits for active turns
in the default update mode, and keeps durably staging new Matrix events. The
replacement process resumes that inbox before the Matrix sync cursor can skip
an accepted event.

There is no Gateway-side release-channel poller. Each node publishes its
current build ID and supervised-update capability in the root-signed Gateway
Directory. A manually deployed PWA may discover one exact signed Gateway
release, but discovery is presentation-only: it lists every node that is
current, outdated, manual-only, or unrouted and waits for explicit user
confirmation. Before enabling the per-node update action, the client requires
a recent terminal reply to a signed `gateway.update.status` command through a
project owned by that node. Matrix connectivity alone is never presented as
proof that the Gateway process is online. The public website stores immutable
files but does not become execution or release-signing authority.

Activation requires the expected build ID, a ready and recent Matrix sync, and
a readable durable inbox throughout probation. Failure restores the previous
symlink. Protected-state schema changes are refused by automatic activation
because binary rollback would be unsafe. The full release and recovery
procedure is in [`gateway-online-updates.md`](gateway-online-updates.md).

## Release acceptance

A release that changes this vertical slice is not accepted on unit tests alone.
The real Synapse Alpha journey must pair two browsers and an installed isolated
APK, create and run concurrent sessions, receive background completion and a
notification, survive Android process restart, restore history, quarantine a
malformed event without blocking later data, converge across devices, and
delete sessions concurrently. See [`real-matrix-testing.md`](real-matrix-testing.md).
