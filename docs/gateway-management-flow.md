# Single-level computer management

The computer card has two separate button targets: the online status refreshes
that node, while the rest of the card opens its management page. Keyboard and
touch users receive the same controls; text descriptions are not action links.

Management shows update progress directly, without Versions or Activity menus:

1. Available release: Update starts preparation.
2. Preparing: Open update session; no second preparation or install action.
3. Signed staged result: Restart and install update, after confirmation.
4. Confirmed installed release: Open or Delete update session.
5. Confirmed session deletion: remove both session actions.

Deletion is explicit, not automatic. Retain the existing authenticated
maintenance-session lifecycle guard. A newly published release must not prevent
deleting the previous completed update's session.

Restart remains a direct management action with one consequence confirmation.
Temporary rollback warns users to update again soon to avoid compatibility
problems; the signed running version restores update availability even before
directory discovery converges. Forward-only updates never offer old readers.

Validation covers desktop and 390px touch layout, independent node status
refresh, preparation, session navigation, staged activation confirmation,
pending versus confirmed deletion, and rollback followed by update availability.
No protocol or native APK changes are required for this presentation flow.
