---
title: Prepared plan admission freezes manifests and local decisions
author: Muhammad
date: 2026-11-08
branch: t3/import-readiness-admission
id: l-680e0e6f
scope: repo
status: active
src: agent
touches:
  - apps/backend/src/work/db.ts
  - packages/contracts/src/operator.ts
  - packages/client/src/index.ts
  - scripts/cli/commands/operations.ts
---

## Decided
- Prepared spec/ticket graphs are imported into immutable plan snapshots in the existing console.db (schema migration 2). Plans normalize addressable ACs, textual+native dependencies, coverage, gate profiles, targets, merge policy and budgets. graph_hash covers frozen member revisions and canonical dependency targets; evidence_hash covers initial labels and holds so a resolved discovery hold can be re-imported as a new snapshot. Admitted or revoked authority is sticky across re-imports; later GitHub label edits never mutate an accepted plan. Operator approval only clears missing/unset ready-for-agent authorization holds, never blocking labels, exclusion, cycles, unresolved references or incomplete discovery. Known-but-unintegrated prerequisites produce conditional dependency_pending_integration holds instead of re-triage.
- Programmatic seam: PlanService (apps/backend/src/plans/service.ts) with project-scoped /plans HTTP routes, client forProject().plans()/importPlan()/approvePlan()/revokePlan(), and animus plan list|get|import|approve|revoke.

## Tried and ruled out
- Ruled out a separate plan database or engine, live label-driven re-evaluation after admission, treating a spec with missing children as standalone, letting re-import bypass a revocation, and invoking another decomposition agent. Did not refresh frozen work revisions from GitHub.

## Watch out
- Dependency dispatch satisfaction requires verified integration lineage (readVerifiedBranchIntegrations), not issue closure. Plan members/ACs/dependencies/holds/decisions/manifests are immutable; new evidence creates a new snapshot. graph_hash excludes live external resolution so re-imports remain idempotent.
