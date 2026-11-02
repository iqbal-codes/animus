---
name: animus-review
description: Review a factory candidate, branch, PR, or work-in-progress on independent Standards and Spec axes by dispatching two parallel subagents. Never reviews in the same session as the implementer.
disable-model-invocation: true
---

# Review a factory candidate

Read `docs/agents/pr-evidence-contract.md`. Review without editing, publishing, approving, or merging unless the user separately requested those actions. This report supplements the native review/evidence gates; it does not replace them.

## When to Use

Use this playbook when:
- Conducting an independent code and specification review of a candidate branch, pull request, or work-in-progress changes.
- Evaluating an implementation candidate on independent Standards and Spec axes in a dedicated review session.
- Rechecking remediated review findings on a revised candidate head.

## Session boundary and reviewer independence

**Never review code in the same session that implemented it.**
The builder/implementer cannot act as an independent reviewer of their own work—confirmation bias, cached assumptions, and builder context blind the author to subtle defects, edge cases, and omitted invariants.

- **Separate session requirement:** If invoked within an active implementation session (or after implementing changes in the same thread), do **not** run the review inline. Handoff to an independent review session or instruct the caller to invoke `/animus-review` in a separate review thread.
- **Coordinator role:** When executing `/animus-review` in an environment that supports subagents, the current session acts exclusively as the **review coordinator**. The coordinator does **not** conduct the code review directly; instead, it pins the scope, identifies sources and standards, dispatches **two dedicated axis subagents** in parallel, and aggregates their results. When running in a standalone review session where subagent delegation is unsupported, the reviewer conducts the evaluation of both axes directly within the session under separate headings.

## Critical Invariant: Strict Read-Only Review Boundary

- **Reviewers DO NOT edit code:** Reviewers (both the coordinating agent and any delegated review subagents) are strictly forbidden from editing, writing, patching, formatting, refactoring, deleting, or committing any files in the workspace.
- **No auto-fixing or silent remediation:** When a defect, smell, or contract gap is discovered, report it honestly as a finding with file:line, impact, and severity. Do NOT attempt to fix it during the review stage. Remediation belongs exclusively to `/animus-implement` or subsequent operator-directed work.
- **Enforced subagent instructions:** When delegating tasks to subagents under `mcp__t3-code__delegate_task`, you MUST explicitly include the instruction:
  `"You are strictly a read-only reviewer. You are FORBIDDEN from using edit, write, or modifying any repository files. Only inspect files, execute read-only check/test commands, and report findings."`

## Steps

1. **Pin the scope and candidate identities.**
   Resolve an explicit fixed point (commit, branch, tag, or PR base) and candidate head to immutable SHAs. For a PR, read its actual base/head rather than assuming `main` or `develop`. Explicitly resolve target-base tip, merge-base (`git merge-base <base> <head>`), PR head, and tested candidate/integration SHA (never treat target-base tip and merge-base as synonyms). If no fixed point can be established, ask. Confirm refs resolve before dispatch. For committed changes use `git diff <base-sha>...<head-sha>` and `git log <base-sha>..<head-sha> --oneline`. For requested work-in-progress also capture staged and unstaged diffs plus relevant untracked file contents. Give both reviewers the identical captured input, file inventory, and scope; unrelated dirty work stays out.
   *Completion Criterion*: Target-base tip, merge-base, candidate head SHA, and file inventory are pinned to immutable Git references with zero ambiguous or symbolic revision names.

2. **Identify requirements, standards, and evidence records.**
   Read an explicit source spec/ticket first, including comments, parent spec, accepted Contract, invariants, ACs, and exclusions. Otherwise resolve issue references in commits/PRs, then matching repository specs. Ask for a missing source; if confirmed none exists, mark Spec SKIPPED, not passed. Find applicable repository standards (`AGENTS.md`, `CODING_STANDARDS.md`, `CONTRIBUTING.md`, relevant ADRs, protected paths). Collect criterion evidence from the PR body or run artifacts and verify candidate binding against the tested candidate/integration SHA; distinguish ordinary harness checks, black-box runtime results, and peer review. Check Before/After applicability: honest `Before: N/A: new feature; <reason>` (with required real After proof) or `Before: unavailable: not captured; <reason>`. Inspect prior open finding records (`F<id>`) and author remediation claims (`author response: implemented, awaiting independent recheck`); author claims of "fixed" do not close findings.
   *Completion Criterion*: Source spec ACs, applicable repo standards, evidence citations, and prior open finding IDs (`F<id>`) are assembled with zero inferred or unverified assumptions.

