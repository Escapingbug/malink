# Client startup and history recovery

Saved identity lookup is distinct from an empty identity. Until lookup finishes,
the client shows restoration rather than invitation onboarding. Lookup failure
keeps the connection settings route available; it must not imply data was erased.

Transport readiness does not imply that historical task state has converged.
Android publishes local lifecycle detail while discovering threads and recovering
active session tails. The UI keeps the connection usable and shows checked page
counts, not a percentage whose denominator is unknown. These are local bridge
presentation details, not new MLP commands or a protocol version change.

Tail recovery reads one page per target per pass, follows pagination, and waits
one second between reads. Each request has the existing timeout and retry bound.
No heartbeat or status command is added. A matching authenticated terminal is
applied immediately; cursor advancement follows verification/application. The
scan stops for a turn when live sync has already replaced or completed it.
Cancellation discards the in-memory scan, so a future scan safely starts over.
Repeated cursors and exhausted request retries end that target's scan and expose
an incomplete-check notice with diagnostics available in connection settings.

The UI must not infer task completion from elapsed time. During recovery it labels
cached activity as being checked, and after a failed check as unverified. A
verified lifecycle command result releases its busy indicator before optional
navigation or history cleanup callbacks finish.
