---
title: unified-backlog-admission-and-frozen-contract-binding
author: Muhammad
date: 2026-11-04
branch: t3/admission-engine-contract-binding
id: l-27b3c746
scope: repo
status: active
src: agent
touches:
  - apps/backend/src/intake/admission.ts
  - apps/backend/src/intake/binding.ts
  - apps/backend/src/intake/service.ts
  - scripts/loop.ts
  - scripts/scheduler.ts
  - scripts/loop/scheduler.ts
---

## Decided
- Unified backlog admission and frozen issue contract binding behind evaluateBacklogAdmission and bindIssueContract in apps/backend/src/intake. Enforced all 7 admission invariants across IntakeService, verifyTargetBinding, scheduler, and loop CLI: OPEN state, unlabeled held, wontfix excluded with absolute precedence, blocking labels (needs-info, ready-for-human, needs-triage, needs-owner) held, ready-for-agent required, union of Markdown Depends on and native GitHub blocked_by satisfied via CLOSED forge state / local merged runs / SQLite branch integrations, and operational held states (active claims, waiting_approval, needs_owner, interrupted, dossier attempts >= max_laps). bindIssueContract cryptographically freezes normalized content including nested canonical sections with SHA-256 and produces deeply frozen immutable contracts.
## Tried and ruled out
- Ad-hoc per-caller admission checks (caused scheduler to crash when selecting issues blocked by native GitHub dependencies, omitted needs-owner from web console and binding, and missed dossier exhaustion). Unvalidated contract reading without cryptographic hash or section validation (allowed malformed or truncated specs to be executed). Swallowing native dependency fetch errors or restricting native queries to synthetic adapter only (failed open and admitted unvetted work during API outages).
## Watch out
- Ensure native dependency queries fail closed across scheduler, intake, and target binding callers when forge adapter dependency lookup errors. Check exact runStates (needs_owner, interrupted) in both scheduler filtering and contract binding. Deeply freeze all nested structures in BoundIssueContract so arrays and sections cannot be mutated.
