---
title: Coherent schema migration registry replaces per-module runners
author: Muhammad
date: 2026-11-08
branch: t3/remediate-ticket-161
id: l-0aad904f
scope: repo
status: active
src: agent
touches:
  - apps/backend/src/registry/migrations.ts
  - apps/backend/src/registry/db.ts
  - apps/backend/src/work/db.ts
  - apps/backend/src/draft/db.ts
  - tests/integration/schema-migrations.test.ts
---

## Decided
- Replaced the per-module applyWorkMigrations/applyDraftMigrations runners with one ordered registry (apps/backend/src/registry/migrations.ts, SCHEMA_MIGRATIONS). Work identity owns v1, prepared plan admission (#153) v2, draft authoring (#161) v3. applyMigrations rejects duplicate versions/names, non-ascending order, and any recorded version/name that disagrees with the build, failing closed instead of skipping a migration or renaming an applied row. Upgrading from v1-only, v1+partial-v2, and a historical mis-recorded v2=draft name are all covered by tests/integration/schema-migrations.test.ts.
## Watch out
- Never claim a version inside a feature module; append to SCHEMA_MIGRATIONS. Future lanes (#154) reserve the next version. A recorded version whose name differs from the registry now hard-fails at startup by design.
