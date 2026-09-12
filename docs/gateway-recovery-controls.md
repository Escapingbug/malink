# Gateway recovery controls

The user is managing a named computer, not a release store. On desktop and
Android-sized screens, its status section keeps a single Refresh status button
visible, including after a successful check. This is read-only: show the last
check time and distinguish no reply from an update failure. Do not promise
that checking repairs the computer, or that a signed response proves Agent
execution healthy.

Version choices follow the existing signed activationMode and executionTracks:

- Steady compatible state: offer the retained previous version.
- Interrupted compatible handoff: label keeping current, restoring previous,
  and retrying target distinctly; deduplicate release identities.
- Forward-only handoff: only offer retrying the target, never an older reader.
- In-flight handoff: do not offer another selection.

The existing confirmation and generation guard still apply. No protocol version
change or new authorization is required. A forward-only recovery may require
local access; it must never silently restore a data backup.

Worker health checks retain a five-second HTTP timeout. Deployment seal is a
different operation: it waits for tasks and durable queues (the Gateway allows
two minutes for queue drain). Its HTTP timeout is 150 seconds, outer drain wait
155 seconds, followed by at most 30 seconds of process-group exit verification;
the controller release wait is 190 seconds. Failure is not permission to kill
tasks or grant execution to another writer. Tasks exceeding the bounded seal
wait can still prevent installation; this change does not force them to stop.

Validation includes a real child process whose seal takes 5.5 seconds,
existing ownership/recovery tests, and desktop/390px rendered interaction tests
for refresh and forward-only choices. These are not a live production upgrade
or an Android emulator test.
