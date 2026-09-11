# Session Extensions

## Product boundary

Malink provides a generic, trusted session-extension platform. It does not
implement privacy policy, entity detection, mappings, reverse mappings,
privacy models, vaults, audit records, preview wording, or the meaning of an
extension action.

An extension owns that behavior and talks to the Gateway through a small local
HTTP protocol. Malink owns only:

- administrator-controlled discovery and authentication;
- project defaults and session bindings;
- extension lifecycle and hook ordering;
- pausing and resuming a turn while an interaction is shown;
- bounded declarative UI rendering and action routing;
- timeout, validation, persistence, and fail-closed behavior.

The resulting runtime flow is:

```text
channel input
  -> SemanticSessionRuntime
  -> each bound extension: prepare turn
       ready ------------------------------+
       interaction required -> show View   |
                              -> return action ID to the same extension
                              -> ready/cancel
  -> AgentProvider / ACP                    |
  -> canonical ConversationEvent journal   |
  -> each bound extension in reverse order: present event
  -> ChannelProjector -> channel
```

With no bindings, the extension host is an exact pass-through. Provider events
are journaled before presentation hooks, so display-time transformations do not
rewrite the canonical provider history.

## Extension granularity

An installed extension is available to a project, while the effective binding
belongs to a session:

```text
installed extension manifest
             |
             v
project.defaultExtensions       <- template for future sessions
             |
       snapshot at create
             v
session.extensions              <- independent effective binding
```

- A project default is only a creation template. Updating it does not mutate
  existing sessions.
- Creating a session without an explicit extension selection copies the current
  project defaults.
- Creating a session with an explicit list, including `[]`, uses that exact list.
- A user may later change one session's binding. Malink invokes the old
  extension lifecycle with `replace`, recreates the runtime, increments the
  session extension revision, and starts a fresh provider conversation. This
  prevents protected and unprotected content from sharing one provider context.
- Provider or model changes never silently add or remove bindings.

Only the binding is persisted by Malink:

```ts
interface SessionExtensionBinding {
  id: string
  config?: Record<string, JsonValue>
}
```

Extension secrets and mutable extension state remain in extension-owned
storage. Config intended to be secret must be represented by an opaque
extension-owned identifier rather than placed in a binding.

## Discovery and trust

Extensions that transform prompts or events can see content at their declared
hook boundary and are therefore highly privileged. Installation is a local
Gateway administrator action. A PWA or Matrix command can select an advertised
extension and submit manifest-declared settings, but cannot register code, an
endpoint, or a bearer token.

At startup the Gateway connects to each configured loopback endpoint and calls:

```http
GET /v1/manifest
Authorization: Bearer <shared secret>
```

The extension owns and returns its descriptor:

```json
{
  "protocolVersion": 1,
  "descriptor": {
    "id": "example-extension",
    "name": "Example extension",
    "description": "Transforms a session for an extension-owned purpose.",
    "version": "1",
    "settings": [],
    "clientIntegration": {
      "origin": "https://app.example-extension.test",
      "bridgeVersion": 1,
      "routes": [
        { "id": "artifact.preview", "path": "/embed/preview" }
      ],
      "capabilities": ["host.close"]
    }
  }
}
```

This avoids duplicating extension metadata in Malink configuration. An
optional `expectedExtensionId` pins the discovered identity. Registrations are
loopback HTTP only, bearer tokens must contain at least 32 bytes, and a missing
or invalid manifest fails Gateway startup rather than installing a partially
known extension.

## Turn and presentation protocol

The Gateway calls the following authenticated extension-owned endpoints:

| Endpoint | Responsibility |
| --- | --- |
| `POST /v1/turns/prepare` | Pass through, transform, block, or request an interaction before provider egress. |
| `POST /v1/interactions/respond` | Receive the user's opaque action ID and return a ready or cancelled result. |
| `POST /v1/events/present` | Transform or suppress normalized provider events before channel rendering. |
| `POST /v1/sessions/lifecycle` | Observe `archive`, `delete`, `replace`, or `shutdown`. |

