---
name: animus-implement-spec
description: Coordinate and implement an approved multi-ticket specification across its dependency task graph using isolated worktrees, concurrent implementer subagents, candidate-bound evidence, and a unified integration branch.
disable-model-invocation: true
---

# Implement Multi-Ticket Specification

Coordinate the end-to-end implementation of an approved specification decomposed into a dependency-ordered task graph (DAG) of tickets. Deliver the entire specification onto a single **integration branch** (`factory/spec-<parent>-integration`), with each ticket implemented in an isolated worktree via targeted `animus-implement` execution, verified through a Two-Tier QA strategy (`docs/agents/pr-evidence-contract.md`), reviewed independently (`/animus-review`), and delivered through a single final pull request (or tracker resolution) that closes the parent spec and all associated tickets.

All orchestrator and sub-agent sessions, execution logs, and evidence artifacts are stored neatly outside the repository under the canonical Animus Home run directory (`~/.animus/runs/<project-slug>/spec-<parent>/`).

Consult `docs/agents/issue-tracker.md` for issue tracker operations, triage labels, and `Depends on:` semantics, and `docs/agents/pr-evidence-contract.md` for the canonical PR body, evidence matrix, Before/After captures, and finding lifecycle contract.

## When to Use

Use this playbook when:
- Implementing an approved parent specification (`/animus-spec`, `docs/spec-*.md`, or tracker issue labeled `spec`) with associated child tickets (`Part of #<parent>`, `Depends on: #...`).
- Delivering complex, multi-ticket features requiring DAG-ordered concurrency, isolated worktrees, and serialized integration onto a single integration branch.
- Coordinating parallel implementer subagents across an active ticket frontier while preserving native factory ownership, candidate-bound evidence gates, and independent review boundaries.

## Core Principles & Task Graph Model

- **Task Graph & Dynamic Frontier**: Child tickets are not a linear list of steps. They form a directed acyclic graph (DAG) with explicit blocking relationships (`Depends on: #12, #14` or `Depends on: None`). Tickets whose prerequisites are fully satisfied form the active **frontier** ready for concurrent execution.
- **Single Integration Branch**: Exactly one integration branch per parent specification (canonical format: `factory/spec-<parent>-integration`). All child worktrees branch from and merge back into this integration branch. Individual child tickets never open PRs against `main`.
- **Sparse Communication via Context Pointers**: Communication to and from subagents must remain sparse. Communicate primarily through explicit context pointers (paths to spec, ticket URLs, exploration notes, frozen contracts, base SHAs, and commit references) rather than duplicating large context blocks.
- **Worktree Isolation & Ephemeral Clean-As-You-Go Lifecycle**: Implementer subagents run concurrently in dedicated, isolated git worktrees bounded by capacity slots (e.g. 2–3 active slots). To prevent storage inflation from duplicated `node_modules`, worktrees are strictly ephemeral: each child worktree is created on demand for its frontier ticket and **immediately removed upon serialized merge**, keeping on-disk footprint minimal.
- **Structured Animus Home Logging (`~/.animus/runs/`)**: To prevent terminal truncation, token exhaustion, and repository litter, all run logs, sub-agent transcripts, test logs, and evidence matrices are stored neatly under `~/.animus/runs/<project-slug>/spec-<parent>/`, isolated by ticket ID.
- **Two-Tier QA Architecture (Micro vs Macro)**:
  - *Tier 1 (Shift-Left Micro QA)*: Each implementer subagent verifies only its specific 2–3 child Acceptance Criteria in its local worktree using TDD seams before integration. This ensures the integration branch is provably green at every step.
  - *Tier 2 (Macro E2E QA)*: Once all tickets are merged, QA focuses on high-level Parent Spec Acceptance Criteria (end-to-end user journeys) plus the automated regression test suite, rather than redundantly re-executing dozens of micro-checks.
