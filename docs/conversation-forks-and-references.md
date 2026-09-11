# Conversation branches and quotations

## User flows

To explore another approach, open an idle project conversation's details menu and
choose **Create branch**. This entry appears only when the provider's current ACP
handshake advertises native fork support. Confirm a name and the shared-files
explanation. Malink displays creation progress, opens the resulting conversation,
and requests its inherited history. Existing creation recovery handles reconnects
and reloads. Archive or delete the new conversation through its usual menu.

A branch uses the source's provider, model, reasoning, permission, controls and
extension settings. It forks the provider's current saved history, not a selected
historical message. Both conversations use the project's working directory;
branching does not create a Git branch, isolate files or revert changes. Scratch
sessions and cross-provider branches are not supported. Providers without native
fork support have no fallback that copies prompts.

To reuse an answer, choose **Quote…** beside an assistant answer's Copy action.
Preview the text, search for another open conversation in the same project with
the same provider, then choose **Add to draft**. Existing target draft text and
attachments are preserved. Review the quotation, add a request, and explicitly
send it. Removing the quotation from the draft cancels sharing. Cancel, Escape
and Android Back dismiss the dialog without changing a draft.

The quotation contains the source title, Malink session ID, message ID and exact
answer text as a block quote. It is a user-selected snapshot, not a live link,
whole-history import or permission to access the source. Files and images are not
copied. The source agent is not contacted. Quotes up to 12,000 characters are
supported; longer answers prompt the user to copy a shorter excerpt. Drafts stay
local until sent; sent quotations use ordinary encrypted conversation messages
and existing cross-device history synchronization.

The interface reuses the existing conversation menu and answer footer. Dialogs
scroll within the viewport, use 44px mobile actions, and offer searchable targets
rather than adding a permanent toolbar. An empty target list explains how to
create a suitable destination. Existing conversations need no migration.

## Implementation boundaries

- `session.create.forkFromSessionId` travels through validated PWA, MLP/3 and native
  Android command payloads. Gateway authorization and journaling remain mandatory.
- Gateway resolves the source within the command's project, requires an idle,
  active, persisted project session, and prevents prompts/lifecycle changes while
  its native fork is running. It obtains a distinct provider session ID, prepares
  history and restores a writable runtime before reporting success.
- ACP adapters use `sessionCapabilities.fork` and `unstable_forkSession`. The new
  session receives its own Malink MCP binding. No provider mutation is retried by
  the adapter.
- The native-fork ledger records intent before calling the provider and saves the
  resulting ID. Replaying a completed attempt reuses that ID. An interrupted
  attempt whose result is unknown is refused rather than creating another fork.
  If a native fork succeeded but later Malink preparation failed, provider history
  is the recovery surface; an orphaned native session may remain.
- Quote composition is client-side. This change adds no autonomous messaging,
  cross-session MCP reading authority, or cross-provider history conversion.

Gateway, PWA and Android should be released together: older Android validators do
not recognize the new command/capability fields. An older Gateway exposes no fork
capability, so a new PWA hides the branch entry.

## Verification

- Gateway integration verifies native source selection, writable restoration,
  command deduplication and restart recovery, alongside existing lifecycle tests.
- Provider/store tests cover advertised support, unsupported providers, distinct
  identities, the new MCP binding, completed-attempt reuse and ambiguous failures.
- Protocol tests cover both schemas and incompatible creation options; Android
  command/projection unit tests validate native compatibility.
- PWA tests cover quotation provenance, eligible targets and inherited-history
  creation recovery. Browser flow tests exercise actual dialogs at 390×844 and
  1280×900, including preview, search, editable draft, empty state and native Back.
- Gateway TypeScript/build checks and PWA production/static checks pass. PWA's
  full TypeScript check has existing baseline errors; this change adds none.

The installed codex-acp 1.10.0 source advertises and implements native fork via
Codex threadFork. Tests use a controlled provider; a live production session was
not forked. Small-screen browser and native unit coverage does not claim testing
on a physical Android device. No deployment or merge is part of this worktree.
