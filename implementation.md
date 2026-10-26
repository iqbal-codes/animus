# Implementation Progress: Candidate-Bound Evidence Inspection (#5)

## Objective
Implement `GET /api/laps/:id/evidence` and `GET /api/laps/:id/evidence/report` to expose an allowlisted public projection of native runtime/holdout verdict metadata and independent review reports without revealing holdouts, private scenarios, or credentials.

## Acceptance Criteria & Status
- [x] AC1: Runtime probe of native run saves `evidence-view.json` in run artifacts with candidate and real evidence identifiers/verdicts resolvable to public report.
  - Probe executed against running candidate service on native run `59ebd42f-442c-49ec-9822-861074ae08b6`.
  - Saved to `/Users/efishery/.archon/workspaces/iqbal-codes/labq-software-factory/artifacts/runs/0836e2d1-971f-4db2-84bc-02e0c65a3506/evidence-view.json`.
- [x] AC2: Distinguish verified, failed, inconclusive, and absent runtime reports without mapping the latter three to verified. A review for another head is marked stale.
  - Verified runtime report requires candidate head match, `check-app` `overall: PASS`, `evidence` `ok: true`, and holdouts not failed.
  - Failed report marked when `overall: FAIL`, `ok: false`, or holdouts fail (`verdict: FAIL`).
  - Inconclusive marked when head does not match candidate or verification is incomplete (`verdict: null`).
  - Absent marked when `check-app` or `evidence` is missing (`verdict: null`).
  - Review with mismatched sha marked `"stale"`.
- [x] AC3: Public projection reports ready review only for independently attributed, current-head ready evidence with 0 unresolved blocking findings; self-attested or ambiguous records are not ready.
  - Reviewer session attributed from `review.session_id`.
  - Self-attested (matches builder session) -> `independent: false`, `status: not_ready`.
  - Ambiguous (missing session) -> `independent: false`, `status: not_ready`.
  - Unresolved blocking findings (from `dispositions` or `review/findings.json`) -> `blocking_findings > 0`, `status: failed`.
  - Non-verified runtime evidence -> `peer_review.status: not_ready`.
- [x] AC4: Redact credentials in all fields; exclude scenario text from holdout reporting (verdict metadata only).
  - Credentials and tokens sanitized via `public_text`.
  - Holdout reporting strictly contains `{id, verdict}`, omitting scenario text, prompts, and connection parameters.
- [x] AC5: Unknown run IDs return HTTP 404; path traversal/absolute paths cannot retrieve files; endpoints never execute workflows. Behavior tests exit 0; record CI harness separately.
  - Unknown run IDs return HTTP 404 `{"error": "lap_not_found"}`.
  - Path traversal returns HTTP 404 `{"error": "lap_not_found"}`.
  - Absent report returns HTTP 404 `{"error": "report_not_found"}`.
  - Native state errors return HTTP 503 `{"error": "native_state_unavailable"}`.
  - Endpoints issue only read-only `workflow runs` and `workflow get` commands.
  - Full test suite passes 56 tests cleanly (`python3 -m unittest discover -s tests -p 'test_*.py'`).
  - `python3 harness/ci.py` recorded truthfully as exiting 1 due to known protected static configuration `$(git`.

## Deliverables
- `laps.py`: Added `ReportNotFound`, `project_evidence`, `_get_run_detail`, `_find_artifacts_dir`, `read_evidence`, and `read_report`.
- `app.py`: Added routing for `/api/laps/<id>/evidence` and `/api/laps/<id>/evidence/report` with 404 and 503 error handling.
- `docs/runtime.md`: Documented evidence inspection endpoints, schemas, privacy guarantees, and error behaviors.
- `tests/test_laps.py`: Added unit and HTTP integration tests covering all evidence projection criteria, reports, redaction, and error conditions.
- `tests/test_app.py`: Added real application process tests for evidence and report endpoints with real native run retrieval.
- Run artifact: `artifacts/runs/0836e2d1-971f-4db2-84bc-02e0c65a3506/evidence-view.json`.
