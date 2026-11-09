---
title: "Ticket #156 repair: shared eligibility, verified stop identity, usable takeover, immediate exhaustion"
author: Muhammad
date: 2026-11-08
branch: t3/repair-ticket-156-blockers
id: l-253239a4
scope: repo
status: active
src: agent
touches:
  - apps/backend/src/dispatch/service.ts
  - apps/backend/src/dispatch/ownership.ts
  - apps/backend/src/dispatch/scheduler.ts
  - apps/backend/src/evidence/observations.ts
  - apps/backend/src/work/budget.ts
  - apps/backend/src/work/budget-schema.ts
  - apps/backend/src/registry/db.ts
  - apps/web/src/features/dispatch/dispatch-control.tsx
  - docs/runtime.md
  - tests/integration/dispatch-budget-controls.test.ts
---

## Decided
- - Shared member selection skips exhausted, held, stopping and stopped siblings; the scheduler maps those errors to continue so one stuck ticket cannot starve independent work or later plans. Explicit work_id dispatch still returns its precise refusal.
- Stop validates run_id, owner_token, ownership_generation and the recorded OS process-start identity before any signal. Stale, foreign, unreadable, unknown or PID-reused records are never signalled and remain stopping/unconfirmed. Takeover clears the stale worker record after the CAS.
- Takeover runs inspectRunEffects before the CAS, then terminalizes the stale run as reconciled with owner_pid NULL and a bumped generation/token. The next dispatch allocates the next numbered lap; consumed budget and exhaustion are preserved.
- A rejected final-lap check/review observation marks the budget exhausted immediately, so the detail/UI expose Needs owner without waiting for another dispatch attempt.
- Reusing a grant idempotency key with a changed payload is an idempotency_conflict and the command ledger records failure; a true replay records idempotent_replay without claiming a new allowance.
- The operator UI loads the selected run detail before opening the panel, disables Dispatch while budget/control state is unknown, retries detail on Refresh, and reuses one grant idempotency key per submission.
- Schema v6 (budgets and controls) lives in work/budget-schema.ts and is appended after v5 in the single ordered registry, with applied-v5 upgrade tests preserving v5 data.
- Actor remains a caller-supplied audit label under the existing trusted operator boundary; docs/runtime.md now states it is not an authenticated principal or an authorization decision.
## Tried and ruled out
- - Did not signal a worker record on token/generation/process-start mismatch even when its pid is alive; treating it as owned reintroduced the PID-reuse hazard.
- Did not leave the taken-over run active under the live coordinator pid; that strands reconcile and dispatch until a backend restart.
- Did not let idempotent replay silently accept a changed amount/reason/actor; that fabricates a successful grant command for an allowance that never applied.
- Did not add per-user authentication or treat actor/role text as authorization.
## Watch out
- - processStartIdentity uses `ps -o lstart=` (fallback `start=`); an unreadable identity fails closed and requires reconcile after the process is gone.
- Trail check reports three heuristic conflicts on service.ts:735 (SQL columns/durable workId), dispatch-control.tsx:725 (UI heading/CSS text) and operator.ts:803 (durable ID schema). These are display/identity-key words, not caller-supplied execution identity.
