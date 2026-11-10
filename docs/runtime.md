# Factory application runtime

- **Status:** Active
- **Last verified:** 2026-11-10

The application requires Bun 1.4.2 and Node 26.13.0. Run from the
delivering checkout's root:

```sh
FACTORY_RUNTIME_STATE=/tmp/factory-state \
FACTORY_RUNTIME_CANDIDATE=candidate-a \
bun apps/backend/src/main.ts --port 8080
```

The start-command argv is `["bun", "apps/backend/src/main.ts", "--port", "{port}"]` (or via unified launcher `["bun", "apps/launcher/src/main.ts", "--port", "{port}"]`), with
`{port}` replaced by the assigned port. The listener binds only `127.0.0.1` by default, not
all network interfaces. When `FACTORY_REMOTE_ACCESS=true`, private IP binding and operator token authentication are enforced. No workflow, provider, or scheduler starts at boot.

## Inputs and state

- `--port` is required; use a different assigned port for each concurrent process.
- `FACTORY_RUNTIME_CANDIDATE`, when set, is the exact response text for
  `/build-id`, including an empty value or whitespace. Supply a non-secret candidate
  identifier: this value is intentionally public to local HTTP clients.
- When `FACTORY_RUNTIME_CANDIDATE` is unset, startup runs `git rev-parse HEAD` in
  the delivering checkout root. Git failures fail startup rather than
  returning a placeholder identity. The identity is resolved once at boot, so
  changing checkout HEAD later does not relabel an already-running process.
- `FACTORY_RUNTIME_STATE` specifies the directory for any writable application
  state. Supply a fresh directory for each attempt. These endpoints are
  stateless: they do not create application directories, databases, or files,
  and they do not need a default state directory. Future persistence must use
  this input, not write into the source checkout or shared factory directories.

## Subticket integration recovery

Subticket auto-merge writes a phase journal under the Animus state directory's
`integration-recovery/` before changing a Git ref. Each journal records the checkout,
issue, integration branch, old and candidate SHAs, PR, and last attempted phase.
`completed` and `rolled_back` are terminal. Any other phase requires inspection;
do not infer remote success from a local integration record.

For recovery, compare the recorded branch with local and remote refs, inspect the
PR and issue on the forge, and check the project's SQLite integration and coordination
records in `state/console.db` under Animus Home. Resolve the exact failed step before
resuming scheduling. A `manual_intervention_required` result means database sync and
Git rollback both failed: preserve the journal and reconcile the observed ref before
retrying. A `remote_reconciliation_pending` result means local integration succeeded
but publication did not finish; later forge operations were not attempted. Recovery
is operator-driven, never an automatic replay of potentially completed forge actions.

Monitor and issue locks serialize ownership changes with a sibling `.mutex` directory.
Only an ESRCH-confirmed dead PID permits stale-owner reclamation. Missing or malformed
owner data, or an abandoned mutation mutex, requires operator inspection rather than
age-based deletion. Stop competing workers before manually recovering either lock.

## Child gate integration

A child ticket auto-integrates only when its candidate-bound acceptance is authorized
under gate-profile version 2: builder, applicable technical/contract checks and an
independent standards/contract review, with any required remote CI completed and
passing. The merge itself is performed by the configured forge so GitHub protections
still apply; factory code only records completion after re-reading the remote target
and proving the candidate (and merge commit) are included in that lineage.

Each verified merge is stored in `child_integrations` (migration v8) with candidate,
merge, before/after target tips and PR identity; attempts are append-only in
`child_integration_events`. Serialization reuses the cross-process integration lock
and git compare-and-swap. Conflicts, target drift, stale evidence, closed PRs, an
exhausted budget or incomplete PR audit hold the ticket; they never force a merge.
A stale succeeded candidate re-enters a new bounded builder lap when the target has
advanced since it was built. Dependents release only after the verified inclusion is
recorded, not from issue closure or a `MERGED` flag alone.

The normal monitor tick and both local CLI entry points (`scripts/scheduler.ts` and
the `animus loop` scheduler command) build the same execution composition. Each tick
first resumes a succeeded run whose gate is not terminal — so a builder-only run, a
pending required-CI read or an interrupted audit continues without a new lap — and
then dispatches the next eligible plan member. Child, standalone and final runs all
receive the shared delivery runtime; there is no CLI-only path that skips gate
processing.

