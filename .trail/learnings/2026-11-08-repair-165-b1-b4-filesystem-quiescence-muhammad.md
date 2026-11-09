---
title: "Repair #165 B1-B4: filesystem quiescence, cross-process locks, external-writer gates, packaged PRAGMA proof"
author: Muhammad
date: 2026-11-08
branch: t3/repair-execution-authority-review
id: l-bae59aab
scope: repo
status: active
src: agent
touches:
  - packages/contracts/src/execution-authority.ts
  - packages/contracts/src/cutover.ts
  - apps/backend/src/cutover/inventory.ts
  - apps/backend/src/cutover/service.ts
  - apps/backend/src/main.ts
  - apps/backend/src/publication/service.ts
  - apps/backend/src/publication/issues.ts
  - apps/backend/src/integration/service.ts
  - apps/backend/src/final/service.ts
  - apps/backend/src/delivery/service.ts
  - scripts/loop/session.ts
  - scripts/loop/merge-queue.ts
  - scripts/loop/publisher.ts
  - scripts/loop/ci.ts
  - scripts/cli/commands/authority.ts
  - scripts/cli/commands/operations.ts
  - docs/authority-cutover.md
---

## Decided
- Inventory legacy runs/dossiers/locks/worktrees from registered-project-derived roots and hold live or ambiguous owners. Serialize stage/activate/abort with an async owner-token operation lock, and serialize marker writes with a non-blocking owner-token CAS lock; recover stale locks only on proven ESRCH. Commit 'activated' before writing the local marker so a crash leaves the migrating fence; verify a local marker against an activated row for every external writer. Gate publication/draft/integration/final/delivery at both route preflight and the service effect point, and re-check mid-lap in the legacy loop, publisher, CI, merge-queue and its direct console.db writer. Report only PRAGMAs actually observed by a read-only packaged connection and prove backup+held-restore through the compiled CLI.
## Tried and ruled out
- Atomics.wait for the synchronous marker lock (reverted: the team ruled out event-loop-blocking lock contention; live contention now fails fast and the async operation lock provides serialization). Treating atomic rename alone as compare-and-swap. Trusting a local marker without an activated cutover row. Scanning arbitrary filesystem paths instead of deriving roots from the projects table. Requiring 'local' for legacy draft publication (pre-cutover legacy must keep working).
## Watch out
- A test fixture that writes a 'local' marker with zero cutover rows is treated as settled; a migrating/staged/activating row always fences. The operation lock is a directory (.authority-cutover.lock) and the marker lock is a file (.execution-authority.lock); both live under the installation state dir. Stage/activate re-check the legacy filesystem digest, not just the DB digest.
