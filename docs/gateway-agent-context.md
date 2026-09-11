# Gateway agent context and MCP

The Matrix Gateway attaches a local `malink` stdio MCP server when it creates,
loads or resumes an ACP session. Release bundles include `mcp/stdio.js`; the
provider launches it with the release's Node runtime. No public MCP listener or
separate user configuration is required.

The MCP subprocess receives the fixed Malink session ID, session working
directory, Matrix channel marker and owner socket path. A provider session ID
is not needed for file delivery, including on the first turn. Restoring a
provider session does not enable legacy daemon tools.

## Agent awareness

Each Matrix ACP prompt starts with a short Malink host-context text block,
followed by the original user input and attachments. This is ordinary ACP
context, not a provider-specific system-message API. It is included each turn
so restored or compacted conversations receive the same guidance. The user
input stored by Malink is unchanged.

The MCP initialization response also carries server instructions. Agents do
not need to discover and read a resource before learning that the user is
remote or that local file paths are not delivered artifacts. If ACP recovery
continues without MCP, the prompt explicitly describes file delivery as
unavailable, alongside the existing user-visible recovery warning.

## Available surface

- `get_malink_context`: environment, session identity and cwd, rendering,
  commands and channel guidance. The corresponding resources use
  `malink://environment`, `malink://session`, `malink://rendering`,
  `malink://commands` and `malink://channel`. They do not expose the owner
  socket path or credentials.
- `send_file`: available with a bound Malink session and Gateway socket.
  `document`/`file` sends a downloadable attachment; `image` sends an image
  preview; `markdown` and `code` use the runtime's text rendering support.
- `privileged_exec`: remains conditional on the existing Privilege Helper
  configuration and approval flow.

File delivery follows the existing route:

```text
Agent -> MCP send_file -> owner socket -> Gateway.sendSessionFile
      -> TopicSession -> SemanticSessionRuntime -> Matrix channel/outbox
      -> signed, application-encrypted MLP attachment -> client projection
```

The destination comes from the MCP process's session binding, not tool-call
arguments. The owner socket remains a local owner-authority interface; this
binding is not a sandbox against an agent that already has unrestricted local
owner access. A queued result does not mean the recipient received or read
the attachment. The existing Gateway outbox owns retries.

Matrix MCP does not register legacy reminder, send-message, delivery-status,
retry-delivery or session-switching tools that depend on the Telegram daemon.
The legacy context resources remain isolated in `src/mcp/legacy`.

Native provider forks and authorized conversation-reference tools are separate
follow-up work. This surface does not advertise them until implemented.

## Verification

`mcp-stdio-gateway.test.ts` starts a real MCP subprocess and checks discovery,
server instructions, context resources and a session-bound image delivery
request through a test Unix socket. ACP recovery tests cover prompt injection,
rich input preservation and degraded MCP availability. Existing Gateway tests
cover runtime image delivery into encrypted Matrix events. Build validation
checks that the MCP entry exists in the production bundle.
