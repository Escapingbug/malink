# Client Matrix Account Convergence

Malink uses two Workspace-owned Matrix users:

- one Gateway user shared by every Gateway node, with a distinct Matrix device
  ID and `gatewayNodeId` for each computer;
- one client user shared by every PWA and Android device, with a distinct
  Matrix device ID and Malink application certificate for each device.

Matrix membership and login are transport. Signed Malink device certificates,
Workspace grants and MLP/3 commands remain the execution authority.

## Why convergence uses invitations

An older Malink installation may have created a separate Matrix user for each
client. Moving those clients does not require copying an account database or
changing MLP/3. Keep one working client on the canonical Workspace client
account as the seed. That seed creates the existing **Add another device**
invitation, containing:

1. a short-lived pairing offer signed by an approved Workspace Gateway; and
2. a one-time Matrix login token issued by the seed client's current Matrix
   session for the same canonical account.

A legacy client cannot create this invitation. Otherwise its login token would
simply propagate the legacy account. The Gateway therefore continues to reject
`device.invite` from a client whose Matrix user differs from the signed
Workspace directory's `clientMatrixUserId`.

The Gateway-local token issuer is an emergency recovery path for the case where
no canonical client remains. It is not the normal product flow.

## Device rejoin transaction

Migrate one physical client at a time:

1. On a client already using the canonical account, choose **Add another
   device**.
2. On the legacy client, open Settings, choose **Rejoin with invitation**, and
   scan or paste the invitation.
3. Before changing any login, Malink verifies that:
   - the one-time target user is the `clientMatrixUserId` in the signed
     Workspace Gateway directory;
   - the signed pairing offer belongs to that same Workspace;
   - its Gateway node, root key and Matrix route match the signed directory;
   - the target and current accounts use the same Matrix homeserver; and
   - on Android, no unfinished native outbox command can be orphaned.
4. After explicit user confirmation, Malink revokes the old Matrix device and
   consumes the one-time token to create a new Matrix device on the canonical
   account.
5. Malink re-pairs with the same application `deviceId` and application key.
   The Gateway renews that device's certificate rather than creating another
   application identity.
6. The existing signed Gateway directory supplies all project rooms. The
   client rejoins them and rebuilds verified Workspace state and history from
   Matrix while retaining its recoverable local projection.

The old account's server-side rooms are not copied into the new account. They
do not need to be: Workspace rooms and MLP/3 history already belong to the
canonical account and are restored after re-pairing.

## Interruption behavior

The Matrix login is replaced before the Malink certificate is renewed. If the
app stops during that interval, it starts with its original Malink identity and
trust but a missing or replacement Matrix session. The existing connection
repair flow then asks for another canonical invitation and completes the same
device reauthorization. The user must keep app data intact.

Android owns its Matrix session in the native service. Account replacement is
therefore exposed as the additive native bridge capability
`matrix.account-rejoin` v1 and never falls back to a Web-owned Matrix runtime.
An older APK can still load the current PWA, but must update before it can run
the rejoin transaction.

The browser revokes its own Matrix device, consumes the token, saves the new
session, and performs the same signed pairing renewal. A failed logout leaves
the saved configuration untouched. Once token login succeeds, any later
pairing failure is ordinary resumable reauthorization on the new account; the
account replacement is not repeated.

## Compatibility and protocol versioning

This feature does not change an existing MLP/3 wire message incompatibly, so
MLP/3 remains version 3. `clientMatrixUserId` remains an optional signed
directory field for readers during rollout. The Android bridge operation is an
additive optional capability: capability negotiation, not a global protocol
version bump, prevents an old native host from receiving a method it cannot
handle.

Protocol versions are changed only when an old implementation cannot safely
interpret or process the existing wire shape. A semantic clarification or an
additive operation uses compatible fields or capability negotiation instead.

## Completion and cleanup

Convergence is complete when every active client certificate reports the
canonical client Matrix user and ordinary history, messaging, project creation
and Agent operations work after a restart. Only then may an operator separately
revoke unused legacy Matrix devices/accounts. That cleanup is not part of the
rejoin transaction and must never delete Malink application identities,
Workspace grants or project history.
