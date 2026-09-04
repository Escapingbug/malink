# Setup and Settings product model

This document defines the user-facing model for joining, reconnecting, signing
out, and maintaining a Malink Workspace. Product copy and controls should use
this model even when the implementation uses Matrix, MLP, or Gateway-specific
terms internally.

## The three things a user manages

1. **Workspace** — the durable projects, conversations, authorized members, and
   computer directory shared by the user.
2. **This device** — the current browser or Android installation and its own
   authorization to the Workspace.
3. **Workspace computer** — a Mac or other host that runs the Gateway, projects,
   and Agents for authorized devices.

A network connection is a temporary condition, not another object the user must
manage. “Matrix” and protocol identifiers belong in advanced details and
diagnostics, not in primary status or action labels.

## Primary setup journeys

### Add this device

An existing authorized device or Workspace computer creates a one-time
invitation. The new device imports, scans, or pastes it, verifies the Workspace
and matching code, and then completes these visible stages:

1. Invitation verified
2. This device signed in
3. Protected connection established
4. Computer authorization received
5. Workspace synchronized

The setup view remains open until it reaches either a recoverable error or an
explicit success screen. Success is not represented only by a disappearing
dialog or transient toast.

### Add another device

The action lives under **Devices**. It creates a one-time invitation that grants
only the new device its own authorization; it does not copy an existing
device’s private key.

### Add a Workspace computer

The action lives under **Computers**. It creates a one-time setup command for the
new host. The existing Workspace displays the pending computer and its
verification code, and the user explicitly approves the matching request.

## Action semantics

| Action | Meaning | What remains |
| --- | --- | --- |
| Resume connection | Restart this device’s temporary Workspace connection | All local and remote state |
| Pause syncing | Stop this device’s active transport | Account, authorization, cached history, and Workspace |
| Sign out this device | Remove the account, device authorization, pending commands, and cached history from this browser/app | Workspace, computers, and server history on other authorized devices |
| Discard incomplete setup | Remove only unfinished invitation and connection residue on this device | Workspace, computers, sessions, and server history |
| Remove computer | Retire one Workspace computer through another authorized computer | Workspace and other computers |

After a successful sign-out, the settings dialog closes and a persistent
onboarding notice confirms what was removed and what was not. The user must not
be offered a second “clear local setup” action for state that was already
removed.

## Recoverable setup failures

A setup failure must answer four questions in the same view:

1. Which stage stopped?
2. What is the most likely cause?
3. Was the invitation or pending request preserved?
4. What exact action should the user take next?

Timeouts are categorized by stage. For example, an expired authorization wait
points to the Workspace computer not approving before the invitation expired;
an encryption-key wait points to protected connection startup; and a Workspace
hydration wait explains that authorization succeeded but synchronization is not
finished. Retrying must reuse recoverable state rather than silently replacing
the account or creating duplicate authority.

## Settings information architecture

Settings has four stable sections:

- **Workspace** — current connection health and counts for devices, computers,
  and projects.
- **Devices** — this device, pause/resume, invitations, and sign-out.
- **Computers** — computer identity, availability, installed version, available
  update, enrollment, retirement, and computer-specific diagnostics.
- **App & support** — this app’s version/update, notifications, diagnostics, and
  advanced connection details.

Computer health and computer software are always shown together on the same
computer card. A user should not have to reconcile a status section with a
separate update section.

## Workspace computer updates

The user chooses the restart policy before installation:

- **Update when idle** prepares the release, waits for current Agent work, then
  restarts and verifies the computer.
- **Install and restart now** warns that active Agent turns will stop, preserves
  queued commands, and requires an explicit confirmation.

Visible progress uses the following stages:

1. Preparing
2. Ready
3. Waiting for work
4. Restarting
5. Verifying
6. Complete

“Staged” is an internal checkpoint represented to the user as **Ready — choose
restart time**. A forward-only release shows an additional protected-data
warning and requires a second explicit action. Closing the update panel never
cancels an already requested update.

## Vocabulary

Primary UI copy uses **this device**, **Workspace**, and **computer**. Use
**Gateway** only when naming the software installed on a Workspace computer or
inside troubleshooting instructions. Use **Matrix**, room IDs, device IDs, and
protocol details only in advanced details, diagnostics, or developer-facing
instructions.
