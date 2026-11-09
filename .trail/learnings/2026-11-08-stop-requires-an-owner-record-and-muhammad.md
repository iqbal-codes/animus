---
title: Stop requires an owner record and matching detached process group
author: Muhammad
date: 2026-11-08
branch: t3/repair-ticket-156-blockers
id: l-d3c97532
scope: repo
status: active
src: agent
touches:
  - apps/backend/src/dispatch/service.ts
  - tests/integration/dispatch-budget-controls.test.ts
---

DispatchService.workerIdentityFailure must reject an absent worker-owner record rather than confirm termination from a dead coordinator alone. Stop remains unconfirmed and sends no signal. The default bounded builder is a detached process-group leader, so its owner.pgid must equal owner.pid before any group signal; matching token/generation/PID start time alone did not authenticate a foreign pgid. Public applyControl regressions use real detached processes and an injected terminator to prove no foreign group is reached; missing record also stays stopping. Explicit reconcile remains the separate evidence/effects release path.
