---
title: Unified Spec Integration and Holdout-Fenced Worktree Management
author: Muhammad
date: 2026-11-04
branch: t3/spec-146-worktree-coordination
id: l-0d61f379
scope: repo
status: active
src: agent
touches:
  - scripts/loop/worktree.ts
  - apps/backend/src/coordination/worktree.ts
  - apps/backend/src/coordination/integration.ts
  - apps/backend/src/coordination/service.ts
  - scripts/loop/merge-queue.ts
  - tests/integration/coordination.test.ts
  - tests/integration/loop-merge-queue-and-reflector.bun.test.ts
  - tests/integration/loop-worktree.bun.test.ts
---

## Decided
- Consolidate backend coordination worktree allocator and lock handling onto scripts/loop/worktree.ts shared implementation. Enforce .factory/holdout/ sparse checkout fencing and .githooks binding across all worktrees. Reclaim stale locks strictly on ESRCH dead PID while treating EPERM as alive and never expiring locks by age. Implement checkout-free CAS integration via git merge-tree --write-tree + git commit-tree + git update-ref without mutating primary checkout branch or working tree. Enforce two-layer Critical Impact Gate in both coordinator and loop auto-merge, and write verified SQLite project_issue_integrations and synchronize project_spec_coordinations records upon merge.
## Tried and ruled out
- Checking out integration branches in primary repository checkout (mutated primary branch, touched working tree, and collided with uncommitted changes); mtime-based lock expiration without PID liveness (stole live locks); parallel duplicate worktree allocators.
## Watch out
- Ensure merge-tree handles conflicts fail-closed; ensure update-ref CAS detects concurrent ref drift without false positive integration rows; ensure isPidAlive treats EPERM as alive.
