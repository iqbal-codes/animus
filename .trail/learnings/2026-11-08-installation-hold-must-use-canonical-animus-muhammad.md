---
title: Installation hold must use canonical Animus state and abandonment must be a terminal intent state
author: Muhammad
date: 2026-11-08
branch: t3/repair-launch-hold-intent-replay
id: l-7dbe5b33
scope: repo
status: active
src: agent
touches:
  - scripts/loop/session.ts
  - apps/backend/src/monitor/service.ts
  - apps/backend/src/delivery/runtime.ts
  - apps/engine-host/src/native.ts
  - apps/backend/src/restore/release.ts
  - apps/backend/src/restore/schema.ts
  - apps/backend/src/publication/service.ts
  - apps/backend/src/publication/issues.ts
---

## Decided
- Native launch wrappers (runAnimusLoop, monitor, engine host, delivery runtime) always assert the hold against the canonical Animus installation state dir (explicit installationStateDir override or environment default), never the per-project worktree stateRoot which has no console.db. The shared read-only hold reader lives in @animus/contracts/installation-hold and fails closed on an unreadable/corrupt/locked database while allowing a missing database (brand-new) or missing hold table (pre-v11). Restore release settles intents in the same SQLite transaction as the snapshot-fenced hold CAS: resolved binds the real remote identity plus PR/relationship bookkeeping, abandoned writes a terminal `abandoned` intent state (migration v13) that publication and issue reconciliation never replay.
## Tried and ruled out
- Ruled out gating against options.stateRoot (project worktree state), skipping the hold when no state dir is passed, returning null on a corrupt/locked hold database, report-only abandonment, and marking abandoned intents accepted.
## Watch out
- Abandoned intents are excluded from unresolved enumeration and reconcile selectors; resolved create_pr requires an OPEN PR with exact repository/head/base/candidate SHA. Migration v13 owns `abandoned`; v12 stays reserved for #160.
