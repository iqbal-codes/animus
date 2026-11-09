---
title: Bounded per-ticket attempt budgets and operator recovery controls
author: Muhammad
date: 2026-11-08
branch: t3/attempt-budget-controls
id: l-cf3eff7a
scope: repo
status: active
src: agent
touches:
  - apps/backend/src/work/db.ts
  - apps/backend/src/dispatch/service.ts
  - apps/backend/src/dispatch/http.ts
  - apps/backend/src/evidence/observations.ts
  - packages/contracts/src/operator.ts
  - packages/client/src/index.ts
  - scripts/cli/commands/operations.ts
  - apps/web/src/features/dispatch/dispatch-control.tsx
---

## Decided
- Ticket #156 adds migration v6 (execution_budgets_and_controls) to the existing console.db: execution_budget_scopes keyed by (delivery, work, gate_profile) so child and final budgets are independent, execution_budget_grants with UNIQUE(project_id, idempotency_key) for replay-safe explicit allowance, and execution_controls for hold/stopping/stopped state. The dispatch claim allocates the lap and checks base_limit+granted_attempts inside the same BEGIN IMMEDIATE; the fourth attempt past a three-lap budget is refused and marks the scope exhausted with retained worktree/branch/head. A rejected final allowed builder attempt marks exhaustion immediately. Grants are recorded in the command ledger and only add numbered allowance; resume refuses when consumed >= allowed. Acceptance adds budget_exhausted to reasons so an exhausted ticket cannot merge. Stop terminates only the recorded bounded-builder process group (never the coordinator pid), stays stopping until reconcileRun re-checks process/effect ownership, and takeover refuses while owner/worker/lock may still run, then bumps delivery-wide ownership_generation with owner-token CAS. CLI plan detail/grant/grants/hold/resume/stop/takeover and the operator Budget & controls panel read the same backend detail.
## Tried and ruled out
- Ruled out a second budget/control store or engine, caller-supplied allowance, resetting consumed laps on grant/resume, marking stop as stopped before reconciliation, killing the coordinator pid on stop, allowing takeover on a dead lease alone, and treating process resume as a new attempt.
## Watch out
- Migration v3 stays reserved for #161 drafts, v4 is dispatch and v5 is evidence; #156 owns v6. Budget exhaustion is per work+profile, so sibling tickets and the final-delivery budget never share consumption. Stop stays unconfirmed (stopping) until reconcileRun; an unreadable worker-owner or worktree-lock record is fail-closed. trail check flags target/path/issue-number keywords in operator.ts, dispatch-control.tsx and service.ts as historical-identity conflicts; those are target branches, worktree paths and display numbers, not execution identity.
