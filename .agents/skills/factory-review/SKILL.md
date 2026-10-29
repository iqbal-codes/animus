---
name: factory-review
description: Review a factory candidate, branch, PR, or work-in-progress on independent Standards and Spec axes by dispatching two parallel subagents. Never reviews in the same session as the implementer.
---

# Review a factory candidate

Read `docs/agents/software-factory-workflow.md`. Review without editing, publishing, approving, or merging unless the user separately requested those actions. This report supplements the native review/evidence gates; it does not replace them.

## Session boundary and reviewer independence

**Never review code in the same session that implemented it.**
The builder/implementer cannot act as an independent reviewer of their own work—confirmation bias, cached assumptions, and builder context blind the author to subtle defects, edge cases, and omitted invariants.

- **Separate session requirement:** If invoked within an active implementation session (or after implementing changes in the same thread), do **not** run the review inline. Handoff to an independent review session or instruct the caller to invoke `/factory-review` in a separate review thread.
- **Coordinator role:** When executing `/factory-review` in an environment that supports subagents, the current session acts exclusively as the **review coordinator**. The coordinator does **not** conduct the code review directly; instead, it pins the scope, identifies sources and standards, dispatches **two dedicated axis subagents** in parallel, and aggregates their results. When running in a standalone review session where subagent delegation is unsupported, the reviewer conducts the evaluation of both axes directly within the session under separate headings.

## Critical Invariant: Strict Read-Only Review Boundary

- **Reviewers DO NOT edit code:** Reviewers (both the coordinating agent and any delegated review subagents) are strictly forbidden from editing, writing, patching, formatting, refactoring, deleting, or committing any files in the workspace.
- **No auto-fixing or silent remediation:** When a defect, smell, or contract gap is discovered, report it honestly as a finding with file:line, impact, and severity. Do NOT attempt to fix it during the review stage. Remediation belongs exclusively to `/factory-implement` or subsequent operator-directed work.
- **Enforced subagent instructions:** When delegating tasks to subagents under `mcp__t3-code__delegate_task`, you MUST explicitly include the instruction:
  `"You are strictly a read-only reviewer. You are FORBIDDEN from using edit, write, or modifying any repository files. Only inspect files, execute read-only check/test commands, and report findings."`

## 1. Pin the scope

Resolve an explicit fixed point (commit, branch, tag, or PR base) and candidate head to immutable SHAs. For a PR, read its actual base/head rather than assuming `main` or `develop`. If no fixed point can be established, ask. Confirm refs resolve before dispatch.

For committed changes use `git diff <base-sha>...<head-sha>` and `git log <base-sha>..<head-sha> --oneline`; record the merge-base too. For requested work-in-progress also capture staged and unstaged diffs plus relevant untracked file contents. An empty committed diff is not an empty WIP review. Give both reviewers the identical captured input, file inventory, and scope; unrelated dirty work stays out. If all requested inputs are empty, report no changes and stop.

Reviewing this skill as a document is not a request to run a branch review. Treat `.` as a directory/scope, not an invented git reference.

## 2. Identify requirements and standards

Read an explicit source spec/ticket first, including its comments, parent spec, accepted Contract, invariants, ACs, and exclusions. Otherwise resolve issue references in commits/PRs, then matching repository specs. A bare issue number may identify a PR; use the tracker instructions. Ask for a missing source; if the user confirms none exists, mark Spec SKIPPED, not passed.

Find all applicable repository standards, including AGENTS.md/CLAUDE.md, CODING_STANDARDS.md, CONTRIBUTING.md, relevant ADRs, and runtime/protected-path rules. Pass actual paths or fetched contents, not vague references. Repository rules override the smell baseline below; skip formatting/static violations already enforced by tooling.

Collect available criterion evidence and verify its tested head/base/candidate against the reviewed state. Distinguish ordinary harness checks, black-box runtime results, and independent peer review. Missing/stale evidence makes a criterion unverified, not automatically a code defect. For WIP bind evidence to the captured working-tree content as well as HEAD.

## 3. Dispatch the two axis subagents in parallel

Reviewing requires two independent perspectives that never share context or contaminate each other:
1. **Standards subagent**
2. **Spec subagent**

**Always spawn both subagents concurrently** using the environment's delegation mechanism (e.g., `delegate_task` with role `review`). Never evaluate both axes inline in the coordinator session, and never let one subagent see the other's findings.

Enforce the **Strict Read-Only Review Boundary** on all delegated subagents: reviewers evaluate the candidate as-is and must never touch the filesystem or fix bugs.

