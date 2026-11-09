---
title: Fence every legacy direct launch after local authority cutover
author: Muhammad
date: 2026-11-08
branch: t3/repair-ticket-154-findings
id: l-b879a0ff
scope: repo
status: active
src: agent
touches:
  - scripts/cli/commands/loop.ts
  - scripts/loop.ts
  - apps/engine-host/src/native.ts
  - apps/web/src/features/dispatch/dispatch-control.tsx
---

Decision: readExecutionAuthority lives in @animus/contracts/execution-authority so backend, engine host and scripts share one durable marker without a cross-app engine-host-to-backend dependency. Guard runLoopCliCommand run, scripts/loop.ts main, and launchNativeLap before forge lookup/preflight/spawn; guard scheduler and monitor separately. Scheduler-only fencing left issue-number direct launch routes active. Regression tests replace Bun.spawnSync with a throwing transport and exercise the standalone entry with no gh in PATH. The authority remains legacy by default until validated cutover. DispatchControl must refresh persisted runs even when dispatch returns an error: failed runs are durable data, not merely transient alerts. Runtime UI proof uses real temp SQLite/git/worktrees and an injected process boundary, not a fake client; it does not prove an external model invocation.
