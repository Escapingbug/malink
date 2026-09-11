Update this Malink Gateway from the exact signed Git commit supplied above.

1. Initialize or refresh the supplied source directory using only the supplied
   credential-free HTTPS repository. Fetch its advertised branch refs with full
   history, then check out the exact authorized 40-character commit and verify
   that `git rev-parse HEAD` equals it. Do not use a shallow fetch or request an
   unadvertised raw SHA as the only fetch. Do not build a branch name or use a
   different commit.
2. Read `AGENTS.md`, `docs/architecture.md`, the package-manager declaration,
   and the target commit's diff before changing the candidate. Install with the
   frozen lockfile. Do not weaken tests, trust checks, authorization, signing,
   encryption, journaling, health checks, rollback, or update supervision.
3. Perform installation admission checks, not release regression testing. Full
   unit/regression suites, protocol integration suites, repository-wide type
   checks, and browser/Android/live E2E belong to release qualification before
   publication; do not run them during this update. In particular, do not run
   `pnpm test`, `pnpm test:workspace`, or the large Gateway session-thread suite
   as an installation gate. Do not change or delete tests to achieve this.
   Run `env -u MALINK_GATEWAY_RELEASE_ID -u MALINK_GATEWAY_BUILD_ID pnpm build`
   once after the frozen install. Its production bundle build and static
   import-closure check are release-blocking. Do not copy or submit bundles if
   a required external module is missing or a required `node:` prefix is lost.
   Fix only reproducible local build/runtime issues required to assemble the
   exact authorized commit. If a repair needs verification, run only the narrow
   check for that repair, not a full suite. A failed admission check must be
   fixed or reported; never classify it as success or retry it indefinitely.
   Remove `MALINK_GATEWAY_RELEASE_ID` and `MALINK_GATEWAY_BUILD_ID` from all
   repository build/check commands so inherited service identity cannot be
   mistaken for static PWA release configuration. If a targeted repair test is
   needed, set `TMPDIR` to a short absolute path such as `/tmp` so macOS socket
   paths remain valid. Do not copy test output into the candidate.
4. The supplied candidate is an independent copy of the active release. Replace
   its Gateway and update-supervisor bundles with the target commit's production
   bundles, including `ops/matrix-local-gateway.js`,
   `ops/gatewayUpdateSupervisorMain.js`, `ops/gatewayAgentUpdateCli.js`, and
   `ops/gatewayJournalRepairCli.js`. Also copy `ops/gatewayExecutionTrackWorker.js`
   and `ops/gatewayForwardRecoveryCli.js`
   when present in the target production build; the independent supervisor uses
   this pinned standby-controller entrypoint. Recovery tooling must remain release-pinned
   to the journal implementation it validates.
   Replace the target commit's `dist/mcp/stdio.js` bundle at
   `mcp/stdio.js` in the candidate as well; ACP sessions cannot open without
   this release-pinned subprocess entrypoint.
   Preserve unchanged production dependencies locally. If the target lockfile
   changes a runtime dependency, install and dereference the exact production
   dependency tree into the candidate; no symlink may remain. Validate the
   external imports of every copied production entrypoint against the completed
   candidate rather than inferring dependency closure only from the lockfile
   diff.
5. Keep the candidate's working Node runtime when it satisfies the target
   repository's runtime requirements. If it does not, obtain the official
   macOS runtime for this Gateway architecture, verify its published checksum,
   and place its executable at `runtime/node`. Never depend on a system-wide
   Node installation after activation.
6. Inspect the complete candidate. It must be self-contained, contain only
   regular files and directories, and must not contain secrets, Git metadata,
   caches, source maps, test output, package-manager stores, sockets, or release
   metadata files. Never execute any candidate Gateway or supervisor entrypoint,
   including with `--help`, a temporary working directory, or modified
   environment variables. These entrypoints do not expose an Agent-safe runtime
   validation mode. Starting one can attach it to production Matrix and journal
   state. The independent supervisor owns all candidate entrypoint validation.
7. Only after the production build and candidate assembly checks pass, run the
   exact supervisor completion command supplied above. Do not alter, wrap, or
   replace that command. Current supervisors name this operation `finish`;
   earlier compatible supervisors may still supply its `submit` alias. The
   supervisor will safely validate, copy, hash-seal, and submit the candidate
   without starting a second Gateway.
   Do not replace supervisor signature, seal, dependency, state-compatibility,
   writer-ownership, or activation health checks with test results. The supervisor
   owns runtime startup and readiness checks; do not start a candidate yourself.
   `staged` means assembly and static admission passed, not that live Agent work
   has been verified. Existing dual-track switch and repair controls remain the
   recovery path; never force an older binary to open incompatible newer state.
   Completion of this preparation step means the returned phase is exactly
   `staged`; otherwise report the
   failure and leave the active Gateway unchanged.
   If an explicitly authorized external activation must outlive the Gateway
   Agent session, its detached command must invoke a known-working Node runtime
   and JavaScript entrypoint by absolute path. Do not rely on `node` from PATH,
   or on pnpm/tsx shell shims, after the Gateway is stopped.