If delegation is unavailable or unsupported by the runtime environment:
- If running in an active implementation session, do **not** perform an inline self-review in the implementer's session; fail closed and inform the caller that an independent review session is required.
- If already running in a dedicated, independent review session separate from the implementer (such as the autonomous loop reviewer node or a standalone CLI review session), evaluate both the Standards and Spec axes directly within this session under separate `## Standards` and `## Spec` headings while strictly adhering to the read-only review boundary.
(In dry-run fixture tests where an explicit mock prompt tests review protocol behavior without subagent tooling, format the two distinct subagent input payloads and isolated reports).

### Standards subagent dispatch

Spawn the Standards reviewer subagent with:
- The pinned commit list, base SHA, head SHA, merge base, and full diff (`git diff <base-sha>...<head-sha>`) plus any staged/unstaged/untracked files for WIP.
- The identified repository standards files (`AGENTS.md`, `CODING_STANDARDS.md`, `CONTRIBUTING.md`, relevant ADRs, protected paths).
- The complete **Smell baseline** below pasted in full.
- **Brief:** Inspect each changed hunk against documented repo rules and the smell baseline. Cite file:line, the rule or smell, concrete scenario/consequence, and evidence. Distinguish hard violations (repo rules, authority boundaries, protected paths) from judgment calls (smells). Documented repo rules override baseline heuristics; skip formatting enforced by tooling.
- Explicit instruction: `"You are strictly a read-only reviewer. You are FORBIDDEN from using edit, write, or modifying any repository files. Only inspect files, execute read-only check/test commands, and report findings."`

### Spec reviewer dispatch

Spawn the Spec reviewer subagent with:
- The pinned commit list, base SHA, head SHA, merge base, full diff, and WIP files.
- The exact source spec / ticket contents (problem, outcome, invariants, ACs, boundary, exclusions).
- Pinned criterion evidence (test commands, logs, candidate SHAs).
- **Brief:** Map every applicable AC and invariant to implementation and observed verification. Report: (a) missing or partial requirements; (b) unrequested scope / behavioral drift; (c) requirements implemented incorrectly; (d) unverified edge/failure/transition branches. Distinguish confirmed defects from unverified criteria or missing prerequisites. Do not weaken criteria or infer success from build alone.
- Explicit instruction: `"You are strictly a read-only reviewer. You are FORBIDDEN from using edit, write, or modifying any repository files. Only inspect files, execute read-only check/test commands, and report findings."`

### Smell baseline

Apply as labeled heuristics, never automatic violations. A documented repo preference wins.

- **Mysterious Name:** a name hides its role; rename to expose intent.
- **Duplicated Code:** repeated logic shape; share it only where the shared concept is real.
- **Feature Envy:** a method uses another object's data more than its own; move behavior to its owner.
- **Data Clumps:** fields repeatedly travel together; consider a cohesive type.
- **Primitive Obsession:** a primitive obscures a domain concept; consider a domain type.
- **Repeated Switches:** repeated dispatch on one concept; centralize the shared dispatch when it simplifies.
- **Shotgun Surgery:** one logical change scatters edits; co-locate what changes together.
- **Divergent Change:** one module changes for unrelated reasons; separate those responsibilities.
- **Speculative Generality:** unused abstraction for imagined needs; remove it.
- **Message Chains:** caller depends on a deep object walk; hide the navigation at its owner.
- **Middle Man:** indirection only delegates; call the real boundary unless the wrapper serves a contract.
- **Refused Bequest:** inheritance mostly ignored/overridden; prefer composition.

## 4. Verify and report

Coordinator collects both reports:
1. Ensure both subagents returned their findings independently. Neither axis can cancel, dilute, or rerank the other.
2. Check each suspected critical defect against the actual input and source if a quick safe check helps confirm it.
3. Recheck head and WIP input stability before reporting. If they changed, refresh affected review input instead of issuing a stale pass.

Report under separate `## Standards` and `## Spec` headings. Within each axis distinguish confirmed findings, judgment calls, and verification gaps. Give each defect a concrete failure scenario, exact code/source references, severity, and supporting evidence. Account for every criterion as satisfied, failed, blocked, or not verified. Keep the two axes separate: neither can cancel the other out.

End with:
- Reviewed base/head (and WIP scope).
- Checks actually run.
- Subagent dispatch confirmation (confirming independent Standards and Spec reviewer subagents were executed).
- Finding count and worst issue within each axis.
- Outstanding evidence and approval status.
- Final disposition: State PASS only where applicable criteria and evidence support it; missing spec is SKIPPED, stale/missing verification is INCOMPLETE. A clean local review grants no native approval, merge, promotion, or deployment authority. Any subsequent relevant code/base change requires fresh verification.
