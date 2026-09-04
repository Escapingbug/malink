# Malink Protocol (MLP/3)

Status: version 3, pre-release hard cutover

**Malink Protocol (MLP)** is Malink's signed, encrypted application protocol.
The current version is written **MLP/3**. Matrix is its durable transport; a
Matrix room/event/sync version and a MLP version are separate concepts.

The MLP version marks a wire-compatibility boundary, not every semantic change.
Compatible additive behavior remains within the current version when old peers
can reject or ignore it safely and new peers retain a fallback. A version
increase is justified only when peers using the same version could otherwise
accept an unsafe or materially incompatible interpretation. Native-bridge
capability versions follow the compatibility-first policy in
[`architecture.md`](architecture.md#compatibility-first-protocol-versioning).

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
| Active session | one Matrix thread | immutable root event and signed lifecycle events |
| Restored provider history | one auxiliary encrypted room per restored session | signed reverse-append pages and committed frontiers; never execution authority |
| User prompt or mutation | ordinary `m.room.message` command event | device signature, certificate, stable `command_id` |
| Agent/tool/status output | ordinary `m.room.message` thread event | Gateway signature and stable logical `event_id` |
| Current project projection | ordinary signed snapshot event | `io.malink.project.current.v3` points to its physical event ID |
| Current native client release compatibility copy | account-owned workspace snapshot field | Gateway admin publication and display-only catalog data; Android update discovery uses the selected static service |
| Gateway release status | account-owned workspace snapshot field plus command result | pinned release signer and local update supervisor |
| Project key grant | directly addressed Room State | `io.malink.project.key_grant.v3` keyed by device ID |
| Transcript and audit | thread timeline and relations | append-only signed events |

One execution room represents exactly one project. Project identity therefore
does not need to be repeated as visual grouping metadata in every session row,
and a session cannot silently move between projects. A recovered-history room
is an explicitly bound, non-execution auxiliary room; it does not change the
project-room or thread authority. Matrix Spaces may organize rooms later
without changing the room/thread protocol.

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
published and stops ordinary transport retransmission. Signed Gateway progress
may follow, and only a signed terminal event completes the command.

If a published command still has no signed terminal, a client may send the
exact saved Matrix content under a fresh transaction ID prefixed
`malink.v3.reconcile.<command_id>.` while bounded Matrix timeline recovery
continues as a compatibility fallback. Timeline pagination MUST NOT gate this
journal probe: an old or slow timeline cannot be allowed to strand an accepted
command. This is a journal reconciliation probe, not a new command: the client
MUST NOT change the signed command, ciphertext, logical ID, or application
payload. Only one reconciliation may be in flight for one command, and another
probe MUST use bounded exponential backoff. The Gateway deduplicates it before
dispatch and emits one idempotent signed `command.reconciled` event per recorded
journal state, regardless of how many equivalent physical probes arrive. Its
state is `accepted`, `running`, or `terminal`;
a terminal event includes the journal's durable outcome and structured result
or error. Clients complete the original outbox record from that event. This
additive event does not change the MLP version because old clients never send
the probe and old Gateways safely leave new clients on the existing
timeline-recovery fallback. Native hosts advertise the optional
`commands.journal-reconciliation` bridge capability so a newer PWA does not
claim this recovery path when hosted by an older APK.

The native outbox resumes queued sends and transport-uncertain sends without a
WebView. Published/running commands rely on the Matrix SDK timeline unless a
foreground caller explicitly requests one bounded journal reconciliation; the
native service MUST NOT loop that probe or scan history on an idle background
timer. A missing terminal remains nonterminal, and clients MUST NOT synthesize
success. They MAY retire a record only with a duplicate-execution tombstone and
evidence that cannot conceal Matrix acceptance: deterministic local envelope
failure, an authoritatively removed project route, or a matching authoritative
session lifecycle that already satisfies the idempotent lifecycle request.

`gateway.update.status` is a read-only observation. Clients may reuse one
unfinished same-project probe for at most two minutes to coalesce overlapping
checks. After that window, or after a native process restart, the old identity
is tombstoned and a new check uses a fresh identity. This bounded observation
rule MUST NOT be applied to business mutations.

The Gateway commits each accepted `command_id` to a durable command journal
before execution. Exact re-delivery returns the recorded state through
`command.reconciled` and never runs the operation twice. Independent append
operations such as prompts are serialized by the Gateway; state-dependent
mutations carry explicit preconditions and produce a reviewable conflict
instead of hidden client-side retry.

Session creation, prompt, cancel, settings, provider-history inspection,
artifact materialization, and archive use this same path. A create command
produces an immutable thread root.
The provider is selected only by `session.create` and is immutable for the
life of that Malink session. `session.create`, `session.update`, and
`project.update` may carry a bounded `controls` map whose values are strings or
booleans. The Gateway accepts only controls advertised by that Provider for the
corresponding `session-create`, `session-active`, or `project-default` surface.
When `session.create.controls` is present, it is the complete selection for
currently editable `session-create` controls; omitted entries use the Provider
default instead of silently restoring a project override. Controls whose
discovery is loading or failed continue to inherit the last project value.
Standard model, reasoning, and permission values retain their legacy fields for
mixed-version peers; the generic map is authoritative for newly advertised
controls. The Gateway applies active changes through the provider's structured
ACP model/config surface rather than manufacturing provider-specific slash
commands.

`workspace.snapshot.capabilities` may advertise declarative Provider controls
using the shared `select`, `segmented`, `toggle`, and `text` renderers. A
Provider MUST omit unsupported controls. Discovery uses separate `loading`,
`ready`, `stale`, and `error` states: loading includes a deadline, while stale
and error descriptors include a bounded diagnostic code/message and may include
sanitized detail and retry timing. Session projections may add or replace
session-only descriptors after ACP initialization. Clients render only the
descriptors for the current surface and MUST NOT infer an unsupported model or
reasoning control from an empty catalog exposed by a current Gateway.

`project.update` atomically stores the display name, Provider control values,
and extension bindings used by later sessions for the project's default
provider. When its `controls` field is present, it replaces the values of all
currently editable `project-default` controls while preserving controls whose
discovery is loading or failed. Its one signed terminal `project.snapshot` is also the new ordinary
timeline snapshot; the Gateway updates the current-snapshot Room State pointer
to that same event instead of publishing a duplicate timeline message.
Provider-native slash commands remain user messages. When ACP publishes
`available_commands_update`, clients may render those commands as actions that
insert the corresponding slash input; Malink does not take ownership of
provider commands such as `/model`.

`project.delete` durably stops execution for that project and emits one signed
`project.deleted` terminal event. It removes the route from the Gateway catalog
and verified client projections, then retires the project room by removing
ordinary membership and aliases and making the Gateway leave and forget it.
Deletion is rejected while any Malink session record remains. It does not erase
the fixed working directory or provider-retained conversations. Standard
Client-Server APIs redact/retire Matrix data but do not promise physical purge
from a homeserver database. The stable bootstrap control route cannot be
deleted, and a Gateway always retains at least one project route. Deletions
share one Gateway-wide lane so concurrent commands cannot both pass that
invariant. Existing `project.settings` certificate authority covers both
update and deletion, preserving already-issued device certificates.

Project management has a bounded transport budget: one client command and one
Gateway terminal timeline event per operation. Settings additionally updates
one idempotent current-snapshot pointer; deletion republishes one signed
Workspace Gateway Directory state on the stable control route. Durable client
and Gateway outboxes retry the same command/event transaction IDs under Matrix
429 responses; retries never split an operation into more semantic messages or
fan out snapshots across every project room.

`gateway.retire` is the user-confirmed Workspace fallback for a computer that
cannot be restored. A client sends it through a verified project owned by a
different Gateway and includes the target `gatewayNodeId`, the exact signed
directory revision, and the observed Gateway key ID. The receiving Gateway must
reject self-retirement and stale preconditions. Success writes the signed
directory tombstone before returning one constant-size `gateway.retired`
terminal event with only the node ID, removed-project count, and revision;
clients then remove projects absent from the new directory from their local
projection. Matrix presence, a liveness timeout, and local UI state can never
authorize this mutation. This is an additive MLP/3 operation, not a wire-version
change.

Provider-owned history is a separate surface. `provider.sessions.list` lists
the sessions still retained by a configured provider and
`provider.session.inspect` returns a bounded read-only transcript preview.
History results are bounded before they enter the command journal so their
signed, encrypted envelope always fits the Matrix timeline budget. A session
list may return the existing optional `nextCursor`; clients request each page
with a new command and concatenate the results. This is an additive MLP/3
capability, not a protocol-version change. Transcript previews retain the most
recent messages that fit the same transport budget. The durable journal reader
also recognizes the narrow pre-pagination Provider History shape whose
provider-owned title, path, or message fields exceeded current bounds. It
validates the rest of the MLP/3 event, normalizes only those known fields for a
new bounded recovery event, and never re-executes or silently deletes the
historical command.
Creating a session with `providerSessionId` adopts that existing provider
conversation. Current clients settle `session.create` first, then submit the
first locally persisted message as an independent `prompt.submit` command. This
keeps session creation and Agent execution as two separately recoverable command
identities. The optional create-command `initialPrompt` remains accepted only as
a compatibility path for already-installed clients. A provider session already
managed by an active Malink session opens that session instead of creating a
duplicate.

Provider continuation uses one auxiliary history room per restored Malink
session. During `session.create`, the Gateway reads the provider transcript once
and stores an immutable local snapshot plus its digest; it does not copy the
whole transcript into Matrix. The session projection carries the auxiliary room
binding, snapshot ID, `reverse_append_v1` ordering, and materialized frontier.
When an explicit older-history load reaches that frontier, the client sends
`provider.history.materialize` in the project room. The Gateway writes a bounded
page from newest toward oldest as signed, application-encrypted
`provider.history.message` events, then writes
`provider.history.page.committed`. Message roles preserve the provider-side
speaker identity. Stable logical IDs and frontier preconditions make retries
idempotent. Existing pages come from Matrix/local projection; later page loads
continue from the Gateway snapshot and do not repeat the provider RPC. Normal
continued conversation remains chronologically ordered in the project thread.

## Turn lifecycle and delivery boundary

One turn uses the existing bounded MLP/3 lifecycle:

- `turn.queued` means the signed command is in the session lane and the Gateway
  may be preparing the provider;
- `turn.started` is emitted at most once, after the provider emits its first
  turn event, so clients no longer present provider startup as active work;
- `turn.completed` or `turn.failed` is the only terminal transition. A stopped
  turn completes with `outcome: cancelled` under the original prompt command
  identity, and the separate `turn.cancel` command receives a matching terminal
  result only after that original turn has settled.

An ordinary Agent turn is not failed merely because a fixed wall-clock duration
has elapsed. The provider result or an authenticated `turn.cancel` owns its
terminal transition; bounded provider startup, interrupt and cleanup waits are
local runtime safeguards. Agent-driven Gateway maintenance uses an independent,
configurable safety deadline. This execution-policy change does not alter MLP/3
wire schemas or require a protocol-version change.

The execution terminal is durable once semantic output and the terminal event
have been staged in the Gateway's local outboxes and command journal. It does
not wait for every staged assistant/tool event to receive a physical Matrix
event ID. Matrix 429 backoff and retry therefore remain delivery state instead
of keeping the Agent runtime falsely active. Stable logical IDs, outbox
ordering, and client projection make delayed delivery safe; no status polling,
heartbeat, or per-provider startup event is added.

Malink has one session-removal action: archive. The command name and accepted
legacy lifecycle values remain wire-compatible, but successful archive emits
`session.lifecycle(state=deleted)` after durably recording an internal
`archived` cleanup checkpoint and detaching the executable runtime. That
constant-time logical boundary owns the command result; it never waits for
provider shutdown or O(history) Matrix work. A resumable background task then
redacts the Matrix thread, retires the session's auxiliary history room,
removes local snapshot/scratch data, and finally drops the checkpoint. Progress
is persisted after each destructive stage, and Gateway shutdown aborts Matrix
cleanup between idempotent requests. A restart resumes only checkpoints that
carry a prior authenticated user cleanup request, without delaying Gateway
availability or making the deleted session reappear. Tombstones produced by
older releases remain available for an explicit archive retry and do not begin
unsolicited Matrix migrations merely because software was upgraded. Archive
never invokes provider-level delete or removes the project working directory;
provider-owned conversations remain continuable from Provider History under a
new Malink session identity. The checkpoint binds the authenticated archive
command ID, so a crash between its state commit and command-journal settlement
recovers that same command as succeeded instead of reporting an ambiguous
failure or executing it twice.
Pre-release `delete` requests are normalized to archive and `restore` is
rejected for compatibility.

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
signer. Results use `gateway.update.status`. Supervisor phase changes may also
produce one uncaused `gateway.update.status` event so active clients converge on
the semantic update state. An unchanged Gateway emits no heartbeat. Visible,
network-connected clients use the causation-bearing command reply for current
liveness and stop probing immediately when hidden or disconnected.

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
command. Published commands remain attached to SDK timeline delivery. Only an
explicit foreground recovery action may issue the exact-content reconciliation
probe described above and read one bounded compatibility page. The UI exposes
the saved command ID and stage, explains whether Matrix or the Gateway is
unavailable, and offers explicit check, reconnect, and diagnostic actions.

Offline clients show their last verified encrypted local projection and
history. They do not report Connected or release new commands until the Matrix
transport and authenticated MLP/3 projection are writable.

The Gateway may persist the latest native client release per platform,
channel, and architecture as compatibility catalog data in `workspace.snapshot`.
That field is not an Android update-discovery API and cannot mutate native
updater state. Android reads bounded metadata only from the selected static
service, then accepts only a same-service immutable path or the exact
fixed-version `Escapingbug/malink` GitHub Release shape. It independently
verifies the APK hash, identity, version, ABI, and Android application-signing
certificate before installation.

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

An approval response is durable Matrix state. Once it has been published,
clients MUST stop presenting that request as an approvable action; repeating
approval cannot repair a local Host activation failure. Enrollment is complete
only after the new Gateway Host starts from that exact data directory,
publishes its signed Workspace directory entry, and proves live Matrix health.
On macOS, `malink gateway join ... --activate-host` atomically switches the
installed Gateway and update-supervisor LaunchAgents to the enrolled directory.
It preserves the former data directory, refuses to interrupt active work, and
restores the previous LaunchAgent configuration if the new node does not become
Matrix-ready. A completed enrollment can resume only that final step with
`malink gateway activate-host --gateway-data-dir PATH`; it does not require a
new invitation or another approval.

The signed Workspace directory, rather than an optional local PWA credential,
defines the fixed client Matrix identity after enrollment. Portable device
grants imported with the approval are sufficient to start serving existing
authorized clients. If the Host has no matching PWA credential, it disables
only the creation of client invitations that require a one-time Matrix login;
it MUST NOT fail Gateway activation or adopt a mismatched credential identity.

`gateway.enrollment.cancel` is an additive MLP/3 administration operation for a
persisted pending request. The issuer marks the request cancelled idempotently,
publishes a sealed cancellation through the existing enrollment-response state
event, and republishes the Workspace snapshot. The enrolling node verifies and
opens that response, deletes its one-shot request key, and exits without a
Workspace grant. The initiating client records a local dismissal immediately,
so an offline issuer or stale Matrix snapshot never blocks another setup link;
the signed `expiresAt` remains the bounded fallback. Approved enrollments cannot
be cancelled through this operation and must use normal Gateway retirement.

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

An installed session extension may project a passive client-application entry
inside `assistant.message.ui`. The encrypted entry contains a registered
extension ID, a registered route ID, and an opaque extension-owned resource
reference; it never contains an executable URL or embedded code. Clients
resolve the route only against the extension descriptor in the authenticated
project projection. Opening the entry is local presentation behavior and has
no MLP/3 execution authority. The integrated application owns its own E2EE
transport and receives no Matrix credential, project key, or implicit access
to Malink content.

An Agent Markdown local path may be rewritten only by the owning Gateway to an
opaque `malink-artifact:` destination after canonical-path containment and stat
checks. The original `assistant.message` carries at most ten encrypted
reference records. A small safe raster image may additionally carry its signed
attachment descriptor in that same event. Other references are lazy: the
client displays projected stat metadata first, then an explicit confirmation
sends exactly one `artifact.materialize` command with the reference ID and
expected stat revision. If the file changed, the terminal event is a
higher-version replacement with new stat metadata and no upload. Otherwise it
is the same replacement with the encrypted attachment descriptor. The
replacement's `artifact_materialization` UI marker makes it both the logical
message update and the signed command terminal; no separate ack or progress
event is permitted.

## Rate and delivery budget

Traffic scales with visible business activity:

- one Matrix command event per user action;
- zero extra events for artifact stat display; one confirmed artifact command
  and one higher-version assistant replacement, with media 429 retries kept
  off-timeline;
- one canonical queued projection, at most one existing `turn.started` event,
  and one terminal event for a prompt; provider-internal startup phases and
  delivery retries create no additional timeline events;
- one bounded tool-group snapshot when current work first becomes visible, at
  most one coalesced progressive replacement per ten-second window while its
  visible state changes, and one terminal snapshot when the group completes;
  raw high-frequency tool telemetry stays inside the Gateway runtime;
- one snapshot event plus one pointer replacement when the current projection
  materially changes;
- one workspace snapshot plus one pointer replacement per active project when
  an account native-client release changes;
- one pairwise key-grant state event only when a device or key epoch changes.
- one root-signed Workspace directory/grant/revocation state write on the
  Gateway bootstrap control route when that semantic document changes, rather
  than one copy per project room.

There is no per-device fan-out for ordinary conversation output, background
liveness, focus refresh, reconnect RPC, session-directory page rewrite, or
manual checkpoint publication. Gateway invitation reconciliation reuses membership
from `/sync`; it does not poll every device in every project on a timer.
Identical signed snapshot pointers and root-signed
Workspace control documents are durably recognized across process restart; an
unchanged Gateway restart performs zero semantic snapshot or liveness writes.
Gateway and client outboxes honor Matrix
`retry_after` and stable transaction IDs. The Gateway also carries the observed
account refill interval forward to pace later room writes, so homeserver rate
limits affect latency rather than forming a repeated-429 feedback loop.

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
