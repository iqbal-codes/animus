---
title: "In-process application kernel, monitor draining, and explicit process lifecycle ownership"
author: Muhammad
date: 2026-11-04
branch: factory/spec-140-integration
id: l-5ff6b0d1
scope: repo
status: active
src: agent
touches:
  - apps/backend/src/main.ts
  - apps/backend/src/monitor/runtime.ts
  - scripts/loop/process.ts
  - tests/integration/onboarding-http.bun.test.ts
---

## Decided
- Consolidate backend routes onto unified parameterized handlers and in-process backend application factory createBackendApp. Implement explicit lifecycle ownership in scripts/loop/process.ts: CLI mode retains default process exit on signal, while in-process hosts pass manageSignals: false to prevent signal listener leaks onto global process. Prevent listenerCount heuristic from disabling CLI signal exit when observers are attached. Make BackendApp.stop() idempotent and return a shared stopPromise to guarantee concurrent callers drain monitor together.
## Tried and ruled out
- process.listenerCount(signal) > 1 heuristic (arbitrary observers disabled CLI signal exit and in-process runs leaked listeners); non-shared boolean stop flag (concurrent stop calls returned before monitor drained); spawning worker.ts subprocess for monitor triage.
## Watch out
- Ensure monitor.stop() awaits drain before closing internal DB; do not attempt to query registry after app.stop() closes owned SQLite DB.
