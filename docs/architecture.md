# Malink Matrix/PWA architecture

Status: MLP/3 implementation

Malink is an ACP coding-agent client built on Matrix. Matrix provides durable
encrypted store-and-forward, multi-device sync, room/thread history, and media;
it is not execution authority and is not used as an application RPC queue.

## Product shape

- A Gateway runs beside the coding agents on a workstation or server.
- The same online-updatable PWA is the UI in desktop browsers and inside the
  first-party Android shell.
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
6. The new node publishes its descriptor into the signed Gateway Directory.
   Each Gateway mirrors that root-signed directory and the portable device
   grants into every project room. Authorized clients are invited to new rooms,
   verify the directory signature, join automatically, and add the route to
   their existing Matrix session. No Gateway switch is exposed to the user.
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
   an exact acknowledgement, lifecycle transition, Agent/tool event, snapshot,
   or terminal result.
5. Application encryption binds workspace, project, room, key epoch, logical
   ID, nonce, and ciphertext. A homeserver cannot relocate or rewrite a signed
   relation without rejection.
6. Logical event identity is independent of the physical Matrix event ID.
   `causationCommandId` is a relationship, never message identity.
7. The client saves exact outbound content before send and reuses a stable
   Matrix transaction ID. Matrix acknowledgement stops retransmission; terminal
   convergence comes from the signed Gateway chain.
8. The Gateway journals a command before execution. Redelivery of the same
   command ID returns its recorded state and cannot execute twice.
9. Current project state is an ordinary signed snapshot referenced by
   `io.malink.project.current.v3`. It is a recovery accelerator, not a separate
   mutable authority or a manual checkpoint.
10. `/sync` is the sole normal source of recent events. Clients commit its
    cursor only after durable inbox/projection handling; a limited timeline
    creates a durable background gap-recovery job. Thread relations are used
    only to establish a cache-cold selected window and to page older history.
11. Clients persist a raw event before projection. Poison is quarantined per
    event and dependency-deferred records converge in multiple passes.
12. MLP/1 and MLP/2 application events are neither emitted nor parsed by
    production Gateway, PWA, or APK entry points. There is no negotiated data
    downgrade.

The normative wire and recovery rules are in
[`malink-protocol.md`](malink-protocol.md).

## Android ownership boundary

The native foreground service remains connected while the Activity/WebView is
backgrounded. It owns:

- Matrix login, `/sync`, thread pagination, and media transfer;
- encrypted identity, trust, project keys, raw inbox, projection, and outbox;
- exactly-once command reconciliation across process death;
- notification emission when an Agent task reaches a user-relevant result;
- versioned store migrations before connection starts.

Native application releases are account state owned by the Gateway. Deployment
stores an immutable APK first, then submits its metadata to the owner-only
Gateway admin socket. The Gateway persists the latest release and includes it
in the ordinary signed, encrypted `workspace.snapshot`; offline devices receive
only that latest state when Matrix synchronization resumes. Android verifies
the APK hash, package identity, monotonic version, architecture, and application
signing certificate before `PackageInstaller` can replace it. Downloads are
resumable and rebuildable; Matrix tokens, trust, commands, and history never
enter update storage. There is no public update manifest or second update key.

The WebView subscribes to a versioned native bridge and renders service-owned
state. Detaching, reloading, or online-updating the PWA cannot cancel a running
Agent or create a second Matrix client. Browser-only use implements the same MLP/3
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
bytes, and converts supported media to ACP rich content. Explicit `send_file`
is the only Agent-to-client local-file delivery authority.

## Delivery and recovery ownership

- Gateway command journal: deduplication and execution outcome.
- Gateway Matrix outbox: exact content, ordering, retry-after, transaction ID.
- Client durable command outbox: intent and Matrix-send reconciliation.
- Client raw inbox: crash-safe receipt before verification/projection.
- Client projection: rebuildable sessions, messages, lifecycle, and snapshot.
- Matrix timeline/threads: durable cross-device history and audit.

The UI reads only the local projection. A session `updatedAt` change, browser
focus, visibility change, or network recovery never synchronously reloads its
recent thread relations. Live `/sync` events update the projection directly;
explicit gap workers and user-requested older pagination are the only recovery
paths allowed to read remote history.

No layer substitutes for another. In particular, increasing an in-memory event
window, publishing a manual checkpoint, or resending an already Matrix-acked
command is not a recovery strategy.

## Release acceptance

A release that changes this vertical slice is not accepted on unit tests alone.
The real Synapse Alpha journey must pair two browsers and an installed isolated
APK, create and run concurrent sessions, receive background completion and a
notification, survive Android process restart, restore history, quarantine a
malformed event without blocking later data, converge across devices, and
delete sessions concurrently. See [`real-matrix-testing.md`](real-matrix-testing.md).
