# Spec: Subticket Integration Branch Auto-Merge with Two-Layer Critical Impact Gate

- **Status:** Superseded
- **Superseded by:** [runtime contract](../../runtime.md) and [authority cutover](../../authority-cutover.md)

* **Date:** 2026-11-01
* **Scope:** Autonomous Delivery Loop (`scripts/local-loop.ts`, `scripts/loop/merge-queue.ts`, `scripts/loop/report-schema.ts`, `scripts/loop/scheduler.ts`, `scripts/prompts/loop-review.md`)

---

## 1. Problem Statement & Value

### Problem
In the autonomous delivery loop (`scripts/local-loop.ts`), every approved lap previously terminated at `status: "waiting_approval"`, requiring a human operator to manually review and merge each Pull Request one by one. For parent specifications decomposed into multiple dependency-ordered subtickets (`Part of #<spec>`, `Depends on: #<prev>`), this created a severe human bottleneck:
1. Downstream subtickets remained blocked until the human manually merged each upstream subticket PR.
2. Conversely, blindly auto-merging every subticket PR that passes tests and acceptance criteria risks merging high-impact foundational mutations (such as database migrations, cross-domain refactors, shared contract changes, security boundary modifications, or dependency additions) into the integration branch without human sign-off, causing downstream subtickets to build on top of an unvetted foundation (*cascading rework*).

### Value & Observable Outcome
- **Integration-Branch Targeting for Subtickets**: Issues carrying `Part of #<parent>` automatically branch from and open Pull Requests against the parent specification's integration branch (`factory/spec-<parent>-integration`) rather than `main`.
- **Zero Extra Model Calls (Subscription LLM Reviewer)**: The existing independent code reviewer session (`loop-review`, Stage 4) evaluates a structured `auto_merge_judgement` block alongside its code & spec review in a single pass.
- **Two-Axis Separation (Quality Verdict vs. Critical Impact Gate)**:
  - **Axis 1 (Quality & Contract Verdict)**: Evaluates whether ordinary checks, CI, Black-box QA (`app-check.json`), and Standards/Spec code review pass. Failures trigger `sent_back` (or `needs_owner`).
  - **Axis 2 (Two-Layer Critical Impact Gate)**: Evaluates whether a Quality-Approved subticket PR is safe to auto-merge into `factory/spec-<parent>-integration` without human eyes, combining:
    1. **Layer 1 — Deterministic Host Diff Impact Analyzer (`analyzeCriticalDiffImpact`)** inspecting `git diff` file paths, domain span, and SQL/DDL statements.
    2. **Layer 2 — Semantic Reviewer Impact Judgement (`auto_merge_judgement`)** evaluating 5 critical impact categories.
- **Automatic Unblocking & Final Integration PR**: Bounded, low-risk subticket PRs that pass both layers are automatically merged into `factory/spec-<parent>-integration` (`status: "merged"`), immediately unblocking dependent subtickets (`Depends on: #<prev>`) in the scheduler. When a subticket touches a critical impact category, it is **not** sent back to the builder; it remains `waiting_approval` (*Quality Approved, Auto-Merge Held for Human Review*) with explicit impact reasons. Once all subtickets of a spec are integrated, a single Final Integration PR (`factory/spec-<parent>-integration` $\rightarrow$ `main`) awaits human review.

---

## 2. Two-Layer Critical Impact Taxonomy

Even when all acceptance criteria, tests, QA probes, and code standards pass (`axes.standards === "pass"` and `axes.spec === "pass"`), auto-merge is **held for human review (`waiting_approval`)** if either the deterministic host analyzer or the independent reviewer detects any of the following 5 critical impact categories:

