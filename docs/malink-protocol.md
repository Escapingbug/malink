# Malink Protocol (MLP/3)

Status: version 3, pre-release hard cutover

**Malink Protocol (MLP)** is Malink's signed, encrypted application protocol.
The current version is written **MLP/3**. Matrix is its durable transport; a
Matrix room/event/sync version and a MLP version are separate concepts.

## Naming boundary

- **MLP/3 command, event, envelope, projection, key, or snapshot** means a
  Malink application-protocol object.
- **Matrix room, event, thread, state, sync, E2EE, or rate limit** means a
  transport object or behavior.
- A code symbol named `MatrixMlp3*` is specifically a Matrix transport adapter
for MLP/3; it does not name a version of Matrix.

Workspace-level semantics are explicit in payloads. Scratch sessions use
`session.create.scope = "scratch"`; received files use
`inbox.file.received` without a `sessionId`. A project ID may still be present
as the authenticated Matrix-room routing binding, but clients must not present
either entity as owned by that project. A workspace inbox event is replicated
once per active project room using the same logical file and event IDs.
- Existing wire event types ending in `.v3`, encrypted-storage domain strings,
  and database filenames remain unchanged because they are compatibility IDs.

Malink uses Matrix as a durable encrypted conversation log. Matrix is not an
RPC queue and a client cache is never authoritative. The homeserver is trusted
for availability and ordering only; Malink signatures establish authorship
and application encryption hides business content from the homeserver.

MLP/3 replaces the pre-release MLP/1 and MLP/2 application data planes. There is no
wire downgrade, checkpoint RPC, state-request RPC, history-request RPC, or v2
timeline fallback. The pairing handshake has its own version and remains only
as the control plane that establishes device trust and distributes MLP/3 keys.

## Native object mapping

| Malink concept | Matrix concept | Authority |
| --- | --- | --- |
| Workspace | a set of encrypted project rooms | local Gateway configuration plus signed room membership |
| Project | one encrypted Matrix room | `project_id` permanently bound to the room |
| Session | one Matrix thread | immutable root event and signed lifecycle events |
| User prompt or mutation | ordinary `m.room.message` command event | device signature, certificate, stable `command_id` |
| Agent/tool/status output | ordinary `m.room.message` thread event | Gateway signature and stable logical `event_id` |
| Current project projection | ordinary signed snapshot event | `io.malink.project.current.v3` points to its physical event ID |
| Current native client release | account-owned workspace snapshot field | Gateway admin publication, replicated to active project rooms |
| Gateway release status | account-owned workspace snapshot field plus command result | pinned release signer and local update supervisor |
| Project key grant | directly addressed Room State | `io.malink.project.key_grant.v3` keyed by device ID |
| Transcript and audit | thread timeline and relations | append-only signed events |

One room represents exactly one project. Project identity therefore does not
need to be repeated as visual grouping metadata in every session row, and a
session cannot silently move between projects. Matrix Spaces may organize
rooms later without changing the room/thread protocol.

## Unified event chain

All business commands and Gateway outputs are normal timeline events. Their
outer `io.malink` object contains MLP version 3, the logical event ID,
project binding, key epoch, nonce, and application ciphertext. The decrypted
payload is either a device-signed command or a Gateway-signed event.

Every signature binds the workspace, project, room, certificate generation,
logical ID, operation/kind, timestamp, and payload. A Matrix physical event ID
is delivery metadata, not business identity. Moving ciphertext to another
room, changing a relation, changing a command, or substituting a logical ID
fails verification.

`causationCommandId` records why a Gateway event exists. It is not the event's
identity: a prompt, progress event, Agent response, tool result, and terminal
result may all causally refer to one command while retaining distinct logical
event IDs. Clients only reconcile the optimistic user prompt with its canonical
user event; they never merge an Agent response into that prompt. A projected
user event MUST retain its originating device ID so the client can select the
exact optimistic entry even when the durable local projection emits before
`send()` returns. That authoritative projection updates the selected entry's
delivery state in place.

## Commands and exactly-once execution

Before sending, a client writes the exact signed and encrypted Matrix content
to its durable outbox. Retry reuses both `command_id` and Matrix transaction ID.
Once Matrix returns the physical event ID, the client records the command as
published and stops retransmitting it. Signed Gateway progress may follow, and
only a signed terminal event completes the command.

The Gateway commits each accepted `command_id` to a durable command journal
before execution. Re-delivery returns the recorded state and never runs the
operation twice. Independent append operations such as prompts are serialized
by the Gateway; state-dependent mutations carry explicit preconditions and
produce a reviewable conflict instead of hidden client-side retry.

Session creation, prompt, cancel, settings, provider-history inspection, and
archive use this same path. A create command produces an immutable thread root.
The provider is selected only by `session.create` and is immutable for the
life of that Malink session. `session.update` may change model and reasoning,
which the Gateway applies through the provider's structured ACP model/config
surface rather than manufacturing provider-specific slash commands.

