# Runtime Scenarios: LabQ Software Factory

These journeys define the end-to-end user paths that verify the running factory service.
Shared runtime verification owns execution and evidence collection.

## 1. Operator queries factory health and candidate build identity

1. Start the factory application service with an assigned port and state directory.
2. Send `GET /health` to the service.
3. Assert that the response HTTP status is 200 and returns status `healthy`.
4. Send `GET /build-id` to the service.
5. Assert that the returned payload matches the exact active build candidate identity string (`FACTORY_RUNTIME_CANDIDATE` or Git SHA).

**What would make this fail:** The server crashes during startup, fails to bind to the dynamic port, or returns a hardcoded or stale build identity.

## 2. Operator inspects workflow catalog and triggers doctor check

1. Send `GET /api/workflows` to list all registered shared SDLC workflows.
2. Assert that the returned list is non-empty and contains `archon-loop`, `archon-ship-block`, `archon-backlog`, and `archon-holdouts`.
3. Send `POST /api/doctor` to verify toolchains, git integration, and provider bindings.
4. Assert that the response reports `ok: true` and verifies the engine status.

**What would make this fail:** Missing shared workflow entries, failed provider resolution, or broken doctor checks.

## 3. Operator initiates a supervised lap with approval gate

1. Submit a work item specification to `POST /api/laps` with `merge_mode: approve`.
2. Inspect the created lap via `GET /api/laps/:id` and observe status transition from `pending` to `running`.
3. Assert that the lap execution isolates work to an independent session directory and records run telemetry.
4. Verify that once review passes, the lap enters `waiting_approval` rather than auto-merging directly.

**What would make this fail:** Direct merge without gate check, leaking state across laps, or dropped run telemetry.
