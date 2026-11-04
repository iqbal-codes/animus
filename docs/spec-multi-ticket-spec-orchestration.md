# Spec: Multi-Ticket Specification Implementation Coordination (`animus-implement-spec`)

* **Status:** Draft / Proposed
* **Date:** 2026-11-04
* **Scope:** Autonomous Software Factory Builder, Subagent Coordination, Session & Artifact Topology (`.agents/skills/animus-implement-spec/SKILL.md`, `scripts/loop/harness-memory.ts`, `apps/backend/src/coordination/`)

---

## Source and problem

### Source
Settled architectural discussion regarding multi-ticket specification delivery in Animus, expanding single-ticket execution (`animus-implement`) into a full task-graph coordinator for the Builder Agent (`animus-implement-spec`), paired with Two-Tier QA and centralized Animus Home session persistence.

### Problem
In the Animus autonomous software factory, parent specifications decomposed into dependency-ordered tickets (`Part of #<spec>`, `Depends on: #...`) faced four fundamental execution bottlenecks when implemented autonomously:

1. **Sequential vs. Monolithic Pitfall**: Treating multi-ticket specs either as isolated sequential single-ticket loops (which misses parallel opportunities across independent branches of the DAG) or as a single giant monolithic prompt (which causes context window exhaustion, loss of focus, and hallucination).
2. **Disk Storage Explosion via Worktree Duplication**: Naively allocating persistent worktrees for all 10+ tickets in a specification duplicates heavy `node_modules` folders, consuming tens of gigabytes of disk space and causing disk exhaustion on build machines.
3. **QA Context Overflow & Cascading Rework**: Deferring all QA testing to a single massive verification step at the end requires testing 30–50 micro-criteria at once. If a foundational schema or contract error from Ticket #1 is discovered at Ticket #10, the entire feature suffers catastrophic cascading rework. Conversely, forcing the global loop to run 10 separate full PR review cycles creates human review fatigue.
4. **Subagent Log Loss & Terminal Truncation**: When a builder agent orchestrates multiple subagents, terminal streaming (`stdout`/`stderr`) is subjected to truncation caps (e.g. 50 KB / 2000 lines). Logs and reasoning traces scattered across provider-specific directories (`~/.pi/agent/sessions/`, `~/.claude/projects/`) make post-lap auditing and failure diagnosis difficult.

---

## Outcome

An end-to-end multi-ticket implementation coordination capability for the **Builder Agent** (`animus-implement-spec`):

1. **Task Graph (DAG) & Dynamic Frontier Orchestration**: The Builder Agent acts as an orchestrator, parsing `Depends on:` relationships to construct an acyclic dependency graph, dynamically identifying and dispatching the active frontier of unblocked tickets to concurrent implementer subagents.
2. **Single Integration Branch Target**: Exactly one integration branch per parent spec (`factory/spec-<parent>-integration`). All child subagents branch from and merge back into this single branch via serialized compare-and-swap (CAS) locks.
3. **Clean-As-You-Go Ephemeral Worktree Lifecycle**: Worktree allocations are strictly ephemeral. Each child worktree is created on demand for an active frontier ticket and is **immediately removed upon serialized integration**, keeping concurrent disk footprint bounded strictly to configured parallel capacity (e.g., 2–3 slots).
4. **Two-Tier QA Architecture**:
   - **Tier 1 (Shift-Left Micro QA)**: Each implementer subagent verifies its specific 2–3 child Acceptance Criteria in its isolated worktree using automated TDD seams before integration, ensuring the integration branch remains provably green at every step.
   - **Tier 2 (Macro E2E QA & Regression Shield)**: Once all tickets in the DAG are integrated, a macro black-box QA pass evaluates top-level Parent Spec Acceptance Criteria (end-to-end user journeys) and runs the entire repository test suite (`bun run check && bun run test`), rather than redundantly re-executing dozens of micro-checks.
5. **Centralized Animus Home Logging & Session Hierarchy**: Main orchestrator events, subagent session transcripts, raw test outputs, and evidence matrices are organized outside the repository under `~/.animus/runs/<project-slug>/spec-<parent>/`, preventing terminal truncation and repo clutter.
6. **Unified Delivery & Tracker Resolution**: Exactly one consolidated Pull Request to `main` (or tracker resolution) that closes the parent spec and all child tickets upon merge (`Closes #<parent>`, `Closes #<child-1>`, `Closes #<child-2>`).

---

## Invariants

1. **Integration Branch Exclusivity**: Subticket branches and PRs must target `factory/spec-<parent>-integration`. No subticket PR may target `main`.
2. **Ephemeral Worktree Cleanup**: A child worktree must be removed (`git worktree remove`) immediately after its commits are integrated into the integration branch. Active worktrees must never exceed the configured concurrency limit.
3. **Two-Tier Separation**: Subagents must pass Tier 1 micro Acceptance Criteria before merge. Final candidate acceptance must pass Tier 2 Macro E2E QA and full regression tests. The builder never self-certifies final black-box acceptance or code review.
4. **Independent Code Review Boundary**: Code review (`/animus-review`) must execute in an independent, read-only session against `CODING_STANDARDS.md` on the unified integration branch candidate, outside the implementer session.
5. **Durable External Logging**: All session events, thinking transcripts, test logs, and evidence records must be written to `~/.animus/runs/<project-slug>/spec-<parent>/` with zero log files committed into tracked Git working trees.
6. **Atomic Compare-and-Swap Integration**: Merging a completed subticket into the integration branch requires verifying that the integration branch HEAD has not drifted incompatibly. Drift or merge conflicts fail closed to human escalation (`needs-owner`).

