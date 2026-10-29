# Factory application runtime

The application requires Python 3.10 or newer. It uses only the standard library;
Git must be available when no candidate identity is supplied. Run from the
delivering checkout's root:

```sh
FACTORY_RUNTIME_STATE=/tmp/factory-state \
FACTORY_RUNTIME_CANDIDATE=candidate-a \
python3 app.py --port 8080
```

The start-command argv is `["python3", "app.py", "--port", "{port}"]`, with
`{port}` replaced by the assigned port. The listener binds only `127.0.0.1`, not
all network interfaces. No workflow, provider, or scheduler starts at boot.

## Inputs and state

- `--port` is required; use a different assigned port for each concurrent process.
- `FACTORY_RUNTIME_CANDIDATE`, when set, is the exact response text for
  `/build-id`, including an empty value or whitespace. Supply a non-secret candidate
  identifier: this value is intentionally public to local HTTP clients.
- When `FACTORY_RUNTIME_CANDIDATE` is unset, startup runs `git rev-parse HEAD` in
  the directory containing `app.py`. Git failures fail startup rather than
  returning a placeholder identity. The identity is resolved once at boot, so
  changing checkout HEAD later does not relabel an already-running process.
- `FACTORY_RUNTIME_STATE` specifies the directory for any writable application
  state. Supply a fresh directory for each attempt. These endpoints are
  stateless: they do not create application directories, databases, or files,
  and they do not need a default state directory. Future persistence must use
  this input, not write into the source checkout or shared factory directories.

## HTTP contract

| Request | Status | Content type | Response body |
| --- | --- | --- | --- |
| `GET /` | 200 | `text/html; charset=utf-8` | Read-only operator dashboard HTML |
| `GET /health` | 200 | `application/json` | `{"status": "healthy"}` |
| `GET /build-id` | 200 | `text/plain; charset=utf-8` | Exact startup candidate or Git commit, with no added newline |
| `GET /api/workflows` | 200 | `application/json` | `ok:true`, validated `source`, `revision`, `workflows`, and local `checks` |
| `POST /api/doctor` | 200 | `application/json` | Validated catalog and required local checks, plus native provider/model binding resolution |
| `GET /api/controls` | 200 | `application/json` | Actual launch-brake state: `{"halted": <bool>, "paused": <bool>}` |
| `POST /api/controls/:action` | 200 | `application/json` | Launch brake action (`halt`, `unhalt`, `pause`, `unpause`): `{"halted": <bool>, "paused": <bool>}` |
| `GET /api/intake` | 200 | `application/json` | Evaluated backlog with admission status (`admitted`, `held`, `excluded`), reasons, Jev advisory recommendations, and satisfied dependencies |
| `GET /api/intake/:number` | 200 | `application/json` | Evaluated admission and Jev advisory metadata for a specific issue number |
| `GET /api/promotion/status` | 200 | `application/json` | Unpromoted commit count, delivered ticket list, candidate freeze flag, and open PR status |
| `POST /api/promotion/prepare` | 201 | `application/json` | Creates batch promotion PR develop → main and activates Candidate Freeze (`.factory/PAUSE`) |
| `GET /api/config/schedule` | 200 | `application/json` | Active schedule settings (`parallel`, `work_window`, `base_branch`, etc.) |
| `GET /api/config/models` | 200 | `application/json` | Configured AI provider model tiers and aliases from `.archon/config.yaml` |
| `POST /api/laps` | 202 | `application/json` | `{"id": "<run-id>", "status": "<status>"}` |
| `GET /api/laps` | 200 | `application/json` | Array of native `archon-loop` lap projections, or `[]` when no laps exist |
| `GET /api/laps/:id` | 200 | `application/json` | One lap projection for the exact native ID |
| `GET /api/laps/:id/evidence` | 200 | `application/json` | Candidate head binding, runtime verification verdicts, holdout verdict metadata, and peer-review evaluation |
| `GET /api/laps/:id/evidence/report` | 200 | `text/markdown; charset=utf-8` | Plain text peer-review markdown report (`reviewer/report.md` or `review/report.md`) |

