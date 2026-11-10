---
name: animus-implement-spec
description: Coordinate an approved multi-ticket specification through the local factory contract: frozen plan admission, one PR per child into the spec integration branch, candidate-bound technical checks and independent review, serialized lineage-verified auto-integration, dependency release by actual lineage, then full final acceptance and one operator-merged final PR.
disable-model-invocation: true
---

# Implement Multi-Ticket Specification

Drive an approved specification to a delivered integration branch through the
**local execution authority** — not a second GitHub control plane. Every
executable ticket gets its own branch/worktree and its own PR. Child PRs target
one spec integration branch and may auto-merge after candidate-bound technical
checks, independent review and required remote CI. Standalone and final PRs target
the delivery branch (default `main`) and stay **manual-merge**.

Read `docs/runtime.md` for the runtime contract, `docs/agents/issue-tracker.md` for
tracker semantics, and `docs/agents/pr-evidence-contract.md` for PR evidence.

## When to Use

Use this playbook when an approved `spec` issue or `docs/spec-*.md` has child
tickets (`Part of #<parent>`, `Depends on: #...`) and the work must run through the
factory. Do not use it to improvise child integration by hand.

## Contract Boundaries (non-negotiable)

- **Local execution authority is the only authority.** Admission is frozen at
  import against exact revisions. GitHub labels are visibility hints; they are not
  a live execution control after admission.
- **One PR per executable ticket.** Child PRs → `factory/spec-<parent>-integration`.
  Never merge child branches directly into the integration branch from an agent
  session, and never open a child PR against `main`.
- **Profile-specific gates.** A child needs applicable technical/contract tests,
  independent standards/contract review and required remote CI — not feature-wide
  black-box QA. Standalone/final need full black-box acceptance, regression,
  required CI and independent review.
- **Candidate-bound evidence.** Every result is bound to the tested head, target
  tip and merge base. A newer failure revokes an older pass. Builder claims are
  never approval authority.
- **Serialized, lineage-verified integration.** Conflicts, target drift, stale
  evidence, missing/failed CI, self-certified review, corrupt artifacts or blocking
  findings **hold**; they never force a merge or fabricate success.
- **Dependency release is lineage-based.** A dependent becomes eligible only when
  its prerequisite is proven included in the required integration lineage (or
  verified merged into the final target). **Issue closure never satisfies a
  dependency.**
- **Bounded laps & token discipline.** Factory failures return to the builder within the ticket's
  durable lap budget (at most 1–2 remediation laps before escalating to `Needs owner`). Exhaustion moves the affected work to Needs owner with
  retained work/evidence; it never resets budget, spins in unbounded review-repair loops, or blocks unrelated work.
- **Living Exploration Notes & Codebase Truth (Anti-Stale Discipline).** Shared exploration notes are an **orientation index, never a closed or static boundary**:
  - **Codebase is the live source of truth**: Every child builder must verify current signatures and call sites on the latest integration branch tip (using code-graph tools like `trail_ask`, `trail_skeleton`, `trail_callers`, or targeted `git diff <base>..HEAD`) rather than blindly trusting pre-run notes or ignoring newly introduced modules.
  - **Append-on-merge delta updates**: Whenever a child ticket integrates new public seams, schema migrations, or shared contracts into the integration branch, append a concise delta entry (`commit SHA + new/modified public symbols`) to the shared exploration notes so downstream frontier builders immediately see what upstream tickets built.
  - **Targeted intermediate checks & immediate worktree cleanup**: Run targeted tests during intermediate laps (reserving the full regression suite for final acceptance), and immediately remove merged child worktrees (`git worktree remove`) to prevent disk bloat and cross-worktree edit collisions.
- **Manual GitHub input is inert.** Issue edits/labels/closure and PR comments,
  reviews or request-changes do not mutate contracts, create findings or allocate
  laps. Required CI, head/base changes and verified merges still govern readiness.

## Steps

1. **Import and verify admission.**
   Import the published spec/tickets through the backend command/query surface
   (`animus plan import --project <id> --issue <spec> --kind spec`, then
   `animus plan get`). A complete, authorized graph admits without a second
   decomposition. Missing/unknown dependencies, cycles, ambiguous children or
   uncovered parent criteria stay held with explicit reasons. Parent specs are
   planning records and never dispatch.
   *Completion Criterion*: the plan is `admitted`, dependencies match the frozen manifest,
   and every parent acceptance criterion has claimed child coverage.

2. **Let the normal scheduler run the frontier.**
   Start the scheduler (`animus scheduler` or the app monitor). Each tick resumes
   any succeeded run whose gate is not terminal, then dispatches the next eligible
   member. Do not hand-record gates, publish PRs or call land manually.
   *Completion Criterion*: the tick processes builder → technical/contract checks →
   independent review → child PR → required remote CI read-back → verified
   integration, and the next dependent becomes eligible.

3. **Review the child PR audit, not a local claim.**
   Each child PR carries candidate-bound stage outcomes, findings and the verdict.
   A failed technical check or review opens a finding; the runtime dispatches a
   bounded builder correction lap and then re-runs the affected checks/review on
   the new candidate. Treat Needs owner as a real stop.
   *Completion Criterion*: the ticket's latest stage results pass for its candidate and the
   integration record proves the candidate is an ancestor of the remote target.

4. **Finish standalone work separately.**
   An explicitly standalone ticket uses its own branch/worktree and one PR to the
   delivery branch. It must pass full acceptance QA, regression, required CI and
   independent review. Merge remains manual.
   *Completion Criterion*: the full-delivery gate is ready for operator review; do not merge
   from the agent session.

5. **Run final acceptance only after lineage is complete.**
   Once every required child is verifiably integrated, the final coordinator
   materializes the combined candidate and runs parent-AC black-box QA, regression,
   required CI and independent final review. Failures use a separate bounded final
   repair cycle on the same integration lineage — never reopen successful children
   or silently broaden scope.
   *Completion Criterion*: one final integration→delivery PR is ready for operator merge
   with renewed evidence, and parent progress distinguishes integrated children
   from delivered status.

6. **Verify completion truthfully.**
   Local completion follows verification of the actual remote merge into the
   correct target. A `MERGED` flag without lineage proof, a closed-unmerged PR, or
   issue closure is incomplete, not delivered. Report exact PRs, candidate SHAs
   and target tips. Never claim deployment or release.
   *Completion Criterion*: the final target merge is verified, the PR audit is published,
   and every claim cites the artifact or remote fact that proves it.

## Run Artifacts

Keep run transcripts, TDD logs, evidence objects and visual captures outside the
repository under the canonical Animus home run directory
(`~/.animus/runs/<project-slug>/spec-<parent>/`). Finalized evidence artifacts are
immutable files referenced by relative path, size and digest; never present an
active stream or a local path as published proof.

## Handoff

Report: plan ID and frozen graph hash, current frontier, each child PR and its
integration lineage, standalone/final gate states, open findings, retained
worktrees, and any Needs owner item with the precise missing prerequisite. Do not
report a ticket, spec or merge as complete from builder prose alone.