- **Two-Layer Critical Impact & Serialized Integration**: As tickets complete, a serialized merger validates checks and inspects the change against the Two-Layer Critical Impact Gate (`docs/spec-subticket-auto-merge-judgement.md`), integrating clean child branches into the integration branch via compare-and-swap locks without race conditions.
- **Independent Quality & Review Boundary**: Final verification and line-by-line review (`/animus-review`) run in an independent, clean session on the unified integration branch before final delivery.

## Artifact & Session Directory Hierarchy

The coordinator initializes the run directory under the canonical Animus Home path (`~/.animus/runs/<project-slug>/spec-<specNumber>/`):

```text
~/.animus/runs/<project-slug>/spec-<specNumber>/
├── run.json                  # Top-level coordinator metadata, DAG state, and summary
├── events.jsonl              # Main orchestrator session event stream / transcripts
├── exploration/              # (Optional) Pre-implementation codebase notes & maps
│   └── notes.md
├── artifacts/                # Macro verification & candidate review artifacts
│   ├── parent-spec.json      # Frozen parent spec contract and resolved DAG
│   ├── integration.log       # Serialized merge & CAS integration log
│   ├── qa-macro.json         # Tier 2 Macro E2E black-box QA results
│   └── review.json           # Independent code review report (/animus-review)
└── tickets/                  # Dedicated child sub-agent workspaces
    ├── ticket-<idA>/
    │   ├── session.jsonl     # Child sub-agent tool calls, reasoning, and transcript
    │   ├── tdd.log           # Full test suite command output (no terminal truncation)
    │   ├── evidence.json     # Tier 1 micro Acceptance Criteria PASS/FAIL matrix
    │   └── captures/         # Local Before/After screenshot captures (if UI changed)
    └── ticket-<idB>/
        ├── session.jsonl
        ├── tdd.log
        ├── evidence.json
        └── captures/
```

## Steps

1. **Ingest specification, child tickets, and construct the task graph (DAG).**
   Read the parent specification (`docs/spec-*.md` or tracker issue labeled `spec`) and all associated child tickets (`Part of #<parent>`). Consult `docs/agents/issue-tracker.md`. Verify ticket admission: child tickets must have `ready-for-agent` (admitted), complete intent, explicit boundaries, and well-formed `Depends on:` lines. Parent specs must be labeled `spec` paired with `ready-for-human` (or `needs-info`) to prevent direct loop intake. If the spec lacks executable tickets or has ambiguous boundaries, invoke `/animus-tickets` first.
   Initialize the run directory at `~/.animus/runs/<project-slug>/spec-<specNumber>/` and record `run.json` containing the frozen contracts and parent metadata.
   Parse dependencies to construct the DAG. Identify the initial **frontier**: all child tickets with `Depends on: None` or whose prerequisites are already satisfied on the target base. Verify the graph is acyclic; detect and reject dependency cycles or self-edges immediately.
   *Completion Criterion*: Dependency DAG is constructed with verified acyclicity, ticket contracts are frozen in `artifacts/parent-spec.json`, and the initial unblocked frontier is identified with zero ambiguous prerequisites or missing intent.

2. **(Optional) Dispatch exploration subagent for shared codebase research.**
   If tickets require preliminary codebase exploration, unfamiliar API investigation, or external documentation discovery, dispatch an **exploration subagent** before launching builders.
   Ensure the exploration subagent writes structured markdown notes (`notes.md`, architecture sketches, subsystem navigation maps) to `~/.animus/runs/<project-slug>/spec-<specNumber>/exploration/notes.md`, accessible to all future subagents. Decoupling exploration from implementation ensures implementer subagents remain lean, fast, and focused purely on TDD and code delivery.
   *Completion Criterion*: Exploration notes and reference pointers are saved in the external notes directory, accessible to all future subagents, with zero modifications or scratch files left in tracked repository paths.

