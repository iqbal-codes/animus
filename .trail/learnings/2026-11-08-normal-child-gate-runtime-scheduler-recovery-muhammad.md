---
title: "Normal child gate runtime, scheduler recovery, and sequential verification"
author: Muhammad
date: 2026-11-08
branch: t3/final-spec-review-remediation
id: l-dc029777
scope: repo
status: active
src: agent
touches:
  - apps/backend/src/delivery/runtime.ts
  - apps/backend/src/dispatch/scheduler.ts
  - scripts/scheduler.ts
  - scripts/cli/commands/loop.ts
  - apps/backend/src/main.ts
  - vite.config.ts
---

## Decided
- The child gate profile is now a branch of DeliveryRuntimeCoordinator.process: run declared technical/contract commands in the real worktree (real exit status) and an independent review through the existing bounded role runner, then publish the child PR and call ChildIntegrationService.land for required-CI readback and lineage-verified merge. Failed stages dispatch bounded corrections through DispatchService (same lap/budget/Stop ownership); blockers such as conflict, target drift, CI missing/pending and unverified lineage hold truthfully. Child stage observations intentionally record candidate-bound command/exit checks without finalized file artifacts, because publication audit completeness requires an operator-hosted URL per finalized artifact and would otherwise force per-child manual approval, contradicting the auto-merge requirement. Standalone/final keep immutable artifacts and manual merge. A shared composition root (apps/backend/src/local-runtime.ts) now builds observations/budget/publication/gate/integration/final/delivery for the app kernel, scripts/scheduler.ts and the CLI scheduler command. runLocalDispatchTick resumes succeeded runs whose gate is not terminal before dispatching, so a builder-only or restart-interrupted run gets gates and a PR on a later tick instead of already_succeeded forever. Canonical verify-all was made a linear sequential chain (toolchain -> static -> neutral -> bun) and neutral files run with fileParallelism false, so load no longer pushes legitimate tests past the default 5s; no timeout was raised or suppressed. authority-cutover-fs and authority-cutover-race bun suites are registered in bun-suite.
## Watch out
- Child auto-integration cannot carry finalized artifacts until an operator binds a hosted URL; keep child stage evidence as candidate-bound observations. The concurrent-tick delivery-role race is bounded by dispatch claims, the integration file lock and idempotent publication, but role execution itself is not separately leased. packages/contracts/src/execution-authority.ts and cutover lock files are owned by a separate lock-safety worker; the F4 retry-exhaustion guard hunk in this lane must be merged mechanically with that change.