Endpoints do not redirect. Unknown lap IDs (including IDs of other workflows)
return 404 JSON `{"error":"lap_not_found"}`. Missing review report artifacts return
404 JSON `{"error":"report_not_found"}`. Unavailable or malformed native
state returns 503 JSON `{"error":"native_state_unavailable"}`, never an empty
success. Unknown control actions or requests containing extra query/body arguments
return 400 JSON `{"error":"unknown_action"}` or `{"error":"invalid_arguments"}` and
invoke zero consumer actions. Other paths return 404. Responses use `Cache-Control: no-store`. Access
logging is disabled so request targets are not copied into process logs.

### Launch brake controls

`GET /api/controls` and `POST /api/controls/:action` expose the factory's native
operational launch brakes without changing identities, bypass merge gates, or enabling
schedules.
- `GET /api/controls` returns the actual launch-brake state as `{"halted": <bool>, "paused": <bool>}`.
- `POST /api/controls/:action` accepts only `halt`, `unhalt`, `pause`, and `unpause`. It calls
  the existing `factory/consumer.py` controls directly with no caller-supplied extra arguments.
  Calling `halt` twice leaves `halted=true`; calling `unhalt` twice leaves `halted=false`;
  calling `pause` twice leaves `paused=true`; calling `unpause` twice leaves `paused=false`.
- Requests containing unknown actions, query arguments (`command`, `source`, `cwd`, etc.), or
  request bodies with extra arguments return HTTP 400 and invoke zero consumer actions.
- Failed consumer actions return HTTP 500 without a false success state.
- Existing brake semantics are preserved: `halt` sets the local STOP marker which refuses
  `run`, `resume`, `approve`, and `respond` while active work remains running and `cancel`
  remains available; `pause` sets the PAUSE marker which stops scheduled timer launches
  while retaining native wake passes and permitting explicit manual runs. Neither control cancels
  or interrupts in-flight runs.
- The service listener is strictly restricted to loopback addresses (`127.0.0.1`, `localhost`, `::1`).
  Any non-loopback bind request (such as `--host 0.0.0.0`) is rejected on startup. No endpoint
  executes schedule installation, schedule removal, or timer-enabling commands.

### Intake ledger and admission gating

`GET /api/intake` evaluates the backlog of target repository issues (default `pabriq-app` or
`FACTORY_TARGET_REPO`):
- **Admission rules**:
  - `admitted`: issue is `OPEN`, carries canonical `ready-for-agent`, carries no blocking
    or exclusion labels, all referenced `Depends on: #...` prerequisites are closed, and has no active loop claim.
    Legacy `factory:*` labels convey zero authority.
  - `held`: unlabeled issues (`unlabeled_awaiting_triage`), missing `ready-for-agent`, has blocking labels
    (`needs-info`, `ready-for-human`, `needs-triage`), issue is `CLOSED`,
    waiting on open dependency, or actively claimed.
  - `excluded`: carries `wontfix` (overrides ready status).
- **Caching**: Queries are cached in-memory for 60 seconds to protect GitHub API rate limits.
  Adding `?refresh=true` or `?refresh=1` forces an immediate cache refresh.
- **Failures**: When the `gh` CLI is unauthenticated or fails, the endpoint returns HTTP 503
  JSON `{"error": "intake_unavailable", "detail": "..."}` without returning false empty state.

### Promotion engine and Candidate Freeze

- `GET /api/promotion/status` calculates `git log origin/main..origin/develop` (or local branches),
  extracts all closed ticket numbers (`#<num>`), returns unpromoted commit count, candidate freeze
  status (`.factory/PAUSE`), and existing promotion PR status.
- `POST /api/promotion/prepare` triggers batch promotion:
  - Verifies `unpromoted_count > 0` (returns HTTP 409 `{"error": "no_unpromoted_commits"}` if none).
  - Verifies no promotion PR is already open (returns HTTP 409 `{"error": "promotion_pr_already_open"}` if open).
  - Automatically compiles a markdown summary of delivered work items and commits.
  - Creates the promotion PR targeting `main` via `gh pr create --base main --head develop`.
  - Enacts **Candidate Freeze** by writing `.factory/PAUSE`, halting further develop integrations until operator sign-off.
- `GET /api/config/schedule` and `GET /api/config/models` provide read-only inspection of factory
  runtime constraints and model mappings.

### Engine discovery and diagnostics

Both endpoints read the repository's shared `.factory/consumer.json` through
`factory/consumer.py`. The configured source must be a clean, complete immutable
installation in a directory named with its full 40-character revision, with locked
Archon dependencies installed. They use the configured Bun executable and pinned
CLI entry point, never an ambient `archon` executable or an HTTP-supplied override.

