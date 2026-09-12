# Computer management: user-facing decisions

The user comes to Settings to know whether a computer can be used, whether an
action is required, and whether a requested operation finished. They should not
need to understand the Gateway supervisor, Matrix journal or deployment phases.

- The list and detail use `computerUserState` for the same conclusion.
- Availability and installed version are independent facts. A failed probe does
  not undo a confirmed installation; an old installation does not prove online.
- Recent authenticated activity remains valid while a probe is pending or misses
  its deadline. Stale restart evidence must not display "updating" indefinitely.
- Preparation and waiting are normal, non-warning states. Completion returns to
  a quiet available state. Version identifiers and update records remain available
  on demand, not as competing default status headings.
- Only one primary next action is shown. Normal operation does not require a
  check. Install, force restart and version switch retain existing consent and
  compatibility checks. Viewing help never silently submits a mutation.
- Connection help gives local recovery steps before a recheck and diagnostics;
  repeated checks are not presented as a repair operation.
- A reported repair-required state cannot be called usable merely because the
  transport replied. Lack of evidence is "connection not confirmed", not a claim
  that the computer is definitely offline.
- This is a projection of existing evidence, not another polling or retry owner.
  No additional Matrix traffic or protocol versions are introduced.
- Do not place the old control panel inside a disclosure. Versions, update
  activity, connection recovery, rename, restart and removal are separate task
  panels with a common visual system and one clear task per surface.
- All levels, including failure and confirmation screens, use designed buttons,
  spacing and readable typography. Raw server explanations belong only in an
  explicit technical-record panel. Destructive consequences must remain visible
  before consent; shortening copy must not conceal history loss or interrupted work.
- Phone panels use bottom sheets; desktop panels use a bounded centered surface.
  Background controls are inert, Escape closes only the top panel, and closing
  restores focus. Panels can close without canceling durable in-flight actions.

Verification: pure state scenarios plus the real React settings fixture at phone
and desktop sizes. Exercise two independent computers, return from update records,
rename, restart consent, retained-version consent, removal prerequisites and
confirmation, diagnostic export, nested focus and background isolation. Inspect
screenshots of every opened task, not just the default computer list. A fixture
does not constitute an online Gateway update or native Android end-to-end test.
