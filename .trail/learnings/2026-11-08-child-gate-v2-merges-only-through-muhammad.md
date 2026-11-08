---
title: Child gate v2 merges only through verified remote lineage
author: Muhammad
date: 2026-11-08
branch: t3/spec-151-integration
id: l-2db16251
scope: repo
status: active
src: agent
touches:
  - apps/backend/src/integration/service.ts
  - apps/backend/src/integration/schema.ts
  - apps/backend/src/evidence/observations.ts
  - apps/backend/src/dispatch/service.ts
  - apps/backend/src/registry/forge.ts
  - apps/web/src/features/dispatch/dispatch-control.tsx
---

## Decided
- Ticket #158 adds gate profile version 2: child tickets require technical_checks AND independent_review (plus required remote CI) before auto-integration. Migration v8 stores child_integrations and append-only child_integration_events. ChildIntegrationService composes the existing dispatch acceptance, publication audit, ForgeAdapter check-run/merge methods, cross-process integration lock and git CAS; it records completion only after re-reading the PR MERGED and proving candidate+merge commit are ancestors of the fetched remote target. Dependents release through project_issue_integrations and ancestor checks, never issue closure. A succeeded-but-unintegrated run whose target advanced is allowed to re-enter a new bounded builder lap (staleSucceededRun) instead of already_succeeded, because observations bind target/base at dispatch time. SyntheticForgeAdapter.mergePullRequest keeps its legacy merged_sha acknowledgement when no mergeRemote transport is injected; the integration service never accepts that as lineage.
## Tried and ruled out
- Ruled out relaxing stale_target_tip in evaluateAcceptance for merge, accepting a MERGED flag or merge SHA without git ancestry proof, creating a second integration store/engine, and treating re-recorded observations on the same run as reverify (observations always bind run.base_sha).
## Watch out
- A real GitHub merge must use merge_method=merge (not squash/rebase) or the candidate head is not an ancestor and dependent lineage checks fail. auditComplete requires manual hosted uploads for finalized artifacts, so artifact-bearing children stay held until bound. getStatus does not query the network; required-check detail appears after a live land attempt.
