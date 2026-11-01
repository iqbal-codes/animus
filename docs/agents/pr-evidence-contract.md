# Canonical PR Evidence and Review Contract

Authoritative specification for PR bodies, Before/After captures, finding lifecycles, and status comments across Animus.

## Authority and Host Ownership

- **Host owns publication and state transitions**: The engine/host orchestrator pins commit identities, validates evidence files, renders delimited PR sections, and posts comments. Agents supply structured observations and local artifact paths; agent text never conveys merge authority or changes lifecycle state.
- **QA blindfold**: QA evaluates acceptance criteria against an isolated integration checkout without reading builder PR prose or subjective rationales.
- **Fail-closed readiness**: Missing evidence, unrun checks, or unresolved blockers hold readiness. Absence of findings text is not proof of completed review.

## Identity Distinctions and Candidate Binding

Evidence claims must bind to exact, immutable Git identities. Never treat distinct refs as interchangeable:

- **Target-base tip**: Latest commit on the target integration branch (`main` or `develop`).
- **Merge-base**: Common ancestor commit (`git merge-base <base> <head>`). Never treat target-base tip and merge-base as synonyms.
- **PR head**: Author's candidate commit on the feature branch.
- **Tested identity**: The exact commit or isolated integration SHA executed during verification. When QA builds a disposable integration worktree merging PR head into target base, record both PR head and the resulting tested integration SHA.
- **Candidate invalidation**: Code edits, branch re-pushes, or base rebases invalidate affected evidence. Stale evidence cannot establish current readiness.

## Canonical PR Body Structure

Published PR bodies retain six canonical headings. Angle-bracket placeholders below are replaced with validated facts; empty sections are marked incomplete rather than deleted:

```markdown
## Problem and Outcome

<Source issue/spec link. Concrete problem and why it matters.>
<Observable delivered behavior; explicit statement of remaining/unimplemented scope.>

## Invariants

- <Preserved system property, boundary, or contract rule and supporting AC reference.>

## Review Guidance (Start here)

- Start at `<entrypoint>`; then inspect `<contract/test>`.
- <Key architectural decisions, tradeoffs, and failure modes reviewers should challenge.>
- Risk, compatibility impact, and rollback strategy: <concrete operational notes>.

## Changed Seams

- `<module/API/CLI>`: <old -> new contract; caller migration and compatibility impact.>

## Evidence

PR head: `<full SHA>`; selected base: `<full SHA>`; merge-base: `<full SHA>`.
Tested identity: `<tested candidate or isolated integration SHA>`.
Environment: <OS, runtime, fixture vs live external mocks>.

| Criterion / scenario | Result | Expected → observed | Check / artifact |
| --- | --- | --- | --- |
| <source AC ID> | <PASS/FAIL/BLOCKED/NOT RUN> | <required behavior → actual assertion or failure details> | <command/scenario; evidence ID/path> |

### Before / After

<Applicability note with explicit reason: visual, non-visual, or N/A.>

| Scenario | Before | After |
| --- | --- | --- |
| <matched scenario/route/state> | <observation + baseline image or honest N/A> | <observation + candidate image> |

<details>
<summary>Reproduction and detailed evidence</summary>

<Exact commands, steps, raw logs, exit codes, test counts, and artifact IDs.>

</details>

Outstanding: <failures, unavailable evidence, unrun checks, or None only when complete>.

### Judge Alterations (Requires Approval)

<None after inspection, or exact alterations and owner-approval reference.>
```

PR prose serves as a human- and agent-readable index rendered from host-validated records. Do not inject a redundant, hand-maintained JSON fence into the PR body.

## Check Results vs Review Outcomes

Keep check results, comparison applicability, and review outcomes strictly separated:

- **Check Results**:
  - `PASS`: The specific behavior was exercised and confirmed by an executable check. Passing build or typecheck alone does not constitute a test `PASS`.
  - `FAIL`: The check ran and the assertion or command failed.
  - `BLOCKED`: Execution was attempted but halted by an external prerequisite or environment failure.
  - `NOT RUN`: The check was not executed.
- **Comparison Applicability (Before / After)**:
  - Screenshots are evaluated against changed user-visible behavior and acceptance criteria, not an unconditional merge gate for every PR.
  - `Before: N/A: new feature; <reason>`: Valid for genuinely new UI screens. Real After candidate capture is still mandatory.
  - `Before: unavailable: not captured; <reason>`: Honest statement when a baseline was not recorded. Never relabel uncaptured baselines as `N/A`. Missing baseline comparison blocks only if the ticket explicitly requires baseline regression proof.
  - Non-visual changes use before/after inputs, outputs, exit codes, or measurements without screenshot requirements.