3. **Initialize the single integration branch and draft delivery surface.**
   Identify the target base branch (e.g. `main`) and record its current stable commit SHA (`baseSha`). Create and check out the dedicated integration branch: `factory/spec-<specNumber>-integration` (or `<feature>-integration` if specified by repo conventions). Verify the branch is clean and passes baseline static checks (`bun run check` or configured harness check).
   If the issue tracker closes work through pull requests (per `docs/agents/issue-tracker.md`), prepare the PR delivery tracking. (A draft PR will be formally opened after the first child merge in Step 5, since a branch with no commits ahead of `main` cannot open a PR, marking it as closing the spec and tickets).
   *Completion Criterion*: Integration branch is created from baseSha, confirmed clean, and established as the single integration target for all child tickets.

4. **Dispatch concurrent implementer subagents with Tier 1 Micro QA and dedicated session logging.**
   For each unblocked ticket currently on the frontier, allocate an isolated git worktree on its own child branch (`factory/spec-<specNumber>/ticket-<ticketNumber>`), respecting concurrency limits (e.g. 2–3 slots). Create the dedicated ticket run folder at `~/.animus/runs/<project-slug>/spec-<specNumber>/tickets/ticket-<ticketNumber>/`.
   Dispatch implementer subagents in the background for maximum concurrency. Provide each implementer sparse context pointers: ticket issue number/URL, parent spec pointer, frozen contract digest, shared exploration notes path, ticket log directory path, and current integration branch tip SHA.
   Each implementer subagent executes targeted implementation via `animus-implement`:
   - Confirms its worktree is branched from the latest integration branch tip, and resets/rebases onto it if behind.
   - Streams/records its session actions to `tickets/ticket-<ticketNumber>/session.jsonl`.
   - Implements the ticket using Test-Driven Development (`.agents/skills/tdd`) at agreed public seams, saving full check logs to `tickets/ticket-<ticketNumber>/tdd.log`.
   - Applies security hardening rules (`.agents/skills/security-hardening`) and UI 7-state design where applicable (`.agents/skills/ui-quality`), storing visual assets under `tickets/ticket-<ticketNumber>/captures/`.
   - **Tier 1 Micro QA**: Strictly validates the specific 2–3 child Acceptance Criteria belonging to this ticket and compiles structured micro-evidence to `tickets/ticket-<ticketNumber>/evidence.json`.
   - Fetches the integration branch tip and merges/rebases it into the child branch before declaring completion.
   *Completion Criterion*: Each active frontier ticket is executed in an isolated worktree with complete session logs, passing Tier 1 micro checks, candidate-bound evidence, and a committed head SHA on its child branch.

5. **Serialize integration, evaluate Critical Impact Gate, and clean up worktree immediately.**
   As each implementer subagent signals completion, a **merger subagent** (or coordinator integration step) validates and integrates the child branch:
   - Validates that ordinary checks, unit tests, and ticket acceptance criteria pass from `tickets/ticket-<ticketNumber>/tdd.log` and `evidence.json`.
   - Evaluates the Two-Layer Critical Impact Gate (`docs/spec-subticket-auto-merge-judgement.md`) for high-impact mutations (database schemas, cross-domain contracts, security boundaries, build toolchains). If an unexpected critical impact is flagged, hold for operator confirmation rather than blindly cascading downstream.
   - Integrates the child branch into the integration branch using serialized compare-and-swap integration, appending details to `artifacts/integration.log`.
   - Records the local integration status (`integrated_to_branch`) and new integration branch HEAD SHA in `run.json` and the coordination state.
   - **Clean-As-You-Go Worktree Lifecycle**: Immediately delete the temporary child worktree (`git worktree remove`) and branch to reclaim storage and prevent filesystem proliferation.
   - If this is the first merged child commit and a PR delivery path is active, open the draft PR targeting `main` from the integration branch with title `feat: <spec-title>` and initial summary marked as closing the spec and tickets (`Closes #<spec>`, `Closes #<child-tickets>`).
   *Completion Criterion*: Completed child branch is cleanly integrated into the integration branch via serialized compare-and-swap, child worktree is removed immediately, integration status is persisted, and draft PR is initialized if first merge.

