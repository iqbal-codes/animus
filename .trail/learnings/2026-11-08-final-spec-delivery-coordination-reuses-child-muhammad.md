---
title: Final-spec delivery coordination reuses child integration and the full-delivery runtime
author: Muhammad
date: 2026-11-08
branch: t3/complete-final-delivery-coordinator
id: l-cbebade8
scope: repo
status: active
src: agent
touches:
  - apps/backend/src/dispatch/service.ts
  - apps/backend/src/delivery/runtime.ts
  - apps/backend/src/dispatch/scheduler.ts
  - packages/contracts/src/operator.ts
---

## Decided
- Final-spec delivery (#160) is a coordination layer over existing stores: migration v12 adds final_deliveries/final_delivery_events (v11 stays reserved for #164), the coordinator verifies every frozen child integration against the remote integration lineage, materializes one gate_profile=final dispatch run per combined candidate, and drives the existing DeliveryGateService + DeliveryRuntimeCoordinator. Final repairs are bounded builder laps through DispatchService.dispatchFinalRepair (same runner/ownership/brakes/Stop/budget scope, gate_profile=final, work=root spec) merged into the integration lineage with the existing serialized CAS merge; they do not create a second PR or rerun children. The final PR is the shared publication target's integration-branch -> delivery-branch PR and remains manual-merge. A DB lease plus a partial unique index on final candidate heads prevent duplicate final runs/QA across ticks and restarts. Final budget is a distinct scope (work=root, gate_profile=final) with reasoned idempotent grants.
## Tried and ruled out
- Ruled out: dispatching the parent spec through DispatchService.dispatch (parent_not_dispatchable by design); creating a second QA pipeline or DB; using the repair run's own publication target (publication targets are unique per delivery+work, so the repair builder deliberately records no audit target and the final candidate target stays integration->delivery); assuming a transport-reported merge SHA (only proven lineage in DeliveryGateService is stored).
## Watch out
- The final assembly run must keep base_sha equal to the tested delivery-branch tip and the integration candidate must include that tip, because acceptance observations record run.base_sha as both target tip and merge base. The operator merge must be verified against the remote target tip without advancing the local delivery branch first.
