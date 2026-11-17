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
- Auditing `AGENTS.md`, `CODING_STANDARDS.md`, `.animus/codebase-rules.json`, or `.animus/lessons.jsonl` for context bloat or missing guardrails.

## Steps

1. **Inspect session primary sources and classify friction**
   Read `.agents/skills/writing-for-agents/SKILL.md` first. Inspect the current session or specified run logs to identify where the agent wasted turns, hit errors, or missed a convention.
   *Completion Criterion*: Every observed friction point is cited from session logs or diffs before proposing changes.

2. **Route each finding by the Single Enforcement Hierarchy**
   Assign each candidate improvement to the lowest-context-cost level that can enforce it, using the seven-level table in `docs/agents/harness-authoring-standard.md` §1. Do not restate that table here: it is the routing authority shared by this playbook, `/animus-learn`, and the loop reflector, so a change to where something belongs is made once.
   *Completion Criterion*: Every candidate improvement is mapped to a named level from §1 with zero judgment-call prose added to the Builder's base prompt.

3. **Prune no-ops and one-off skill bloat**
   Scan `AGENTS.md`, `.animus/lessons.jsonl`, and `.agents/skills/` for instructions the model already follows by default (no-ops), duplicate rules, or narrow single-issue skills. Recommend deletions or consolidations.
   *Completion Criterion*: Ranked improvement and pruning candidates are presented to the user in order of severity and approved before writing.