`EngineDiagnostics` calls the consumer's `doctor` boundary for verified pin,
CLI capabilities, native discovery, pack completeness and native workflow
validation. Returned workflows come from actual discovery, not the manifest.
The reported revision is the configured revision verified against source HEAD.
Both endpoints also require Python >=3.10 and successful `git --version`,
`uv --version`, and configured `bun --version` subprocesses.

Doctor additionally reads native `ai tier list` and `ai alias list` JSON in the
application's context. All three tiers and every configured alias must have a
resolved effective provider/model. It then validates each pinned workflow with
`--workflow-source` and the application `--cwd`, so native model references use
the application's configuration. These are local configuration checks, **not**
proof that a provider credential or remote model works. The
`provider_authentication` check is explicitly `not_live_tested`, `required:false`,
with no `ok:true` authentication claim. No AI step, provider authentication probe,
tracker write, schedule, publication or credential change is performed.

Each required check reports `ok` and `status` (`passed`, `failed`, or `blocked`
when prerequisites prevent evaluation). Any failed/blocked required check returns
HTTP 503, `ok:false`, `error:"engine_prerequisites_unavailable"`, and no success
catalog. This includes absent settings, a wrong pin, missing tools, invalid native
JSON, command failures and unresolved bindings. Raw exception/subprocess output
is not exposed because it may contain credentials. Health and build identity
remain independent of these prerequisites. The listener handles requests on
separate threads, so in-flight diagnostics do not block health, build identity,
or lap list/detail reads. Requests have no body or configuration inputs; unknown
POST paths return 404. No results are cached or persisted.

### Native lap inspection

Lap requests use the same repository's consumer pin (`read_settings`,
`verify_source`, `native_json` in `factory/consumer.py`). Install the consumer's
pinned engine and its locked dependencies using the existing factory setup; no
ambient CLI or HTTP-supplied executable is used. The engine must be available to
read laps, but health and build identity do not depend on it. `ARCHON_HOME`, when
set, selects native engine storage exactly as it does for the consumer CLI.
`FACTORY_RUNTIME_STATE` does not replace native storage or create a second store.

Each request reads project-scoped `workflow runs` and
`workflow get <id> --verbose --events`. Lists include CLI-created runs and use
native details for the same status derivation as detail requests. There is no
application cache or history database. Reads never run the consumer tick, sweep,
resume, rerun, merge, provider, or scheduler. Launches refused before a native run
was recorded cannot appear as invented laps; a recorded pending/failed launch
retains its native status. A run disappearing between listing and detail is an
unavailable read, not an empty list.

Each lap has:

- `id`, `workflow_name`, `native_status` unchanged from native run detail;
  `product_status` preserves native status except for the evidence-bound
  `waiting_approval` projection below.
- `started_at`, `completed_at`, `last_activity_at`: native timestamps, not
  application poll times. Unavailable optional strings are `null`.
- `source`: native workflow source `origin`, `digest`, `captured_at`;
  `source_commit`: native checkout baseline commit.
- `candidate_head`: last Git checkout commit observed in native invocation/attempt
  evidence, or the structured subject head when no checkout sample exists.
  This is an observation, not a new forge query or a claim about an external PR
  after the run finished.
- `work_item`, `pull_request`: structured native pick/subject identities, when
  available; no intent is reconstructed from free prose.
- `session`: native `conversation_id`, isolated `working_path`, and `agents`
  containing observed `node`/`session_id` pairs. Missing/deleted worktrees are not
  recreated. A native null conversation is not replaced with a fabricated ID.
- `transitions`: ordered native non-provider events with `id`, `event_order`,
  `event_type`, `step_name`, and `created_at`. These are observed run/node
  lifecycle transitions, not an inferred success timeline. Provider transcripts,
  raw outputs, error prose and holdout contents are excluded.
- `approval_evidence`: `null` unless all approval-wait conditions hold; otherwise
  includes the matching head/PR, verification and review verdicts, skipped-land
  state and native event IDs/timestamps supporting the derivation.

