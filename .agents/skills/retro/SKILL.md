---
name: retro
description: Run a post-session retrospective to improve the coding agent environment while keeping builder context pressure low.
disable-model-invocation: true
---

# Retrospective: Environment & Harness Improvement

Improve the coding agent's environment after a build or debugging session. Separate **Implementation** (high context pressure: exploring, coding, debugging) from **Review** (low context pressure: inspecting a diff) so the Builder never suffers instruction saturation.

## When to Use

Use this playbook when:
- Looking back over a completed or sideways session to prevent recurring mistakes.
- Auditing `AGENTS.md`, `CODING_STANDARDS.md`, `.factory/codebase-rules.json`, or `.factory/lessons.jsonl` for context bloat or missing guardrails.

## Steps

1. **Inspect session primary sources and classify friction**
   Read `.agents/skills/writing-for-agents/SKILL.md` first. Inspect the current session or specified run logs to identify where the agent wasted turns, hit errors, or missed a convention.
   *Completion Criterion*: Every observed friction point is cited from session logs or diffs before proposing changes.

2. **Route each finding by the Context-Pressure Hierarchy**
   Assign each candidate improvement to the lowest-context-pressure layer that can enforce it:
   - **Automated Guard / Check (0 Builder context tokens)**: Mechanical mistakes (banned APIs, import shapes, regex patterns) become deterministic `rules` in `.factory/codebase-rules.json`, linter rules, or CI checks. Always prefer building a check over writing prose.
   - **Reviewer Coding Standards (0 Builder context tokens)**: Judgement calls, module-depth expectations, and cross-file style rules go into `CODING_STANDARDS.md` for the **Reviewer** to enforce during code review, never into `AGENTS.md`.
   - **Verified Tool Recipes (On-demand on error)**: Working CLI commands (`exit 0`) go into `.factory/tool-guidance.json`.
   - **File-Scoped Gotchas (On-demand per file)**: Non-obvious runtime traps go into `.factory/lessons.jsonl` with narrow `trigger_patterns` (max 2 sentences, positive imperative).
   - **Navigation Pointers**: Only genuine repo-wide navigation pointers belong in `AGENTS.md` (strictly <= 150 lines).
   *Completion Criterion*: Every candidate improvement is mapped to its target artifact with zero judgment-call prose added to the Builder's base prompt.

3. **Prune no-ops and one-off skill bloat**
   Scan `AGENTS.md`, `.factory/lessons.jsonl`, and `.agents/skills/` for instructions the model already follows by default (no-ops), duplicate rules, or narrow single-issue skills. Recommend deletions or consolidations.
   *Completion Criterion*: Ranked improvement and pruning candidates are presented to the user in order of severity and approved before writing.
