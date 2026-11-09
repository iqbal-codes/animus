---
title: Standalone full-delivery gate and durable verified merge
author: Muhammad
date: 2026-11-08
branch: t3/ticket-159-standalone-delivery
id: l-56471f0f
scope: repo
status: active
src: agent
touches:
  - apps/backend/src/evidence/observations.ts
  - apps/backend/src/main.ts
  - apps/backend/src/publication/service.ts
  - apps/backend/src/registry/db.ts
  - apps/backend/src/registry/forge.ts
  - apps/web/src/features/dispatch/dispatch-control.tsx
  - packages/client/src/index.ts
  - packages/contracts/src/operator.ts
  - scripts/cli/commands/operations.ts
  - scripts/health/ui-dispatch-harness.ts
---

## Decided
- Ticket #159 adds delivery migration v9 with typed execution-check kinds/criterion keys and delivery_merge_verifications. DeliveryGateService composes the existing evidence/publication/forge modules for standalone/final profiles: it requires independent review plus final acceptance, AC-keyed black-box checks, regression, remote CI, independent producers, publication audit, exact source/target binding, and manual merge policy. verifyMerge records local completion only after the remote PR reports MERGED into the exact target and the candidate is proven in the remote target lineage. GATE_PROFILE_VERSION is 2 because the full-delivery gate definition changed. Routes/client/CLI/operator panel expose the precise gate and merge states.
## Watch out
- A merged PR is no longer active; publication renders auditCompleteness from the last bound PR and preserves a previously published target state so post-merge reconciliation does not erase the audit. Delivery completion still requires remote target lineage, not just a MERGED state. Child profiles are explicitly rejected by the full gate. Migration v8 stays reserved for #158.
