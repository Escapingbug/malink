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

The transferred port accepts only exact `close` or `back` messages, and only
when the manifest declares the matching `host.close` or `host.back`
capability. Locale and color scheme are likewise omitted unless the manifest
declares `host.read-locale` or `host.read-theme`. Both navigation messages
return to the originating conversation in V1. The integrated page must use a
different origin from Malink, allow the approved Malink origins in its CSP
`frame-ancestors` policy, validate the initial `message` event origin, and use
the transferred port for subsequent messages. V1 does not expose Matrix
credentials, MLP project keys, local files, conversation projection access,
arbitrary navigation, or command execution to the embedded application.

The integrated application owns its page, authentication, data model, and
E2EE synchronization. Malink transfers only the opaque reference. If content
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
