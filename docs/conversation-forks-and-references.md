# Conversation branches and references

## User flow

**Branch:** open a project conversation's details menu, choose Create branch,
review the shared-files explanation and confirm its name. Malink creates a native
provider branch, opens it when writable restore succeeds, and loads the inherited
history. Creation recovery survives reconnects/reloads. Unsupported providers show
a disabled entry with an explanation. Busy sources must finish before branching.
Both conversations use the same project files: this is not a Git branch or a file
rollback. Only the current saved provider history can be forked, not an arbitrary
message in the timeline. Archive/delete the branch through its usual menu.

**Quote an answer:** choose the quote icon beside Copy, preview the answer, search
for a target conversation, then select it. The target draft retains existing text
and attachments and receives an independent `@Title · Answer` chip. Click the chip
for a Markdown preview; remove it with ×. The quotation is not pasted into the
input box and nothing is sent until the user presses Send.

**Reference a whole conversation:** use @ in the composer to choose a source, or
Reference conversation in the source's menu to choose a destination. The draft
contains `@Title · Conversation`. Its preview explains the snapshot and can open
the source conversation. At send time, Gateway captures the full saved user and
assistant text; the target agent uses `read_conversation_reference` to read it in
pages. The source agent is not contacted. Subsequent source messages do not alter
the captured snapshot. The preview's Open source action opens the current source,
not a historical rendering of the saved snapshot.

Sharing files and both reference flows use `ConversationPicker`: the same search,
project/computer grouping, ordering, empty state and row presentation. The picker
fits desktop and Android small screens, uses scrollable results and supports
Escape and native Back without adding a permanent panel. References are visible
in sent user messages on other devices through the existing encrypted projection.
Unsent drafts follow existing local draft behavior; they do not sync across devices.

## Scope and provider capabilities

References are limited to another conversation in the same project and provider.
An answer reference retains its selected text and provenance (up to 12,000
characters). A message may carry up to eight references. Attachments and internal
reasoning/tool transcripts are not part of whole-conversation text references.
There is no cross-provider history conversion, automatic conversation messaging,
or implicit permission to inspect arbitrary sessions.

Native fork availability comes from a real ACP initialize handshake. The catalog
provider often has no connection, so Gateway probes a separate instance, caches
its result for that Gateway process and releases the probe. Fork execution checks
support again. No prompt-copy fallback is used. A transient failed probe is logged
and reports unavailable until Gateway restart.

Whole-conversation references require `AgentProvider.getReferenceHistory`, an
explicit full read-only capability. Codex implements this with native `thread/read`;
it bypasses preview limits of 256 messages/16 KiB per message and does not fall back
to writable ACP session/load. Other providers remain unsupported for whole-history
references until an appropriate read-only implementation is available. Answer
quotations remain available through the Malink MCP surface.

## Security, persistence and ownership

- Structured `prompt.references` passes through PWA, native validation, signed MLP/3
  commands and the Gateway command journal. UI titles and answer text are user
  selections, not independently authenticated proof of source authorship.
- Gateway verifies the source belongs to the same project/provider and is not the
  target or a deleted conversation. Only an accepted signed prompt can create the
  target's durable reference snapshot. User-facing text stays unchanged; Gateway
  adds the MCP reference IDs to provider input separately.
- Snapshots use individual atomically written local files with the existing
  owner-only store permissions. A replay reuses the reference ID and cannot replace
  its source/content. MCP reads bind the requesting session from host environment,
  check its grant and source availability, and return at most 16,000 characters
  with `nextOffset`. This supports long individual messages without truncation.
- Archived sources remain readable; deleted sources and inactive target sessions
  are refused. Sent grants last with their target/source availability; deleting a
  chip before sending creates no grant. Removing text after it was sent cannot
  retract information already read by an agent.
- The owner-only admin socket exposes the read route used by MCP. It adds no Matrix
  membership authority or unsolicited agent-to-agent messaging.
- Native fork intent is persisted before mutation. Completed attempts reuse their
  provider ID; an unknown result is never retried automatically. Provider history
  remains the recovery surface if native creation succeeds but Malink restore fails.

Gateway, PWA and APK require a coordinated release for new reference fields and
capabilities. Existing messages without references continue to render normally.
The earlier textual quotes remain ordinary text; there is no heuristic migration.

## Verification

Tests cover capability probing without a connected catalog, native fork identity
and MCP binding, full Codex history beyond preview limits, reference schemas,
per-target snapshot authorization/restart/pagination, MCP stdio routing, signed
Gateway prompts and unchanged display text, and desktop/small-screen UI flows.
The browser fixture exercises the actual shared picker, Markdown preview, editable
draft preservation, removal, empty state and native Back at 390×844 and 1280×900.
Android validator/projection tests and Gateway/PWA build checks are also run.

A real local codex-acp 1.10.0 initialize handshake returned native fork support.
No production conversation was forked or read as part of verification. Physical
Android device interaction and deployment are not claimed by the browser fixture.