6. **Advance the frontier and dynamically launch subsequent implementer subagents.**
   Update the DAG in `run.json` with the newly integrated ticket(s). Re-evaluate remaining tickets: any ticket whose full set of `Depends on:` prerequisites are now satisfied enters the **frontier**.
   Immediately launch new implementer subagents in isolated worktrees for the newly unblocked tickets (returning to Step 4). Repeat Steps 4, 5, and 6 dynamically until every ticket in the specification task graph has been implemented, verified, and integrated into the integration branch.
   If any child implementer fails or encounters a blocker, halt the affected branch of the DAG, preserve worktree state for attribution, and escalate via `needs-owner` without dropping completed sibling progress.
   *Completion Criterion*: Dynamic frontier evaluation continues until all tickets in the DAG are successfully integrated into the integration branch with zero outstanding unblocked or stalled nodes.

7. **Conduct Tier 2 Macro E2E QA and independent code review on the integration branch.**
   Once all tickets in the spec DAG are integrated, run Tier 2 validation on the single integration branch:
   - **Automated Regression Shield**: Run full repository verification (`bun run check && bun run test`), ensuring all automated test suites authored across all tickets pass without regressions.
   - **Macro Black-box E2E QA**: Execute black-box acceptance against the **Parent Spec Acceptance Criteria** (evaluating top-level end-to-end user journeys and macro business outcomes rather than re-running dozens of child micro-checks), recording findings to `artifacts/qa-macro.json`.
   - **Independent Code Review**: Request an independent line-by-line code review (`/animus-review`) in a clean, separate, read-only session against `CODING_STANDARDS.md`, module depth, external blast radius, and test quality, writing the verdict to `artifacts/review.json`. Never perform code review inside an implementer session.
   - If the reviewer raises any findings (`F<id>`), launch a single remediation implementer subagent on the integration branch:
     - Fixes all raised issues using TDD (`.agents/skills/tdd`).
     - Documents author remediation records (`F<id> | author response: implemented, awaiting independent recheck`) citing commit SHAs and changed files per `docs/agents/pr-evidence-contract.md`.
     - Re-runs independent review until all findings are resolved cleanly.
   *Completion Criterion*: Full test suite passes, Macro E2E parent criteria are verified in `qa-macro.json`, and `/animus-review` reports clean approval in `review.json` with zero unresolved blocking findings.

8. **Format consolidated delivery PR and close tracker items.**
   Format the candidate's PR body following `.agents/skills/pr/SKILL.md` and `docs/agents/pr-evidence-contract.md`:
   - Lead with a plain-English `## Summary` and compact visual (diff-sketch, call-tree, or architecture diagram).
   - Include explicit closing keywords: `Closes #<parent-spec>`, followed by `Closes #<child-1>`, `Closes #<child-2>`, etc., ensuring all tracker issues are resolved upon merge.
   - Present consolidated Before/After proof and criterion matrix under `## Evidence` (high-level Parent Spec ACs at the top, followed by a collapsible `<!-- BEGIN_FACTORY_EVIDENCE_INDEX -->` block linking sub-ticket evidence).
   - State `Door` (`Two-way` vs `One-way`) and `Blast Radius` under `## Merge Danger`.
   If a draft PR exists, mark it ready for review. If the issue tracker closes work directly without PRs, close each ticket and the parent spec using `gh issue close` with completion summary comments per `docs/agents/issue-tracker.md`, and report the integration branch.
   *Completion Criterion*: Single final PR is published or marked ready for review with visual Summary, delimited Evidence, Merge Danger assessment, and issue-closing keywords (or all tracker items are closed), and Git commit references are recorded.

9. **Final cleanup and handback.**
   Prune any remaining worktree registrations (`git worktree prune`). Ensure no dangling temporary child branches remain, leaving only the primary integration branch intact.
   Finalize `run.json` with completion timestamp, total laps, and integration branch commit SHA.
   Report the final delivery status, integration branch commit SHA, PR URL, and summary of resolved tickets to the operator.
   *Completion Criterion*: All temporary resources are pruned with zero filesystem residue or dirty checkouts remaining, and `run.json` reflects terminal success.
