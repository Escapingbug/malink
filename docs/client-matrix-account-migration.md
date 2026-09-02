# Client Matrix Account Convergence

Malink uses two Workspace-owned Matrix users:

- one Gateway user shared by every Gateway node, with one Matrix device ID and
  `gatewayNodeId` per computer;
- one client user shared by every PWA and Android client, with one Matrix device
  ID and Malink application certificate per physical client.

Matrix membership and login are transport. Signed Malink certificates,
Workspace grants, and authenticated MLP/3 commands remain the execution
authority.

## Explicit account switch

Malink does not detect a legacy Matrix user and automatically replace it. It
also does not expose an in-place account-upgrade state machine. Account changes
use the same ordinary product boundaries as every other sign-in:

1. Keep one working client signed in to the canonical Workspace client account.
2. On the client that must change accounts, choose **Sign out** and confirm.
3. On the canonical client, choose **Add another device**.
4. Open that new one-time invitation on the signed-out client.

If an invitation belongs to a different Matrix user while the receiving client
is still signed in, Malink rejects it and asks the user to sign out first. It
never silently replaces the account or opens Settings merely because the
signed Workspace directory names another client user.

The Gateway-local token issuer remains an emergency recovery path when no
canonical client survives. It is not the normal product flow.

## Sign-out boundary

Sign-out removes all account-scoped state from the physical client:

- Matrix access token and native SDK account/crypto storage;
- every saved Gateway route and trusted certificate for that account;
- application encryption keys, replay state, pending commands, and transfers;
- local projections and cached conversation history.

Android makes a short best-effort Matrix logout request first, but server or
network availability cannot block local account removal. The local token is
destroyed even when the homeserver cannot confirm server-side revocation.
Android then remains on the account setup screen so the user can open a new
invitation immediately.

Workspace projects, Gateway state, sessions, and Matrix-hosted history are not
deleted. They are restored from the canonical Workspace after the new client
device signs in and is authorized. Unsent local commands and local-only caches
belong to the signed-out device and are intentionally removed.

## Invitation enforcement

New invitations still carry a one-time Matrix login token for the issuer's
account. A client on a legacy account cannot be used as the canonical seed:
otherwise its token would simply reproduce the legacy account. The Gateway
therefore continues to validate the signed Workspace `clientMatrixUserId` when
authorizing new device invitations.

The one-time invitation, signed Gateway route, application identity, and
Workspace grants retain their existing schemas. This flow does not change
MLP/3 or require a protocol version bump.

The released `malink.client.rejoin` bridge wire shape remains parseable as a
compatibility tombstone for cached older PWAs, but current clients do not
request its optional capability and current Android hosts do not advertise it.
No product flow can start an in-place account replacement.