`project.update` stores the default model and reasoning used by later sessions
for the project's default provider. Provider-native slash commands remain user
messages. When ACP publishes `available_commands_update`, clients may render
those commands as actions that insert the corresponding slash input; Malink
does not take ownership of provider commands such as `/model`.

Provider-owned history is a separate surface. `provider.sessions.list` lists
the sessions still retained by a configured provider and
`provider.session.inspect` returns a bounded read-only transcript preview.
Creating a session with `providerSessionId` adopts that existing provider
conversation; the first message sent from the preview is carried as the create
command's initial prompt. A provider session already managed by an active
Malink session opens that session instead of creating a duplicate.

Malink has one removal action: archive. It removes a session from the managed
session projection but retains its metadata tombstone and never invokes a
provider-level delete. Archived sessions are not restored in place; if the
provider still lists the conversation, users continue it from Provider
History, producing a new Malink session identity. Pre-release `delete`
requests are normalized to archive and `restore` is rejected for compatibility;
neither redacts Matrix or provider history.

Browser notification enrollment also uses this path. A web device sends
`notification.subscribe` or `notification.unsubscribe` as a signed,
project-encrypted MLP/3 command. The subscription is scoped to the authenticated
`deviceId`; a command cannot install or remove another device's endpoint. The
Gateway advertises its stable VAPID public key in the optional `web_push`
capability and acknowledges the change with
`notification.subscription.changed`. Existing `session.settings` certificate
authority covers this device-local setting, so adding the optional capability
does not invalidate an already paired device.

Gateway release control uses three workspace commands:

- `gateway.update.stage` names an immutable release ID and asks the local
  supervisor to download and verify it.
- `gateway.update.apply` activates the already staged ID using `when_idle` or
  the explicitly destructive `force` mode. `when_idle` closes the new-command
  execution gate immediately, drains work that was already active, and leaves
  later accepted commands queued for restart recovery; it does not wait for a
  naturally idle moment while continuing to start new work.
- `gateway.update.status` reads the durable supervisor state.

All three require the `gateway.update` pairing grant. This grant is not an
arbitrary code-install capability: the remote command contains no URL or key,
and the local supervisor accepts only manifests signed by its pinned release
signer. Results use `gateway.update.status` and are also carried in subsequent
`workspace.snapshot` events so another authorized client converges after the
Gateway restart.

## Current state and recovery

Current state is an optimization over the event log, not a second authority.
After a projection change, the Gateway emits an ordinary signed project
snapshot and updates `io.malink.project.current.v3` to that event. A cold
client reads the pointer, fetches and verifies the referenced event, then
enumerates Matrix threads with complete pagination. It loads a selected
transcript's initial window through standard thread relations only when the
local projection has no cached window. Older transcript pages are loaded on
explicit user pagination.

Clients persist raw Matrix events before projection. Projection success marks
an inbox record complete. A malformed event is quarantined individually; it
cannot block later valid events. Events that are valid but await a dependency,
such as a project key grant, are retried in multi-pass order so a later grant
can unlock an earlier event without deadlocking the inbox.

The `/sync` token is the incremental Matrix transport cursor, not a MLP
checkpoint. A client advances it only after every accepted event has completed
its durable local transition or has been quarantined as poison. If `/sync` is
limited, the client persists the exact gap boundary before advancing the live
cursor and closes that gap in a coalesced background worker. The current
pointer and fully paginated thread directory provide a cache-cold baseline;
thread relations do not poll for recent state. Process death resumes the
durable inbox, gap queue, and outbox and never manufactures a replacement
command.

Offline clients show their last verified encrypted local projection and
history. They do not report Connected or release new commands until the Matrix
transport and authenticated MLP/3 projection are writable.

The Gateway also persists the latest native client release per platform,
channel, and architecture. Deployment installs the immutable artifact first,
then publishes its bounded metadata through the owner-only local admin socket.
The Gateway replaces `workspace.snapshot` in each active project room, so an
online Android service receives it through ordinary incremental sync and an
offline device receives only the current release on recovery. The artifact URL
is not a discovery API: Android accepts metadata only from the authenticated
MLP snapshot, then independently verifies the APK hash, identity, version, ABI,
and Android application-signing certificate before installation.

Android owns this process in its foreground connection service. The service
keeps `/sync`, raw-inbox persistence, projection, outbox reconciliation, and
task notifications running while the WebView is detached or the screen is
off. Opening the Activity reads the service-owned projection; it does not start
a separate catch-up protocol. Gateway/session timestamps, WebView focus, and
network visibility are never reasons to rescan recent thread history.

