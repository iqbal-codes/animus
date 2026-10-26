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
| `GET /health` | 200 | `application/json` | `{"status": "healthy"}` |
| `GET /build-id` | 200 | `text/plain; charset=utf-8` | Exact startup candidate or Git commit, with no added newline |
| `GET /api/workflows` | 200 | `application/json` | `ok:true`, validated `source`, `revision`, `workflows`, and local `checks` |
| `POST /api/doctor` | 200 | `application/json` | Validated catalog and required local checks, plus native provider/model binding resolution |
| `POST /api/laps` | 202 | `application/json` | `{"id": "<run-id>", "status": "<status>"}` |
| `GET /api/laps` | 200 | `application/json` | Array of native `archon-loop` lap projections, or `[]` when no laps exist |
| `GET /api/laps/:id` | 200 | `application/json` | One lap projection for the exact native ID |
| `GET /api/laps/:id/evidence` | 200 | `application/json` | Candidate head binding, runtime verification verdicts, holdout verdict metadata, and peer-review evaluation |
| `GET /api/laps/:id/evidence/report` | 200 | `text/markdown; charset=utf-8` | Plain text peer-review markdown report (`reviewer/report.md` or `review/report.md`) |

Endpoints do not redirect. Unknown lap IDs (including IDs of other workflows)
return 404 JSON `{"error":"lap_not_found"}`. Missing review report artifacts return
404 JSON `{"error":"report_not_found"}`. Unavailable or malformed native
state returns 503 JSON `{"error":"native_state_unavailable"}`, never an empty
success. Other paths return 404. Responses use `Cache-Control: no-store`. Access
logging is disabled so request targets are not copied into process logs.

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
  the shared repository root). If present, submission returns HTTP 409
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
The repository defines no separate application lint or type-check command.

The repository's separately declared ordinary gate is `python3 harness/ci.py`.
Its protected configuration currently contains shell syntax that its argv-based
runner does not expand (`$(git ... )`); report that result separately rather than
changing the judge or treating these focused tests as a successful ordinary gate.
