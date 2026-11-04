---
title: Stateful Loop Publisher with Offline Test Seam
author: Muhammad
date: 2026-11-04
branch: t3/stateful-loop-publisher
id: l-69c8d866
scope: repo
status: active
src: agent
touches:
  - scripts/loop/pr-publication.ts
  - scripts/loop/ci.ts
  - scripts/animus-loop.ts
  - scripts/loop/types.ts
  - scripts/loop/index.ts
  - scripts/loop/lifecycle.ts
  - scripts/loop/qa-runner.ts
  - scripts/loop/review-gate.ts
  - tests/integration/loop-publication.bun.test.ts
  - tests/integration/loop-ci.bun.test.ts
---

## Decided
- Encapsulated all GitHub PR creations, bounded evidence section updates, idempotent comments, remote CI check polling, and ready-for-human label escalations inside a stateful LoopPublisher module initialized once per lap. Unified duplicate GhRunner types into a canonical port definition in scripts/loop/types.ts and propagated ghRunner through LocalLoopOptions and runAnimusLoop to enable full offline verification with push: true. Reconciled waiting approval PR CI in scripts/loop/ci.ts via LoopPublisher's pipeline, eliminating inline un-audited gh invocations and auditing all mutations into publication-records.json deduplicated by (action, target, commentType, candidate).
## Tried and ruled out
- Allowing git push to hard-fail in publishBuilderDelivery when offline caused PR creation to be skipped; catching git push gracefully allows forge mock transport to test PR creation and comments offline with push: true. Inline un-audited gh invocations in reconcileWaitingApprovalPrCi bypassed comment deduplication and publication records.
## Watch out
- Always use package.json runner (bun run test / vp run test-all) rather than raw bun test across all files to preserve Vitest isolation. Qualification script has a known baseline buildId diagnostic assertion failure.
