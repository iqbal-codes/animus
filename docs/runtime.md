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
| `GET /api/laps` | 200 | `application/json` | Array of native `archon-loop` lap projections, or `[]` when no laps exist |
| `GET /api/laps/:id` | 200 | `application/json` | One lap projection for the exact native ID |

Endpoints do not redirect. Unknown lap IDs (including IDs of other workflows)
return 404 JSON `{"error":"lap_not_found"}`. Unavailable or malformed native
state returns 503 JSON `{"error":"native_state_unavailable"}`, never an empty
success. Other paths return 404. Responses use `Cache-Control: no-store`. Access
logging is disabled so request targets are not copied into process logs.

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
failure semantics and two-run isolation. It does not launch provider workflows.
The repository defines no separate application lint or type-check command.

The repository's separately declared ordinary gate is `python3 harness/ci.py`.
Its protected configuration currently contains shell syntax that its argv-based
runner does not expand (`$(git ... )`); report that result separately rather than
changing the judge or treating these focused tests as a successful ordinary gate.