A ready preparation returns the provider input and may return an opaque
`stateRef` for later presentation calls. An interactive preparation returns a
short-lived opaque `preparationToken`, a declarative `view`, and a
`cancelActionId`. Malink renders the view, routes exactly one selected action
ID back with the token, and continues only if the extension returns `ready`.
Malink never interprets action names such as `send`, `retry`, or `reveal`.

Bound extensions are composed in binding order for input and reverse order for
presentation. If any bound extension times out, is unavailable, or returns an
invalid response, the affected operation fails closed. Unbound sessions remain
unaffected.

## Declarative UI contract

Extensions cannot inject JavaScript or channel-specific components. View V1 is
a bounded data model rendered natively by each Malink client:

```ts
interface SessionExtensionView {
  version: 1
  title: string
  elements: Array<
    | { type: 'status'; tone: 'info' | 'success' | 'warning' | 'error'; text: string }
    | { type: 'text'; text: string }
    | { type: 'readonly_textarea'; label: string; value: string }
    | { type: 'list'; label?: string; items: string[] }
  >
  actions: Array<{
    id: string
    label: string
    style?: 'primary' | 'secondary' | 'danger'
  }>
}
```

V1 permits at most 16 elements, 8 actions, and 16 KiB for the whole view. An
action ID is a bounded opaque protocol value, not a Malink enum. One action
must be designated as cancellation. Read-only text areas are capped at 8 KiB
and support exact extension-owned previews such as a sanitized prompt.

The PWA renders the full card. Telegram renders the same semantic content as
escaped text plus inline buttons. Android receives the same MLP/3 interaction
event through its native projection. Resolution is a persisted MLP/3 event, so
other devices replace the pending control with the selected outcome instead of
leaving a stale actionable UI.

## Client application integration

An extension may optionally register one HTTPS client application and a
bounded set of routes in `descriptor.clientIntegration`. The descriptor comes
from the administrator-installed, loopback-authenticated extension process and
is published in the signed, application-encrypted project projection. A
conversation event can therefore name only an extension ID, registered route
ID, and opaque resource reference; it cannot inject a URL.

An extension returns a passive entry from `/v1/events/present` as an ordinary
normalized conversation event:

```json
{
  "kind": "integration_entry",
  "meta": {
    "id": "event-1",
    "sessionId": "session-1",
    "turnId": "turn-1",
    "provider": "agent",
    "seq": 1,
    "timestamp": 1,
    "sourcePhase": "live"
  },
  "presentation": {
    "kind": "integration_entry",
    "version": 1,
    "integrationId": "example-extension",
    "routeId": "artifact.preview",
    "resourceRef": "opaque-extension-owned-reference",
    "title": "Project report",
    "description": "Open the protected report in the extension application.",
    "actionLabel": "Open report"
  }
}
```

The integration ID MUST equal the presenting extension ID. Malink validates
the entry, publishes it as bounded `assistant.message.ui` inside MLP/3, and
shows a passive card. Opening the card is local navigation; it is not an MLP
command, does not resolve an extension interaction, and cannot mutate Agent
execution state.

The PWA resolves the route against the installed descriptor, opens it in a
cross-origin sandboxed iframe, and sends the resource reference only after the
frame loads. The reference is transferred through a dedicated
`MessageChannel`; it is never placed in the iframe URL, referrer, cleartext
Matrix message fields, or server access logs. The launch message is:

```ts
interface ClientIntegrationLaunchMessage {
  protocol: 'io.malink.client-integration'
  version: 1
  type: 'launch'
  integrationId: string
  routeId: string
  resourceRef: string
  resourceVersion?: string
  environment: {
    locale?: string
    colorScheme?: 'light' | 'dark'
  }
}
```

Without `host.crypto`, the transferred port accepts only exact `close` or `back` messages, and only
when the manifest declares the matching `host.close` or `host.back`
capability. Locale and color scheme are likewise omitted unless the manifest
declares `host.read-locale` or `host.read-theme`. Both navigation messages
return to the originating conversation in V1. The integrated page must use a
different origin from Malink, allow the approved Malink origins in its CSP
`frame-ancestors` policy, validate the initial `message` event origin, and use
the transferred port for subsequent messages. V1 does not expose Matrix
credentials, MLP project keys, local files, conversation projection access,
arbitrary navigation, or command execution to the embedded application.