- HTTP: `GET /projects/:id/integration`, `GET /projects/:id/integration/runs/:runId`,
  `POST /projects/:id/integration/runs/:runId/land`.
- CLI: `factory plan integrations`, `factory plan integration <run-id>`,
  `factory plan land <run-id>`.
- Operator UI: the per-run **Integration** panel shows acceptance reasons, blockers,
  required checks, the child PR, verified merge identity and attempts, and exposes the
  keyboard-operable merge action.

### Delivery-role claims

Technical checks, independent review and full-delivery acceptance run as durable
delivery-role claims (`delivery_role_claims`), separate from the builder dispatch
run. Stop/takeover and cutover staging honor the recorded role process identity:

- A **running** claim blocks quiescence and takeover.
- An **interrupted** claim with a retained/unreadable owner identity is held
  (`frozen_unknown_owner`); it is never reported as released.
- `interrupt` only releases a claim whose recorded role/coordinator process is
  proven dead (ESRCH or a start-identity mismatch that is gone), clearing
  owner/role PID/PGID/start, zeroing the lease, rotating the fencing token and
  bumping the generation. A *live* owner is refused; an unreadable identity
  requires an explicit `acknowledgeUnknownOwner` acknowledgement and stays held.
- `complete` resolves the result observation under the claim's own
  project/run/stage/lap/attempt/candidate tuple; a foreign or stale receipt is
  rejected with 409 and never terminalizes the claim.
- Every reconcile is fenced by the caller-observed opaque generation, candidate
  and state, recorded through the durable `CommandLedger` and the append-only
  `delivery_role_claim_audit` table.

- HTTP: `GET /projects/:id/delivery/runs/:runId/claims`,
  `POST /projects/:id/delivery/runs/:runId/claims/:stage/reconcile`.
- CLI: `factory plan claims <run-id> --project <id>`,
  `factory plan claim-interrupt <run-id> --project <id> --stage <stage> --lap <n>
  --expected-generation <n> --reason <text> [--ack-unknown-owner]`,
  `factory plan claim-complete ... [--observation <id>]`.
- Operator UI: the per-run **Delivery role claims** panel shows active, unknown and
  interrupted claims even when the builder run has succeeded, with fresh CAS state
  and interrupt/complete controls.

Embedded monitor operations inherit an async-local subprocess policy that leaves
SIGTERM/SIGINT ownership with the backend. Nested Git and agent processes still have
bounded owned-process cleanup, but cannot terminate the backend with the standalone
loop's signal exit code. Standalone loop commands retain their signal handlers.

## Operator authentication and actor attribution

The backend is a single-operator local service. With remote access disabled it accepts
loopback requests; when `FACTORY_REMOTE_ACCESS=true` it requires the configured 32+ character
operator token on every request. Authentication proves that a request comes from the trusted
operator boundary. It does not establish per-user identity or a role hierarchy.

Command bodies carry an `actor` label that is recorded in the command ledger, findings,
grants and control records for audit attribution. That label is caller-supplied descriptive
text, not an authenticated principal and not an authorization decision. No caller-supplied
role is used to grant permission. Authorization remains the shared operator boundary: do not
treat `actor` as an ACL subject, and do not add per-user authentication without a separate
trusted identity design.

Dispatch controls and budget grants authorize through the same boundary. Their durable
identity checks (`owner_token`, `ownership_generation` and the recorded process start
identity) protect process ownership and PID reuse; they are not user authentication.

## HTTP contract

The backend authenticates every request through the operator boundary except
`GET /health`, `GET /build-id`, `GET /api/v1/health` (the authenticated
backend-to-host identity roundtrip), and `POST /api/v1/webhooks/github` (HMAC
verified). With `FACTORY_REMOTE_ACCESS=true`, every other request requires
`Authorization: Bearer <FACTORY_OPERATOR_TOKEN>`.

