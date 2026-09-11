# Manual Gateway switching

Release discovery does not authorize installation. The first update action
prepares and verifies the signed release. A staged release remains staged until
the user explicitly selects **Switch to new version**. The current writer keeps
running during preparation.

The client captures switch consent from the displayed staged release before
asynchronous discovery. A Prepare click cannot turn into an activation request
because staging completed during that request. Saved preparation intents and
reconnect handlers never carry switch consent.

The same boundary applies to execution tracks and legacy restart-based updates.
Legacy blue/green candidate preparation still requires its existing separate
promotion action. Force-restart controls are available only after staging;
incompatible activation retains its additional risk confirmation.

This change does not revise the worker drain timeout, bootstrap unsupported old
installations, or repair client message projection. Those are separate issues.