---

## Acceptance criteria

- [ ] **AC1: Dependency Task Graph & Dynamic Frontier Execution**:
  The coordinator parses parent spec and child tickets (`Part of #<parent>`), extracts standalone `Depends on:` lines, constructs an acyclic DAG, rejects cycles, and dispatches implementer subagents for tickets whose prerequisites are satisfied. When a ticket merges, dependent tickets are dynamically added to the active frontier.
- [ ] **AC2: Single Integration Branch Targeting & Serialized Integration**:
  The coordinator establishes `factory/spec-<parent>-integration` from the base SHA. Child tickets branch from this integration branch tip. As child tickets complete, a serialized merger validates checks, evaluates the Two-Layer Critical Impact Gate (`docs/spec-subticket-auto-merge-judgement.md`), and integrates the child branch using compare-and-swap locking.
- [ ] **AC3: Ephemeral Clean-As-You-Go Worktree Lifecycle**:
  Child worktrees (`factory/spec-<specNumber>/ticket-<ticketNumber>`) are allocated on demand within concurrency bounds (max 2–3 active). Upon serialized merge into the integration branch, the child worktree is immediately removed (`git worktree remove`) and pruned, keeping peak disk usage bounded.
- [ ] **AC4: Two-Tier QA Verification (Micro vs Macro)**:
  - **Tier 1 (Micro)**: Each implementer subagent verifies its 2–3 child ACs using TDD unit/integration tests and local UI captures prior to merge approval.
  - **Tier 2 (Macro)**: Following full DAG integration, repo-wide static and unit tests run (`bun run check && bun run test`), followed by black-box acceptance of high-level Parent Spec user journeys (`qa-macro.json`).
- [ ] **AC5: Canonical Animus Home Session & Artifact Routing**:
  The coordinator initializes `~/.animus/runs/<project-slug>/spec-<specNumber>/`:
  - Main events and DAG state: `events.jsonl`, `run.json`, `artifacts/parent-spec.json`, `artifacts/integration.log`.
  - Subagent ticket logs: `tickets/ticket-<id>/session.jsonl`, `tdd.log`, `evidence.json`, `captures/`.
  - Raw test output is persisted directly to disk without terminal truncation.
- [ ] **AC6: Single Consolidated Delivery PR & Issue Closure**:
  The candidate PR targets `main` from `factory/spec-<parent>-integration`. The PR body follows `.agents/skills/pr/SKILL.md` (visual Summary, delimited `## Evidence` with Before/After proof, `## Merge Danger`), includes explicit closing directives (`Closes #<parent>`, `Closes #<child-1>`, `Closes #<child-2>`), and closes all associated tracker issues upon merge.

---

## Boundary

- **Touchpoints**:
  - Playbook: `.agents/skills/animus-implement-spec/SKILL.md`
  - Builder skill integration: `scripts/loop/harness-memory.ts` (`resolveAllowedSkills`)
  - Scaffold & configuration: `scripts/cli/commands/harness-scaffold.ts`, `AGENTS.md`, `factory/templates/AGENTS.template.md`
  - Integration tests: `tests/integration/loop-modules.bun.test.ts`
  - Coordination primitives: `apps/backend/src/coordination/`
- **Known callers (blast radius)**:
  - Autonomous builder execution in `scripts/animus-loop.ts` (and `scripts/local-loop.ts` facade)
  - Interactive operator invocations (`/animus-implement-spec #<id>`)
  - Subticket auto-merge queue (`scripts/loop/merge-queue.ts`)
- **Test seam**:
  - `tests/integration/loop-modules.bun.test.ts`
  - `tests/integration/coordination.test.ts`
- **Exclusions**:
  - Does not replace `/animus-tickets` (ticket decomposition must be completed before implementation).
  - Does not auto-merge the Final Integration PR into `main`; final integration PRs remain subject to operator review and branch protection.
  - Does not execute unbound general loop pickers (Invariant 1 of coordination primitive).

---

## Agreed decisions

1. **Builder Agent as Orchestrator**: `animus-implement-spec` is assigned to the `builder` role in `scripts/loop/harness-memory.ts`, allowing the builder agent to coordinate subagents during multi-ticket implementation.
2. **Ephemeral Worktrees**: To prevent `node_modules` duplication across 10+ tickets from consuming storage, worktrees are deleted immediately upon merge into the integration branch rather than retained until end-of-spec.
3. **Two-Tier QA**: Shift-left testing validates child micro-ACs per ticket before merge; final integration testing validates Parent Spec macro journeys and the regression test suite.
4. **Animus Home Run Storage**: Sockets, logs, and subagent session transcripts are stored under `~/.animus/runs/<project-slug>/spec-<specNumber>/`, completely decoupled from git working trees.

---

## Verification

- **Automated Check**: `bun run check` (architecture boundaries, formatting, linting, typechecking).
- **Unit & Integration Suite**: `bun test tests/integration/loop-modules.bun.test.ts` and `bun test tests/integration/coordination.test.ts`.
- **Pre-commit Gate**: Zero regression against all 4 CI gates.

---

## Prerequisites and open questions

- **Prerequisites**:
  - Parent specification authored via `/animus-spec` and decomposed into dependency-ordered tickets via `/animus-tickets`.
  - Issue tracker configured with canonical labels (`ready-for-agent`, `spec`, `ready-for-human`) and `Depends on:` lines per `docs/agents/issue-tracker.md`.
- **Open questions**:
  - None. All architectural constraints, worktree lifecycles, QA tiers, and storage layouts are settled.
