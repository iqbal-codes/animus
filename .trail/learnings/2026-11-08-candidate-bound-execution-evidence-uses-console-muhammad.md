---
title: Candidate-bound execution evidence uses console.db migration v5
author: Muhammad
date: 2026-11-08
branch: t3/immutable-lap-observations
id: l-90229445
scope: repo
status: active
src: agent
touches:
  - apps/backend/src/evidence/routes.ts
  - apps/backend/src/dispatch/service.ts
  - apps/backend/src/work/db.ts
  - packages/contracts/src/operator.ts
  - packages/client/src/index.ts
  - scripts/cli/commands/operations.ts
  - apps/web/src/features/dispatch/dispatch-control.tsx
---

## Decided
- Ticket #155 stores immutable stage observations, individual checks, append-only finding events and finalized artifact references in the existing console.db via work migration version 5 (execution_observations_findings_artifacts). Dispatch finalize writes its builder observation in the same BEGIN IMMEDIATE transaction as the terminal run state, so a result never persists without its evidence. Observation identity (delivery/run/lap/candidate/target tip/merge base/tested identity/lineage/producer/gate-profile version) is derived from durable dispatch rows, never trusted from the request. Acceptance re-derives the current target tip/merge base from git, re-verifies finalized artifact size+sha256, and requires a passed non-builder stage observation plus no open blocking findings. Builder fix claims append an event but cannot resolve; only an independent producer recheck can. Rechecks and observation+checks+findings+artifact writes use SAVEPOINTs so partial writes roll back.
## Tried and ruled out
- Ruled out a second evidence database/engine, caller-supplied candidate/target/lineage identity, updating candidate_verifications rows in place, trusting producer role text alone (builder ids are also rejected by identity), and accepting non-regular artifact files or symlinks as finalized proof.
## Watch out
- Migration v3 stays reserved for #161 drafts and v4 is #154 dispatch; #155 uses v5 only. Gate-profile version 1 maps child->technical_checks, standalone->independent_review, final->final_acceptance; changing that mapping requires bumping GATE_PROFILE_VERSION so old evidence stops authorizing acceptance. Artifact paths are relative to <animus state>/artifacts/<projectId> and accepted only as regular files under the realpath root.
