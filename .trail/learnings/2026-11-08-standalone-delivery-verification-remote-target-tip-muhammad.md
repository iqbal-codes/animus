---
title: "Standalone delivery verification: remote target-tip proof, single remote-CI readback, runtime producer"
author: Muhammad
date: 2026-11-08
branch: t3/ticket-159-standalone-repair
id: l-f1e1f52f
scope: repo
status: active
src: agent
touches:
  - apps/backend/src/delivery/service.ts
  - apps/backend/src/evidence/observations.ts
  - apps/backend/src/dispatch/service.ts
  - scripts/loop/role-runner.ts
  - scripts/loop/worktree.ts
---

## Decided
- Ticket #159 repair keeps one delivery gate and one evidence store. Readiness now fetches the remote target tip and invalidates when it differs from the observation's tested targetTipSha before merge; verifyMerge re-reads the PR and proves the actual merge commit is on the remote target lineage with first parent == tested tip (fast-forward allowed only when tip == candidate and its parent is the tested tip); transport-reported mergeCommitOid is stored only after that proof. Remote CI is delegated to the single readRequiredChecks helper in apps/backend/src/registry/required-checks.ts shared by child integration and delivery, so a producer-asserted remote_ci observation cannot substitute. evaluateAcceptance re-verifies artifacts/staleness/producer identity for every present authorizing independent stage (review and final_acceptance), and latest selection uses created_at,rowid for both listObservations and latestObservation. A DeliveryRuntimeCoordinator drives the normal scheduler tick: it runs the real bounded reviewer/QA role runner with the injected production transport, runs declared regression checks, persists hash-verified artifacts/observations, and dispatches bounded correction laps through DispatchService with the prior blocking findings, then rechecks; Stop controls prevent correction. Recheck observations use the technical_checks stage so they never replace the authorizing review/final_acceptance results.
## Tried and ruled out
- Ruled out storing forge mergeCommitOid without git proof, comparing only candidate ancestry, trusting a producer PASS remote_ci, per-stage latest ordering with UUID tie-breaks, duplicating the required-check readback in delivery, creating a second QA/review engine, and letting runtime recheck observations become the latest authorizing stage.
## Watch out
- The coordinator publishes after independent gates but the manual publication audit still requires operator-hosted evidence bindings; it never marks delivered. The role runner now uses node:fs/promises writeFile instead of Bun.write so vitest/Node can exercise the production executor.