| Request | Purpose |
| --- | --- |
| `GET /` | Read-only operator dashboard and web console shell |
| `GET /health` | Local liveness: `{"status":"healthy"}` |
| `GET /build-id` | Exact startup candidate or Git commit text, without a trailing newline |
| `GET /api/v1/health` | Authenticated backend-to-host identity roundtrip; fails on mismatch |
| `GET /api/v1/catalog` | Pinned workflow catalog forwarded from the engine host |
| `GET /api/v1/diagnostics` | Pin, digest, source, and default-workflow diagnostics forwarded from the engine host |
| `GET /api/v1/laps` | Native lap list |
| `POST /api/v1/laps` | Supervised lap submission with a strict `{"specification": "..."}` body |
| `GET /api/v1/laps/:id` | Native lap detail and observed lifecycle transitions |
| `GET /api/v1/laps/:id/evidence` | Candidate-bound runtime, holdout, and review evidence projection |
| `GET /api/v1/laps/:id/evidence/report` | Plain-markdown independent review report |
| `GET /api/v1/controls` | Read or change global launch/schedule controls through the engine host |
| `GET /api/v1/brakes` | Global launch-brake and schedule-pause state |
| `GET /api/v1/promotion/status` | Unpromoted commits, delivered tickets, candidate freeze, and promotion PR state |
| `POST /api/v1/promotion/prepare` | Create the promotion PR and activate candidate freeze |
| `GET /api/v1/commands` | Durable command ledger with state and reconciliation records |
| `/api/v1/authority/*` | Execution-authority state, staging, activation, abort, and backup inspection |
| `/api/v1/backups/*`, `/api/v1/restores/*` | Backup creation, listing, inspection, and held restore |
| `GET /api/v1/intake`, `GET /api/v1/intake/:number` | Global intake projection and per-issue admission metadata |
| `GET /api/v1/monitoring` | Monitor status, capacity, and registered-project projections |
| `/api/v1/projects`, `/api/v1/projects/:id` | Project registry, retargeting, and deregistration |
| `/api/v1/projects/:id/*` | Project-scoped intake, work, drafts, plans, dispatch, coordination, evidence, publication, draft-publications, integration, delivery, final, board, laps, controls, promotion, brakes, and commands |
| `/api/v1/ws` | WebSocket heartbeat and invalidation events |
| `POST /api/v1/webhooks/github` | HMAC-verified GitHub issue event ingestion |
| `/api/harness/*` | Harness memory and self-check surfaces |

All responses use `Cache-Control: no-store`. Unknown paths return 404. Unsupported
methods on a declared path return 405 with an `Allow` header. Non-settled execution
authority refuses mutating project actions with 409 `execution_authority_moving`;
legacy-only live-forge coordination dispatch refuses with 409
`execution_authority_moved` after local activation. Error bodies contain typed codes,
never raw upstream text or credentials.

### Launch brake controls

`/api/v1/controls` reads or changes global launch and schedule controls through the
engine host. `/api/v1/brakes` and `/api/v1/projects/:id/brakes` read and set the
durable global and project brake state directly:

- `global_launch` / project `launch_brake` sets the STOP marker. New work, resume,
  approve, and respond are refused while active work remains; cancel stays available.
- `schedule_pause` sets the PAUSE marker. Scheduled timer launches stop while explicit
  manual runs and native wake passes remain available.
- Repeating the same action is idempotent. Neither brake cancels or interrupts an
  in-flight run, changes execution authority, bypasses a merge gate, or installs a
  schedule.
- Project-scoped brake mutation passes through the shared execution-authority
  preflight before it writes.

### Intake projection

`GET /api/v1/intake` evaluates the operator-visible issue backlog;
`GET /api/v1/intake/:number` resolves one issue. `GET /api/v1/projects/:id/intake`
applies the same projection to a registered project. `?refresh=true` forces a fresh
tracker read; otherwise results are cached briefly to protect API rate limits.

Admission labels (`ready-for-agent`, `needs-info`, `ready-for-human`, `needs-triage`,
`wontfix`, `spec`, `needs-owner`) are visibility hints. Execution admission and
dependency release come from the frozen local plan and verified lineage after the
authority cutover, never from issue closure alone. Legacy `factory:*` labels carry
zero authority. When the tracker read fails, the endpoint returns 503
`intake_unavailable` rather than an empty success.

### Promotion and candidate freeze

`GET /api/v1/promotion/status` compares the integration target with the promotion
target, lists delivered ticket numbers, reports candidate-freeze state, and describes
an open promotion PR. `POST /api/v1/promotion/prepare` refuses with 409
`no_unpromoted_commits` or `promotion_pr_already_open`, compiles the delivered-work
summary, creates the promotion PR, and activates candidate freeze through
`.factory/PAUSE`.

