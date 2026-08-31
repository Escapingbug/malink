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
3. Run the repository's complete Gateway unit tests, protocol integration
   tests, type checks, and production bundle build. Fix only reproducible local
   build/runtime issues required to build this exact commit. If a test or build
   cannot pass, stop without submitting the candidate.
   The Agent process inherits metadata from the active Gateway service. Remove
   `MALINK_GATEWAY_RELEASE_ID` and `MALINK_GATEWAY_BUILD_ID` from the environment
   of repository test and build commands so the installed Gateway identity
   cannot be mistaken for static PWA release configuration. For example, prefix
   those commands with
   `env -u MALINK_GATEWAY_RELEASE_ID -u MALINK_GATEWAY_BUILD_ID`.
4. The supplied candidate is an independent copy of the active release. Replace
   its Gateway and update-supervisor bundles with the target commit's production
   bundles, including `ops/matrix-local-gateway.js`,
   `ops/gatewayUpdateSupervisorMain.js`, `ops/gatewayAgentUpdateCli.js`, and
   `ops/gatewayJournalRepairCli.js`. Recovery tooling must remain release-pinned
   to the journal implementation it validates.
   Replace the target commit's `dist/mcp/stdio.js` bundle at
   `mcp/stdio.js` in the candidate as well; ACP sessions cannot open without
   this release-pinned subprocess entrypoint.
   Preserve unchanged production dependencies locally. If the target lockfile
   changes a runtime dependency, install and dereference the exact production
   dependency tree into the candidate; no symlink may remain.
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
7. Only after all repository tests and candidate assembly checks pass, run the
   exact supervisor completion command supplied above. Do not alter, wrap, or
   replace that command. Current supervisors name this operation `finish`;
   earlier compatible supervisors may still supply its `submit` alias. The
   supervisor will safely validate, copy, hash-seal, and submit the candidate
   without starting a second Gateway.
   Success means the returned phase is exactly `staged`; otherwise report the
   failure and leave the active Gateway unchanged.
