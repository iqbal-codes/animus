# Spec: Deterministic Intake Gating with Canonical Labels & TypeSafe Jev System 1 Decision Client (Phase 1)

* **Status:** Ready for Implementation
* **Target Issue:** GitHub Issue #15
* **Milestone:** Phase 1 (Intake Admission & System 1 Gatekeeper)
* **Date:** 2026-10-27

---

## Problem Statement

The autonomous software factory faces reliability, predictability, and cost challenges when admitting issues into its execution loop:

1. **Premature Execution of Ambiguous Work**: When incoming issues lack explicit acceptance criteria, clear scope boundaries, or verifiable constraints, autonomous coding agents (System 2 models like Pi or Claude) attempt to resolve ambiguities by hallucinating requirements. This results in broken implementations, high token expenditure (often 50k–200k tokens per failed lap), and rejected pull requests.
2. **Fragmented & Inconsistent Labeling**: The factory historically depended on legacy proprietary labels (`factory:ready`, `factory:hold`, `factory:exclude`). Meanwhile, modern engineering workflows and agent skills adopt canonical triage standards (`ready-for-agent`, `needs-info`, `ready-for-human`, `needs-triage`, `wontfix`). This dual convention causes confusion, requires manual label re-mapping, and violates the "clean cutover" architectural principle.
3. **Unsafe Handling of Unlabeled Issues**: Issues created without labels or in draft states must never be blindly processed by code-generation workers. Without a dedicated System 1 gatekeeper, differentiating between an actionable specification and an unrefined idea requires either fragile regular expressions or costly autoregressive model calls.

---

## Goals & Non-Goals

### Goals
- **Clean Cutover to Canonical Triage Vocabulary**: Fully migrate `intake.py` to recognize `ready-for-agent`, `needs-info`, `ready-for-human`, `needs-triage`, and `wontfix`.
- **Fail-Closed Unlabeled Issue Gating**: Guarantee that every unlabeled issue is held (`held`) from active execution laps by default.
- **Standalone TypeSafe Jev System 1 Client**: Implement a clean, modular `JevClient` communicating with OpenRouter's `/api/v1/systemone` endpoint using `typesafe/jev-1.14`.
- **Typed Decision Support**: Full typed support for `noul` (boolean confidence float), `choice` (categorical selection with probability distribution), and `score` (ordinal complexity rating).
- **Advisory Triage & Actionability Scoring**: Use Jev during intake polling to evaluate whether an unlabeled issue contains verifiable acceptance criteria and recommend the appropriate triage category.
- **100% Mockable, Offline-Capable Testing**: Full unit and integration test coverage using injectable transport fixtures with zero external network dependencies.

### Non-Goals
- **No Direct Commits to `develop`**: This phase does not commit or push to remote branches from background hooks.
- **No Autonomous Workflow Mutation**: Animus SDLC workflows and model configurations remain strictly immutable.
- **No Unmanaged Consumer Subagents**: No LLM prompt choreography or reflection subagents run inside `factory/consumer.py`. (Deferred to Phase 2).
- **No Dashboard Memory UI Extensions**: Changes to `app.py` are limited to exposing the updated intake admission status contract. (Deferred to Phase 3).

---

## Alternatives Considered

| Alternative Architecture | Rejected Trade-off / Why Not Chosen |
|---|---|
| **1. Regex & Heuristic Rule Matching Only** | Cannot assess semantic clarity or verify whether acceptance criteria are meaningful; easily tricked by arbitrary boilerplate text. |
| **2. Autoregressive LLM Call (Pi / Gemini-Flash / Claude) for Triage** | High latency (2–5 seconds), non-deterministic prose outputs, prone to hallucination, and costs token generation overhead for every poll tick. |
| **3. In-Process Local Embedding Classifier** | Requires downloading, compiling, and running local PyTorch/ONNX runtime dependencies on the host, introducing complex native build environments. |
| **4. Chosen: TypeSafe Jev via OpenRouter (`/api/v1/systemone`)** | **Chosen**: Non-autoregressive bidirectional encoder (< 300ms latency), zero hallucination, pure typed struct outputs, mathematical calibrated confidence, and $0 token generation cost during standard operation. |

---

## Risks & Limits

1. **Third-Party API Outage or Rate Limiting (OpenRouter)**:
   - *Mitigation*: Fail-closed invariant. Any HTTP 429, 5xx, or socket timeout automatically defaults the issue status to `held` with reason `evaluation_error:jev_unreachable`. Active laps are never launched on unverified work.
