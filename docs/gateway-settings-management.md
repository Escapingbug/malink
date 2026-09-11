# Gateway management in Settings

Remote users manage a computer from **Settings → Computers → Manage computer**.
The list keeps connection evidence and update summaries visible. Only one
computer's details are expanded at a time. Restart, rename and diagnostics are
secondary controls within that computer.

## User flow

**Execution tracks** shows the selected and retained releases, transition or
admission errors, and explicit version selection. The retained version supports
normal work and repair. Confirmation captures the displayed generation and
becomes disabled if it changes; compatibility remains enforced by the Host.

**Update session & progress** exposes preparation, its associated session,
the ready-to-switch checkpoint, handoff and completion/failure. Starting
preparation cannot authorize activation. Returning from the session restores
the selected computer. After selecting an older version, the update session
remains accessible for repair.

Opening details refreshes signed computer/version status if the previous read
is older than five minutes. Existing data remains visible. Concurrent requests
are suppressed and background/offline reads pause. Manual refresh is secondary;
refresh and selection failures appear inline. Other computers are not probed.

Version selection continues through the independent signed control route.
Missing release-channel information does not hide computers or track selection
and cannot produce an “up to date” conclusion. Existing durable commands,
update intents, legacy deployment paths and forward-only safeguards remain
authoritative. UI progress uses projected supervisor phases, not Agent prose.
The projection does not expose a general permission-wait phase, so the UI does
not invent one; interactive work remains in the associated update session.

## Validation

- Production build, unresolved-name and static-base-path checks passed.
- 139 Gateway, manual-switch, settings and computer tests passed.
- Browser fixture at 390 × 844 and 1280 × 844 covered settings navigation,
  automatic refresh without repeated reads on return, session navigation,
  preparation, explicit retained-version confirmation and switching back.
  No nested modal, horizontal overflow or browser runtime errors occurred.
- Screenshots were inspected and typography/alignment corrected for small
  screens. These checks use simulated session/Host responses, not live Matrix
  or physical APK acceptance. No real Gateway was updated or switched.
- Full PWA TypeScript check remains failing on the baseline: 198 diagnostics
  on main versus 196 in this worktree, with no new diagnostic messages.

For browser verification, run the PWA Vite server on port 4179 and execute
`node tests/fixtures/computer-settings/check-browser.mjs` from `apps/pwa`.
`CHROME_PATH` and `SETTINGS_FIXTURE_URL` override local defaults. Fixture actions
are simulated and never issue Matrix commands.
