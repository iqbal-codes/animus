---
name: animus-review
description: Independent read-only line-by-line code review evaluating candidate diffs against CODING_STANDARDS.md, module depth, blast radius, test quality, and pattern registry.
disable-model-invocation: true
---

# Independent Code Review

Review candidate code diffs strictly and objectively without editing, auto-fixing, or modifying the workspace. Black-box QA handles functional acceptance; you evaluate architecture, correctness, depth, blast radius, security, and test quality line by line.

## When to Use

Use this skill when:
- Conducting an independent code review of a candidate branch, pull request, or staged diff.
- Evaluating a candidate against `CODING_STANDARDS.md` and `.animus/codebase-rules.json`.
- Inspecting external blast-radius safety, module depth, test adequacy, and schema boundaries.
- Rechecking remediated review findings on a fresh candidate SHA.

## Session Boundary and Independence

**Never review code in the same session that implemented it.**
The builder/author cannot independently review their own work due to confirmation bias and cached assumptions. Review runs in an isolated, read-only session.

- **Strict Read-Only Boundary:** Reviewers are strictly forbidden from editing, writing, patching, formatting, refactoring, or deleting any repository files.
- **No silent remediation:** Report every issue as an actionable finding with `file:line`, severity, clear impact description, and optional code suggestion.

## Steps

1. **Pin candidate identity and establish diff scope.**
   Resolve target-base tip and candidate head to immutable Git SHAs. Inspect the line-numbered unified diff (`L<line>:` annotations) against the base. Identify changed files and external callers outside the diff via `## Host-Computed Blast Radius`.
   *Completion Criterion*: Target-base tip, candidate SHA, and changed file list are pinned to immutable references.

2. **Conduct line-by-line code inspection against standards.**
   Inspect the line-numbered diff line by line against `CODING_STANDARDS.md`, `.animus/codebase-rules.json` (`pattern_registry`), and repository conventions:
   - **Module Depth & Deletion Test:** Reject shallow wrappers and pass-through functions that add no value. Enforce deep modules with simple interfaces hiding complex implementations.
   - **External Blast Radius & Callers:** Verify all unmodified callers remain safe. Require Proof Level 4 (tests or executable probe evidence) when shared interfaces, schemas, or lifecycle methods change.
   - **Test Quality:** Reject tautological tests, mock-heavy implementation-coupled checks, and happy-path-only additions missing negative/error cases.
   - **Security & Anti-Reinvention:** Validate boundary schemas (`.agents/skills/security-hardening/SKILL.md`). Block hand-rolled parsers or ad-hoc protocols; enforce standard dependencies.
   - **Simplicity:** Remove narration comments, dead code, and speculative generality.
   *Completion Criterion*: Every changed hunk evaluated against module depth, blast radius, test quality, security, and codebase rules.

3. **Anchor findings and verify rechecks.**
   - Anchor every defect to its exact `file` and 1-based `line` number from the diff.
   - Classify findings as `blocking` (true/false) and provide actionable descriptions with optional `suggestion` replacement blocks.
   - For prior findings, independently recheck whether the fix holds on the fresh candidate using cited evidence.
   *Completion Criterion*: All findings carry valid `file:line` locations, clear severity, and prior findings have verified recheck records.

4. **Compile review report and determine outcome.**
   Synthesize findings into the canonical JSON reviewer schema:
   - `merge`: Zero blocking findings, clean checks, low risk, and zero critical impact categories.
   - `approved`: Zero blocking findings, but requires human sign-off due to critical impact (DB migration, cross-domain contract, security/auth, toolchain/infra, or foundational direction).
   - `sent-back`: Fixable defects, test inadequacies, or standards violations exist.
   - `needs-owner`: Contradictory scope, protected path mutations, or max rejections exceeded.
   *Completion Criterion*: Complete reviewer JSON report emitted with explicit outcome, candidate SHA, structured findings, and critical impact evaluation.