### Engine discovery and diagnostics

`GET /api/v1/catalog` and `GET /api/v1/diagnostics` forward to the engine host over
the authenticated loopback/internal boundary. The host must be reachable and must
return the validated catalog or diagnostics schema. An unreachable host returns 503
`host_unavailable`; an authentication failure returns 503 `host_unauthorized`; a
malformed host response returns 502 `invalid_host_response`. Diagnostics describe the
pinned revision, source digest, captured time, source directory, file count, and
whether default workflows loaded. They are local configuration checks, not proof
that a provider credential or remote model works, and they never mutate tracker,
publication, schedule, provider, or credential state.

### Native lap inspection and submission

`GET /api/v1/laps` and `GET /api/v1/laps/:id` read native run projections through the
engine host. Lists include CLI-created runs and use native details for status
derivation; a run disappearing between list and detail is an unavailable read, not an
empty list. Public projections include the native workflow name and status,
`product_status`, timestamps, candidate head, work item and pull-request identity,
isolated session facts, observed transitions, and token usage. Provider transcripts,
raw outputs, error prose, and holdout contents are excluded. Exposed identity strings
are credential-redacted.

`product_status` preserves the native status except for an evidence-bound
`waiting_approval` projection: a supervised `merge=approve` run must have matching
subject, verification, evidence, and review events for the same current head, and no
completed land event. This is historical evidence, not a fresh claim that the forge
PR is still open.

`POST /api/v1/laps` accepts only a JSON object with a non-empty `specification`
string; unknown fields are rejected. Shell metacharacters remain literal message text.
Before launch the service checks the STOP brake and returns 409 `launch_brake_set`
without creating a run. A valid submission generates an isolated worktree and
session, then returns 202 with the genuine native run ID and initial status. Invalid
payloads return 400 `invalid_payload`; host/engine failures return 503
`host_unavailable` or 502 launch failure without a synthetic run ID.

`GET /api/v1/laps/:id/evidence` returns an allowlisted projection of candidate-bound
runtime verification, holdout verdict metadata, and independent review status.
`GET /api/v1/laps/:id/evidence/report` returns only the allowlisted reviewer report
artifact as `text/markdown`; path traversal, arbitrary artifact browsing, missing runs,
and missing reports fail with typed 404 codes, and native-store failures return 503
`native_state_unavailable`.

### Operator dashboard

`GET /` serves the read-only operator dashboard and the React web console. It uses the
live lap, intake, project, evidence, authority, brake, and command APIs above, renders
explicit empty and unavailable states, and treats all untrusted text as text nodes.
Loading, selecting, and refreshing perform read-only GET requests and trigger zero
engine mutations.

## Focused checks

```sh
bun test
vp test run
```

The tests launch real subprocesses with temporary state directories and assigned
ports. They check health readiness within five seconds, exact identities, Git
fallback, concurrent isolation, and listener release for both shutdown signals.
Focused test suites exercise the lap HTTP/native read boundary,
status derivation, stale/incomplete evidence, privacy, engine
failure semantics, two-run isolation, supervised submission validation,
local STOP brake refusal, detached execution, shell literal preservation, process
failure handling, as well as candidate-bound evidence projections, report delivery,
holdout fencing, credential redaction, path traversal rejection, and independent
peer review attribution. It does not launch provider workflows.
Engine diagnostics verify catalog, local tools, configured Bun, pin verification,
native JSON discovery, and binding validation.

The repository's declared ordinary gates are `bun run check` and `vp run verify-all`.

## Unified TypeScript/Bun distribution and runtime

The unified factory operates `apps/backend` and `apps/engine-host`
via `apps/launcher/src/main.ts`. See [monorepo health instructions](monorepo-health.md)
for pinned Bun 1.4.2 / Node 26.13.0 / Vite+ 1.4.0, exact start argv, private credential provisioning and checks.
Backend API serves on loopback or configured host, while engine-host remains strictly loopback private.

## Execution authority cutover

An existing installation upgrades to the single local execution authority through
the validated #165 cutover. The durable marker, migration-15 schema, restartable
staging, isolated held-restore proof, CAS activation/abort and every fenced legacy
consumer are documented in [authority-cutover.md](authority-cutover.md). Restore
holds remain a separate gate: a held restored installation never activates
execution authority automatically.