3. **Dispatch the two axis subagents in parallel.**
   Reviewing requires two independent perspectives that never share context or contaminate each other:
   1. **Standards subagent**
   2. **Spec subagent**

   **Always spawn both subagents concurrently** using the environment's delegation mechanism (e.g., `delegate_task` with role `review`). Never evaluate both axes inline in the coordinator session, and never let one subagent see the other's findings. Enforce the **Strict Read-Only Review Boundary** on all delegated subagents.

   If delegation is unavailable or unsupported by the runtime environment:
   - If running in an active implementation session, fail closed and require an independent review session.
   - If already running in a dedicated, independent review session separate from the implementer, evaluate both Standards and Spec axes directly within this session under separate `## Standards` and `## Spec` headings while strictly adhering to the read-only boundary.

   **Standards subagent dispatch:**
   - Supply pinned commit list, base SHA, head SHA, merge-base, full diff, WIP files, standards files, and the Smell baseline below.
   - Brief: Inspect each changed hunk against repo rules and the smell baseline. Cite file:line, the rule or smell, concrete scenario/consequence, and evidence. Distinguish hard violations from judgment calls.
   - Explicit instruction: `"You are strictly a read-only reviewer. You are FORBIDDEN from using edit, write, or modifying any repository files. Only inspect files, execute read-only check/test commands, and report findings."`

   **Spec reviewer dispatch:**
   - Supply pinned commit list, base SHA, head SHA, merge-base, full diff, WIP files, exact source spec/ticket, and criterion evidence.
   - Brief: Map every applicable AC and invariant to implementation and observed verification. Report missing/partial requirements, behavioral drift, wrong implementations, and unverified edge/failure branches. Recheck author remediations for prior findings on the new candidate.
   - Explicit instruction: `"You are strictly a read-only reviewer. You are FORBIDDEN from using edit, write, or modifying any repository files. Only inspect files, execute read-only check/test commands, and report findings."`

   **Smell baseline:**
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

   *Completion Criterion*: Both subagents return independent reports adhering to the read-only boundary with zero cross-axis contamination.

4. **Verify, compile findings, and format review summary.**
   Coordinator collects both reports:
   - Ensure both subagents returned findings independently; neither axis can cancel, dilute, or rerank the other.
   - Recheck candidate head stability before reporting. If changed, refresh review input instead of issuing a stale pass.
   - Format findings with stable host IDs (`F1`, `F2`), axis (`Standards` | `Spec`), severity (`blocking` | `suggestion` | `verification-gap`), location (`file:line` anchored to candidate SHA), contract, scenario, observed -> required, impact, evidence, and required correction.
   - For prior findings, record a separate independent remediation recheck: finding ID, candidate, scenario, fresh evidence, and resolved versus still-open result. Omitted findings remain open. Preserve native QA-line disposition meanings from `docs/agents/pr-evidence-contract.md`; `rechecked` means disproving a mistaken QA result, not closing a repaired finding, and `accepted` does not grant exception authority.
   - Report under separate `## Standards` and `## Spec` headings.
   - Format final summary comment following `docs/agents/pr-evidence-contract.md`: preserve `Loop review: <outcome>` prefix and native outcome enums (`merge`, `approved`, `sent-back`, `needs-owner`, `nothing`). A clean review grants no forge merge, promotion, or deployment authority.
   *Completion Criterion*: Review report contains separate Standards and Spec headings, all findings follow the canonical field format with stable IDs, every prior finding has an independent remediation recheck or remains visibly open, and publication uses canonical `Loop review:` format without claiming merge authority.