`waiting_approval` means a native running/completed lap explicitly used supervised
`merge=approve`, its latest completed `subject`, `check-app`, `evidence`, and
`review` events agree in order, verification reports `PASS`, evidence reports
`ok="true"`, review reports `outcome="approved"`, and subject/check/review identify
the same PR and current observed head. The latest native checkout sample must
match that head. The subsequent `land` event must be skipped, and no completed
native land event may exist. A restarted review, stale head, missing verification,
failed/cancelled/pending run, or automatic merge mode does not qualify. This is
native historical approval evidence, not a fresh assertion that the forge PR
remains open. Polling never revalidates or mutates the forge. No separate `merged`
product status is inferred from completion or review approval.

Public projections omit arbitrary inputs, metadata, transcripts and artifact
contents. URL userinfo is redacted and URL query/fragment credentials are omitted;
common bearer/token/password/API-key assignments and recognized credential token
forms are redacted in exposed identity strings. Native errors are never returned
verbatim. As with build identity, do not deliberately use secrets as identifiers.

### Supervised lap submission

`POST /api/laps` submits a supervised lap work item to the pinned engine:

- Request body must be a JSON object with non-empty string `specification` and
  `merge_mode: "approve"`. Any other merge mode, missing or whitespace-only
  specification, malformed JSON, or caller-supplied launch, source, or identity
  overrides return HTTP 400 `{"error": "invalid_payload"}` with zero engine launches.
- Shell metacharacters in `specification` remain literal message text; arguments
  are passed directly to the engine without shell interpolation.
- Before launch, the service verifies the local launch brake (`.factory/STOP` under
  the shared repository root). The shared repository root is the primary checkout that
  owns the repository's Git common directory, so a checkout and its linked worktrees
  read and write the same brake file. If present, submission returns HTTP 409
  `{"error": "launch_brake_set"}` and creates zero runs. Application code never
  removes the STOP file.
- Valid submissions generate an isolated Git worktree branch (`archon/lap-...`)
  and unique session identifier (`session-...`), carry default holdout and protected
  paths unchanged, and invoke the pinned Archon engine detached:
  `workflow run archon-loop --detach --json --branch <branch> --conversation-id <id> --input merge=approve -- <specification>`.
- Successful launches return HTTP 202 `{"id": "<run-id>", "status": "<status>"}`
  with the genuine native run ID and initial status (e.g. `pending`).
- Non-zero native process exit, execution errors, or malformed launch output return
  HTTP 502 `{"error": "launch_process_failed"}` without returning a false HTTP 202 or
  synthetic run ID. Unavailable engine configuration returns HTTP 503
  `{"error": "native_state_unavailable"}`.

### Evidence and report inspection

Operators can inspect candidate-bound runtime verification evidence and peer-review reports for any native `archon-loop` run:

- `GET /api/laps/:id/evidence` returns an allowlisted JSON projection of native runtime/holdout verdict metadata and independent review status:
  - `id`, `workflow_name`, and `candidate_head`: verified Git commit observed in native invocation/attempt checkouts or structured subject head.
  - `runtime_verification`:
    - `status`: `"verified"` when candidate head matches, `check-app` reports `overall="PASS"`, and `evidence` reports `ok="true"`; `"failed"` when verification reports `FAIL` or holdouts fail; `"inconclusive"` when head does not match candidate or verification is incomplete; `"absent"` when verification events are missing.
    - `verdict`: `"PASS"`, `"FAIL"`, or `null`.
    - `lines`: allowlisted public criteria/probe items with `id`, `kind`, and `verdict`.
    - `holdout`: verdict metadata only (`verdict` and `lines` containing `{id, verdict}`). Private scenario text, prompts, and connection parameters are strictly excluded.
  - `peer_review`:
    - `status`: `"ready"` only when review evaluates the matching `candidate_head`, reviewer session is independently attributed (distinct from builder sessions), and 0 unresolved blocking findings exist; `"stale"` when reviewing another commit; `"failed"` when unresolved blocking findings exist or review rejected/sent-back; `"not_ready"` when self-attested, ambiguous, or runtime evidence is not verified; `"absent"` when review event is missing.
    - `sha` and `outcome`: evaluated commit SHA and review outcome (e.g. `approved`).
    - `independent`: boolean indicating whether reviewer attribution is provably independent of builder sessions.
    - `reviewer_session`: attributed reviewer session ID (credentials redacted).
    - `blocking_findings`: integer count of blocking dispositions and open blocking findings in run artifacts.
    - `report`: `{available: bool, path: str | null, url: str | null}` referencing the independent review report when present (`/api/laps/:id/evidence/report`).
