# Runtime Scenarios: Animus

These journeys define the end-to-end user paths that verify the running factory service.
Shared runtime verification owns execution and evidence collection.

## 1. Operator queries factory health and candidate build identity

1. Start the factory application service with an assigned port and state directory.
2. Send `GET /health` to the service.
3. Assert that the response HTTP status is 200 and returns status `healthy`.
4. Send `GET /build-id` to the service.
5. Assert that the returned payload matches the exact active build candidate identity string (`FACTORY_RUNTIME_CANDIDATE` or Git SHA).

**What would make this fail:** The server crashes during startup, fails to bind to the dynamic port, or returns a hardcoded or stale build identity.

## 2. Operator inspects the workflow catalog and engine diagnostics

1. Send `GET /api/v1/catalog` to the service.
2. Assert that the response is 200 with a non-empty `workflows` array containing `animus-loop`,
   `animus-ship-block`, `animus-backlog`, and `animus-holdouts`.
3. Send `GET /api/v1/diagnostics` to the service.
4. Assert that the response is 200 with `status` in `healthy` / `degraded`, the configured
   `revision_required`, a non-empty `digest`, and `default_workflows_loaded: true`.

**What would make this fail:** The engine host is unreachable, the pinned source is incomplete,
the catalog omits required workflows, or diagnostics report unavailable prerequisites. A 503
`host_unavailable` / `host_unauthorized` is an honest blocked result, never a pass.

## 3. Operator submits a supervised lap and inspects its isolated run

1. Submit a work item with `POST /api/v1/laps` and a strict JSON body `{"specification": "<work>"}`.
2. Assert that the response is 202 with the genuine native run `id` and an initial `status`.
3. Inspect the created lap with `GET /api/v1/laps/:id` and observe the transition from
   `pending` to `running`.
4. Assert that the lap records an isolated session `working_path` and that
   `GET /api/v1/commands` contains the corresponding `launch` command record.
5. Assert that the lap never merges directly into the promotion target: child integration and
   final delivery remain gated, and the final merge stays manual.

**What would make this fail:** A STOP brake still permits a launch, the service returns a
synthetic run ID, state leaks across laps, the command ledger omits the launch, or a run
bypasses the delivery gates.
