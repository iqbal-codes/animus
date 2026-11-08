---
title: "Ticket #155 remediates per-ticket laps, scoped findings and trusted producer identity"
author: Muhammad
date: 2026-11-08
branch: t3/repair-ticket-155-review-blockers
id: l-cac7fa16
scope: repo
status: active
src: agent
touches:
  - apps/backend/src/evidence/observations.ts
  - apps/backend/src/dispatch/service.ts
  - apps/backend/src/work/db.ts
  - apps/backend/src/evidence/routes.ts
  - packages/contracts/src/operator.ts
  - apps/web/src/features/dispatch/dispatch-control.tsx
---

## Decided
- Acceptance now governs on the latest actual observation per required stage (newer failed/running/inconclusive revokes an older pass) and scopes blocking findings to the run's work item so sibling tickets sharing one plan delivery never contaminate each other. A new dispatch_runs.lap is allocated transactionally per (delivery, work) inside the claim BEGIN IMMEDIATE, so siblings start at lap 1 while ownership_generation stays delivery-wide fencing; an explicit re-dispatch after an open finding starts the next ticket lap (budget policy remains #156). Independent stages require a durable execution_producers registration whose one-time credential is minted by the trusted host boundary (never the public evidence route); the HTTP writer derives producer identity from the credential, builder evidence is bound to dispatch_runs.actor and restricted to dispatch finalize, and attempt_key per finding lets one reviewer recheck multiple findings in the same lap.
## Watch out
- gate-profile version 1 unchanged because stage mapping did not change; execution lap is per ticket while ownership_generation remains delivery-wide; registering the same producer id twice fails closed (producer_exists). trail check flags operator.ts artifactPath as 'project path issue' — artifact evidence paths are not execution identity.
