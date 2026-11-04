---
title: Prune dead loop stubs and fold deploy probe
author: Muhammad
date: 2026-11-04
branch: t3/remove-dead-stubs-141
id: l-2a1cedc9
scope: repo
status: active
src: agent
touches:
  - scripts/loop/qa-runner.ts
  - scripts/loop/index.ts
  - tests/integration/loop-modules.bun.test.ts
---

## Decided
- Pruned 7 dead stub modules in scripts/loop (ship.ts, backlog.ts, holdouts.ts, manager.ts, simplify.ts, discoveries.ts, deploy.ts), folded DeploymentVerificationResult and verifyDeployment into scripts/loop/qa-runner.ts, eliminated unsafe mtime-based lock deletion in manager.ts to preserve PID liveness invariant (kill(pid, 0)), cleaned re-exports from scripts/loop/index.ts, and pruned synthetic stub tests in tests/integration/loop-modules.bun.test.ts while preserving all active tests.
## Tried and ruled out
- Running raw bun test runs vitest suites under bun which fails on vi.unstubAllGlobals; test execution must adhere to package.json test-all split via bun run test / vp run test-all.
## Watch out
- Ensure .gitignore and .ignore changes from environment are preserved untouched. Qualification script has a known baseline blocker at health.ts buildId mutation.
