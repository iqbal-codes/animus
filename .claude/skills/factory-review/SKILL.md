---
name: factory-review
description: Review a factory candidate, branch, PR, or work-in-progress on independent Standards and Spec axes with head-bound behavior evidence.
---

# Review a factory candidate

Read `docs/agents/software-factory-workflow.md`. Review without editing, publishing, approving, or merging unless the user separately requested those actions. This report supplements the native review/evidence gates; it does not replace them.

## 1. Pin the scope

Resolve an explicit fixed point (commit, branch, tag, or PR base) and candidate head to immutable SHAs. For a PR, read its actual base/head rather than assuming `main` or `develop`. If no fixed point can be established, ask. Confirm refs resolve before dispatch.

For committed changes use `git diff <base-sha>...<head-sha>` and `git log <base-sha>..<head-sha> --oneline`; record the merge-base too. For requested work-in-progress also capture staged and unstaged diffs plus relevant untracked file contents. An empty committed diff is not an empty WIP review. Give both reviewers the identical captured input, file inventory, and scope; unrelated dirty work stays out. If all requested inputs are empty, report no changes and stop.

Reviewing this skill as a document is not a request to run a branch review. Treat `.` as a directory/scope, not an invented git reference.

## 2. Identify requirements and standards

Read an explicit source spec/ticket first, including its comments, parent spec, accepted Contract, invariants, ACs, and exclusions. Otherwise resolve issue references in commits/PRs, then matching repository specs. A bare issue number may identify a PR; use the tracker instructions. Ask for a missing source; if the user confirms none exists, mark Spec SKIPPED, not passed.

Find all applicable repository standards, including AGENTS.md/CLAUDE.md, CODING_STANDARDS.md, CONTRIBUTING.md, relevant ADRs, and runtime/protected-path rules. Pass actual paths or fetched contents, not vague references. Repository rules override the smell baseline below; skip formatting/static violations already enforced by tooling.

Collect available criterion evidence and verify its tested head/base/candidate against the reviewed state. Distinguish ordinary harness checks, black-box runtime results, and independent peer review. Missing/stale evidence makes a criterion unverified, not automatically a code defect. For WIP bind evidence to the captured working-tree content as well as HEAD.

## 3. Review the axes independently

Run two independent reviewers concurrently when the environment permits delegation. Supply each the pinned diff/commits, relevant new-file contents, source pointers, and evidence. Follow the environment's delegation tool/authorization rules. If delegation is unavailable, run isolated sequential passes and disclose that deviation rather than inventing reviewers.

**Standards reviewer:** inspect each changed hunk against the documented rules and the full smell baseline. Cite file:line, the rule, concrete scenario/consequence, and evidence. Distinguish hard violations from judgment calls. Smells alone are not blockers. Check authority, protected boundaries, and evidence honesty where repository rules require them.

**Spec reviewer:** map every applicable AC/invariant to implementation and observed verification. Report missing/partial requirements, wrong behavior, and unrequested scope with the source's exact requirement and code location. Include edge/failure/transition branches the contract requires. Distinguish confirmed defects from unverified criteria or unavailable prerequisites. Do not weaken criteria to fit the patch or infer success from a build alone.

Each reviewer returns findings plus coverage/verification gaps. Keep reports concise without omitting blockers to meet an arbitrary word limit. Neither reviewer sees the other's conclusions.

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

Check each suspected defect against the actual input and source. Run focused safe checks when feasible, with commands/results recorded; tests requiring provider calls, tracker writes, or deployment need the corresponding permission. Recheck head and WIP input stability before reporting. If they changed, refresh affected review input instead of issuing a stale pass.

Report under separate `## Standards` and `## Spec` headings. Within each axis distinguish confirmed findings, judgment calls, and verification gaps. Give each defect a concrete failure scenario, exact code/source references, severity, and supporting evidence. Account for every criterion as satisfied, failed, blocked, or not verified. Keep the two axes separate: neither can cancel the other out.

End with reviewed base/head (and WIP scope), checks actually run, finding count and worst issue within each axis, and outstanding evidence/approval. State PASS only where applicable criteria and evidence support it; missing spec is SKIPPED, stale/missing verification is INCOMPLETE. A clean local review grants no native approval, merge, promotion, or deployment authority. Any subsequent relevant code/base change requires fresh verification.