2. **Missing or Invalid `OPENROUTER_API_KEY`**:
   - *Mitigation*: Graceful fallback. If the API key is not configured, `JevClient` logs a warning and intake admission operates in static label mode (requiring an explicit `ready-for-agent` label applied by a human operator).
3. **Network Latency Impact on Intake Polling**:
   - *Mitigation*: Intake polling in `IntakeService` employs background evaluation with a configurable TTL cache (default 60s), ensuring the loopback HTTP API remains responsive sub-millisecond.

---

## User Stories

1. As a software factory operator, I want all unlabeled issues to be held from automatic execution by default, so that half-baked ideas or incomplete bug reports never burn agent compute tokens.
2. As a software factory operator, I want incoming issues to be evaluated by TypeSafe Jev (`typesafe/jev-1.14`), so that issues lacking verifiable acceptance criteria are caught in sub-300ms before any coding agent starts.
3. As an issue author, I want my submitted issue to receive immediate automated feedback via `needs-info` when criteria are missing, so that I know what details to add.
4. As an autonomous factory runner, I want only issues marked `ready-for-agent` with all prerequisite dependencies closed to be admitted into active laps, so that work executes strictly in dependency order.
5. As an operator, I want issues labeled `ready-for-human` to be held indefinitely from automated agent loops, so that sensitive or architectural refactors are preserved for human review.
6. As an operator, I want `wontfix` issues to be marked as `excluded` and ignored across all intake operations, so that obsolete proposals do not clutter the admission ledger.
7. As a developer using agent skills (`/to-spec`, `/to-tickets`), I want tickets created with `ready-for-agent` to be recognized immediately by the factory intake ledger without manual label conversion.
8. As a site reliability engineer, I want network timeouts or API outages to fail closed into a safe `held` state, so that service disruptions never cause unvetted issues to accidentally execute.
9. As a test engineer, I want the Jev client transport layer to be fully injectable and mockable, so that unit and integration tests run deterministically without outbound network calls.
10. As an operator inspecting the factory dashboard, I want to see the Jev admission reason, confidence score, and triage recommendation alongside each issue in the intake ledger, so that I have complete visibility into why an issue was admitted or held.

---

## Implementation Decisions

### 1. TypeSafe Jev Client Module (`factory/jev_client.py`)

A dedicated, standalone client class `JevClient` will handle all communication with OpenRouter's System One endpoint.

#### API Contract
- **Endpoint**: `https://openrouter.ai/api/v1/systemone`
- **Model**: `typesafe/jev-1.14`
- **Headers**:
  ```http
  Authorization: Bearer <OPENROUTER_API_KEY>
  Content-Type: application/json
  ```
- **Timeout**: 5.0 seconds.

#### Request Schema
```json
{
  "model": "typesafe/jev-1.14",
  "state": "Issue context: title, body, and labels",
  "questions": {
    "is_actionable": {
      "type": "noul",
      "instructions": "Does the issue have clear and unambiguous acceptance criteria?"
    },
    "triage_category": {
      "type": "choice",
      "instructions": "Categorize the issue",
      "criteria": {
        "ready_for_agent": "Fully specified with unambiguous acceptance criteria",
        "needs_info": "Vague or missing acceptance criteria",
        "ready_for_human": "Requires human decision or high-level architecture"
      }
    },
    "complexity": {
      "type": "score",
      "instructions": "Rate complexity of the task",
      "criteria": [
        "trivial_single_line",
        "small_single_file",
        "medium_multi_file",
        "large_system_wide"
      ]
    }
  }
}
```

#### Response Dataclasses & Parsing
```python
@dataclass(frozen=True)
class NoulAnswer:
    noul: float  # Calibrated probability [0.0, 1.0]

@dataclass(frozen=True)
class ChoiceAnswer:
    choice: str  # Winning label key
    confidence: float  # Calibrated confidence score
    probabilities: dict[str, float]  # Full probability distribution

@dataclass(frozen=True)
class ScoreAnswer:
    score: float  # Continuous calibrated score
    confidence: float
    legend: dict[int, str]
    probabilities: dict[int, float]

@dataclass(frozen=True)
class JevEvaluationResult:
    id: str
    model: str
    answers: dict[str, NoulAnswer | ChoiceAnswer | ScoreAnswer]
    usage: dict[str, Any]
```

#### Client Interface
```python
class JevClient:
    def __init__(
        self,
        api_key: str | None = None,
        base_url: str = "https://openrouter.ai/api/v1",
        model: str = "typesafe/jev-1.14",
        timeout: float = 5.0,
        transport: Callable[[dict[str, Any]], dict[str, Any]] | None = None,
    ) -> None: ...

    def evaluate(
        self, state: str, questions: dict[str, Any]
    ) -> JevEvaluationResult: ...
```

