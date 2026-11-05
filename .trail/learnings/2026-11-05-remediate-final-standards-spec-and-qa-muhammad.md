---
title: "Remediate final standards, spec, and QA findings for deep software factory modules"
author: Muhammad
date: 2026-11-05
branch: t3/spec140-final-remediation
id: l-c3ab184e
scope: repo
status: active
src: agent
touches:
  - apps/backend/src/coordination/integration.ts
  - apps/backend/src/coordination/service.ts
  - apps/backend/src/coordination/worktree.ts
  - apps/backend/src/intake/admission.ts
  - apps/backend/src/intake/contract.ts
  - apps/backend/src/monitor/runtime.ts
  - apps/backend/src/monitor/service.ts
  - apps/engine-host/src/native.ts
  - packages/contracts/src/paths.ts
  - scripts/loop/index.ts
  - scripts/loop/merge-queue.ts
  - scripts/loop/process.ts
  - scripts/loop/reflector.ts
  - scripts/loop/scheduler.ts
  - scripts/loop/session.ts
  - scripts/loop/triage.ts
  - scripts/loop/types.ts
  - scripts/loop/worktree.ts
---

## Decided
- Consolidate all FINAL standards+spec+QA findings for spec140:
1. Removed accidental evidence.json and tdd.log from root git tracking into external run artifacts.
2. Made acquireCrossProcessIntegrationLock strictly async with await setTimeout(25) timer (Atomics.wait prohibited), fixed rev-parse newline, added heartbeat responsiveness test under contention.
3. Fixed Git CAS + SQLite + forge mutation ordering in subticket auto-merge: CAS ref update -> SQLite project_issue_integrations write BEFORE remote publication; automatic CAS ref rollback to targetBaseTip on DB write failure; honest persisted recovery ('merged' with reconciliation required) on remote publication failure.
4. Consolidated canonical PID liveness in paths.ts on isProcessAlive/isPidAlive: positive integer validation, only ESRCH is dead, EPERM is alive, reused across worktree, triage, integration.
5. Derived all LapSession paths via canonical resolveProjectWorkspace, added reviewer/report.md generation, verified engine host and monitor visibility under ANIMUS_HOME.
6. Aggregated [ws.runsDir, ...ws.fallbackRunsDirs] in evaluateBacklogAdmission, bindIssueContract, and scheduler tick.
7. Verified SQLite project_issue_integrations dependency satisfaction parity across IntakeService, target binding, bindIssueContract, and scheduler.
8. Refactored reflector createBoundedReflectionTransport to delegate to shared runBoundedRole with role: 'reflector' without positional argv string mutation.
9. Added owner.json PID tracking and stale lock recovery (ESRCH) to RegisteredProjectMonitor candidateLock.
10. Delegated monitor setup(root) schedule validation to shared loadCascadedScheduleConfig.
11. Cleaned dead configureProcessLifecycle and phantom bindIssueContractAsync references.
12. Disambiguated acquireIssueLock (worktree lock) and acquireTriageIssueLock (triage lock).
13. Exported allocateWorktree directly from apps/backend/src/coordination/worktree.ts and updated SpecCoordinatorService.
## Tried and ruled out
- Ruled out Atomics.wait for lock contention (prohibited because it blocks Node/Bun event loop); ruled out pretending unmerged waiting_approval after irreversible Git ref and SQLite mutations; ruled out swallowing EPERM as dead process; ruled out hardcoded common/factory-local-loop paths; ruled out positional argv string patching in role runner; ruled out modifying scripts/health/qualify.mjs baseline judge or gaming client typecheck.
## Watch out
- Always check that owner.json exists before reclaiming monitor locks; missing owner.json must fail closed (age never proves dead). Always verify git rev-parse output is trimmed when resolving git-dir.