Browser-only PWA installations use standards-based Web Push when the user opts
in. The Gateway persists its VAPID key pair, per-device subscriptions, completed
event IDs, and a retrying notification outbox. `turn.completed` and
`turn.failed` are enqueued only after the command terminal is durable. Web Push
payload encryption protects a small routing payload in transit; it contains no
prompt, Agent output, session title, path, or attachment. A Service Worker may
wake while the PWA is closed, show a generic system notification, and route a
click to `#session=<id>`. A visible PWA suppresses the duplicate system popup
and the Service Worker persists a bounded `eventId` dedupe set. The UI continues
to use the authenticated Matrix projection as the source of truth. HTTP 404/410
responses remove expired endpoints; transient failures stay in the durable
outbox for retry.

## Encryption and device lifecycle

Matrix E2EE protects the Matrix transport. MLP/3 additionally encrypts project
payloads with a durable AES-256-GCM project key ring. The Gateway sends
one pairwise encrypted `io.malink.project.key_grant.v3` state event for each
trusted device. A client ignores grants addressed to other devices; they are
normal room state, not poison input.

Adding a device grants the retained project epochs needed for authorized
history. Revocation rotates the active epoch. A removed device may retain data
it legitimately decrypted earlier but cannot decrypt later events. Pairing
responses/rejections and signed Gateway Matrix-device rotation remain
pairwise control messages; they do not carry application session state.

Gateway enrollment is a separate, short-lived control exchange. An existing
authorized device sends `gateway.enrollment.invitation.create` under the same
certificate authority as `device.invitation.create`. The resulting signed
setup document contains only the public Workspace key, Matrix rendezvous room,
random challenge, and a one-time login token for the Workspace-owned Gateway
Matrix account. It MUST NOT contain the Workspace private signing key.

The enrolling node creates a fresh `gatewayNodeId` and temporary ES256 key,
then publishes a signed `io.malink.gateway.enrollment_request.v1` state event.
Clients display the verification code derived from the invitation challenge,
node ID, and temporary key. `gateway.enrollment.approve` is accepted only for a
persisted pending request. The issuer Gateway seals the high-authority
Workspace join bearer directly to that temporary key and publishes
`io.malink.gateway.enrollment_response.v1`; the private Workspace identity is
therefore never plaintext Matrix state. The enrolling node durably preserves
its request key until approval, verifies and opens the response, imports the
current root-signed Gateway directory and portable device grants from the
rendezvous room, creates one encrypted project room, and then deletes the
one-shot recovery material. Interrupted installation resumes the same request
and MUST NOT create a second project room.

All Gateway nodes share the Workspace authorization identity but retain unique
node IDs, Matrix device IDs, project rooms, working directories, and runtime
lifecycle. Clients verify one portable Workspace grant and consume the signed
Gateway directory; they do not pair with or switch between individual nodes.
The legacy `malink://gateway-join` bearer may be emitted only for offline
recovery because it directly contains the Workspace private identity.

Large attachments are encrypted before Matrix media upload and referenced by
signed metadata. Large visible text is split into deterministic bounded parts
with one logical message identity so recovery never depends on an oversized
single response.

## Rate and delivery budget

Traffic scales with visible business activity:

- one Matrix command event per user action;
- one canonical queued projection and one terminal event for a prompt; there is
  no separate durable `turn.started` transition;
- one bounded final tool-group snapshot per completed tool group; intermediate
  tool telemetry stays in the Gateway runtime and never enters Matrix;
- one snapshot event plus one pointer replacement when the current projection
  materially changes;
- one workspace snapshot plus one pointer replacement per active project when
  an account native-client release changes;
- one pairwise key-grant state event only when a device or key epoch changes.
- one root-signed Workspace directory/grant/revocation state write on the
  Gateway bootstrap control route when that semantic document changes, rather
  than one copy per project room.

There is no per-device fan-out for ordinary conversation output, heartbeat
state, focus refresh, reconnect RPC, session-directory page rewrite, or manual
checkpoint publication. Gateway invitation reconciliation reuses membership
from `/sync`; it does not poll every device in every project on a timer.
Identical signed snapshot pointers and root-signed
Workspace control documents are durably recognized across process restart; an
unchanged Gateway restart performs zero Matrix writes. Gateway and client
outboxes honor Matrix `retry_after` and stable transaction IDs, so homeserver
rate limits affect latency rather than correctness.

## Cutover invariants

- Production Gateway entry points instantiate only `MatrixMlp3GatewayRunner`.
- PWA production connection uses only `connectMatrixMlp3`.
- Android business projection accepts only MLP/3 project events. It does not
  parse MLP/2 Room State, `secure_envelope`, `secure_envelope_bundle`, or
  `timeline_envelope` as application data.
- No production composition root imports, emits, parses, or negotiates a MLP/1 or MLP/2
  application data event.
- Unsupported authenticated versions fail closed; they are never reinterpreted
  through another codec.
- Full Alpha acceptance requires disposable Synapse, two browser devices, a
  real installed Android target, Gateway restart-safe stores, background Agent
  completion and notification, reload/history restore, poison quarantine,
  cross-device convergence, and concurrent deletion.