---

### 2. Unified Triage & Clean Cutover in `intake.py`

#### Label Mapping and Rules
- **Admitted**:
  - Requires `ready-for-agent`.
  - Zero blocking labels (`needs-info`, `ready-for-human`, `needs-triage`) or exclusion labels (`wontfix`). Legacy `factory:*` labels convey zero authority.
  - All referenced dependencies (`Depends on: #...`) must be `CLOSED`.
  - No active unreleased lap claim comment.
- **Held**:
  - Unlabeled issues (`admission_status: held`, `reason: unlabeled_awaiting_triage`).
  - Issues labeled with `needs-info`, `ready-for-human`, or `needs-triage`.
  - Issues with unsatisfied dependencies (`reason: waiting_on_dependency:#...`).
  - Actively claimed issues (`reason: actively_claimed`).
- **Excluded**:
  - Issues labeled with `wontfix`. Legacy `factory:*` labels convey zero authority.

#### Backward Compatibility
- Clean cutover enforced: legacy `factory:*` labels convey zero authority. `ready-for-agent` is strictly required for admission, while `needs-info`, `ready-for-human`, `needs-triage` hold, and `wontfix` excludes.

#### Jev Advisory Evaluation Flow
When `IntakeService.poll()` fetches issues:
1. For unlabeled or `needs-triage` open issues, invoke `JevClient.evaluate()`.
2. Extract `is_actionable` (`noul`), `triage_category` (`choice`), and `complexity` (`score`).
3. If `triage_category.choice == "ready_for_agent"` with confidence >= 0.70 and `is_actionable.noul >= 0.70`:
   - Mark evaluation advisory in the intake ledger as `recommended_label: ready-for-agent`.
4. If confidence < 0.70 or choice is `needs_info`:
   - Mark evaluation advisory as `recommended_label: needs-info` with `reason: unclear_acceptance_criteria`.
5. Store Jev evaluation metadata (`confidence`, `probabilities`, `complexity`) in `EvaluatedIssue` for visibility on `/intake` HTTP endpoints.

---

## Testing Decisions

### What Makes a Good Test
- Tests must assert external observable behavior and state transitions, not private socket or threading plumbing.
- Unit tests must be 100% deterministic, running offline with zero live network calls.

### Concrete Test Files & Scenarios

1. **`tests/test_jev.py`**:
   - `test_jev_payload_serialization`: Verify correct formatting of `noul`, `choice`, and `score` questions.
   - `test_jev_response_deserialization`: Parse real OpenRouter response fixtures into dataclasses.
   - `test_jev_transport_error_handling`: Assert timeout and HTTP 429/500 raise `JevError` without crashing.
   - `test_jev_missing_api_key_graceful_handling`: Assert unconfigured client warns and raises clean configuration error.

2. **`tests/test_intake.py`**:
   - `test_unlabeled_issue_is_held`: Verify an issue with no labels is held (`unlabeled_awaiting_triage`).
   - `test_ready_for_agent_admitted`: Verify canonical `ready-for-agent` issue is admitted.
   - `test_needs_info_and_ready_for_human_held`: Verify blocking labels hold admission.
   - `test_wontfix_excluded`: Verify `wontfix` excludes issue.
   - `test_legacy_label_clean_cutover`: Verify legacy `factory:ready` alone conveys zero authority and is held due to `missing_ready_label`.
   - `test_jev_assisted_advisory_evaluation`: Mock `JevClient` transport returning high-confidence `ready_for_agent` vs low-confidence `needs_info` and assert resulting metadata in `EvaluatedIssue`.

### Prior Art
- `tests/test_intake.py`: Existing parsing and deterministic admission tests.
- `tests/test_consumer_gating.py`: Integration assertions on admission invariants.

---

## Out of Scope

- Synchronous post-lap reflection agent in consumer (Deferred to Phase 2 as an Animus SDLC workflow step).
- Autonomous git commits directly to remote branches.
- Dynamic prompt modification of Animus workflow definitions.
- Web dashboard memory management tabs (Deferred to Phase 3).
- Third-party issue trackers (Jira, Linear).

---

## Further Notes

- OpenRouter's `/api/v1/systemone` endpoint processes inference non-autoregressively (< 300ms) with zero token generation cost during standard operation.
- Environment variable `OPENROUTER_API_KEY` is read from the process environment.