- **Review Dispositions**:
  - `blocks`: Confirmed defect or contract breach requiring remediation.
  - `rechecked`: The reviewer independently demonstrated that the QA check was mistaken, with fresh evidence. This is not the remediation-closure state.
  - `pre-existing`: The failure reproduces identically on target base, with base evidence and an open tracking issue.
  - `issue`: A non-blocking question or defect tracked in an issue under the existing workflow's conditions.
  - `accepted`: A question confirmed not to be a defect and invisible to end-users. This disposition does not create waiver authority.
- **Native Review Outcomes**:
  - `merge`, `approved`, `sent-back`, `needs-owner`, `nothing`.
  - Distinct from the local review skill's evaluation statuses (`PASS`, `SKIPPED`, `INCOMPLETE`).

## Screenshot Asset Workflow and URL Binding

Animus does not upload images to external hosts automatically. Follow this workflow for visual evidence:

1. **Local capture**: Write captures to the run artifact directory with stable immutable evidence IDs (e.g., `ev-cap-<id>`).
2. **Manual operator upload**: The operator uploads local images through the GitHub UI (e.g., dragging into a comment draft) and copies the hosted GitHub asset URLs.
3. **Loop evidence workflow**:
   - The operator uses the loop evidence command semantics to export the capture upload checklist and preview the evidence section locally (default mode).
   - The operator supplies a mapping file linking evidence IDs to manual hosted URLs.
   - An explicit publish option updates only the host-owned evidence boundary on the PR.
4. **URL states**: Rendered Markdown images (`![descriptive alt text](url)`) require valid hosted URLs. The contract visibly distinguishes:
   - `Unpublished`: Local capture artifact exists; awaiting operator upload and URL binding.
   - `Supplied (unverified access)`: URL mapped by operator; syntax valid, access not independently re-verified.
   - `Confirmed access`: URL verified reachable.
   - `Inaccessible`: URL returned 404, 403, or expired.
5. **No fake URLs**: Never publish `file://`, `localhost`, local absolute paths, or placeholder asset URLs as clickable Markdown links or images.

## Findings, Remediation, and Recheck Lifecycle

Findings use stable identifiers allocated and persisted by the host (e.g., `F1`, `F2`). IDs remain bound to the issue/dossier across laps and are never recycled.

### Finding Record Format

```text
F1 | <Standards | Spec> | <blocking | suggestion | verification-gap>
Location: <file:line anchored to candidate SHA>
Contract: <source AC or documented invariant>
Scenario: <concrete state, inputs, or actions>
Observed -> required: <actual defect> -> <expected behavior>
Impact: <system, security, or user consequence>
Evidence: <reproduction log, command, or capture ID>
Required correction: <remediation guidance>
```

### Author Remediation Format

```text
F1 | author response: implemented, awaiting independent recheck
Change: <commit SHA and modified files>
Verification: <exact test command, scenario, and observed result on tested candidate>
```

An author claim of "fixed" records a proposed resolution, not independent closure.

### Independent Recheck

Only an independent reviewer in a separate session (or the autonomous loop reviewer node) can confirm remediation closure. Record that recheck separately from QA-line dispositions: the finding ID, remediated candidate, exact scenario, fresh evidence, and resolved versus still-open result. Preserve each native disposition's meaning above; none implicitly proves a code fix. Omitted findings remain open. If the defect persists on the new candidate, record it as still blocking with fresh candidate-bound evidence.

## Comment Lifecycle

Autonomous and operator status comments follow canonical formats:

### Builder Update Comment

```text
Builder update: candidate <SHA> (lap <n>; route <route>)
Delivered: <observable change since prior update>
Verified: <criterion/result/evidence; exact tested identity>
Outstanding: <FAIL/BLOCKED/NOT RUN items and approval status>
Next: <concrete action/owner>; merge/promotion/deployment <actual state>
```

### Review Summary Comment

```text
Loop review: <native outcome> (route: <route>)
Reviewed: base <SHA>; head <SHA>; tested identity <identity>; <timestamp>
Standards: <coverage, confirmed findings, suggestions, gaps>
Spec: <AC coverage, confirmed findings, gaps; SKIPPED if no confirmed source>
Evidence: <observed checks/runtime results and artifact links>
Blocking: <finding IDs or None only after completed evaluation>
Disposition: <reason; outstanding evidence and owner decisions>
Authority: <native gate status and genuine GitHub review state distinguished>
Next: <actor/role, concrete action>
```

Preserve the `Loop review:` prefix and native outcome enums so automated consumers parse results without divergence.