| Category ID | Description | Layer 1: Deterministic Host Diff Triggers | Layer 2: Semantic Reviewer Evaluation |
|---|---|---|---|
| `database_or_state_migration` | Database schema, SQLite table definitions, or persisted state migrations | Touches `*db*.ts`, `*database*`, `*migration*`, `*schema*`, `*.sql`, or diff contains added/modified DDL (`CREATE TABLE`, `ALTER TABLE`, `DROP TABLE`, `CREATE INDEX`, `DROP INDEX`, `PRAGMA user_version`). | Modifies persisted data formats, on-disk state schemas, or requires data migration. |
| `cross_domain_or_shared_contract` | Cross-domain refactoring or shared public contract mutations | Modifies `packages/contracts/**` or `packages/client/**`, spans $> 2$ distinct top-level domain modules, or modifies $> 12$ non-test files. | Refactors shared interfaces consumed across multiple domains outside the subticket's bounded slice. |
| `security_auth_or_trust_boundary` | Authentication, authorization, sanitization, or execution guards | Touches `*security*`, `*auth*`, `*sanitizer*`, `*permission*`, `holdout_fence`, `loop-guard`, or `.factory/hooks/**`. | Alters trust boundaries, secret handling, operator authority gates, or subprocess sandboxing. |
| `dependency_toolchain_or_infra` | External dependencies, build/test toolchain, CI workflows, or protected paths | Touches `package.json`, `bun.lock`, `tsconfig*.json`, `vite.config.ts`, `renovate.json`, `.github/workflows/**`, `Dockerfile`, `install.sh`, or any configured `protectedPaths`. | Introduces new third-party dependencies or alters build/verification pipelines. |
| `foundational_direction_or_irreversible` | Architectural foundation choices or irreversible runtime effects | Flagged when protected governance files are touched. | Introduces foundational architectural decisions that could misdirect downstream `Depends on:` subtickets or cause irreversible side effects. |

---

## 3. Business Invariants & Authority Boundaries

1. **Deterministic Gates Precede Auto-Merge**: Auto-merge is never evaluated or executed unless `evaluateHostReadiness()` returns `ready: true` (`candidateStable`, `ordinaryChecksPassed`, `qaReport.passed`, `ciPassed`, `reviewerReport.passed`, and zero open blocking findings).
2. **Integration-Branch Only Authority**: Automatic merge execution is strictly restricted to subticket PRs (`Part of #<parent>`) targeting `factory/spec-<parent>-integration`. Standalone PRs and Final Integration PRs targeting `main` (or the default base branch) are never auto-merged by the loop; their `auto_merge_judgement` is published purely as an advisory summary for the human operator.
3. **Quality-Approved Hold (No False Send-Backs)**: When a subticket PR passes Axis 1 (Quality & Spec) but is held by Axis 2 (Critical Impact Gate), the run status transitions to `waiting_approval`—never `sent_back`—so the agent does not waste laps rewriting valid high-impact code.
4. **Candidate SHA Compare-and-Swap Lock**: Before updating `factory/spec-<parent>-integration` or executing `gh pr merge`, the host verifies that the candidate SHA and integration branch base SHA have not drifted incompatibly. Any drift or merge conflict fails closed to `waiting_approval`.

---

## 4. Acceptance Criteria

- **`AC1` (Structured Reviewer Auto-Merge Judgement Schema)**: `reviewerReportSchema` (`scripts/loop/report-schema.ts`) and `scripts/prompts/loop-review.md` define `auto_merge_judgement` (`eligible`, `risk_level`, `scope_aligned`, `critical_impacts`, `rationale`) with the 5 canonical `CriticalImpactCategory` values.
- **`AC2` (Two-Layer Critical Impact & Auto-Merge Evaluator)**: `analyzeCriticalDiffImpact` and `evaluateSubticketAutoMerge` (`scripts/loop/merge-queue.ts`) combine deterministic file/diff heuristics with the reviewer's semantic `auto_merge_judgement`, authorizing auto-merge only when `isSubticket === true`, target branch is `factory/spec-<parent>-integration`, `readinessReady === true`, `risk_level` is `"trivial"` or `"low"`, `scope_aligned === true`, `eligible === true`, `outcome === "merge"`, and zero critical impacts exist across both layers.
- **`AC3` (Subticket Integration Branch Targeting & Atomic Auto-Merge)**: For issues with `Part of #<parent>`, `runLocalLoop` initializes/targets `factory/spec-<parent>-integration`, opens the PR with `--base factory/spec-<parent>-integration`, and when `evaluateSubticketAutoMerge` authorizes auto-merge, atomically advances `factory/spec-<parent>-integration` to the verified candidate commit (`status: "merged"`), merges/closes the remote subticket PR/issue when pushing is enabled, and opens/updates the Final Integration PR to `main` once all sibling subtickets are integrated.
- **`AC4` (Automatic Dependency Unblocking in Scheduler & Loop)**: `getMergedIssueNumbers`, `filterAdmittedIssues` (`scripts/loop/scheduler.ts`), and `readIssueContract` (`scripts/loop.ts`) recognize `status === "merged"` runs as completed and dependency-satisfying so downstream `Depends on: #<prev>` subtickets unblock automatically without human intervention.
- **`AC5` (Transparent PR & Evidence Reporting)**: `formatReviewComment` and `renderEvidenceContent` (`scripts/loop/pr-reporting.ts`) render the Auto-Merge & Critical Impact Judgement section, clearly distinguishing auto-merged subtickets from PRs held for human impact review (`waiting_approval`).
