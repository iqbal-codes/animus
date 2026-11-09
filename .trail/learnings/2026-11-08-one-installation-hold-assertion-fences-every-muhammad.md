---
title: One installation-hold assertion fences every execution/publication writer; release is verified
author: Muhammad
date: 2026-11-08
branch: t3/review-remediation-164
id: l-5aa37b9a
scope: repo
status: active
src: agent
touches:
  - apps/backend/src/restore/hold.ts
  - apps/backend/src/restore/service.ts
  - apps/backend/src/publication/issues.ts
  - apps/backend/src/coordination/service.ts
  - apps/backend/src/integration/service.ts
  - apps/backend/src/evidence/landing-guard.ts
---

## Decided
- Restored installations reuse the single assertInstallationNotHeld policy at the actual writer choke points: DispatchService, PublicationService (publish/reconcile/reconcileAll), DraftPublicationService (publishDraft/publish/reconcile/reconcileAll), SpecCoordinatorService (dispatchChild/createFinalPullRequest), ChildIntegrationService.land, LandingGuard.executeLanding, and the legacy CLI/native loop/merge-queue/scheduler launchers via assertInstallationNotHeldAtStateDir. Release requires an exact-enumerated set of dispositions fenced to the restored snapshot: runs must have copied owner pid/lease cleared (never signalled, PID reuse is not authority) and intents are verified by read-only forge readback so present effects must be resolved and unreadable readbacks fail closed.
## Tried and ruled out
- Ruled out a second policy/runner per module, caller/actor flags that bypass the hold, unconditional reconciliation by free-text reason, signalling a copied owner PID, and treating a queued/unknown intent as resolved without a positive remote readback.
## Watch out
- Bundled artifacts dedupe by project-relative path (owner identity is not bundle identity); restore rewrites worktree/scope/checkout paths to the final target root, never the staged temp root; a v11-only snapshot applies v8 after v11 on restore which is safe because v8 only creates independent tables.
