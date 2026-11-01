---
name: animus-implement
description: Implement an approved spec through its ticket frontier while preserving native factory ownership and evidence gates.
disable-model-invocation: true
---

# Implement the approved frontier

Implement an approved spec through its ticket frontier while preserving native factory ownership, candidate-bound evidence, and independent review boundaries. Consult `docs/agents/pr-evidence-contract.md` for the canonical PR body, evidence matrix, Before/After captures, and finding lifecycle contract, and `docs/agents/issue-tracker.md` for tracker operations.

## When to Use

Use this playbook when:
- Implementing an approved frontier ticket from a parent specification or tracker issue.
- Delivering code changes for an unambiguous, approved work item.
- Remediating review findings on an existing candidate branch.

## Steps

1. **Resolve work, authority, and candidate identities.**
   Read the full spec, child tickets, comments, agreed Contract, dependencies, and existing PRs. Read `docs/agents/pr-evidence-contract.md` and `docs/agents/issue-tracker.md`. Establish the target repository, explicit base SHA, candidate branch/head SHA, merge mode, and authorized operations. Preserve unrelated dirty files. Verify the target ticket is a frontier ticket: complete intent, no unresolved owner decisions, no competing active claims, and all prerequisite outcomes verified on the chosen base. If the spec lacks executable tickets, invoke `/animus-tickets` first.
   *Completion Criterion*: Target ticket, base SHA, candidate head SHA, and prerequisite verification status are documented with zero unresolved blockers or unverified prerequisites.

2. **Choose the delivery path.**
   - **Native factory delivery requested**: Inspect the pinned engine's inputs, workability policy, and consumer boundary. Verify how the target ticket is selected before launch; report any target-binding blocker without claiming execution. Present the repository, base, ticket, and merge mode for authorization before launch.
   - **Direct code implementation requested**: Implement the single approved frontier ticket in the authorized branch using repository conventions, domain types (`.agents/skills/blueprint`), and test-driven development (`.agents/skills/tdd`). Never reset another checkout or touch out-of-scope worktrees.
   *Completion Criterion*: Delivery path is selected with verified authority; direct edits stay confined to the designated branch with zero incidental scheduler, branch-switch, or merge mutations.

3. **Build, verify, and compile candidate-bound evidence.**
   Follow `docs/agents/pr-evidence-contract.md` for all evidence compilation. Write tests first at agreed public seams (`.agents/skills/tdd`). Run ordinary unit/typecheck checks separately from behavioral and integration scenarios. If UI is changed, capture local image artifacts under the run artifact directory with stable evidence IDs; pair Before/After for applicable visual states or record honest applicability (`Before: N/A: new feature; <reason>` with mandatory After capture, or `Before: unavailable: not captured; <reason>`). Operators handle screenshot uploads manually via the GitHub UI, and URL binding is performed through the loop evidence workflow; never emit fake URLs, `file://`, or localhost links in evidence records. For any prior finding, record author remediation (`F<id> | author response: implemented, awaiting independent recheck`) citing the commit SHA, changed files, and specific verification scenario; author claims never close findings.
   *Completion Criterion*: Every applicable AC is accounted for in a criterion matrix with exact status (`PASS`, `FAIL`, `BLOCKED`, `NOT RUN`), observed behavior, command/artifact path, and tested commit SHA, with zero `"not implemented"` stubs remaining.

4. **Advance, format PR Evidence, and hand back.**
   Format the candidate's PR body following the 6 canonical headings in `docs/agents/pr-evidence-contract.md` (Problem and Outcome, Invariants, Review Guidance, Changed Seams, Evidence, Judge Alterations). Leave forge publication, native status transitions, and readiness labeling to the host orchestrator. Request `/animus-review` in a clean, separate session to conduct independent peer review across Standards and Spec axes; never perform the review in the same session as the implementer. Report delivered vs remaining tickets, exact tested candidate SHA, criterion matrix, and any outstanding blockers or required human approvals.
   *Completion Criterion*: PR body and evidence adhere to the canonical contract, independent review is requested in a separate session without inline reviewer self-certification, and handback summary records delivered vs remaining frontier tickets with exact Git commit references.
