---
title: Immutable project work identity and revision import
author: Muhammad
date: 2026-11-08
branch: t3/project-work-revision-persistence
id: l-672b488a
scope: repo
status: active
src: agent
touches:
  - apps/backend/src/intake/service.ts
  - apps/backend/src/registry/db.ts
  - packages/contracts/src/operator.ts
---

## Decided
- Discovery/read seочи imports complete GitHub issue snapshots into work_items/work_revisions in the existing console.db. GitHub identity is unique by (repo_id, issue_number); revisions are append-only with update/delete triggers and a composite (work_id, project_id) foreign key; concurrent duplicates serialize through BEGIN IMMEDIATE and converge on the existing accepted revision. Intake reads expose the work record, and project-scoped work routes plus client/CLI readers expose the immutable original source. Work records stay observational and are NOT execution authority until the #165 cutover.
## Tried and ruled out
- Rejected a separate work database, refreshing revisions on later discovery, and using project checkout paths or issue numbers as primary identity. Also rejected silently treating a missing issue body as valid in the service (the synthetic test adapter now normalizes omitted bodies to empty strings so only real incomplete reads fail closed).
## Watch out
- SQLite migrations must keep PRAGMA synchronous=FULL, WAL, foreign_keys=ON and busy_timeout for cross-connection duplicate imports. A work identity that already belongs to another project is held as work_import_held:work_identity_conflict rather than reassigned.
