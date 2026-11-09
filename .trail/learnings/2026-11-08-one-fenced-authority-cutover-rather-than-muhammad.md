---
title: One fenced authority cutover rather than dual writers or a second store
author: Muhammad
date: 2026-11-08
branch: t3/execution-authority-cutover
id: l-2e7a2dbc
scope: repo
status: active
src: agent
touches:
  - packages/contracts/src/execution-authority.ts
  - packages/contracts/src/cutover.ts
  - apps/backend/src/registry/db.ts
  - apps/backend/src/main.ts
  - apps/backend/src/monitor/service.ts
  - apps/backend/src/webhooks/github.ts
  - scripts/cli/commands/authority.ts
  - docs/authority-cutover.md
  - tests/integration/authority-cutover.test.ts
  - tests/integration/authority-acceptance.test.ts
  - tests/integration/authority-runtime.bun.test.ts
  - tests/integration/authority-ui.test.tsx
---

## Decided
- Implemented #165 as one durable execution-authority.json with legacy|migrating|local, migration 15 for cutover operations/mappings, and a restartable service that stages a verified #164 backup plus an isolated held restore before CAS-activating local. Every legacy writer (dispatch, monitor, scheduler, loop, native launch, coordination, webhook issue events) now fails closed outside legacy; only remote CI observations remain eligible after activation. Deterministic identity mappings preserve real IDs and legacy audit rows are kept as history, never executable authorization.
## Tried and ruled out
- Ruled out a second authority marker/database/engine, in-memory quiesce flags, marker writes without fsync/CAS, falling through to legacy when authority is migrating, treating a released restore as cutover proof, and fabricating authorization for ambiguous legacy rows. Also ruled out aborting after activation (rollback is a validated isolated restore).
## Watch out
- Activation holds a real SQLite BEGIN EXCLUSIVE window and re-inventories; status is relatively expensive because it re-verifies the staged bundle/restore. Untracked OS processes must still be quiesced by the operator; the fence blocks supported writers and detects committed drift.
