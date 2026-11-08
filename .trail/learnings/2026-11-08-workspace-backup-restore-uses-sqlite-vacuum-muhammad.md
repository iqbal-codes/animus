---
title: "Workspace backup/restore uses SQLite VACUUM INTO drain, immutable artifacts and an installation hold"
author: Muhammad
date: 2026-11-08
branch: t3/workspace-backup-restore
id: l-380c2176
scope: repo
status: active
src: agent
touches:
  - apps/backend/src/dispatch/service.ts
  - apps/backend/src/publication/service.ts
  - apps/backend/src/registry/db.ts
---

## Decided
- Ticket #164 adds migration v11 (backup_snapshots, restore_operations, installation_holds). Backup drains writers by holding a real BEGIN IMMEDIATE write transaction on an independent SQLite connection while a second connection runs VACUUM INTO, then copies execution_artifacts by size+sha256 into a temp bundle and atomically renames a verified manifest/hash bundle into place. Restore validates manifest hash, database digest, integrity/FK, schema-registry compatibility and artifact completeness before staging into an isolated state dir; only a fully validated temp tree is renamed. Restored installations rewrite legitimate home-local worktree/state paths, mark active dispatch_runs interrupted, set controls held, preserve budgets/commands/publication intents and insert a singleton installation_holds row that DispatchService and PublicationService fail closed on until explicit reconcile.
## Tried and ruled out
- Ruled out a second backup engine, an in-memory JS lock for draining writers, copying unfinalized/live artifacts, advertising a bundle before final verification, restoring over a non-empty or live state dir, and using a restore flag to activate execution authority.
## Watch out
- Migration versions 8-10 remain reserved for #158/#159/#162; #164 owns 11. Restore must never claim live process or uncommitted-worktree recovery. Failure-path snapshot audit uses a bounded independent connection so a drained-writer failure cannot block behind the same lock.