By default the integrated application owns its page, authentication, data model,
and E2EE synchronization. The optional `host.crypto` capability below delegates
device authorization and extension-scoped encryption to Malink. Malink transfers only the opaque reference. If content
exists solely in Malink, sharing it with the application requires a separate,
explicit cross-security-domain authorization; a client integration entry does
not grant that access implicitly.

## Project and MLP/3 protocol state

Project snapshots advertise:

- installed extension descriptors;
- `defaultExtensions`;
- `extensionDefaultsRevision`.

Session snapshots advertise safe extension summaries and
`extensionRevision`; `session.ready` also contains the exact normalized
bindings. `project.update` changes the project template. `session.create`
captures it when extensions are omitted. `session.update` changes only that
session.

Old persisted MLP/3 records migrate to empty project defaults and empty session
bindings. Existing unbound behavior is unchanged.

## Extension ownership and verification boundary

Malink does not bundle a first-party extension implementation. Extension
projects own their implementation, packaging, model or service dependencies,
state, policy, integrated client page, independent E2EE service, and
implementation-specific tests. They consume the protocol
published by Malink and may run their own compatibility and product acceptance
suites against a Malink Gateway.

Malink's conformance tests use in-memory, implementation-neutral fixtures such
as `prefix-transform` and `review-gate`. They verify the host lifecycle,
authenticated loopback HTTP boundary, declarative interaction routing,
provider isolation, persistence, and fail-closed behavior without starting or
requiring any external extension process.

## Malink-managed extension E2EE

An installed extension may opt into `host.crypto` in its
`clientIntegration.capabilities`. The Gateway, browser host and Android native
service then provide extension-scoped encryption. Project and session IDs are
not key scopes. All projects served by the same extension crypto authority use
the same extension identity and key ring. Other extensions and Malink's main
MLP data use independent keys.

The local Gateway extension process and the client application are the
plaintext endpoints. An extension's remote storage/synchronization service
stores only ciphertext. The extension still owns its data model, storage,
resource lookup and synchronization. A remote server given plaintext or keys
is itself a trusted endpoint, not a blind E2EE storage service.

### Local extension server

Use `ExtensionCryptoServer` from `@malink/security/node` on the extension's
existing loopback-only authenticated HTTP server:

```ts
import { ExtensionCryptoServer } from '@malink/security/node'

const encryption = new ExtensionCryptoServer(extensionId, bearerToken)

// Route POST /v1/crypto/configure to this Fetch-compatible handler.
async function configure(request: Request): Promise<Response> {
  return encryption.provision(request)
}

// Inside extension hooks, after Malink has provisioned encryption:
const ciphertext = await encryption.crypto.encrypt(JSON.stringify(document))
await storage.put(resourceRef, ciphertext)
const document = JSON.parse(await encryption.crypto.decrypt(ciphertext))
```

The bearer token is the existing administrator-configured secret, not a new
client credential. The SDK checks the token and exact extension identity.
The Gateway provisions before hooks and grants, and fails closed on unavailable
or invalid provisioning. The extension retains its scoped key ring only in
its own process memory; it never receives Workspace or device private keys,
Matrix credentials, or MLP project keys. HTTP redirects are forbidden.

### Embedded extension client

Use `connectExtensionCrypto` from `@malink/security`. Accept the launch message
only from an explicitly approved Malink origin and `window.parent`, validate
it with `clientIntegrationLaunchMessageSchema`, and require the expected
integration ID before using its transferred port:

```ts
import { clientIntegrationLaunchMessageSchema } from '@malink/protocol'
import { connectExtensionCrypto } from '@malink/security'

window.addEventListener('message', async event => {
  if (event.source !== window.parent || !allowedMalinkOrigins.has(event.origin)) return
  const parsed = clientIntegrationLaunchMessageSchema.safeParse(event.data)
  if (!parsed.success || parsed.data.integrationId !== extensionId || event.ports.length !== 1) return

  const encryption = await connectExtensionCrypto(event.ports[0])
  const ciphertext = await storage.get(parsed.data.resourceRef)
  const document = JSON.parse(await encryption.decrypt(ciphertext))
  // Render document. Call encryption.close() when this client is disposed.
})
```