- `GET /api/laps/:id/evidence/report` returns the plain markdown text (`text/markdown; charset=utf-8`) of the independent review report (`reviewer/report.md` or `review/report.md`) from run artifacts.
  - Returns HTTP 404 `{"error": "report_not_found"}` if the lap has no review report artifact.
  - Returns HTTP 404 `{"error": "lap_not_found"}` if the run ID does not exist or fails format validation (`[0-9a-f-]{32,36}`).
  - Returns HTTP 503 `{"error": "native_state_unavailable"}` if native storage cannot be accessed.
  - Path traversal and arbitrary artifact browsing are strictly prevented; only allowlisted report paths within the run's artifact tree can be retrieved.
  - Exposed content is sanitized through credential redaction filters.

### Operator dashboard

`GET /` serves the read-only operator dashboard (`text/html; charset=utf-8`):
- Uses live lap list and detail APIs (`/api/laps` and `/api/laps/:id`).
- Renders run ID, workflow name, native/product status, timestamps, candidate head, session identity, and work item text.
- Selecting a run fetches its detail view displaying session identity (conversation ID, working path, agents) and observed lifecycle transitions.
- Displays explicit empty state ("No runs found") and unavailable state ("Lap data unavailable") on API failure without leaving stale views.
- Untrusted text is escaped using DOM text nodes, rendering HTML/scripts strictly as literal text.
- Loading, selecting, and refreshing perform read-only GET requests and trigger zero engine mutation commands.

Send `SIGTERM` or `SIGINT` to the application process for a clean exit that closes
the listener. Terminating one instance does not affect another instance's
listener or identity.

## Focused checks

```sh
python3 -m unittest discover
python3 -m unittest discover -s tests -p 'test_*.py'
```

The tests launch real subprocesses with temporary state directories and assigned
ports. They check health readiness within five seconds, exact identities, Git
fallback, concurrent isolation, and listener release for both shutdown signals.
`python3 -m unittest tests.test_laps` focuses on the lap HTTP/native read boundary,
status derivation, stale/incomplete evidence, ten read-only polls, privacy, engine
failure semantics, two-run isolation, supervised submission validation,
local STOP brake refusal, detached execution, shell literal preservation, process
failure handling, as well as candidate-bound evidence projections, report delivery,
holdout fencing, credential redaction, path traversal rejection, and independent
peer review attribution. It does not launch provider workflows.
`python3 -m unittest tests.test_engine_diagnostics` exercises real HTTP and the
unchanged consumer against a temporary Git-pinned installation and deterministic
native CLI test fixture: verified catalog, local tools, configured Bun, absent or
malformed settings, pin mismatch, missing Bun/UV/Git, old Python, malformed native
JSON, failed subprocess, incomplete discovery and unresolved/invalid bindings.
It also holds each diagnostic route in flight while health, identity, and lap
list/detail requests must complete before diagnostics are released.
The fixture does not substitute for a configured runtime probe. Save the real
`GET /api/workflows` and `POST /api/doctor` status/bodies, `/build-id` candidate and
validated revision as `engine-diagnostics.json` in the run artifacts.
The Python application defines no separate lint or type-check command; the new
TypeScript migration code has separate Vite+ checks described below.

The repository's separately declared ordinary gate is `python3 harness/ci.py`.
Its protected configuration currently contains shell syntax that its argv-based
runner does not expand (`$(git ... )`); report that result separately rather than
changing the judge or treating these focused tests as a successful ordinary gate.

## Separate Bun/Vite+ migration health runtime

Issue #28 adds independently startable `apps/backend`, `apps/engine-host` and
`apps/web` without changing the Python runtime above. See
[monorepo health instructions](monorepo-health.md) for pinned Bun 1.4.2 / Node
26.8.1 / Vite+ 1.4.0, exact start argv, private credential provisioning and checks.
The new browser journey calls validated client → backend → authenticated loopback
host health and requires matching exact startup identities. Local `/health` and
`/build-id` remain independent liveness/identity probes; the host requires auth on
all routes. `FACTORY_RUNTIME_STATE` is reserved and remains unwritten by this slice.
This health page is verification infrastructure, not a cutover: Python remains the
only active owner of every operational behavior documented above. No native
workflow health, recovery, provider or promotion qualification is implied.
