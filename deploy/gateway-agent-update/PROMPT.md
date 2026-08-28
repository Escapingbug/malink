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
4. The supplied candidate is an independent copy of the active release. Replace
   its Gateway and update-supervisor bundles with the target commit's production
   bundles, including `ops/matrix-local-gateway.js`,
   `ops/gatewayUpdateSupervisorMain.js`, and `ops/gatewayAgentUpdateCli.js`.
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
   metadata files. Run the candidate's entrypoints with safe validation/help
   inputs where supported.
7. Only after all checks pass, run the exact supervisor submission command
   supplied above. The supervisor will copy, hash-seal, and validate the result.
   Success means the returned phase is exactly `staged`; otherwise report the
   failure and leave the active Gateway unchanged.