The host binds the capability to the installed descriptor and that frame load;
requests cannot select another extension ID. Keys stay in the browser host or
Android native service. Android negotiates the optional `extensions.crypto`
v1 capability; older APKs must update to use encryption. The SDK offers
`identity`, `encrypt(string)`, `decrypt(envelope)` and `close()`. Strings may be
empty; the encoded plaintext limit is 128 KiB per operation. Binary streaming,
resource ACLs and arbitrary signing/key-export APIs are not provided.

### Key grants and lifecycle

`extension.crypto.grant` is a typed, signed, application-encrypted MLP/3
command, journaled and authorized before execution. Its project ID is only a
transport route. Full Workspace members inherit the operation; restricted
devices require an explicit `extension.crypto.grant` certificate capability.
The Gateway also rechecks current device trust, certificate and extension
installation at execution. An installed extension with `host.crypto` grants
access to its complete crypto domain, regardless of session bindings.

The host generates an ephemeral RSA-2048 key pair. The signed command binds
the public key and a unique request ID. The terminal `extension.crypto.granted`
event contains a fresh AES-256-GCM key wrapped using RSA-OAEP with SHA-256 and
MGF1-SHA-256, plus the AES-GCM-encrypted extension key ring. The authenticated
MLP event is the grant's sender authentication; the standalone grant must never
be accepted from an unverified remote service. Other project-room recipients
cannot unwrap the grant. Ephemeral private keys are never journaled or sent
through the WebView. Reopening after host/process loss creates a fresh request.

Data encryption uses AES-256-GCM, random 96-bit nonces and 128-bit tags.
Canonical JSON of the full envelope header is authenticated as AAD. The header
binds kind, version, extension ID, random crypto domain ID, key epoch and nonce.
There is no Workspace, project or session field in the data envelope.
Authentication proves possession of the shared extension key, not which device
wrote a value. Applications requiring writer attribution or latest-version
checks must keep references in authenticated Malink events or provide their
own synchronization semantics. A valid historical ciphertext is replayable.

Host handles expire after five minutes. The frame host obtains fresh grants
on subsequent operations after four minutes; closing/reloading the frame
releases its handle. Sign-out/disconnect clears host handles. No persistent
client-side/offline extension key cache is introduced. Grant acquisition and
renewal require an available Gateway.

The authority records eligible device/certificate/public-key recipients. When
it next provisions a hook or a grant after recipients lose authorization, it
creates a new random epoch and retains historical keys. Revoked devices cannot
receive new epochs. Already obtained plaintext and old keys cannot be recalled;
old handles may still encrypt/decrypt old-epoch data until they close or expire.
Readers holding an older epoch must reconnect to read newly rotated data.
Up to 128 epochs are retained; exhaustion fails closed rather than deleting
history. Uninstalling an extension stops new grants and does not erase its
stored identity.

### Authority storage and process isolation

The default authority store is `extension-crypto.json` in the Gateway data
directory, created with owner-only permissions. `MALINK_EXTENSION_CRYPTO_FILE`
can select an existing authority store. Back up this file securely: generating
a replacement identity cannot decrypt data encrypted by the lost identity.
It contains independent random keys, never derivatives of the Workspace
signing key or MLP project keys.

A separately installed Gateway has a separate authority store by default.
Gateway enrollment does not replicate these extension keys. To operate multiple
Gateway processes as one extension encryption authority, explicitly configure
the same authoritative store on a filesystem supporting its atomic locks and
provide the same device authorization population. Do not operate independently
writable copies: they can diverge or rotate inconsistently. Cross-machine
replication/transfer and merging existing domains are not implemented here.
This is an authority-deployment limitation, not a project/Workspace key scope.

The existing local extension model trusts administrator-installed processes.
A same-user process able to read Gateway private files can bypass SDK isolation.
Use separate OS identities or a sandbox to protect against malicious local
extensions. This SDK enforces cryptographic and bridge namespace separation;
it does not create an OS process sandbox. An authorized extension can read and
exfiltrate its own plaintext, including plaintext returned by host decryption.
